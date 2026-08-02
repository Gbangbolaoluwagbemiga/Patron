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

  CREATE TABLE IF NOT EXISTS poller_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// ── One-time repairs ────────────────────────────────────────────────────────
// Guarded by a marker table so each runs exactly once per database, ever. The
// completed-task re-check in particular MUST NOT run on every boot: it would
// hand every finished job back to the poller on each restart and re-broadcast
// its completion, so the command center would replay old jobs finishing every
// time the daemon redeployed.
db.exec(`CREATE TABLE IF NOT EXISTS applied_repairs (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);`);

function repairOnce(name: string, run: () => void): void {
  const done = db.prepare(`SELECT 1 FROM applied_repairs WHERE name = ?`).get(name);
  if (done) return;
  run();
  db.prepare(`INSERT INTO applied_repairs (name, applied_at) VALUES (?, ?)`).run(name, Date.now());
}

// ── Repair of rows written by three now-fixed bugs ──────────────────────────
// Both fixes above stop BAD rows being written from here on, but a database
// that already has them (including the deployed one, which sits on a
// persistent volume and is never rebuilt) would keep showing them forever.
// Both WHERE clauses are deliberately narrow, and both log what they touched
// rather than repairing silently.
repairOnce("2026-08-remove-phantom-payments-and-stranded-tasks", () => {
  // 1. Payments that were never payments. The direction ternary used to fall
  //    through to "escrow_lock" for ANY event carrying a txHash, so accepting
  //    an applicant / requesting a revision / escalating a dispute all got
  //    filed as money movements — always with an empty amount, since no money
  //    moved. Real transactions, but not payments.
  const phantom = db
    .prepare(
      `DELETE FROM payments
        WHERE direction = 'escrow_lock'
          AND (amount_usdc IS NULL OR amount_usdc = '')
          AND reason NOT IN ('job_posted', 'payment_released', 'portfolio_verified', 'x402_hire_fee')`,
    )
    .run();
  if (phantom.changes) console.log(`[store] removed ${phantom.changes} phantom payment row(s) — see the payment-direction fix`);

  // 2. Jobs stranded mid-brief. runHireFlow inserted the row as "briefing"
  //    before calling the LLM and opening escrow; if either threw, nothing
  //    ever moved the row on. No escrow id means no commission was ever
  //    opened, so these are failures, and counting them as in-progress
  //    overstated the amount of live work.
  const stranded = db
    .prepare(`UPDATE tasks SET status = 'failed' WHERE status = 'briefing' AND escrow_id IS NULL AND created_at < ?`)
    .run(Date.now() - 10 * 60 * 1000);
  if (stranded.changes) console.log(`[store] marked ${stranded.changes} stranded briefing task(s) as failed`);

  // 3. Jobs marked complete on a partial payout. Completion was briefly derived
  //    from the milestone list the subgraph returns, but the subgraph only
  //    indexes milestones that have been interacted with — so a 3-milestone job
  //    with its first milestone approved came back as a one-element, all-approved
  //    list and was declared finished with two thirds of the budget unpaid.
  //    Rather than guess which rows are affected (that needs subgraph reads this
  //    module has no business making at import time), hand every completed job
  //    back to the poller: it re-derives completion against the brief's real
  //    milestone count on its next pass and re-marks the genuinely finished ones
  //    within a cycle.
  const recheck = db.prepare(`UPDATE tasks SET status = 'active' WHERE status = 'completed' AND escrow_id IS NOT NULL`).run();
  if (recheck.changes) console.log(`[store] re-queued ${recheck.changes} completed task(s) for completion re-check`);
});

repairOnce("2026-08-clear-stranded-scoring-markers", () => {
  // The poller used to write its "already scored N applicants" marker BEFORE
  // doing the scoring, so a job whose only attempt failed (a rate limit, a
  // timeout) kept a marker claiming work that never happened and was skipped
  // forever after. The ordering is fixed going forward, but a database that
  // already holds one of those markers stays stuck on its own.
  //
  // Narrow by construction: only jobs still sitting at 'posted' that have no
  // decision rows at all. A job with any decision was genuinely scored, and a
  // job past 'posted' has moved on regardless.
  const cleared = db
    .prepare(
      `DELETE FROM poller_state
        WHERE key LIKE 'scored_applications:%'
          AND SUBSTR(key, LENGTH('scored_applications:') + 1) IN (
            SELECT t.escrow_id FROM tasks t
             WHERE t.status = 'posted' AND t.escrow_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM decisions d WHERE d.task_id = t.escrow_id)
          )`,
    )
    .run();
  if (cleared.changes) console.log(`[store] cleared ${cleared.changes} stranded scoring marker(s) — those jobs will be scored on the next poll`);
});

repairOnce("2026-08-dedupe-rescored-decisions-v2", () => {
  // The poller's scored-applicant counter was in-memory, so each restart made it
  // re-score every open job. Escrow #31 held 27 rows for 3 applicants.
  //
  // Text-matching can't find these: the model reworded every re-score, so all 27
  // reasonings are byte-distinct while describing the same three verdicts. The
  // real key is (job, applicant) — an applicant is scored once per job, verified
  // once, and hired once.
  //
  // Scoped deliberately to those three types. work_approved / work_rejected /
  // escalated legitimately repeat for the same freelancer on the same job —
  // that IS the revision cycle — and must not be collapsed.
  // Grouped on rowid, not id: `decisions.id` is a random UUID, so MIN(id) would
  // pick the lexicographically smallest rather than the one written first.
  const dupes = db
    .prepare(
      `DELETE FROM decisions
        WHERE type IN ('application_scored', 'portfolio_verified', 'applicant_accepted')
          AND rowid NOT IN (
            SELECT MIN(rowid) FROM decisions
             WHERE type IN ('application_scored', 'portfolio_verified', 'applicant_accepted')
             GROUP BY task_id, type, COALESCE(target, '')
          )`,
    )
    .run();
  if (dupes.changes) console.log(`[store] removed ${dupes.changes} re-scored duplicate decision row(s)`);
});

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

// ── Poller state ────────────────────────────────────────────────────────────
// Small durable key/value for the background poller's dedup counters. These
// used to be in-memory Maps, which meant every daemon restart — including every
// Railway redeploy — made the poller forget what it had already done and score
// every open job's applicants again from scratch. Escrow #31 accumulated 27
// decision rows for 3 applicants, the same verdicts over and over, and each
// repeat was a real LLM call. Worse, a re-score can re-enter the hire path for
// a job that already has a freelancer.

export function getPollerInt(key: string): number | null {
  const row = db.prepare(`SELECT value FROM poller_state WHERE key = ?`).get(key) as { value: string } | undefined;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

export function setPollerInt(key: string, value: number): void {
  db.prepare(
    `INSERT INTO poller_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, String(value), Date.now());
}
