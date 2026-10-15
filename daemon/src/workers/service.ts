// service.ts — everything a human can do, independent of how they reached us.
//
// This is the actual feature. The web page and the Telegram bot are both thin
// shells over these five functions; neither knows anything the other doesn't.
// Keeping the surface out of here is what makes the second door cost a day
// instead of a week, and what lets us change our minds about surfaces later.
//
// The architectural property that makes all of this cheap: Patron's poller reads
// the SecureFlow subgraph, not a list of applicants it maintains. It has no idea
// who produced an application. So a worker applying through this service flows
// into reviewApplications → acceptFreelancer → reviewMilestone → approveMilestone
// with zero changes to the scorer, the reviewer, the agent, the store, the SSE
// stream, or the frontend. The guild master genuinely cannot tell which door
// someone came through — and doesn't need to.

import crypto from "node:crypto";
import * as store from "../store.js";
import * as secureflow from "../web3/secureflow.js";
import { createSignerFor } from "../circle/circleSigner.js";
import { config } from "../config.js";
import { dripGas, provisionWorkerWallet, workerBalance, withdrawTo } from "./wallets.js";

/**
 * An error whose message was written to be read by the person who caused it.
 *
 * The API sanitises errors before returning them, which is right for raw upstream
 * failures (a provider 401 has no business in an HTTP response) and wrong for
 * these: "that portfolio link doesn't look like a URL" is already the most useful
 * thing we could say, and it was being replaced with "Could not open this
 * commission. The failure has been logged." — unhelpful, and about a commission
 * on an endpoint that has nothing to do with commissions.
 */
export class UserFacingError extends Error {}

export interface JoinParams {
  handle: string;
  channel: "web" | "telegram";
  channelRef?: string;
  skills?: string;
  /** Bring-your-own-wallet: they already have an address and will sign for themselves. */
  ownAddress?: `0x${string}`;
}

/**
 * Join the guild.
 *
 * Managed mode (the default) provisions a real MPC wallet and drips enough for
 * gas, and the person is never told either happened — because why would you tell
 * them. Bring-your-own mode records their address and provisions nothing; for
 * those users Patron is a notifier and coordinator, never a custodian.
 */
export async function join(params: JoinParams): Promise<store.WorkerRow> {
  const handle = params.handle.trim();
  if (!handle) throw new UserFacingError("A handle is required — it's the only thing you have to choose.");
  if (handle.length > 40) throw new UserFacingError("That handle is too long (40 characters max).");

  if (params.channelRef) {
    const existing = store.getWorkerByChannelRef(params.channel, params.channelRef);
    if (existing) return existing; // idempotent: tapping "join" twice is not two people
  }

  const id = crypto.randomUUID();

  if (params.ownAddress) {
    return store.insertWorker({
      id,
      handle,
      channel: params.channel,
      channelRef: params.channelRef ?? null,
      skills: params.skills ?? null,
      walletId: null,
      walletAddress: requireAddress(params.ownAddress, "wallet address"),
      mode: "own",
    });
  }

  const wallet = await provisionWorkerWallet();
  const worker = store.insertWorker({
    id,
    handle,
    channel: params.channel,
    channelRef: params.channelRef ?? null,
    skills: params.skills ?? null,
    walletId: wallet.walletId,
    walletAddress: wallet.address,
    mode: "managed",
  });

  // Non-blocking: they are a real worker the moment the row exists. If the drip
  // fails they'll hit it when they act, which is a far better place to surface
  // it than the front door.
  void dripGas(wallet.address);

  return worker;
}

export interface Quest {
  escrowId: string;
  title: string;
  budget: number;
  durationDays: number;
  criteria: string[];
  /** How the budget is split, so a worker can see they're paid in stages. */
  milestones: { description: string; amount: number }[];
  /** When applications close and the guild master judges them together. */
  closesAt: number;
  /** Only set when a worker was supplied — lets a surface hide "Apply" on ones they've taken. */
  alreadyApplied?: boolean;
  /**
   * Who reviews the work and releases the money.
   *
   * "patron" means this agent opened the escrow and will judge the delivery.
   * "client" means somebody else did — the job is real and applying to it is
   * real, but a human on the other side decides, not Patron. Saying which is
   * the difference between a board and a claim we cannot keep.
   */
  managedBy: "patron" | "client";
}

/** Open commissions, optionally marked up for one worker. */
/**
 * Every job a human can actually apply to, asked of the CONTRACT.
 *
 * This read our own task table and filtered on status === "posted". Two real,
 * funded, open commissions were sitting on Arc mainnet — $0.30 between them —
 * while the board told every visitor "No open commissions at this moment",
 * because neither had a row in this database. Same mistake as asking our own
 * database which escrows exist: the chain is the thing that knows.
 *
 * It also meant a job posted on SecureFlow's own dApp was invisible here, which
 * quietly contradicts the claim that these are the same jobs on two interfaces.
 *
 * The database is still used, for what it is actually good at: the brief. The
 * contract stores a title and a description; our row stores the acceptance
 * criteria, the milestone wording and the application window. So the chain
 * decides WHICH jobs exist and the row enriches the ones it knows about.
 */
/**
 * The board, cached.
 *
 * Reading it costs one nextEscrowId plus a getEscrow per escrow, and this is a
 * PUBLIC endpoint — every visitor to /work, every Telegram /jobs, every poll of
 * the page. Doing that per request is a self-inflicted denial of service: the
 * public Arc RPC rate-limits by IP, and with a poller running alongside it the
 * reads started failing with "Request exceeds defined limit", which emptied the
 * board for everyone.
 *
 * Thirty seconds is longer than a person refreshes and far shorter than the
 * minutes an application window runs for, so nothing a worker can act on is
 * ever stale enough to matter.
 */
let boardCache: { at: number; quests: Quest[] } | null = null;
const BOARD_TTL_MS = 30_000;

export async function openQuests(): Promise<Quest[]> {
  if (boardCache && Date.now() - boardCache.at < BOARD_TTL_MS) return boardCache.quests;

  const byEscrow = new Map<string, store.TaskRow>();
  for (const t of store.listTasks(300)) {
    if (t.escrowId && t.briefJson && store.isOnCurrentChain(t)) byEscrow.set(t.escrowId, t);
  }

  /*
   * A FLICKER MUST NOT EMPTY THE BOARD.
   *
   * This returned [] the moment nextEscrowId() threw, and the public Arc RPC
   * rate-limits under load — two daemons and a script were enough. The visible
   * result is "No open commissions at this moment" shown to a freelancer while
   * funded work sits on chain, which is indistinguishable from there being no
   * work, and they leave.
   *
   * So: retry once, and if the chain still will not answer, fall back to the
   * rows we do have rather than to silence. A slightly stale board is a far
   * better lie than an empty one — and it is the same board this function
   * returned before it learned to read the chain at all.
   */
  let next: bigint | null = null;
  for (let attempt = 0; attempt < 2 && next === null; attempt++) {
    try {
      next = await secureflow.nextEscrowId();
    } catch (err) {
      console.warn(`[quests] nextEscrowId attempt ${attempt} failed:`, (err as Error)?.message?.split("\n")[0]?.slice(0, 160));
      if (attempt === 0) await new Promise((r) => setTimeout(r, 750));
    }
  }

  if (next === null) {
    // A stale board beats an empty one: the jobs it lists were real 30 seconds
    // ago and are almost certainly still open.
    if (boardCache) {
      console.warn("[quests] chain unreadable — serving the last good board");
      return boardCache.quests;
    }
    console.warn("[quests] chain unreadable — serving the board from local rows only");
    return [...byEscrow.values()].flatMap((t) => {
      const brief = JSON.parse(t.briefJson as string);
      if (t.status !== "posted") return [];
      const windowMinutes = (brief.applicationWindowMinutes as number | undefined) ?? config.applicationWindowMinutes;
      return [{
        escrowId: t.escrowId as string,
        title: brief.title as string,
        budget: brief.budget as number,
        durationDays: brief.durationDays as number,
        criteria: (brief.criteria ?? []) as string[],
        milestones: (brief.milestones ?? []) as { description: string; amount: number }[],
        closesAt: t.createdAt + windowMinutes * 60_000,
        managedBy: "patron" as const,
      }];
    });
  }

  const treasury = config.circleWalletAddress.toLowerCase();
  const quests: Quest[] = [];

  for (let id = 0n; id < next; id++) {
    let esc: {
      depositor?: string;
      beneficiary?: string;
      totalAmount?: bigint;
      deadline?: bigint;
      status?: number | bigint;
      isOpenJob?: boolean;
      projectTitle?: string;
    };
    try {
      esc = (await secureflow.getEscrow(id)) as typeof esc;
    } catch {
      continue; // deleted or never existed — not an open job either way
    }

    // The contract's own definition of "a human may apply to this": open to
    // applications, nobody hired, still Pending, and actually holding money.
    const open =
      esc?.isOpenJob === true &&
      (esc.beneficiary ?? "").toLowerCase() === "0x0000000000000000000000000000000000000000" &&
      Number(esc.status ?? -1) === 0 &&
      (esc.totalAmount ?? 0n) > 0n;
    if (!open) continue;

    const key = String(id);
    const row = byEscrow.get(key);
    const brief = row?.briefJson ? (JSON.parse(row.briefJson) as Record<string, unknown>) : null;
    const windowMinutes = (brief?.applicationWindowMinutes as number | undefined) ?? config.applicationWindowMinutes;

    let milestones = (brief?.milestones ?? []) as { description: string; amount: number }[];
    if (!milestones.length) {
      // No local brief — take the stages from the contract so a worker still
      // sees how the money is split rather than one opaque figure.
      try {
        const ms = (await secureflow.getMilestones(id)) as { amount: bigint; requirements: string; description: string }[];
        milestones = ms.map((m) => ({
          description: m.requirements || m.description || "Deliverable",
          amount: Number(m.amount) / 1e6,
        }));
      } catch {
        /* leave it empty — better than inventing stages */
      }
    }

    const deadlineMs = Number(esc.deadline ?? 0n) * 1000;
    quests.push({
      escrowId: key,
      title: (brief?.title as string) || esc.projectTitle || `Commission #${key}`,
      budget: Number(esc.totalAmount ?? 0n) / 1e6,
      durationDays: (brief?.durationDays as number) ?? Math.max(1, Math.round((deadlineMs - Date.now()) / 86_400_000)),
      criteria: (brief?.criteria ?? []) as string[],
      milestones,
      // A local row knows when applications close; a chain-only job has only a
      // delivery deadline, which is the honest upper bound on applying.
      closesAt: row ? row.createdAt + windowMinutes * 60_000 : deadlineMs,
      managedBy: (esc.depositor ?? "").toLowerCase() === treasury ? "patron" : "client",
    });
  }

  boardCache = { at: Date.now(), quests };
  return quests;
}

/**
 * The same board, marked with what this person has already applied to.
 *
 * Separate from openQuests() because it costs one chain read per job: the plain
 * list is used on every poll and by anonymous visitors, and making that pay for
 * a personalisation nobody asked for would be the wrong default.
 */
export async function openQuestsFor(workerId: string): Promise<Quest[]> {
  const worker = store.getWorker(workerId);
  const quests = await openQuests();
  if (!worker?.walletAddress) return quests;
  const address = worker.walletAddress as `0x${string}`;
  return Promise.all(
    quests.map(async (q) => {
      try {
        return { ...q, alreadyApplied: await secureflow.hasApplied(BigInt(q.escrowId), address) };
      } catch {
        return q; // a chain hiccup must not empty someone's job board
      }
    }),
  );
}

/**
 * Make sure a worker can actually pay for the transaction they're about to sign.
 *
 * The gas drip on signup is deliberately non-blocking, which means someone who
 * joins and immediately applies can get there before their own funding has
 * confirmed. Found by doing exactly that: the first apply failed and the second,
 * four seconds later, worked.
 *
 * Worse than the failure was the message. The raw error says "insufficient
 * funds", which the API's sanitiser matched to its treasury rule and rendered as
 * "Patron's treasury doesn't hold enough USDC" — telling a freelancer that OUR
 * wallet was empty when the issue was a drip in flight to theirs.
 */
async function ensureGas(worker: store.WorkerRow): Promise<void> {
  if (worker.mode === "own" || !worker.walletAddress) return;
  const address = worker.walletAddress as `0x${string}`;
  try {
    if (Number(await workerBalance(address)) >= MIN_GAS_USDC) return;
    await dripGas(address); // awaited here, unlike signup — they are mid-action
    if (Number(await workerBalance(address)) >= MIN_GAS_USDC) return;
  } catch {
    // fall through to the message below rather than surfacing a chain error
  }
  throw new UserFacingError(
    "Your wallet is still being funded for network fees — give it about ten seconds and try again. Nothing was lost.",
  );
}

/** Enough to sign with. Arc fees are tiny; this is a floor, not a target. */
const MIN_GAS_USDC = Number(process.env.WORKER_MIN_GAS_USDC ?? 0.01);

function signerFor(worker: store.WorkerRow) {
  if (worker.mode === "own") {
    throw new UserFacingError(
      "You signed up with your own wallet, so Patron can't sign for you — apply from SecureFlow with your wallet and Patron will still see it.",
    );
  }
  if (!worker.walletAddress) throw new UserFacingError("No wallet on this account yet.");
  return createSignerFor(worker.walletAddress as `0x${string}`);
}

/**
 * Apply to a commission.
 *
 * The freelancer's OWN wallet signs this, not Patron's — SecureFlow authorises
 * applyToJob on msg.sender, so an application signed by Patron would record
 * Patron as the applicant. Their tap is the instruction; Patron is the broker
 * executing it in their name.
 */
/**
 * How long the applicant says they need.
 *
 * Both surfaces hard-coded 3. The scorer gives 15 points for a realistic
 * timeline and compares this against the brief's duration — so every applicant
 * to a 1-day or 2-day job automatically lost all 15 for a number they never
 * chose and were never shown. A real person applying to a one-day brief was
 * told their proposed 3 days "exceeds the brief's duration"; they had proposed
 * nothing at all.
 *
 * Defaulting to the brief's OWN duration is the honest reading of an applicant
 * who didn't specify: they are applying to the job as advertised, so they are
 * saying they can meet the deadline in it.
 */
async function defaultTimelineFor(escrowId: string): Promise<number> {
  const task = store.listTasks(300).find((t) => t.escrowId === escrowId);
  if (!task?.briefJson) return 3;
  try {
    const days = Number(JSON.parse(task.briefJson).durationDays);
    return Number.isFinite(days) && days > 0 ? days : 3;
  } catch {
    return 3;
  }
}

export async function apply(
  workerId: string,
  escrowId: string,
  coverLetter: string,
  /** Omit to say "I can do it in the time you asked for". */
  proposedTimelineDays: number | undefined,
  /**
   * A link to past work — portfolio, CV, Behance, a repo, anything.
   *
   * Testers asked for this: with only a text box, everyone sounds equally
   * confident and the only thing separating applicants is how well they write.
   * Someone with ten years of logos had no way to show it.
   *
   * A LINK rather than an upload, deliberately. Patron has no file storage, and
   * the obvious shortcut — accepting a Telegram upload and putting its URL
   * on-chain — would be a security hole: Telegram's file URLs embed the bot
   * token, so that would publish our credentials permanently on a public chain.
   * A link the applicant already controls is both safer and more durable.
   */
  portfolioUrl?: string,
): Promise<{ txHash: string }> {
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
  const letter = coverLetter.trim();
  if (!letter) throw new UserFacingError("Write a short note about why you're right for this one.");

  const portfolio = portfolioUrl?.trim();
  if (portfolio && !/^https?:\/\/\S+$/i.test(portfolio)) {
    throw new UserFacingError("That portfolio link doesn't look like a URL — it should start with http:// or https://");
  }

  // Check BEFORE spending their gas. The contract tracks this and would happily
  // record a second application: two rows on-chain for one person, gas paid
  // twice, and the scorer ranking someone against themselves.
  const signer = signerFor(worker);
  await ensureGas(worker);
  if (await secureflow.hasApplied(BigInt(escrowId), signer.address)) {
    throw new UserFacingError(
      "You've already applied to this one — the guild master has your application and will come back to you either way.",
    );
  }

  // Labelled rather than concatenated, so the scorer can tell the applicant's
  // own words from a link they provided, and so the link survives as something
  // readable on-chain and on SecureFlow's own interface.
  const full = portfolio ? `${letter}\n\nPast work: ${portfolio}` : letter;

  const timeline = proposedTimelineDays ?? (await defaultTimelineFor(escrowId));
  const txHash = await secureflow.applyToJob(BigInt(escrowId), full, BigInt(timeline), signer);
  return { txHash };
}

/**
 * Submit finished work for a milestone.
 *
 * `startWork` is called first and its failure swallowed on purpose: SecureFlow
 * requires the lifecycle step, but it reverts if the job is already in progress,
 * and a worker submitting their second milestone should not be shown a contract
 * error about a state transition that already happened.
 */
export async function submit(
  workerId: string,
  escrowId: string,
  description: string,
  /** Omit to send the next milestone that actually needs work — see resolveMilestone. */
  milestoneIndex?: number,
): Promise<{ txHash: string }> {
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
  const text = description.trim();
  if (!text) throw new UserFacingError("Describe what you're delivering, and include a link to the file.");

  /**
   * Are you actually the person hired for this job?
   *
   * SecureFlow answers this with Unauthorized(), which is correct and useless:
   * a freelancer typed /submit 61 for a job still open for applications that
   * they had never applied to, and got a raw viem stack trace — calldata,
   * gas estimation error, a link to the viem docs — after their gas had already
   * been spent. The contract was never going to accept it, and we knew that
   * before sending.
   *
   * So it is checked here, where the answer can be a sentence instead.
   */
  const wallet = worker.walletAddress?.toLowerCase();
  try {
    const escrow = (await secureflow.getEscrow(BigInt(escrowId))) as { beneficiary?: string };
    const hired = (escrow?.beneficiary ?? "").toLowerCase();
    const nobodyHired = !hired || /^0x0{40}$/.test(hired);
    if (nobodyHired) {
      throw new UserFacingError(
        `Nobody has been hired for commission ${escrowId} yet — it's still taking applications, so there's nothing to deliver. ` +
          `Apply with /jobs, and I'll message you if you get it.`,
      );
    }
    if (wallet && hired !== wallet) {
      throw new UserFacingError(
        `Commission ${escrowId} went to a different freelancer, so only they can deliver it. ` +
          `/mine shows the jobs that are actually yours.`,
      );
    }
  } catch (err) {
    // A UserFacingError above is the answer; a chain read failing is not, and
    // must not block a legitimate delivery.
    if (err instanceof UserFacingError) throw err;
  }

  const index = milestoneIndex ?? (await resolveMilestone(escrowId));

  const signer = signerFor(worker);
  await ensureGas(worker);
  try {
    await secureflow.startWork(BigInt(escrowId), signer);
  } catch {
    // already started — expected on every milestone after the first
  }
  const txHash = await secureflow.submitMilestone(BigInt(escrowId), BigInt(index), text, signer);
  return { txHash };
}

/**
 * Which milestone is a worker actually delivering?
 *
 * Both surfaces hard-coded 0. For the single-milestone jobs that make up almost
 * everything posted so far that was invisibly correct, and for anything staged
 * it was a dead end: milestone 0 gets approved, the worker sends stage two, it
 * goes to index 0 again, and the job can never reach the approved-milestone
 * count that marks it complete. Job #38 is a two-stage voiceover sitting open
 * right now, so this was a live trap rather than a hypothetical one.
 *
 * Resolved against the BRIEF's milestone count rather than the subgraph's list,
 * because the subgraph only indexes milestones that have been touched — a job
 * whose first stage was just approved comes back as a one-element list, and
 * "the next one" would be off the end of it.
 */
const MS_SUBMITTED = 1;
const MS_APPROVED = 2;

async function resolveMilestone(escrowId: string): Promise<number> {
  const task = store.listTasks(100).find((t) => t.escrowId === escrowId);
  let expected = 1;
  if (task?.briefJson) {
    try {
      const b = JSON.parse(task.briefJson);
      if (Array.isArray(b.milestones) && b.milestones.length > 0) expected = b.milestones.length;
    } catch {
      /* a malformed brief just means we assume one stage */
    }
  }
  if (expected === 1) return 0;

  try {
    const secureflow = await import("../web3/secureflow.js");
    const ms = (await secureflow.getMilestones(BigInt(escrowId))) as { status: number | bigint }[];
    const byIndex = new Map(ms.map((m, i) => [i, Number(m.status)]));
    for (let i = 0; i < expected; i++) {
      const status = byIndex.get(i) ?? 0; // never touched = still to do
      if (status !== MS_SUBMITTED && status !== MS_APPROVED) return i; // pending or sent back for revision
    }
    // Everything is either awaiting review or already approved. Re-sending the
    // last stage is the only sensible reading of "here is my work".
    return expected - 1;
  } catch {
    return 0; // cannot read the chain: assume the first stage, which is right for most jobs
  }
}

/**
 * Everything this person is involved in, and where it stands.
 *
 * Built from the decision log and task list rather than new bookkeeping — the
 * hire is already recorded there for the command center, so a worker's view of
 * their own jobs is a different reading of the same facts, not a second copy of
 * them that could drift.
 */
export type WorkState = "applied" | "hired" | "completed" | "disputed" | "lost";

export async function myWork(
  workerId: string,
): Promise<{ escrowId: string; title: string; budget: number; status: string; icon: string; state: WorkState }[]> {
  const worker = store.getWorker(workerId);
  if (!worker?.walletAddress) return [];
  const me = worker.walletAddress.toLowerCase();

  const hiredFor = new Set(
    store
      .listDecisions(300)
      .filter((d: { type?: string; target?: string }) => d.type === "applicant_accepted" && d.target?.toLowerCase() === me)
      .map((d: { task_id?: string }) => d.task_id),
  );

  // One chain read per job, run TOGETHER rather than one after another. As a
  // sequential loop this was up to 100 round trips before the first character of
  // output — several seconds of a bot that looks hung, growing every time anyone
  // posts a job. Nothing here depends on the previous answer, so nothing needed
  // to wait for it.
  const candidates = store.listTasks(100).filter((t) => t.escrowId && t.briefJson);
  const involvement = await Promise.all(
    candidates.map(async (t) => {
      if (hiredFor.has(t.escrowId as string)) return { hired: true, applied: true };
      try {
        return { hired: false, applied: await secureflow.hasApplied(BigInt(t.escrowId as string), worker.walletAddress as `0x${string}`) };
      } catch {
        return { hired: false, applied: false }; // a chain hiccup hides a row, never breaks the list
      }
    }),
  );

  const out: { escrowId: string; title: string; budget: number; status: string; icon: string; state: WorkState }[] = [];
  for (const [i, t] of candidates.entries()) {
    const { hired, applied } = involvement[i]!;
    if (!hired && !applied) continue;

    const brief = JSON.parse(t.briefJson as string);
    // `state` is what a surface should BRANCH on; `status` is a sentence for a
    // human. They were the same string, which meant the web page had to
    // pattern-match prose to decide whether to show a submit button — and that
    // prose told a web user to type a Telegram command.
    const state: WorkState = hired
      ? t.status === "completed"
        ? "completed"
        : t.status === "disputed"
          ? "disputed"
          : "hired"
      : t.status === "posted"
        ? "applied"
        : "lost";

    const presentation: Record<WorkState, [string, string]> = {
      completed: ["✅", "Finished and paid"],
      disputed: ["⚖️", "With a human arbiter"],
      hired: ["🔨", "You were hired — send your work"],
      applied: ["⏳", "Applied, waiting on the guild master"],
      lost: ["—", "Applied, but someone else was hired"],
    };
    const [icon, status] = presentation[state];

    out.push({ escrowId: t.escrowId as string, title: brief.title, budget: brief.budget, status, icon, state });
  }
  return out;
}

/**
 * Everything decided about one commission — who applied, what each scored, why.
 *
 * A tester wearing the client hat asked where they could see this. The answer
 * was "the public ledger", which was true and useless: nothing pointed them at
 * it. Transparency nobody can find isn't transparency.
 */
export function jobDetail(escrowId: string): {
  title: string;
  budget: number;
  status: string;
  criteria: string[];
  milestones: { description: string; amount: number }[];
  scores: { address: string; score: number; reasoning: string; hired: boolean; injection: boolean }[];
  outcome: string | null;
} | null {
  const task = store.listTasks(100).find((t) => t.escrowId === escrowId);
  if (!task?.briefJson) return null;
  const brief = JSON.parse(task.briefJson);
  const decisions = store.listDecisions(300).filter((d: { task_id?: string }) => d.task_id === escrowId);

  const hired = decisions.find((d: { type?: string }) => d.type === "applicant_accepted") as { target?: string } | undefined;
  const scores = decisions
    .filter((d: { type?: string }) => d.type === "application_scored")
    .map((d: { target?: string; score?: number; reasoning?: string }) => ({
      address: d.target ?? "",
      score: d.score ?? 0,
      reasoning: d.reasoning ?? "",
      hired: !!hired?.target && d.target?.toLowerCase() === hired.target.toLowerCase(),
      injection: (d.reasoning ?? "").includes("INJECTION"),
    }));

  const none = decisions.find((d: { type?: string }) => d.type === "no_suitable_applicant") as { reasoning?: string } | undefined;
  const outcome = hired?.target
    ? `Hired ${hired.target.slice(0, 10)}…`
    : none?.reasoning
      ? none.reasoning
      : task.status === "cancelled"
        ? "Deadline passed with no suitable applicant — the budget was returned in full."
        : null;

  return {
    title: brief.title,
    budget: brief.budget,
    status: task.status,
    criteria: brief.criteria ?? [],
    milestones: brief.milestones ?? [],
    scores,
    outcome,
  };
}

/** What they've earned. On Arc this is both their spendable balance and their gas. */
export async function balance(workerId: string): Promise<{ balance: string; address: string }> {
  const worker = store.getWorker(workerId);
  if (!worker?.walletAddress) throw new UserFacingError("Unknown worker.");
  return { balance: await workerBalance(worker.walletAddress as `0x${string}`), address: worker.walletAddress };
}

/**
 * Check an address before we send money to it.
 *
 * There was no validation anywhere on either surface, so a mistyped destination
 * went all the way down to viem and came back as an encoding error — on the one
 * path where the user is moving their own earnings and most deserves a sentence
 * they can act on. We cannot catch a typo that is still a VALID address; we can
 * catch every string that could never have been one, and refuse the burn address.
 */
function requireAddress(value: string | undefined, what: string): `0x${string}` {
  const v = (value ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(v)) {
    throw new UserFacingError(
      `That ${what} doesn't look like a wallet address — it should start with 0x and have 40 characters after it. Nothing was sent.`,
    );
  }
  if (/^0x0{40}$/.test(v)) {
    throw new UserFacingError(`That address is the burn address — anything sent there is gone forever. Nothing was sent.`);
  }
  return v as `0x${string}`;
}

/** The escape hatch. A withdrawal, not a key export — see workers/wallets.ts. */
export async function withdraw(workerId: string, destination: `0x${string}`, amountUsdc?: string) {
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
  if (worker.mode === "own") throw new UserFacingError("You're already using your own wallet — the money is in it.");
  if (!worker.walletAddress) throw new UserFacingError("No wallet on this account yet.");
  const to = requireAddress(destination, "destination address");
  if (amountUsdc !== undefined && !(Number(amountUsdc) > 0)) {
    throw new UserFacingError("The amount to withdraw has to be a positive number. Nothing was sent.");
  }
  return withdrawTo({ walletAddress: worker.walletAddress }, to, amountUsdc);
}

/** Graduation: keep the account, move to self-custody. Mode A is a ramp, not a trap. */
export async function switchToOwnWallet(workerId: string, addressInput: `0x${string}`) {
  const address = requireAddress(addressInput, "wallet address");
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
  if (worker.mode === "managed" && worker.walletAddress) {
    // Sweep what they've earned before switching, or it's stranded in a wallet
    // they've just stopped using.
    try {
      await withdrawTo({ walletAddress: worker.walletAddress }, address);
    } catch {
      // nothing to sweep, or nothing worth the gas — the switch still stands
    }
  }
  store.setWorkerOwnWallet(workerId, address);
  return store.getWorker(workerId)!;
}
