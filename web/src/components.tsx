import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { postInstruction, stageForEventType, type Stage, type WalletInfo } from "./api";
import type { AgentEvent, DecisionRow, PaymentRow, TaskRow } from "./types";

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

export function Treasury({ wallet }: { wallet: WalletInfo | null }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    if (!wallet) return;
    void navigator.clipboard.writeText(wallet.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="treasury">
      <div className="treasury-main">
        <div className="treasury-label">Patron's Treasury</div>
        <div className="treasury-balance">{wallet ? `$${parseFloat(wallet.balance).toFixed(2)}` : "…"}</div>
        <div className="treasury-sub">available to fund new jobs</div>
      </div>
      <div className="treasury-fund">
        <div className="treasury-fund-label">Fund it — send testnet USDC on Arc to:</div>
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
    </div>
  );
}

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

export function InjectionToasts({ decisions }: { decisions: DecisionRow[] }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const flagged = decisions.filter((d) => d.reasoning.includes("[PROMPT INJECTION DETECTED]") && !dismissed.has(d.id)).slice(0, 3);

  useEffect(() => {
    if (flagged.length === 0) return;
    const timers = flagged.map((d) =>
      setTimeout(() => setDismissed((prev) => new Set(prev).add(d.id)), 8000),
    );
    return () => timers.forEach(clearTimeout);
  }, [flagged.map((f) => f.id).join(",")]);

  return (
    <div className="toast-stack">
      <AnimatePresence>
        {flagged.map((d) => (
          <motion.div
            key={d.id}
            className="toast"
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
          >
            🚨 <b>Prompt injection blocked</b> — applicant scored near-zero and rejected automatically.
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
