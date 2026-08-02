// store.ts — SQLite persistence for the daemon: tasks, decisions, and payments.
// Uses node:sqlite (built in, no native compile step — important since this
// daemon may get deployed to Railway/Fly under time pressure and a native
// better-sqlite3 build failing on a foreign platform is exactly the kind of
// thing that eats the last day before submission).
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DATA_DIR = path.join(process.cwd(), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "patron.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    escrow_id TEXT,
    instruction TEXT NOT NULL,
    client_type TEXT NOT NULL,
    status TEXT NOT NULL,
    brief_json TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    type TEXT NOT NULL,
    reasoning TEXT NOT NULL,
    target TEXT,
    score REAL,
    timestamp INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL,      -- 'in' (x402 commission) | 'out' (x402 buy) | 'escrow_lock' | 'escrow_release'
    escrow_id TEXT,
    amount_usdc TEXT NOT NULL,
    counterparty TEXT,
    tx_hash TEXT,
    reason TEXT,
    timestamp INTEGER NOT NULL
  );

  -- Every work review, per milestone, in order. This backs the escalation
  -- counter: shouldEscalateToHuman() needs the FULL rejection history for a
  -- milestone, and it used to live in an in-memory Map — so a daemon restart
  -- (or any Railway redeploy) silently reset someone's revision count to zero
  -- and handed them unlimited extra rounds. Persisted here so a redeploy
  -- mid-dispute can't quietly extend a revision cycle forever.
  CREATE TABLE IF NOT EXISTS review_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escrow_id TEXT NOT NULL,
    milestone_index TEXT NOT NULL,
    review_json TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS review_history_milestone
    ON review_history (escrow_id, milestone_index);
`);

export interface TaskRow {
  id: string;
  escrowId: string | null;
  instruction: string;
  clientType: "agent" | "human";
  status: string;
  briefJson: string | null;
  createdAt: number;
}

export function insertTask(task: Omit<TaskRow, "createdAt">): void {
  db.prepare(
    `INSERT INTO tasks (id, escrow_id, instruction, client_type, status, brief_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(task.id, task.escrowId, task.instruction, task.clientType, task.status, task.briefJson, Date.now());
}

export function updateTaskStatus(id: string, status: string, escrowId?: string): void {
  if (escrowId) {
    db.prepare(`UPDATE tasks SET status = ?, escrow_id = ? WHERE id = ?`).run(status, escrowId, id);
  } else {
    db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, id);
  }
}

export function updateTaskBrief(id: string, briefJson: string): void {
  db.prepare(`UPDATE tasks SET brief_json = ? WHERE id = ?`).run(briefJson, id);
}

export function listTasks(limit = 50): TaskRow[] {
  const rows = db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?`).all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    escrowId: r.escrow_id,
    instruction: r.instruction,
    clientType: r.client_type,
    status: r.status,
    briefJson: r.brief_json,
    createdAt: r.created_at,
  }));
}

export function recordDecision(d: {
  id: string;
  taskId: string;
  type: string;
  reasoning: string;
  target?: string;
  score?: number;
  timestamp: number;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO decisions (id, task_id, type, reasoning, target, score, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(d.id, d.taskId, d.type, d.reasoning, d.target ?? null, d.score ?? null, d.timestamp);
}

export function listDecisions(limit = 100): any[] {
  return db.prepare(`SELECT * FROM decisions ORDER BY timestamp DESC LIMIT ?`).all(limit);
}

export function recordPayment(p: {
  id: string;
  direction: "in" | "out" | "escrow_lock" | "escrow_release";
  escrowId?: string;
  amountUsdc: string;
  counterparty?: string;
  txHash?: string;
  reason?: string;
}): void {
  db.prepare(
    `INSERT INTO payments (id, direction, escrow_id, amount_usdc, counterparty, tx_hash, reason, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.id, p.direction, p.escrowId ?? null, p.amountUsdc, p.counterparty ?? null, p.txHash ?? null, p.reason ?? null, Date.now());
}

export function listPayments(limit = 100): any[] {
  return db.prepare(`SELECT * FROM payments ORDER BY timestamp DESC LIMIT ?`).all(limit);
}

// ── Review history (backs the escalation counter) ───────────────────────────
// Keyed by escrow + milestone. Stored as JSON because WorkReviewResult is the
// LLM's structured output and we want the whole thing back verbatim — the
// escalation decision reads `approved`, but the reasoning is what a human
// arbiter needs if it ever gets that far.

export function appendReview(escrowId: string, milestoneIndex: string, review: unknown): void {
  db.prepare(
    `INSERT INTO review_history (escrow_id, milestone_index, review_json, timestamp) VALUES (?, ?, ?, ?)`,
  ).run(escrowId, milestoneIndex, JSON.stringify(review), Date.now());
}

export function listReviews<T>(escrowId: string, milestoneIndex: string): T[] {
  const rows = db
    .prepare(`SELECT review_json FROM review_history WHERE escrow_id = ? AND milestone_index = ? ORDER BY id ASC`)
    .all(escrowId, milestoneIndex) as { review_json: string }[];
  return rows.map((r) => JSON.parse(r.review_json) as T);
}

/** Called once a milestone is approved — that cycle is closed, the next one starts fresh. */
export function clearReviews(escrowId: string, milestoneIndex: string): void {
  db.prepare(`DELETE FROM review_history WHERE escrow_id = ? AND milestone_index = ?`).run(escrowId, milestoneIndex);
}
