import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, NavLink } from "react-router-dom";

const MotionLink = motion(Link);
import { ARC_EXPLORER, postInstruction, stageForEventType, type Stage, type WalletInfo } from "./api";
import { hasInjectedWallet, useWalletConnect } from "./wallet-connect";
import { milestoneStates, parseBrief, type AgentEvent, type DecisionRow, type MilestoneState, type PaymentRow, type TaskRow } from "./types";

const SECUREFLOW_JOBS_URL = "https://secureflow-arc.vercel.app/jobs";

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function shorten(addr: string | null | undefined): string {
  if (!addr) return "—";
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

export const cardMotion = {
  layout: true,
  initial: { opacity: 0, y: -12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { duration: 0.35, ease: "easeOut" as const },
};

// ── Nav ──────────────────────────────────────────────────────────────────────
export function Nav({ connected }: { connected: boolean }) {
  const links = [
    { to: "/", label: "Dashboard", end: true },
    { to: "/jobs", label: "Quest Board" },
    { to: "/decisions", label: "Decision Log" },
    { to: "/payments", label: "Payment Feed" },
  ];
  return (
    <div className="nav">
      <div className="nav-brand">
        <img src="/patron-logo.svg" alt="" className="logo" />
        <div>
          <div className="nav-title">PATRON</div>
          <div className="nav-subtitle">the human-labor endpoint of the agent economy</div>
        </div>
      </div>
      <div className="nav-links">
        {links.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
            {l.label}
          </NavLink>
        ))}
      </div>
      <div className="status">
        <span className={`dot ${connected ? "live" : ""}`} />
        {connected ? "Live" : "Disconnected"}
      </div>
    </div>
  );
}

// ── Pipeline ─────────────────────────────────────────────────────────────────
const STAGES: { key: Stage; icon: string; label: string }[] = [
  { key: "intake", icon: "📨", label: "Client Instructs" },
  { key: "brief", icon: "🧠", label: "Claude Writes Brief" },
  { key: "escrow", icon: "🔒", label: "Locked in Escrow" },
  { key: "applicants", icon: "⚔️", label: "Humans Apply" },
  { key: "review", icon: "🔍", label: "Work Reviewed" },
  { key: "payout", icon: "💰", label: "USDC Released" },
];

function highestStageIndex(tasks: TaskRow[], decisions: DecisionRow[], payments: PaymentRow[]): number {
  let idx = tasks.length > 0 ? 0 : -1;
  if (tasks.some((t) => t.briefJson)) idx = Math.max(idx, 1);
  if (tasks.some((t) => t.escrowId)) idx = Math.max(idx, 2);
  if (decisions.some((d) => ["application_scored", "applicant_accepted", "no_suitable_applicant"].includes(d.type)))
    idx = Math.max(idx, 3);
  if (decisions.some((d) => ["work_approved", "work_rejected", "revision_requested", "escalated_to_human", "escalated"].includes(d.type)))
    idx = Math.max(idx, 4);
  if (payments.some((p) => p.direction === "escrow_release")) idx = Math.max(idx, 5);
  return idx;
}

export function PipelineFlow({
  tasks,
  decisions,
  payments,
  lastEvent,
}: {
  tasks: TaskRow[];
  decisions: DecisionRow[];
  payments: PaymentRow[];
  lastEvent: AgentEvent | null;
}) {
  const [pulseKey, setPulseKey] = useState<Stage | null>(null);
  const reached = highestStageIndex(tasks, decisions, payments);

  useEffect(() => {
    if (!lastEvent) return;
    const stage = stageForEventType(lastEvent.type);
    if (!stage) return;
    setPulseKey(stage);
    const t = setTimeout(() => setPulseKey(null), 2600);
    return () => clearTimeout(t);
  }, [lastEvent]);

  return (
    <div className="flow">
      {STAGES.map((s, i) => (
        <div className="flow-stage" key={s.key}>
          <motion.div
            className={`flow-node ${i <= reached ? "lit" : ""} ${pulseKey === s.key ? "pulsing" : ""}`}
            animate={pulseKey === s.key ? { scale: [1, 1.12, 1] } : {}}
            transition={{ duration: 0.6 }}
          >
            <span className="flow-icon">{s.icon}</span>
          </motion.div>
          <div className={`flow-label ${i <= reached ? "lit" : ""}`}>{s.label}</div>
          {i < STAGES.length - 1 && <div className={`flow-line ${i < reached ? "lit" : ""}`} />}
        </div>
      ))}
    </div>
  );
}

// ── Stats ────────────────────────────────────────────────────────────────────
export function StatsBar({ tasks, payments }: { tasks: TaskRow[]; payments: PaymentRow[] }) {
  const totalJobs = tasks.length;
  const active = tasks.filter((t) => t.status === "posted" || t.status === "active" || t.status === "briefing").length;
  const completed = tasks.filter((t) => t.status === "completed").length;
  const released = payments
    .filter((p) => p.direction === "escrow_release" && p.amount_usdc)
    .reduce((sum, p) => sum + parseFloat(p.amount_usdc || "0"), 0);
  const completionRate = totalJobs > 0 ? Math.round((completed / totalJobs) * 100) : 0;

  const stats = [
    { label: "Quests Posted", value: totalJobs.toString() },
    { label: "Active", value: active.toString() },
    { label: "USDC Released", value: `$${released.toFixed(2)}` },
    { label: "Completion Rate", value: `${completionRate}%` },
  ];

  return (
    <div className="stats">
      {stats.map((s) => (
        <div className="stat" key={s.label}>
          <div className="stat-value">{s.value}</div>
          <div className="stat-label">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── Treasury (+ real wallet-connect funding) ─────────────────────────────────
export function Treasury({ wallet, onFunded }: { wallet: WalletInfo | null; onFunded: () => void }) {
  const [copied, setCopied] = useState(false);
  const [amount, setAmount] = useState("5");
  const [fundedTx, setFundedTx] = useState<string | null>(null);
  const { address, connecting, funding, error, connect, fund } = useWalletConnect();

  function copy() {
    if (!wallet) return;
    void navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  async function handleFund() {
    if (!wallet) return;
    setFundedTx(null);
    const hash = await fund(wallet.address, amount);
    if (hash) {
      setFundedTx(hash);
      onFunded();
    }
  }

  return (
    <div className="treasury">
      <div className="treasury-main">
        <div className="treasury-label">Patron's Treasury</div>
        <div className="treasury-balance">{wallet ? `$${parseFloat(wallet.balance).toFixed(2)}` : "…"}</div>
        <div className="treasury-sub">available to fund new jobs</div>
      </div>

      <div className="treasury-fund">
        <div className="treasury-fund-label">Fund it</div>
        <div className="treasury-address-row">
          <code className="treasury-address">{wallet ? wallet.address : "…"}</code>
          <button className="treasury-copy" onClick={copy} disabled={!wallet}>
            {copied ? "Copied ✓" : "Copy"}
          </button>
        </div>
        {wallet && (
          <a className="tx-link" href={wallet.explorerUrl} target="_blank" rel="noreferrer">
            view balance & history on Arcscan ↗
          </a>
        )}
      </div>

      <div className="treasury-connect">
        {!hasInjectedWallet() ? (
          <div className="treasury-fund-label">No browser wallet detected — send funds to the address instead.</div>
        ) : !address ? (
          <button className="treasury-connect-btn" onClick={connect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        ) : (
          <>
            <div className="treasury-fund-label">Connected: {shorten(address)}</div>
            <div className="treasury-fund-row">
              <input type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <button className="treasury-connect-btn" onClick={handleFund} disabled={funding || !wallet}>
                {funding ? "Sending…" : `Fund $${amount}`}
              </button>
            </div>
          </>
        )}
        {error && <div className="post-quest-msg error">⚠ {error}</div>}
        {fundedTx && <div className="post-quest-msg ok">✓ Sent — tx {shorten(fundedTx)}</div>}
      </div>
    </div>
  );
}

// ── Post a quest ─────────────────────────────────────────────────────────────
export function PostQuest({ onPosted, wallet }: { onPosted: () => void; wallet: WalletInfo | null }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [budget, setBudget] = useState("");
  const [days, setDays] = useState("3");
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "done">("idle");
  const [result, setResult] = useState<{ taskId: string; escrowId: string } | null>(null);
  const [error, setError] = useState("");

  const available = wallet ? parseFloat(wallet.balance) : null;
  const overBudget = available != null && budget !== "" && parseFloat(budget) > available;
  const canSubmit = description.trim() !== "" && budget !== "" && parseFloat(budget) > 0 && days !== "" && status !== "loading";

  async function submit() {
    if (!canSubmit) return;
    setStatus("loading");
    setError("");
    const instruction = `${title.trim() ? title.trim() + " — " : ""}${description.trim()}. Budget $${budget}, ${days} day(s).`;
    try {
      const res = await postInstruction(instruction);
      setResult(res);
      setStatus("done");
      setTitle("");
      setDescription("");
      setBudget("");
      setDays("3");
      onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  return (
    <div className="post-quest">
      <div className="post-quest-label">Try it yourself — hire Patron right now</div>

      <input
        className="post-quest-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Job title (optional) — e.g. Coffee shop logo"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What do you need? Be specific — this becomes the acceptance brief."
        rows={2}
      />

      <div className="post-quest-fields">
        <label className="post-quest-field">
          <span>Budget (USDC)</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            placeholder="50"
          />
        </label>
        <label className="post-quest-field">
          <span>Duration (days)</span>
          <input type="number" min="1" step="1" value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <button onClick={submit} disabled={!canSubmit}>
          {status === "loading" ? "Posting…" : "Post Quest →"}
        </button>
      </div>

      {overBudget && (
        <div className="post-quest-msg warn">
          ⚠ Patron only has ${available?.toFixed(2)} available — this will likely fail. Fund the treasury below first, or lower the budget.
        </div>
      )}
      {status === "error" && <div className="post-quest-msg error">⚠ {error}</div>}
      {status === "done" && result && (
        <div className="post-quest-msg ok">
          ✓ Posted — escrow #{result.escrowId}. Watch it flow through the panels below.
        </div>
      )}
    </div>
  );
}

// ── Live notification center (every event type, not just injection) ─────────
const EVENT_ICON: Record<string, string> = {
  brief_generated: "🧠",
  job_posted: "🔒",
  applications_fetched: "📨",
  application_scored: "⚔️",
  applicant_accepted: "🤝",
  no_suitable_applicant: "🤷",
  work_submitted: "📤",
  work_approved: "✅",
  work_rejected: "✍️",
  revision_requested: "✍️",
  escalated_to_human: "🧑‍⚖️",
  payment_released: "💰",
  task_completed: "🏁",
};

export function NotificationCenter({ liveEvents }: { liveEvents: AgentEvent[] }) {
  const [visible, setVisible] = useState<(AgentEvent & { key: string })[]>([]);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    const fresh = liveEvents[0];
    if (!fresh) return;
    const key = `${fresh.type}-${fresh.timestamp}`;
    if (seen.current.has(key)) return;
    seen.current.add(key);
    setVisible((prev) => [{ ...fresh, key }, ...prev].slice(0, 4));
    const t = setTimeout(() => setVisible((prev) => prev.filter((e) => e.key !== key)), 6000);
    return () => clearTimeout(t);
  }, [liveEvents[0]]);

  const isInjection = (e: AgentEvent) => e.decision?.reasoning?.includes("[PROMPT INJECTION DETECTED]");

  return (
    <div className="toast-stack">
      <AnimatePresence>
        {visible.map((e) => (
          <motion.div
            key={e.key}
            className={`toast ${isInjection(e) ? "toast-alert" : "toast-info"}`}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
          >
            {isInjection(e) ? (
              <>🚨 <b>Prompt injection blocked</b> — applicant scored near-zero and rejected automatically.</>
            ) : (
              <>
                {EVENT_ICON[e.type] ?? "•"} {e.message}
              </>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ── Shared cards ─────────────────────────────────────────────────────────────
export function TaskCard({ task, linkToDetail = true }: { task: TaskRow; linkToDetail?: boolean }) {
  const brief = parseBrief(task);
  const inner = (
    <>
      <div className="card-row">
        <span className={`badge ${task.clientType}`}>{task.clientType === "agent" ? "AI Agent" : "Human"}</span>
        <span className={`badge status-${task.status}`}>{task.status}</span>
      </div>
      <div className="card-title">{brief?.title ?? task.instruction}</div>
      {brief && (
        <div className="card-milestones-preview">
          {brief.milestones.length} milestone{brief.milestones.length !== 1 ? "s" : ""} · ${brief.budget} total
        </div>
      )}
      <div className="card-row" style={{ marginTop: 8, marginBottom: 0 }}>
        <span>{timeAgo(task.createdAt)}</span>
        {task.escrowId && <span className="tx-link">escrow #{task.escrowId} →</span>}
      </div>
    </>
  );
  return linkToDetail && task.escrowId ? (
    <MotionLink className="card card-link" to={`/jobs/${task.escrowId}`} {...cardMotion}>
      {inner}
    </MotionLink>
  ) : (
    <motion.div className="card" {...cardMotion}>
      {inner}
    </motion.div>
  );
}

export function DecisionCard({ decision }: { decision: DecisionRow }) {
  const isInjection = decision.reasoning.includes("[PROMPT INJECTION DETECTED]");
  return (
    <motion.div className={`card ${isInjection ? "card-alert" : ""}`} {...cardMotion}>
      <div className="card-row">
        <span className="badge">{decision.type.replace(/_/g, " ")}</span>
        {decision.score != null && <span className="amount">{decision.score}/100</span>}
      </div>
      <div className={`card-reasoning ${isInjection ? "injection" : ""}`}>{decision.reasoning}</div>
      {decision.target && (
        <div className="card-row" style={{ marginTop: 6, marginBottom: 0 }}>
          {shorten(decision.target)}
        </div>
      )}
    </motion.div>
  );
}

export function PaymentCard({ payment }: { payment: PaymentRow }) {
  const label: Record<PaymentRow["direction"], string> = {
    in: "Robot → Patron",
    out: "Patron → Service",
    escrow_lock: "Locked in Escrow",
    escrow_release: "Escrow → Human",
  };
  return (
    <motion.div className="card" {...cardMotion}>
      <div className="card-row">
        <span className={`badge direction-${payment.direction}`}>{label[payment.direction]}</span>
        <span className="amount">{payment.amount_usdc ? `$${payment.amount_usdc}` : ""}</span>
      </div>
      <div className="card-row" style={{ marginBottom: 0 }}>
        <span>{timeAgo(payment.timestamp)}</span>
        {payment.tx_hash && (
          <a className="tx-link" href={`${ARC_EXPLORER}/tx/${payment.tx_hash}`} target="_blank" rel="noreferrer">
            view tx ↗
          </a>
        )}
      </div>
    </motion.div>
  );
}

const MILESTONE_LABEL: Record<MilestoneState, string> = {
  paid: "✓ Paid",
  in_review: "◐ In review",
  pending: "○ Pending",
};

export function MilestoneList({ task, payments }: { task: TaskRow; payments: PaymentRow[] }) {
  const brief = parseBrief(task);
  if (!brief) return <div className="empty">No brief yet.</div>;
  const states = milestoneStates(task, payments);

  return (
    <div className="milestones">
      {brief.milestones.map((m, i) => (
        <div className={`milestone milestone-${states[i]}`} key={i}>
          <div className="milestone-index">{i + 1}</div>
          <div className="milestone-body">
            <div className="milestone-desc">{m.description}</div>
            <div className="milestone-meta">
              <span className="amount">${m.amount}</span>
              <span className={`milestone-state milestone-state-${states[i]}`}>{MILESTONE_LABEL[states[i]]}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export { SECUREFLOW_JOBS_URL };
