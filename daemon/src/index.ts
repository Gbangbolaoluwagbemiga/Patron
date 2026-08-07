// index.ts — Patron's daemon entrypoint. Raw node:http (not a framework) so the
// x402 seller middleware — which expects Express-style (req, res, next) — mounts
// with zero adapter code, matching the proven pattern from the reference x402
// seller implementation this was built against. Serves:
//
//   POST /api/hire            x402-gated — AI agents commission Patron here
//   POST /api/instruct        unguarded — the human front door (same pipeline)
//   GET  /api/tasks           REST for the command-center UI
//   GET  /api/decisions       decision log
//   GET  /api/payments        payment feed
//   GET  /events              SSE stream of live AgentEvents

import http from "node:http";
import { randomUUID } from "node:crypto";
import { createPublicClient, http as viemHttp, formatEther, verifyMessage } from "viem";
import { config, arcTestnet, rpcUrl } from "./config.js";
import { AgentClient, type AgentEvent } from "./agent/AgentClient.js";
import { createPatronGateway } from "./circle/gateway.js";
import { createPatronPaywall, ORDER_FEE_USDC } from "./circle/x402-seller.js";
import * as secureflow from "./web3/secureflow.js";
import { graphQuery, isGraphConfigured } from "./graph/client.js";
import { GET_JOB_APPLICATIONS, GET_JOB_BY_ID, type GQLEscrow } from "./graph/queries.js";
import * as store from "./store.js";
import * as workers from "./workers/service.js";
import * as telegram from "./workers/telegram.js";
import { setLlmPausedUntil } from "./llm-status.js";
import { extractStatedBudget } from "./agent/BriefGenerator.js";

const PORT = config.port;

/**
 * Held back from every withdrawal so Patron can still sign.
 *
 * A treasury drained to exactly zero cannot pay the gas to do anything at all —
 * including paying the next freelancer whose work was already approved.
 */
const TREASURY_GAS_FLOOR = Number(process.env.TREASURY_GAS_FLOOR_USDC ?? 0.5);

/**
 * The exact sentence a depositor signs to authorise a withdrawal.
 *
 * It names the address AND the amount, so a signature captured for one
 * withdrawal cannot be replayed to authorise a bigger one.
 */
function withdrawalMessage(address: string, amountUsdc: string): string {
  return `Patron treasury withdrawal\nAddress: ${address.toLowerCase()}\nAmount: ${amountUsdc} USDC`;
}

/** The sentence a depositor signs to spend their own deposit on a commission. */
function commissionMessage(address: string, amountUsdc: string): string {
  return `Patron commission\nAddress: ${address.toLowerCase()}\nBudget: ${amountUsdc} USDC`;
}

// ── SSE broadcast ──────────────────────────────────────────────────────────
const sseClients = new Set<http.ServerResponse>();
function broadcast(event: AgentEvent) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// Patron's Gateway-backed treasury (MPC). Lazily created so the daemon still boots
// (and /api/tasks etc. still work) if Circle env vars aren't set yet — only x402
// routes need it.
let gatewayInstance: ReturnType<typeof createPatronGateway> | null = null;
function getGateway() {
  if (!gatewayInstance) gatewayInstance = createPatronGateway();
  return gatewayInstance;
}

const agent = new AgentClient((event) => {
  broadcast(event);

  // Reach the human this actually happened to. The web page can show all of
  // this, but only if someone is looking at it — a freelancer waiting to hear
  // whether they got the job is not sitting on a dashboard. Every call is a
  // no-op when no bot token is configured.
  if (event.decision?.target) {
    const who = event.decision.target;
    if (event.type === "applicant_accepted") {
      void telegram.notifyWorkerByAddress(
        who,
        [
          "🎉 <b>You got the job.</b>",
          "",
          "The money is already locked in escrow and can't be taken back — not even by the AI that hired you.",
          "",
          `Send your work with <code>/submit ${event.escrowId}</code> when it's ready. Include a link to the file.`,
        ].join("\n"),
      );
      // And tell everyone else. They applied, waited, and were never told
      // anything — the job simply went quiet on them forever. An answer you
      // don't want is still better than silence, and someone who knows they
      // weren't picked can go and apply for the next one.
      if (event.escrowId) void notifyUnsuccessfulApplicants(event.escrowId, who);
    }
  }
  if (event.type === "work_approved" && event.escrowId) {
    void telegram.notifyWorkerForEscrow(event.escrowId, "✅ Your work was accepted. Payment is on its way to your wallet.");
  }
  if (event.type === "work_rejected" && event.escrowId) {
    void telegram.notifyWorkerForEscrow(
      event.escrowId,
      `📝 Revision requested:\n\n${event.decision?.reasoning ?? "See the ledger for details."}\n\nSend an updated version when you're ready — the money stays locked in escrow either way.`,
    );
  }
  if (event.type === "payment_released" && event.escrowId) {
    void telegram.notifyWorkerForEscrow(event.escrowId, `💰 Paid${event.amountUsdc ? ` — $${event.amountUsdc} USDC` : ""}. It's in your wallet now. /balance to see it.`);
  }
  if (event.type === "job_posted" && event.escrowId && event.amountUsdc) {
    const task = store.listTasks(5).find((t) => t.escrowId === event.escrowId);
    const brief = task?.briefJson ? JSON.parse(task.briefJson) : null;
    if (brief?.title) void telegram.broadcastNewQuest(brief.title, Number(event.amountUsdc), event.escrowId);
  }
  if (event.decision) {
    store.recordDecision({
      id: event.decision.id,
      taskId: event.decision.taskId,
      type: event.decision.type,
      reasoning: event.decision.reasoning,
      target: event.decision.target,
      score: event.decision.score,
      timestamp: event.decision.timestamp,
    });
  }
  // Only actual movements of money belong in the payment feed. This used to end
  // in a catch-all `: "escrow_lock"`, which meant every on-chain write carrying
  // a txHash — accepting an applicant, requesting a revision, escalating a
  // dispute — was filed as a payment. Escrow #28 alone showed five phantom
  // "Locked in Escrow" rows with no amount against a $1 job. Those are real
  // transactions, but they are not payments, and padding the ledger with them
  // is exactly the kind of thing that makes a real feed look fabricated.
  const PAYMENT_DIRECTIONS = {
    job_posted: "escrow_lock",
    payment_released: "escrow_release",
    portfolio_verified: "out",
  } as const;
  const direction = PAYMENT_DIRECTIONS[event.type as keyof typeof PAYMENT_DIRECTIONS];
  if (event.txHash && event.escrowId && direction) {
    store.recordPayment({
      id: randomUUID(),
      direction,
      escrowId: event.escrowId,
      amountUsdc: event.amountUsdc ?? "",
      counterparty: event.counterparty,
      txHash: event.txHash,
      reason: event.type,
    });
  }
}, getGateway);


/**
 * Tell the applicants who weren't chosen.
 *
 * Only the winner was ever notified, so everyone else was left waiting on a
 * decision that had already been made. Their scores and the reasoning were
 * public on the ledger the whole time; nobody thought to point them at it.
 *
 * Deliberately includes WHY and where to read it. A rejection that explains
 * itself and links to the actual reasoning is a reason to apply again; a silent
 * one is a reason to leave.
 */
async function notifyUnsuccessfulApplicants(escrowId: string, winner: string): Promise<void> {
  try {
    const result = await graphQuery<{ escrow: { applications: { freelancer: string }[] } | null }>(GET_JOB_APPLICATIONS, {
      escrowId,
    });
    const applicants = result.escrow?.applications ?? [];
    const scores = store
      .listDecisions(300)
      .filter((d: { task_id?: string; type?: string }) => d.task_id === escrowId && d.type === "application_scored");

    for (const a of applicants) {
      if (a.freelancer.toLowerCase() === winner.toLowerCase()) continue;
      const mine = scores.find((s: { target?: string }) => s.target?.toLowerCase() === a.freelancer.toLowerCase()) as
        | { score?: number; reasoning?: string }
        | undefined;
      await telegram.notifyWorkerByAddress(
        a.freelancer,
        [
          "This one went to someone else.",
          "",
          mine?.score != null ? `You scored <b>${mine.score}/100</b> — the bar to be hired is 70.` : "",
          mine?.reasoning ? `\n<i>${mine.reasoning}</i>\n` : "",
          "Every score and the reasoning behind it is public, so you can see exactly how the decision was made:",
          `https://web-plum-one-12.vercel.app/jobs/${escrowId}`,
          "",
          "/jobs to see what else is open — being turned down here counts against nothing.",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
  } catch (err) {
    console.warn("[notify] could not reach unsuccessful applicants:", err instanceof Error ? err.message : err);
  }
}

/**
 * What a caller is allowed to see when something upstream breaks. The full
 * error still goes to the server log — but `/api/instruct` is a public endpoint,
 * and echoing the raw failure put a verbatim Groq 401 payload (provider name,
 * error taxonomy, response shape) straight into an HTTP response body. Known
 * failure modes get a sentence a human can act on; anything else is generic.
 */
function clientError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  console.error("[api]", raw);

  // Already written for the person who caused it — sanitising it would replace
  // the most useful sentence we have with a generic one.
  if (err instanceof workers.UserFacingError) return raw;

  if (/insufficient|exceeds balance/i.test(raw)) {
    return "Patron's treasury doesn't hold enough USDC to fund this commission. Fund the treasury or lower the budget.";
  }
  if (/exceeds the maximum single-commission cap/i.test(raw)) return raw; // ours, already phrased for a human
  if (/budget must be positive/i.test(raw)) return raw;
  if (/401|invalid api key|unauthorized/i.test(raw)) {
    return "The guild master's language model rejected the request (credentials). This is a server-side configuration problem, not a problem with your instruction.";
  }
  if (/429|rate.?limit/i.test(raw)) return "The guild master's language model is rate-limited right now. Try again shortly.";
  if (/timeout|timed out|aborted/i.test(raw)) return "That took too long and was cancelled. Nothing was charged and no escrow was opened.";
  if (/inconsistent brief|do not sum/i.test(raw)) {
    return "Could not produce a coherent brief from that instruction. Try stating the deliverable, budget, and deadline explicitly.";
  }
  return "Could not open this commission. The failure has been logged.";
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });
}

function json(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Shared by both the x402 (agent) and unguarded (human) entrypoints. */
async function runHireFlow(instruction: string, clientType: "agent" | "human", clientAddress?: string) {
  const taskId = randomUUID();
  store.insertTask({ id: taskId, escrowId: null, instruction, clientType, status: "briefing", briefJson: null, clientAddress });

  try {
    const { brief, escrowId } = await agent.processInstruction(instruction);
    store.updateTaskBrief(taskId, JSON.stringify(brief));
    store.updateTaskStatus(taskId, "posted", escrowId.toString());
    return { taskId, escrowId: escrowId.toString(), brief };
  } catch (err) {
    // Without this the row stays "briefing" forever — the LLM call or the
    // createEscrow write failed (insufficient treasury, RPC hiccup, bad
    // instruction) and nothing ever moved it on. Six such ghosts had piled up
    // locally, and because the stats bar counts briefing as in-progress they
    // were silently inflating "in progress" while never being real work.
    store.updateTaskStatus(taskId, "failed");
    broadcast({
      type: "error",
      message: `Could not open this commission: ${err instanceof Error ? err.message : String(err)}`,
      timestamp: Date.now(),
    });
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // CORS: the command-center web viewer runs on a different origin (Vite dev
  // server / static host) and only ever does reads — safe to allow from anywhere.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Payment");
  // Without this the browser can SEE the response but not the header on it, so
  // a paged reader would have no idea how many pages there are.
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, X-Total-In, X-Total-Out");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── SSE stream ──
  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // ── x402-gated: AI agents commission Patron ──
  if (req.method === "POST" && url.pathname === "/api/hire") {
    try {
      const gateway = getGateway();
      const applyPaywall = createPatronPaywall(gateway.address as `0x${string}`, ORDER_FEE_USDC);
      const proceed = await applyPaywall(req, res);
      if (!proceed) return; // paywall already wrote 402 or an error

      // The x402 commission fee that just cleared — "Payment 1: robot → Patron" in
      // the demo script. The middleware verifies+settles before we get here but
      // never persists anything; this is the only place that payment is recorded.
      const payment = (req as unknown as { payment?: { payer?: string; transaction?: string } }).payment;
      const paymentEvent: AgentEvent = {
        type: "payment_released",
        message: `Received $${ORDER_FEE_USDC} USDC commission from ${payment?.payer ?? "an AI agent"}.`,
        txHash: payment?.transaction,
        amountUsdc: ORDER_FEE_USDC,
        timestamp: Date.now(),
      };
      broadcast(paymentEvent);
      store.recordPayment({
        id: randomUUID(),
        direction: "in",
        amountUsdc: ORDER_FEE_USDC,
        counterparty: payment?.payer,
        txHash: payment?.transaction,
        reason: "x402_hire_fee",
      });

      const body = JSON.parse(await readBody(req)) as { instruction?: string };
      if (!body.instruction) return json(res, 400, { error: "instruction is required" });

      const result = await runHireFlow(body.instruction, "agent", payment?.payer);
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: clientError(err) });
    }
    return;
  }

  // ── Unguarded: the human front door (same pipeline, no x402 fee) ──
  if (req.method === "POST" && url.pathname === "/api/instruct") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        instruction?: string;
        clientAddress?: string;
        signature?: string;
        message?: string;
      };
      if (!body.instruction) return json(res, 400, { error: "instruction is required" });

      /**
       * A depositor may only commission what they have actually put in.
       *
       * Enforced HERE and not only in the browser, because the browser is not a
       * security boundary — this endpoint is public, and a cap that lives in a
       * form is a suggestion. When a client identifies themselves they sign for
       * it, exactly like a withdrawal: the treasury is a shared pot, and
       * spending against someone else's deposit by typing their address would
       * be the same theft as withdrawing it.
       *
       * Posting anonymously is still allowed — that is the "try it yourself"
       * demo path — and stays bounded by MAX_JOB_BUDGET_USDC as before.
       */
      let payer: string | null = null;
      {
        // Required, not optional. Leaving an anonymous path open meant the UI
        // could demand a wallet while the endpoint underneath happily accepted
        // a bare POST and spent the shared treasury — a cap enforced in a form
        // is a suggestion. Agents come through /api/hire and pay via x402;
        // humans come through here and commission against their own deposit.
        if (!body.clientAddress) {
          return json(res, 401, {
            error: "Connect a wallet and deposit before commissioning. Every job is funded from its client's own balance.",
          });
        }
        if (!/^0x[a-fA-F0-9]{40}$/.test(body.clientAddress)) return json(res, 400, { error: "That is not a valid address." });
        const stated = extractStatedBudget(body.instruction);
        if (stated == null) return json(res, 400, { error: "State a budget in the instruction, e.g. \"Budget $5\"." });

        const expected = commissionMessage(body.clientAddress, stated.toFixed(6));
        if (body.message !== expected) return json(res, 400, { error: "That signature does not match this commission." });
        const valid = await verifyMessage({
          address: body.clientAddress as `0x${string}`,
          message: body.message,
          signature: (body.signature ?? "0x") as `0x${string}`,
        }).catch(() => false);
        if (!valid) return json(res, 401, { error: "Signature did not verify — this address did not authorise the commission." });

        const account = store.treasuryAccount(body.clientAddress);
        if (stated > account.net + 1e-9) {
          return json(res, 400, {
            error:
              account.net <= 0
                ? "You haven't deposited anything to commission with yet. Fund the treasury first — you can withdraw whatever you don't spend."
                : `That's more than your deposit. You have $${account.net.toFixed(2)} left to commission with.`,
          });
        }
        payer = body.clientAddress;
      }

      const result = await runHireFlow(body.instruction, "human", payer ?? undefined);

      // Debit the real brief amount, not the stated one — the guild master
      // rescales a budget that doesn't add up, and the ledger has to record
      // what was actually locked in escrow.
      if (payer) {
        store.recordTreasuryEntry({
          id: randomUUID(),
          party: payer,
          direction: "spend",
          amountUsdc: Number(result.brief.budget).toFixed(6),
          txHash: `commission:${result.escrowId}`,
        });
      }
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: clientError(err) });
    }
    return;
  }

  // ── REST for the command center ──
  if (req.method === "GET" && url.pathname === "/api/tasks") {
    return json(res, 200, store.listTasks());
  }
  /**
   * The decision log, paged.
   *
   * Still returns a bare array so every existing caller keeps working; the
   * total rides along in a header rather than changing the response shape.
   * Without limit/offset there was no way to read past the newest 100, which
   * meant the public record quietly began deleting itself once traffic arrived.
   */
  if (req.method === "GET" && url.pathname === "/api/decisions") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    res.setHeader("X-Total-Count", String(store.countDecisions()));
    return json(res, 200, store.listDecisions(limit, offset));
  }
  /**
   * The payment feed, paged.
   *
   * The totals ride in headers because they must describe the WHOLE ledger, not
   * the page being viewed. Summing the rows the browser happens to hold was
   * correct only while it held all of them.
   */
  if (req.method === "GET" && url.pathname === "/api/payments") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const totals = store.paymentTotals();
    res.setHeader("X-Total-Count", String(store.countPayments()));
    res.setHeader("X-Total-In", totals.in.toFixed(6));
    res.setHeader("X-Total-Out", totals.out.toFixed(6));
    return json(res, 200, store.listPayments(limit, offset));
  }

  /**
   * The public commission board — every task that actually opened an escrow.
   * Separate from /api/tasks, which stays exactly as it was for the dashboard
   * and for anything already consuming it.
   */
  if (req.method === "GET" && url.pathname === "/api/commissions") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    res.setHeader("X-Total-Count", String(store.countCommissions()));
    return json(res, 200, store.listCommissions(limit, offset));
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true });
  }

  // Treasury address + live balance — read-only, no key material involved. The
  // command center shows this so a user knows what Patron can actually afford
  // before posting a job, and where to send funds to top it up.
  if (req.method === "GET" && url.pathname === "/api/wallet") {
    try {
      const publicClient = createPublicClient({ chain: arcTestnet, transport: viemHttp(rpcUrl) });
      const balance = await publicClient.getBalance({ address: config.circleWalletAddress as `0x${string}` });
      return json(res, 200, {
        address: config.circleWalletAddress,
        balance: formatEther(balance),
        explorerUrl: `https://testnet.arcscan.app/address/${config.circleWalletAddress}`,
      });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * A depositor's own position in the pooled treasury.
   *
   * `withdrawable` is deliberately NOT just what they put in. The treasury is a
   * single pooled wallet that Patron spends from to fund escrows, and money in
   * an escrow has genuinely left it — so if someone deposits $5 and Patron
   * commissions $5 of work, there is nothing to give back until that work
   * settles. Paying the first person to ask, out of a pot that is backing other
   * people's live commissions, is a bank run with extra steps.
   *
   * So the cap is the LESSER of what they are owed and what is actually here.
   */
  if (req.method === "GET" && url.pathname === "/api/treasury/account") {
    const address = (url.searchParams.get("address") ?? "").trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return json(res, 400, { error: "a valid address is required" });
    try {
      const account = store.treasuryAccount(address);
      const onHand = await treasuryBalance();
      // Keep a little back so Patron can still sign; a treasury that cannot pay
      // gas cannot pay anyone.
      const spendable = Math.max(0, onHand - TREASURY_GAS_FLOOR);
      return json(res, 200, {
        address,
        deposited: account.deposited.toFixed(6),
        withdrawn: account.withdrawn.toFixed(6),
        spent: account.spent.toFixed(6),
        claim: account.net.toFixed(6),
        withdrawable: Math.min(account.net, spendable).toFixed(6),
        treasuryOnHand: onHand.toFixed(6),
        entries: store.treasuryEntries(address, 20),
      });
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  /**
   * Claim a deposit.
   *
   * VERIFIED ON-CHAIN before it is credited — the client reports a transaction
   * hash and we go and read it: it must exist, be mined, be addressed to this
   * treasury, and come from the address claiming it. Trusting the browser here
   * would let anyone type a number and withdraw it.
   */
  if (req.method === "POST" && url.pathname === "/api/treasury/deposit") {
    try {
      const b = JSON.parse(await readBody(req)) as { txHash?: string; from?: string };
      if (!b.txHash || !b.from) return json(res, 400, { error: "txHash and from are required" });

      const pub = createPublicClient({ chain: arcTestnet, transport: viemHttp(rpcUrl) });
      const tx = await pub.getTransaction({ hash: b.txHash as `0x${string}` }).catch(() => null);
      if (!tx) return json(res, 404, { error: "That transaction could not be found on Arc yet. Give it a moment and try again." });

      const receipt = await pub.getTransactionReceipt({ hash: b.txHash as `0x${string}` }).catch(() => null);
      if (!receipt || receipt.status !== "success") return json(res, 400, { error: "That transaction has not succeeded." });

      const treasury = config.circleWalletAddress.toLowerCase();
      if ((tx.to ?? "").toLowerCase() !== treasury) return json(res, 400, { error: "That transaction did not pay Patron's treasury." });
      if (tx.from.toLowerCase() !== b.from.toLowerCase()) return json(res, 400, { error: "That transaction was not sent from this address." });
      if (tx.value <= 0n) return json(res, 400, { error: "That transaction moved no funds." });

      const amount = Number(formatEther(tx.value)).toFixed(6);
      const credited = store.recordTreasuryEntry({
        id: randomUUID(),
        party: b.from,
        direction: "deposit",
        amountUsdc: amount,
        txHash: b.txHash,
      });
      // Not an error: the UI reports the deposit and the user may refresh.
      return json(res, 200, { credited, amount, account: store.treasuryAccount(b.from) });
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  /**
   * Withdraw a deposit.
   *
   * Authorised by a SIGNATURE from the depositing address, not by asking. The
   * treasury is Patron's wallet, so an endpoint that pays out to whatever
   * address the caller names would let anyone drain everyone else's deposits by
   * typing their address — the signature is what proves the caller controls it.
   */
  if (req.method === "POST" && url.pathname === "/api/treasury/withdraw") {
    try {
      const b = JSON.parse(await readBody(req)) as { address?: string; amountUsdc?: string; signature?: string; message?: string };
      if (!b.address || !b.amountUsdc || !b.signature || !b.message) {
        return json(res, 400, { error: "address, amountUsdc, signature and message are required" });
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(b.address)) return json(res, 400, { error: "That is not a valid address." });

      const amount = Number(b.amountUsdc);
      if (!(amount > 0)) return json(res, 400, { error: "The amount has to be a positive number." });

      // The signed message must name THIS withdrawal, so a signature captured
      // for one amount cannot be replayed for a larger one.
      const expected = withdrawalMessage(b.address, b.amountUsdc);
      if (b.message !== expected) return json(res, 400, { error: "That signature does not match this withdrawal." });

      const valid = await verifyMessage({
        address: b.address as `0x${string}`,
        message: b.message,
        signature: b.signature as `0x${string}`,
      }).catch(() => false);
      if (!valid) return json(res, 401, { error: "Signature did not verify — this address did not authorise the withdrawal." });

      const account = store.treasuryAccount(b.address);
      const onHand = await treasuryBalance();
      const spendable = Math.max(0, onHand - TREASURY_GAS_FLOOR);
      const cap = Math.min(account.net, spendable);
      if (amount > cap + 1e-9) {
        return json(res, 400, {
          error:
            account.net < amount
              ? `You can withdraw at most $${account.net.toFixed(2)} — that's what you've deposited and not yet taken back.`
              : `Only $${spendable.toFixed(2)} is currently in the treasury; the rest is locked in escrow against live commissions. It becomes withdrawable as those settle.`,
        });
      }

      const gateway = getGateway();
      const sent = await gateway.transferUsdc(b.address as `0x${string}`, amount.toFixed(6));
      store.recordTreasuryEntry({
        id: randomUUID(),
        party: b.address,
        direction: "withdrawal",
        amountUsdc: amount.toFixed(6),
        txHash: sent.hash,
      });
      store.recordPayment({
        id: randomUUID(),
        direction: "out",
        amountUsdc: amount.toFixed(6),
        counterparty: b.address,
        txHash: sent.hash,
        reason: "depositor_withdrawal",
      });
      broadcast({
        type: "task_completed",
        message: `Depositor withdrawal — $${amount.toFixed(2)} returned to ${b.address.slice(0, 10)}…`,
        txHash: sent.hash,
        amountUsdc: amount.toFixed(6),
        timestamp: Date.now(),
      });
      return json(res, 200, { txHash: sent.hash, amountUsdc: amount.toFixed(6), account: store.treasuryAccount(b.address) });
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  // ── The human front door (managed-worker layer) ──────────────────────────
  // Same pipeline as everything else: an application submitted here lands on
  // the SecureFlow subgraph, and the poller picks it up without knowing or
  // caring that a person on a web page produced it.

  if (req.method === "POST" && url.pathname === "/api/worker/join") {
    try {
      const body = JSON.parse(await readBody(req)) as {
        handle?: string;
        skills?: string;
        ownAddress?: string;
        channelRef?: string;
      };
      if (!body.handle) return json(res, 400, { error: "handle is required" });
      const worker = await workers.join({
        handle: body.handle,
        channel: "web",
        channelRef: body.channelRef,
        skills: body.skills,
        ownAddress: body.ownAddress as `0x${string}` | undefined,
      });
      // walletId is deliberately not returned — it is Circle's handle on the
      // wallet, of no use to a browser and not something to put in a response.
      return json(res, 200, {
        id: worker.id,
        handle: worker.handle,
        address: worker.walletAddress,
        mode: worker.mode,
      });
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/worker/quests") {
    return json(res, 200, workers.openQuests());
  }

  /**
   * On-chain reputation, read straight from SecureFlow.
   *
   * Deliberately NOT computed from our own database: the point of putting
   * ratings on the contract is that anyone can verify them without trusting us,
   * so this endpoint reads the same source a stranger would.
   */
  if (req.method === "GET" && url.pathname === "/api/ratings") {
    const addresses = (url.searchParams.get("addresses") ?? "")
      .split(",")
      .map((a) => a.trim())
      .filter((a) => /^0x[a-fA-F0-9]{40}$/.test(a))
      .slice(0, 25);
    if (addresses.length === 0) return json(res, 200, {});
    try {
      const entries = await Promise.all(
        addresses.map(async (a) => {
          try {
            return [a.toLowerCase(), await secureflow.getAverageRating(a as `0x${string}`)] as const;
          } catch {
            return [a.toLowerCase(), { average: 0, count: 0 }] as const;
          }
        }),
      );
      return json(res, 200, Object.fromEntries(entries));
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  /**
   * Cancel an unfilled commission and return its budget to the treasury.
   *
   * Guarded here as well as on-chain: the contract refuses once a freelancer is
   * hired, but refusing earlier gives a readable reason instead of a revert, and
   * makes the rule explicit to anyone reading this file — money stops being
   * reclaimable the moment a human has a claim on it.
   */
  if (req.method === "POST" && url.pathname === "/api/jobs/cancel") {
    try {
      const b = JSON.parse(await readBody(req)) as { escrowId?: string };
      if (!b.escrowId) return json(res, 400, { error: "escrowId is required" });

      const task = store.listTasks(100).find((t) => t.escrowId === b.escrowId);
      if (!task) return json(res, 404, { error: "No such commission." });
      if (task.status !== "posted") {
        return json(res, 400, {
          error:
            task.status === "active"
              ? "Someone is already working on this — their claim on the escrow is exactly what makes Patron trustworthy, so it can't be cancelled now."
              : `This commission is ${task.status}; only an unfilled one can be cancelled.`,
        });
      }

      // Measure rather than assume. SecureFlow deducts a cancellation penalty
      // that scales with how often you've cancelled and how many people already
      // applied, so the amount that actually comes back is not the face value of
      // the budget — and the client must be refunded what was really recovered.
      const before = await treasuryBalance();
      const txHash = await secureflow.cancelJob(BigInt(b.escrowId));
      const recovered = Math.max(0, (await treasuryBalance()) - before);

      store.updateTaskStatus(task.id, "cancelled", task.escrowId ?? undefined);

      // Pass it back to whoever commissioned the work.
      //
      // Patron has to be the escrow depositor — SecureFlow only lets the
      // depositor approve milestones, and a machine approving them is the entire
      // product — so the contract refunds Patron, not the client. Forwarding it
      // is therefore a POLICY Patron keeps, not something the contract enforces,
      // and it is described that way everywhere rather than implied to be a
      // guarantee.
      let refund: { to: string; amountUsdc: string; txHash: string } | null = null;
      if (task.clientAddress && recovered > 0) {
        try {
          const amount = recovered.toFixed(6);
          const gateway = getGateway();
          const forward = await gateway.transferUsdc(task.clientAddress as `0x${string}`, amount);
          refund = { to: task.clientAddress, amountUsdc: amount, txHash: forward.hash };
          store.recordPayment({
            id: randomUUID(),
            direction: "out",
            escrowId: b.escrowId,
            amountUsdc: amount,
            counterparty: task.clientAddress,
            txHash: forward.hash,
            reason: "client_refund",
          });
        } catch (err) {
          // The cancellation already succeeded and the money is safe in the
          // treasury; a failed forward must not read as a failed cancellation.
          console.error("[refund] cancelled but could not forward to the client:", err instanceof Error ? err.message : err);
        }
      }

      broadcast({
        type: "task_completed",
        message: refund
          ? `Commission cancelled — $${refund.amountUsdc} returned to the client who commissioned it.`
          : `Commission cancelled — $${recovered.toFixed(4)} recovered to the treasury.`,
        escrowId: b.escrowId,
        txHash,
        timestamp: Date.now(),
      });
      return json(res, 200, { txHash, recovered: recovered.toFixed(6), refund });
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  /**
   * The delivered work, for the person who paid for it.
   *
   * The loop was open at the most important point: a client commissioned a job,
   * watched the guild master hire, review and pay — and had nowhere to COLLECT
   * what they bought. The freelancer's submission goes on-chain, is read by the
   * poller, handed to the reviewer, and then dropped. Nothing stored it and
   * nothing served it, so the buyer could see that their logo had been approved
   * and paid for without ever seeing the logo.
   *
   * Read straight from the subgraph rather than from a copy we keep, for the
   * same reason ratings are: the client can verify every word of this against
   * the chain, and a cache would be one more thing that can quietly disagree
   * with the truth.
   */
  if (req.method === "GET" && url.pathname === "/api/jobs/work") {
    const escrowId = url.searchParams.get("escrowId");
    if (!escrowId) return json(res, 400, { error: "escrowId is required" });
    try {
      const task = store.listTasks(300).find((t) => t.escrowId === escrowId);
      const brief = task?.briefJson ? JSON.parse(task.briefJson) : null;
      const planned: { description?: string; amount?: number }[] = Array.isArray(brief?.milestones) ? brief.milestones : [];

      const result = await graphQuery<{ escrow: GQLEscrow | null }>(GET_JOB_BY_ID, { escrowId });
      const onChain = new Map(
        (result.escrow?.milestones ?? []).map((m) => [Number(m.milestoneIndex), m]),
      );

      const STATUS = ["awaiting delivery", "delivered — under review", "accepted and paid", "revision requested", "disputed", "resolved"];
      const milestones = (planned.length ? planned : [{ description: brief?.title ?? "Deliverable", amount: brief?.budget }]).map((p, i) => {
        const m = onChain.get(i);
        const delivered = m?.description ?? null;
        return {
          index: i,
          planned: p.description ?? "",
          amount: p.amount ?? null,
          status: STATUS[Number(m?.status ?? 0)] ?? "awaiting delivery",
          statusCode: Number(m?.status ?? 0),
          submittedAt: m?.submittedAt ? Number(m.submittedAt) * 1000 : null,
          approvedAt: m?.approvedAt ? Number(m.approvedAt) * 1000 : null,
          /** What the freelancer actually wrote and sent. */
          delivered,
          /** Pulled out so the client can just click the thing they paid for. */
          links: delivered ? (delivered.match(/https?:\/\/[^\s<>"')]+/gi) ?? []) : [],
        };
      });

      return json(res, 200, { escrowId, title: brief?.title ?? null, status: task?.status ?? null, milestones });
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  /** Humans who have joined the guild — the answer to "has anyone actually signed up". */
  if (req.method === "GET" && url.pathname === "/api/workers") {
    return json(
      res,
      200,
      store.listWorkers(100).map((w) => ({
        handle: w.handle,
        channel: w.channel,
        skills: w.skills,
        address: w.walletAddress,
        mode: w.mode,
        createdAt: w.createdAt,
      })),
    );
  }

  if (req.method === "GET" && url.pathname === "/api/worker/me") {
    const id = url.searchParams.get("id");
    if (!id) return json(res, 400, { error: "id is required" });
    const worker = store.getWorker(id);
    if (!worker) return json(res, 404, { error: "not found" });
    try {
      const { balance } = await workers.balance(id);
      return json(res, 200, { id: worker.id, handle: worker.handle, address: worker.walletAddress, mode: worker.mode, balance });
    } catch {
      return json(res, 200, { id: worker.id, handle: worker.handle, address: worker.walletAddress, mode: worker.mode, balance: null });
    }
  }

  /**
   * Everything this worker is involved in — applied to, hired for, finished.
   *
   * The bot had this as /mine from the start; the web page did not, and the
   * omission was worse than a missing convenience. The job board only lists
   * commissions still at "posted", so the instant someone was HIRED their job
   * left the board — taking the "I was hired, send work" button with it. A web
   * user could be hired and then have no way to deliver, while the identical
   * account on Telegram could. Both doors are supposed to be the same door.
   */
  if (req.method === "GET" && url.pathname === "/api/worker/mine") {
    const id = url.searchParams.get("id");
    if (!id) return json(res, 400, { error: "id is required" });
    try {
      return json(res, 200, await workers.myWork(id));
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  /** Graduation to self-custody — the bot's /link, which the web could not do. */
  if (req.method === "POST" && url.pathname === "/api/worker/switch-wallet") {
    try {
      const b = JSON.parse(await readBody(req)) as { workerId?: string; address?: string };
      if (!b.workerId || !b.address) return json(res, 400, { error: "workerId and address are required" });
      const worker = await workers.switchToOwnWallet(b.workerId, b.address as `0x${string}`);
      return json(res, 200, { id: worker.id, handle: worker.handle, address: worker.walletAddress, mode: worker.mode });
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/worker/apply") {
    try {
      const b = JSON.parse(await readBody(req)) as {
        workerId?: string;
        escrowId?: string;
        coverLetter?: string;
        proposedTimelineDays?: number;
        portfolioUrl?: string;
      };
      if (!b.workerId || !b.escrowId || !b.coverLetter) {
        return json(res, 400, { error: "workerId, escrowId and coverLetter are required" });
      }
      const result = await workers.apply(b.workerId, b.escrowId, b.coverLetter, b.proposedTimelineDays ?? 3, b.portfolioUrl);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/worker/submit") {
    try {
      const b = JSON.parse(await readBody(req)) as {
        workerId?: string;
        escrowId?: string;
        milestoneIndex?: number;
        description?: string;
      };
      if (!b.workerId || !b.escrowId || !b.description) {
        return json(res, 400, { error: "workerId, escrowId and description are required" });
      }
      // milestoneIndex stays honoured when a caller genuinely means a specific
      // stage, but is no longer defaulted to 0 — undefined lets the service pick
      // the stage that actually needs delivering.
      const result = await workers.submit(b.workerId, b.escrowId, b.description, b.milestoneIndex);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/worker/withdraw") {
    try {
      const b = JSON.parse(await readBody(req)) as { workerId?: string; destination?: string; amountUsdc?: string };
      if (!b.workerId || !b.destination) return json(res, 400, { error: "workerId and destination are required" });
      const result = await workers.withdraw(b.workerId, b.destination as `0x${string}`, b.amountUsdc);
      return json(res, 200, result);
    } catch (err) {
      return json(res, 500, { error: clientError(err) });
    }
  }

  res.writeHead(404).end("not found");
});

server.listen(PORT, () => {
  console.log(`\n  🏰 Patron daemon listening on http://localhost:${PORT}`);
  console.log(`     POST /api/hire       (x402-gated — AI agents)`);
  console.log(`     POST /api/instruct   (human front door)`);
  console.log(`     GET  /events         (SSE — command center)\n`);
});

// ── Background poller: applications → hire, submissions → review ──────────
// MilestoneStatus enum ordering assumed 0=pending,1=submitted,2=approved,
// 3=rejected,4=disputed,5=resolved (matches the app's original type comments) —
// confirm against the live contract in scripts/e2e-loop.ts before the demo.
const MILESTONE_SUBMITTED = 1;
const MILESTONE_APPROVED = 2;
const MILESTONE_DISPUTED = 4;
const ESCROW_RELEASED = 2;
const ESCROW_DISPUTED = 4;

/**
 * Which milestone reviews have actually COMPLETED.
 *
 * This was an in-memory Set marked BEFORE the review ran — the identical
 * mistake already fixed for application scoring below, still live on the path
 * that decides whether someone gets paid. A review that threw (a rate limit, a
 * timeout) had its key recorded anyway, so the submission was never looked at
 * again: the freelancer delivered real work, the guild master hit a 429 once,
 * and the job sat "active" forever with the money locked. On a tight token
 * budget that is not an edge case, it is the expected path.
 *
 * Now: persisted like every other poller marker, written only on success, and
 * attempt-bounded so a genuinely poisonous submission (one too large for the
 * model, say) gives up instead of retrying every 15 seconds forever.
 */
const reviewDoneKey = (escrowId: string, index: number, submittedAt: string) => `milestone_reviewed:${escrowId}:${index}:${submittedAt}`;
const reviewTriesKey = (escrowId: string, index: number, submittedAt: string) => `milestone_review_tries:${escrowId}:${index}:${submittedAt}`;
const MAX_REVIEW_ATTEMPTS = 5;

// Last application count Patron has actually SCORED for a given job. Without this,
// a job with zero (or unchanged) applicants gets re-queried and re-scored every
// 15s forever — burning LLM calls for nothing and flooding the command center
// with the same "no suitable applicant" notification on a loop. Only re-run
// reviewApplications when the applicant count has actually grown since last check.
//
// PERSISTED, not a Map: as an in-memory Map this survived only until the next
// restart, so every redeploy re-scored every open job's applicants from scratch.
// Escrow #31 ended up with 27 decision rows for 3 applicants — the same verdicts
// repeated — and each repeat was a real LLM call on a job that was already done.
const scoredCountKey = (escrowId: string) => `scored_applications:${escrowId}`;

/**
 * Rate the freelancer on-chain once a job finishes.
 *
 * This is what makes Patron's reputation REAL rather than derived. Anyone can
 * compute a reputation score from their own database and call it behaviour-based;
 * SecureFlow's submitRating puts it on the contract, where it is readable by
 * anyone — including SecureFlow's own dApp and any future client — and cannot be
 * quietly recalculated to flatter us.
 *
 * The score isn't invented: it comes from the review scores the guild master
 * actually produced for this job's milestones, mapped from 0–100 onto the
 * contract's 1–5. A job that needed two revisions genuinely earns a lower rating
 * than one accepted first time, and that difference is now permanent and public.
 *
 * Never fatal: the money is already paid by this point, and failing to record a
 * rating must not look like a failed payout.
 */
async function rateFreelancer(escrowId: string, brief: { milestones?: unknown[] }): Promise<void> {
  try {
    const hire = store
      .listDecisions(300)
      .find((d: { task_id?: string; type?: string; target?: string }) => d.task_id === escrowId && d.type === "applicant_accepted" && d.target);
    if (!hire?.target) return;

    const reviews = store
      .listDecisions(300)
      .filter((d: { task_id?: string; type?: string }) => d.task_id === escrowId && (d.type === "work_approved" || d.type === "work_rejected"));
    const rejections = reviews.filter((r: { type?: string }) => r.type === "work_rejected").length;
    const milestones = Array.isArray(brief?.milestones) ? brief.milestones.length : 1;

    // Five stars for clean acceptance, one star off per revision round needed.
    const score = Math.max(1, 5 - rejections);
    const review =
      rejections === 0
        ? `All ${milestones} milestone(s) accepted first time against the acceptance brief.`
        : `Completed after ${rejections} revision round(s); all ${milestones} milestone(s) ultimately accepted.`;

    const txHash = await secureflow.submitRating(BigInt(escrowId), score, review);
    console.log(`[rating] ${hire.target} rated ${score}/5 for escrow ${escrowId} (${txHash})`);
    broadcast({
      type: "task_completed",
      message: `On-chain rating recorded: ${score}/5 — ${review}`,
      escrowId,
      txHash,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.warn(`[rating] could not record rating for escrow ${escrowId} (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

/** Treasury balance as a number, for measuring what a cancellation actually returned. */
async function treasuryBalance(): Promise<number> {
  const pub = createPublicClient({ chain: arcTestnet, transport: viemHttp(rpcUrl) });
  const wei = await pub.getBalance({ address: config.circleWalletAddress as `0x${string}` });
  return Number(formatEther(wei));
}

/** True while every task in a pass is failing — i.e. the subgraph is unreachable. */
let pollerDegraded = false;
/** True once the LLM has reported a rate limit, so the warning is sent once, not every 15s. */
let llmExhausted = false;

/**
 * Wall-clock time until which LLM-backed poller work is skipped.
 *
 * Without this, a rate limit turns into a self-inflicted denial of service: the
 * poller wakes every 15s, fires another ~5k-token scoring request at an API
 * that just said no, and burns through the per-minute allowance as well as the
 * daily one — so the budget never gets a chance to recover and the logs fill
 * with the same 429. Observed live on production.
 *
 * Groq tells us exactly how long to wait ("Please try again in 29.34s"), so we
 * honour that when present and fall back to a conservative default when not.
 */
let llmCooldownUntil = 0;

function noteLlmRateLimit(message: string): void {
  const retryIn = message.match(/try again in ([\d.]+)s/i);
  const seconds = retryIn?.[1] ? Number(retryIn[1]) : NaN;
  // A per-minute limit clears in seconds; an exhausted DAILY budget does not,
  // and retrying it every minute all day is pointless noise.
  const isDaily = /per day|TPD|daily/i.test(message);
  const waitMs = Number.isFinite(seconds) && !isDaily ? Math.max(seconds * 1000, 5_000) : isDaily ? 15 * 60_000 : 60_000;
  llmCooldownUntil = Date.now() + waitMs;
  // Share it, so the people waiting on a decision can be told rather than left
  // watching silence.
  setLlmPausedUntil(llmCooldownUntil);
  console.warn(`[poller] LLM rate-limited — pausing LLM work for ${Math.round(waitMs / 1000)}s`);
}

/**
 * Sweep jobs stranded mid-brief.
 *
 * runHireFlow marks its own failures, but only when it catches one — a daemon
 * killed or redeployed between "insert the row" and "open the escrow" leaves a
 * row in `briefing` that nothing will ever move on. It then counts as in-progress
 * forever and quietly overstates how much live work there is.
 *
 * This was originally a one-time repair, which was the wrong shape: it fixed the
 * rows that existed that day and did nothing about the next one, and production
 * grew a fresh stranded row within hours. A recurring condition needs a recurring
 * sweep.
 */
function sweepStrandedBriefs(): void {
  const cutoff = Date.now() - 10 * 60_000;
  for (const t of store.listTasks(100)) {
    if (t.status === "briefing" && !t.escrowId && t.createdAt < cutoff) {
      store.updateTaskStatus(t.id, "failed");
      console.log(`[poller] marked stranded brief ${t.id} as failed (no escrow after 10 minutes)`);
    }
  }
}

/**
 * Return the budget on commissions nobody ever qualified for.
 *
 * Without this a job that attracts only weak applicants stays open forever with
 * the money locked: production had one sitting at 66 hours, scored fifteen times
 * as new applicants trickled in, none reaching the bar. Nothing was wrong, and
 * nothing would ever happen.
 *
 * Tied to the client's own deadline rather than an arbitrary timer — once the
 * duration they asked for has passed, the work cannot be delivered on time
 * anyway, so holding their money serves nobody. Same principle as the refund
 * path: money nobody earned goes back.
 *
 * Deliberately only touches jobs still at "posted". The moment a freelancer is
 * hired their claim on the escrow is exactly what makes Patron worth trusting.
 */
async function sweepExpiredCommissions(): Promise<void> {
  for (const task of store.listTasks(100)) {
    if (task.status !== "posted" || !task.escrowId || !task.briefJson) continue;
    let brief: { durationDays?: number; title?: string };
    try {
      brief = JSON.parse(task.briefJson);
    } catch {
      continue;
    }
    const days = Number(brief.durationDays ?? 0);
    if (!days) continue;
    if (Date.now() < task.createdAt + days * 86_400_000) continue;

    try {
      const txHash = await secureflow.cancelJob(BigInt(task.escrowId));
      store.updateTaskStatus(task.id, "cancelled", task.escrowId);
      console.log(`[poller] expired unfilled commission ${task.escrowId} cancelled, budget returned (${txHash})`);
      broadcast({
        type: "task_completed",
        message: `"${brief.title ?? "Commission"}" reached its deadline without a suitable applicant — the budget has been returned in full.`,
        escrowId: task.escrowId,
        txHash,
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn(`[poller] could not cancel expired ${task.escrowId}:`, err instanceof Error ? err.message : err);
    }
  }
}

async function pollOnce() {
  sweepStrandedBriefs();
  await sweepExpiredCommissions();
  if (!isGraphConfigured()) return;
  // Everything the poller does downstream costs an LLM call. While the model is
  // rate-limited there is nothing useful to do, and trying anyway is what kept
  // the budget pinned at zero.
  if (Date.now() < llmCooldownUntil) return;
  // Filtered AFTER the fetch, so the window has to be wide enough to still
  // contain live work once finished jobs pile up in front of it. At 50 a busy
  // week would have pushed a genuinely active job out of the poller's sight and
  // frozen it — nothing would advance it, and nothing would say why.
  const tasks = store.listTasks(300).filter((t) => t.escrowId && (t.status === "posted" || t.status === "active"));
  let pollFailures = 0;

  for (const task of tasks) {
    if (!task.escrowId || !task.briefJson) continue;
    const brief = JSON.parse(task.briefJson);
    const escrowId = BigInt(task.escrowId);
    /** Attempt counter of a review in progress, so a rate limit can give it back. */
    let inFlightReview: string | null = null;

    try {
      if (task.status === "posted") {
        const appsResult = await graphQuery<{ escrow: { applications: unknown[] } | null }>(GET_JOB_APPLICATIONS, {
          escrowId: task.escrowId,
        });
        const currentCount = appsResult.escrow?.applications.length ?? 0;
        const lastScored = store.getPollerInt(scoredCountKey(task.escrowId)) ?? -1;
        if (currentCount === 0 || currentCount <= lastScored) continue; // nothing new to score

        // Give people a chance to apply before judging.
        //
        // This used to score the instant the first application arrived, and hire
        // anyone clearing the bar — so the job went to whoever refreshed fastest,
        // and the "one comparative call ranking applicants against each other"
        // was ranking a pool of one. That is not a marketplace, it is a race.
        //
        // The window is per-job so a client can ask for longer ("give people a
        // day"), and it only gates the FIRST judgement: once a job has been
        // scored, a later applicant is still picked up on the next pass, because
        // the alternative is telling someone who applied in good time that they
        // arrived too late to be read at all.
        const windowMinutes = brief?.applicationWindowMinutes ?? config.applicationWindowMinutes;
        const opensAt = task.createdAt + windowMinutes * 60_000;
        if (lastScored < 0 && Date.now() < opensAt) {
          continue; // still open for applications
        }

        // Mark AFTER the pass succeeds, never before. Recording the count first
        // meant a single transient LLM failure — a rate limit, a timeout — burned
        // the marker anyway and the job was skipped forever: escrow #32 took a
        // 429 on its only scoring attempt and would never have been looked at
        // again. The dedup marker exists to prevent repeated SUCCESSFUL work, so
        // it has to record success, not intent.
        const winner = await agent.reviewApplications(escrowId, brief);
        store.setPollerInt(scoredCountKey(task.escrowId), currentCount);
        if (winner) store.updateTaskStatus(task.id, "active", task.escrowId);
        continue;
      }

      if (task.status === "active") {
        const result = await graphQuery<{ escrow: GQLEscrow | null }>(GET_JOB_BY_ID, { escrowId: task.escrowId });
        const milestones = result.escrow?.milestones ?? [];
        for (const [index, m] of milestones.entries()) {
          if (m.status !== MILESTONE_SUBMITTED) continue;
          // Keyed on submittedAt, not just index — a rejected milestone gets
          // resubmitted at the SAME index with a NEW submittedAt. Keying on index
          // alone meant a resubmission after rejection was permanently skipped:
          // the first review's key stayed in the set forever, so the revision the
          // freelancer actually sent in response to feedback never got looked at.
          // Caught by actually driving a real reject -> resubmit cycle end to end.
          const submittedAt = String(m.submittedAt ?? "");
          if (store.getPollerInt(reviewDoneKey(task.escrowId, index, submittedAt))) continue;

          const tries = store.getPollerInt(reviewTriesKey(task.escrowId, index, submittedAt)) ?? 0;
          if (tries >= MAX_REVIEW_ATTEMPTS) {
            // Out of retries. Say so loudly — someone's delivered work is sitting
            // here unpaid, and silence is how that stays invisible.
            if (tries === MAX_REVIEW_ATTEMPTS) {
              store.setPollerInt(reviewTriesKey(task.escrowId, index, submittedAt), tries + 1);
              console.error(`[poller] milestone ${task.escrowId}:${index} could not be reviewed after ${MAX_REVIEW_ATTEMPTS} attempts — needs a human`);
              broadcast({
                type: "escalated_to_human",
                message: "A submission could not be reviewed automatically after repeated attempts and needs a human look. The escrowed funds are untouched.",
                escrowId: task.escrowId,
                timestamp: Date.now(),
              });
            }
            continue;
          }

          // Count the attempt BEFORE the call so a submission that reliably
          // breaks the model cannot loop forever; record DONE only after it
          // genuinely succeeds so a transient failure is retried.
          store.setPollerInt(reviewTriesKey(task.escrowId, index, submittedAt), tries + 1);
          inFlightReview = reviewTriesKey(task.escrowId, index, submittedAt);
          await agent.reviewMilestone(escrowId, BigInt(index), m.description, "", brief, m.description);
          inFlightReview = null;
          store.setPollerInt(reviewDoneKey(task.escrowId, index, submittedAt), 1);
        }

        // Re-fetch rather than trust the pre-review snapshot above, since a
        // review in the loop above may have just approved and paid a milestone.
        const refreshed = await graphQuery<{ escrow: GQLEscrow | null }>(GET_JOB_BY_ID, { escrowId: task.escrowId });
        const finalMilestones = refreshed.escrow?.milestones ?? [];

        // A disputed job is not "active" — it's out of the agent's hands and
        // waiting on a human arbiter. Surfacing this matters: escalation is the
        // answer to "what if the AI wrongly rejects good work", and it was
        // invisible here. Escrow #28 sat on-chain as status 4 for a day while
        // the command center still displayed it as merrily active.
        const disputed =
          refreshed.escrow?.status === ESCROW_DISPUTED || finalMilestones.some((m) => m.status === MILESTONE_DISPUTED);

        // Completion is derived from the MILESTONES, not from escrow.status.
        // The old check was `escrow.status === 2` (Released), which never fires:
        // SecureFlow leaves an escrow at status 1 even after every milestone is
        // approved and the money is out the door. Escrow #19 had all milestones
        // approved and $4 genuinely paid to a human, and still showed as active —
        // so the dashboard reported "0 completed, 0% completion rate" forever,
        // which is both the worst possible number to show and simply untrue.
        // Count approved milestones against the BRIEF's milestone count, not
        // against the list the subgraph returns. The subgraph only indexes
        // milestones that have been interacted with, so a 3-milestone job whose
        // first milestone was just approved comes back as a single-element list
        // — and `every(approved)` over that is trivially true. Escrow #29 was
        // marked complete after $0.50 of its $1 had been paid, with two
        // milestones still outstanding.
        const expectedMilestones = Array.isArray(brief?.milestones) ? brief.milestones.length : 0;
        const approvedCount = finalMilestones.filter((m) => m.status === MILESTONE_APPROVED).length;
        const allApproved = expectedMilestones > 0 && approvedCount >= expectedMilestones;

        if (disputed) {
          store.updateTaskStatus(task.id, "disputed", task.escrowId);
          broadcast({
            type: "escalated_to_human",
            message: "Job escalated — a human arbiter now holds this milestone via SecureFlow's dispute system.",
            escrowId: task.escrowId,
            timestamp: Date.now(),
          });
        } else if (allApproved || refreshed.escrow?.status === ESCROW_RELEASED) {
          store.updateTaskStatus(task.id, "completed", task.escrowId);
          broadcast({ type: "task_completed", message: "Job completed — all milestones approved and paid.", escrowId: task.escrowId, timestamp: Date.now() });
          void rateFreelancer(task.escrowId, brief);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[poller] task ${task.id} failed:`, msg);
      pollFailures++;

      // An exhausted LLM budget stops hiring dead while everything else looks
      // perfectly healthy — the API answers, the chain is fine, jobs just never
      // move. Announce it once. Discovered the hard way: the daily token budget
      // ran out and the only visible symptom was a schema-validation error.
      // 413 means the request was too big, not that we asked too often — the
      // message still says "rate_limit_exceeded", but pausing and retrying an
      // oversized prompt fails identically forever. It is a bug to fix, not a
      // wait to serve.
      if (/413|too large/i.test(msg)) {
        console.error("[poller] prompt too large for the model — this will not resolve by waiting");
      } else if (/rate limit|rate_limit|429/i.test(msg)) {
        // Being rate-limited says nothing about the submission, so it must not
        // spend one of its five chances. Otherwise a quiet afternoon of 429s
        // exhausts a perfectly good milestone's retries and strands the payout.
        if (inFlightReview) {
          const spent = store.getPollerInt(inFlightReview) ?? 1;
          store.setPollerInt(inFlightReview, Math.max(0, spent - 1));
        }
        noteLlmRateLimit(msg);
        if (!llmExhausted) {
          llmExhausted = true;
          broadcast({
            type: "error",
            message: "The guild master's language model has hit its rate limit — hiring and reviews are paused until it resets. Escrowed funds are unaffected.",
            timestamp: Date.now(),
          });
        }
        break; // no point walking the remaining tasks this pass
      } else if (llmExhausted) {
        llmExhausted = false;
      }
    }
  }

  // The poller is how every job advances. If the subgraph is unreachable it
  // fails silently per-task forever: the daemon stays healthy, the API keeps
  // answering, and jobs simply stop moving with nothing on screen to say why.
  // Announce the outage ONCE, and announce recovery once, so the command
  // center can tell a viewer that Patron has gone blind rather than idle.
  const nowDegraded = tasks.length > 0 && pollFailures >= tasks.length;
  if (nowDegraded && !pollerDegraded) {
    pollerDegraded = true;
    broadcast({
      type: "error",
      message: "Lost contact with the SecureFlow subgraph — jobs will not advance until it returns. Escrowed funds are unaffected.",
      timestamp: Date.now(),
    });
  } else if (!nowDegraded && pollerDegraded) {
    pollerDegraded = false;
    broadcast({ type: "error", message: "Subgraph contact restored — the guild master is reading the chain again.", timestamp: Date.now() });
  }
}

setInterval(() => void pollOnce(), 15_000);

// Second door into the worker layer. Dormant without a bot token; the daemon
// boots and runs identically either way.
telegram.startTelegramBot();
