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
import { config } from "./config.js";
import { AgentClient, type AgentEvent } from "./agent/AgentClient.js";
import { createPatronGateway } from "./circle/gateway.js";
import { createPatronPaywall, ORDER_FEE_USDC } from "./circle/x402-seller.js";
import * as secureflow from "./web3/secureflow.js";
import { graphQuery, isGraphConfigured } from "./graph/client.js";
import { GET_JOB_BY_ID, type GQLEscrow } from "./graph/queries.js";
import * as store from "./store.js";

const PORT = config.port;

// ── SSE broadcast ──────────────────────────────────────────────────────────
const sseClients = new Set<http.ServerResponse>();
function broadcast(event: AgentEvent) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

const agent = new AgentClient((event) => {
  broadcast(event);
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
  if (event.txHash && event.escrowId) {
    const direction =
      event.type === "job_posted" ? "escrow_lock" : event.type === "payment_released" ? "escrow_release" : "escrow_lock";
    store.recordPayment({
      id: randomUUID(),
      direction,
      escrowId: event.escrowId,
      amountUsdc: "",
      txHash: event.txHash,
      reason: event.type,
    });
  }
});

// Patron's Gateway-backed treasury (MPC). Lazily created so the daemon still boots
// (and /api/tasks etc. still work) if Circle env vars aren't set yet — only x402
// routes need it.
let gatewayInstance: ReturnType<typeof createPatronGateway> | null = null;
function getGateway() {
  if (!gatewayInstance) gatewayInstance = createPatronGateway();
  return gatewayInstance;
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
async function runHireFlow(instruction: string, clientType: "agent" | "human") {
  const taskId = randomUUID();
  store.insertTask({ id: taskId, escrowId: null, instruction, clientType, status: "briefing", briefJson: null });

  const { brief, escrowId } = await agent.processInstruction(instruction);
  store.updateTaskBrief(taskId, JSON.stringify(brief));
  store.updateTaskStatus(taskId, "posted", escrowId.toString());

  return { taskId, escrowId: escrowId.toString(), brief };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

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

      const body = JSON.parse(await readBody(req)) as { instruction?: string };
      if (!body.instruction) return json(res, 400, { error: "instruction is required" });

      const result = await runHireFlow(body.instruction, "agent");
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ── Unguarded: the human front door (same pipeline, no x402 fee) ──
  if (req.method === "POST" && url.pathname === "/api/instruct") {
    try {
      const body = JSON.parse(await readBody(req)) as { instruction?: string };
      if (!body.instruction) return json(res, 400, { error: "instruction is required" });
      const result = await runHireFlow(body.instruction, "human");
      json(res, 200, result);
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ── REST for the command center ──
  if (req.method === "GET" && url.pathname === "/api/tasks") {
    return json(res, 200, store.listTasks());
  }
  if (req.method === "GET" && url.pathname === "/api/decisions") {
    return json(res, 200, store.listDecisions());
  }
  if (req.method === "GET" && url.pathname === "/api/payments") {
    return json(res, 200, store.listPayments());
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { ok: true });
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
const reviewedMilestones = new Set<string>();

async function pollOnce() {
  if (!isGraphConfigured()) return;
  const tasks = store.listTasks(50).filter((t) => t.escrowId && (t.status === "posted" || t.status === "active"));

  for (const task of tasks) {
    if (!task.escrowId || !task.briefJson) continue;
    const brief = JSON.parse(task.briefJson);
    const escrowId = BigInt(task.escrowId);

    try {
      if (task.status === "posted") {
        const winner = await agent.reviewApplications(escrowId, brief);
        if (winner) store.updateTaskStatus(task.id, "active", task.escrowId);
        continue;
      }

      if (task.status === "active") {
        const result = await graphQuery<{ escrow: GQLEscrow | null }>(GET_JOB_BY_ID, { escrowId: task.escrowId });
        const milestones = result.escrow?.milestones ?? [];
        for (const [index, m] of milestones.entries()) {
          const key = `${task.escrowId}:${index}`;
          if (m.status === 1 && !reviewedMilestones.has(key)) {
            reviewedMilestones.add(key);
            await agent.reviewMilestone(escrowId, BigInt(index), m.description, "", brief, m.description);
          }
        }
      }
    } catch (err) {
      console.error(`[poller] task ${task.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
}

setInterval(() => void pollOnce(), 15_000);
