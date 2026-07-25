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
