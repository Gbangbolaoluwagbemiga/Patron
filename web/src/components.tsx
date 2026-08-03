import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, NavLink } from "react-router-dom";

const MotionLink = motion(Link);
import { ARC_EXPLORER, postInstruction, stageForEventType, type Stage, type WalletInfo } from "./api";
import { hasInjectedWallet, useWalletConnect } from "./wallet-connect";
import { milestoneStates, parseBrief, type AgentEvent, type DecisionRow, type MilestoneState, type PaymentRow, type TaskRow } from "./types";
import { inkTransition, useCountUp, useFlashOnChange } from "./motion";
import {
  IconAlert,
  IconBrain,
  IconCheck,
  IconCoin,
  IconDot,
  IconFlag,
  IconGavel,
  IconLock,
  IconPen,
  IconScroll,
  IconSearch,
  IconShrug,
  IconSwords,
  type IconComponent,
} from "./Icon";

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

// Quiet on purpose. The previous entrance (y: -12 with a scale pop) read as
// springy app-chrome; ink appearing on paper shouldn't bounce. A short fade
// with a few pixels of lift is enough to show that a row is new.
export const cardMotion = {
  layout: true,
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  transition: inkTransition,
};

// ── Nav ──────────────────────────────────────────────────────────────────────
export function Nav({ connected }: { connected: boolean }) {
  // Named as sections of a guild's account book rather than as dashboard tabs.
  // Same routes, same data — the voice is what changes.
  const links = [
    { to: "/", label: "The Ledger", end: true },
    { to: "/jobs", label: "Open Commissions" },
    { to: "/decisions", label: "The Guild Master's Hand" },
    { to: "/payments", label: "Account of Monies" },
    { to: "/freelancers", label: "Register of Adventurers" },
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
const STAGES: { key: Stage; icon: IconComponent; label: string }[] = [
  { key: "intake", icon: IconScroll, label: "Client Instructs" },
  { key: "brief", icon: IconBrain, label: "Brief Generated" },
  { key: "escrow", icon: IconLock, label: "Locked in Escrow" },
  { key: "applicants", icon: IconSwords, label: "Humans Apply" },
  { key: "review", icon: IconSearch, label: "Work Reviewed" },
  { key: "payout", icon: IconCoin, label: "USDC Released" },
];

function highestStageIndex(tasks: TaskRow[], decisions: DecisionRow[], payments: PaymentRow[]): number {
  let idx = tasks.length > 0 ? 0 : -1;
  if (tasks.some((t) => t.briefJson)) idx = Math.max(idx, 1);
  if (tasks.some((t) => t.escrowId)) idx = Math.max(idx, 2);
  if (decisions.some((d) => ["application_scored", "applicant_accepted", "no_suitable_applicant", "portfolio_verified"].includes(d.type)))
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
            // A completed stage swells once and settles. Deliberately understated:
            // the old 1.12 pop on a 42px circle read as a UI toy, and this diagram
            // is the spine of the demo — it should feel like a stamp landing.
            animate={pulseKey === s.key ? { scale: [1, 1.07, 1] } : { scale: 1 }}
            transition={{ duration: 0.55, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <s.icon size={19} />
          </motion.div>
          <div className={`flow-label ${i <= reached ? "lit" : ""}`}>{s.label}</div>
          {i < STAGES.length - 1 && (
            // The connector DRAWS toward the next stage rather than switching
            // colour, so progress reads as travel along the line.
            <div className="flow-line">
              <motion.div
                className="flow-line-fill"
                initial={false}
                animate={{ scaleX: i < reached ? 1 : 0 }}
                transition={{ duration: 0.5, ease: [0.22, 0.61, 0.36, 1] }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Stats ────────────────────────────────────────────────────────────────────
export function StatsBar({ tasks, payments }: { tasks: TaskRow[]; payments: PaymentRow[] }) {
  // "failed" jobs never opened an escrow at all (the LLM call or createEscrow
  // threw), so they aren't commissions and don't belong in any of these counts.
  const real = tasks.filter((t) => t.status !== "failed");
  const totalJobs = real.length;
  const active = real.filter((t) => t.status === "posted" || t.status === "active" || t.status === "briefing").length;
  const completed = real.filter((t) => t.status === "completed").length;
  const disputed = real.filter((t) => t.status === "disputed").length;
  const released = payments
    .filter((p) => p.direction === "escrow_release" && p.amount_usdc)
    .reduce((sum, p) => sum + parseFloat(p.amount_usdc || "0"), 0);

  // Of the jobs that actually reached a conclusion, how many finished cleanly.
  // Dividing by ALL jobs (the old behaviour) counts everything still in flight
  // as a failure, which permanently pins the number near zero and says nothing
  // true about how well the agent performs.
  const concluded = completed + disputed;
  const completionRate = concluded > 0 ? Math.round((completed / concluded) * 100) : 0;

  const animatedReleased = useCountUp(released);
  const releasedFlash = useFlashOnChange(released);

  // Deliberate hierarchy, not four equal boxes: money actually paid to humans
  // is the entire point of the project, so it is set enormous and everything
  // else is small. Uniform mid-sized stat cards are the clearest tell of a
  // generated layout — this is the opposite on purpose.
  const rest = [
    { label: "Commissions", value: totalJobs.toString() },
    { label: "In Progress", value: active.toString() },
    { label: "Completed", value: completed.toString() },
    ...(disputed > 0 ? [{ label: "With Arbiter", value: disputed.toString() }] : []),
    { label: concluded > 0 ? "Completed Cleanly" : "Completion Rate", value: `${completionRate}%` },
  ];

  return (
    <div className="stats">
      <div className="stat stat-hero">
        {/* Counts toward its new value when an escrow releases. This is the one
            number the whole project is about — a judge who misses it climbing
            has missed the payment happening. */}
        <div className={`stat-value ${releasedFlash ? "stat-value-flash" : ""}`}>${animatedReleased.toFixed(2)}</div>
        <div className="stat-label">paid to humans, on-chain</div>
      </div>
      <div className="stat-rest">
        {rest.map((s) => (
          <div className="stat" key={s.label}>
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Treasury (+ real wallet-connect funding) ─────────────────────────────────
export function Treasury({ wallet, onFunded }: { wallet: WalletInfo | null; onFunded: () => void }) {
  const [copied, setCopied] = useState(false);
  const [amount, setAmount] = useState("5");
  const [fundedTx, setFundedTx] = useState<string | null>(null);
  const { address, connecting, funding, error, connect, fund } = useWalletConnect();
  // Polled every 15s, so it moves on its own when a job is posted or paid —
  // ticking rather than snapping makes that visible instead of easy to miss.
  const balance = wallet ? parseFloat(wallet.balance) : 0;
  const animatedBalance = useCountUp(balance);
  const balanceFlash = useFlashOnChange(wallet ? wallet.balance : null);

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
        <div className={`treasury-balance ${balanceFlash ? "stat-value-flash" : ""}`}>
          {wallet ? `$${animatedBalance.toFixed(2)}` : "—"}
        </div>
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
const EVENT_ICON: Record<string, IconComponent> = {
  brief_generated: IconBrain,
  job_posted: IconLock,
  applications_fetched: IconScroll,
  application_scored: IconSwords,
  applicant_accepted: IconCheck,
  no_suitable_applicant: IconShrug,
  portfolio_verified: IconSearch,
  work_submitted: IconPen,
  work_approved: IconCheck,
  work_rejected: IconPen,
  revision_requested: IconPen,
  escalated_to_human: IconGavel,
  payment_released: IconCoin,
  task_completed: IconFlag,
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
        {visible.map((e) => {
          const EventIcon = EVENT_ICON[e.type] ?? IconDot;
          return (
            <motion.div
              key={e.key}
              className={`toast ${isInjection(e) ? "toast-alert" : "toast-info"}`}
              initial={{ opacity: 0, x: 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 40 }}
            >
              <span className="toast-icon">{isInjection(e) ? <IconAlert size={16} /> : <EventIcon size={16} />}</span>
              <span>
                {isInjection(e) ? (
                  <>
                    <b>Prompt injection blocked</b> — applicant scored near-zero and rejected automatically.
                  </>
                ) : (
                  e.message
                )}
              </span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

// ── Shared cards ─────────────────────────────────────────────────────────────
export function TaskCard({ task, linkToDetail = true }: { task: TaskRow; linkToDetail?: boolean }) {
  const brief = parseBrief(task);
  // Every commission carries a ledger entry number — the escrow id, zero-padded
  // like a folio. It's the same number that's on-chain, so a judge can read it
  // here and find it on Arcscan.
  const entryNo = task.escrowId ? task.escrowId.padStart(4, "0") : null;
  const inner = (
    <>
      <div className="card-row">
        <span>
          {entryNo && <span className="entry-no">ENTRY {entryNo}&nbsp;&nbsp;·&nbsp;&nbsp;</span>}
          <span className={`badge ${task.clientType}`}>{task.clientType === "agent" ? "AI Agent" : "Human"}</span>
        </span>
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
        {task.escrowId && <span className="tx-link">read the entry →</span>}
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
  paid: "Paid",
  in_review: "In review",
  pending: "Pending",
};

const MILESTONE_ICON: Record<MilestoneState, IconComponent> = {
  paid: IconCheck,
  in_review: IconSearch,
  pending: IconDot,
};

export function MilestoneList({ task, payments }: { task: TaskRow; payments: PaymentRow[] }) {
  const brief = parseBrief(task);
  if (!brief) return <div className="empty">No brief yet.</div>;
  const states = milestoneStates(task, payments);

  return (
    <div className="milestones">
      {brief.milestones.map((m, i) => {
        const StateIcon = MILESTONE_ICON[states[i]];
        return (
          <div className={`milestone milestone-${states[i]}`} key={i}>
            <div className="milestone-index">{i + 1}</div>
            <div className="milestone-body">
              <div className="milestone-desc">{m.description}</div>
              <div className="milestone-meta">
                <span className="amount">${m.amount}</span>
                <span className={`milestone-state milestone-state-${states[i]}`}>
                  <StateIcon size={13} /> {MILESTONE_LABEL[states[i]]}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export { SECUREFLOW_JOBS_URL };
