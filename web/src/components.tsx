import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { postInstruction, stageForEventType, type Stage } from "./api";
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

export function PostQuest({ onPosted }: { onPosted: () => void }) {
  const [instruction, setInstruction] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "done">("idle");
  const [result, setResult] = useState<{ taskId: string; escrowId: string } | null>(null);
  const [error, setError] = useState("");

  async function submit() {
    if (!instruction.trim()) return;
    setStatus("loading");
    setError("");
    try {
      const res = await postInstruction(instruction.trim());
      setResult(res);
      setStatus("done");
      setInstruction("");
      onPosted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  return (
    <div className="post-quest">
      <div className="post-quest-label">Try it yourself — hire Patron right now</div>
      <div className="post-quest-row">
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder='e.g. "I need a logo for my coffee shop, budget $50, 3 days."'
          rows={2}
        />
        <button onClick={submit} disabled={status === "loading" || !instruction.trim()}>
          {status === "loading" ? "Posting…" : "Post Quest →"}
        </button>
      </div>
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
