export interface TaskRow {
  id: string;
  escrowId: string | null;
  instruction: string;
  clientType: "agent" | "human";
  status: string;
  briefJson: string | null;
  createdAt: number;
}

export interface DecisionRow {
  id: string;
  task_id: string;
  type: string;
  reasoning: string;
  target: string | null;
  score: number | null;
  timestamp: number;
}

export interface PaymentRow {
  id: string;
  direction: "in" | "out" | "escrow_lock" | "escrow_release";
  escrow_id: string | null;
  amount_usdc: string;
  counterparty: string | null;
  tx_hash: string | null;
  reason: string | null;
  timestamp: number;
}

export type AgentEventType =
  | "brief_generated"
  | "job_posted"
  | "applications_fetched"
  | "application_scored"
  | "applicant_accepted"
  | "no_suitable_applicant"
  | "portfolio_verified"
  | "work_submitted"
  | "work_approved"
  | "work_rejected"
  | "revision_requested"
  | "escalated_to_human"
  | "payment_released"
  | "task_completed"
  | "error";

export interface AgentDecision {
  id: string;
  taskId: string;
  type: string;
  reasoning: string;
  target?: string;
  score?: number;
  timestamp: number;
}

export interface AgentEvent {
  type: AgentEventType;
  message: string;
  decision?: AgentDecision;
  escrowId?: string;
  txHash?: string;
  timestamp: number;
}

export interface BriefMilestone {
  description: string;
  amount: number;
}

export interface TaskBrief {
  title: string;
  budget: number;
  durationDays: number;
  criteria: string[];
  deliverableFormat: string;
  revisionRounds: number;
  milestones: BriefMilestone[];
  briefHash: string;
}

/** task.briefJson is a raw string from SQLite — null until BriefGenerator has run. */
export function parseBrief(task: TaskRow): TaskBrief | null {
  if (!task.briefJson) return null;
  try {
    return JSON.parse(task.briefJson) as TaskBrief;
  } catch {
    return null;
  }
}

export type MilestoneState = "paid" | "in_review" | "pending";

/** No per-milestone status is tracked server-side — approximated from how many
 * escrow_release payments exist for this job (paid in order) plus whether work is
 * currently mid-review. Good enough to show progress; not a substitute for reading
 * the contract directly if exact per-milestone on-chain state is ever needed. */
export function milestoneStates(task: TaskRow, payments: PaymentRow[]): MilestoneState[] {
  const brief = parseBrief(task);
  if (!brief) return [];
  const paidCount = payments.filter((p) => p.escrow_id === task.escrowId && p.direction === "escrow_release").length;
  return brief.milestones.map((_, i) => {
    if (i < paidCount) return "paid";
    if (i === paidCount && task.status === "active") return "in_review";
    return "pending";
  });
}

export interface FreelancerStats {
  address: string;
  hires: number;
  completedJobs: number;
  totalEarnedUsdc: number;
  completionRate: number; // 0-100
  lastActiveAt: number;
}

/** No dedicated reputation table server-side — derived client-side from decisions
 * (who got hired for which escrow) + tasks (which of those escrows completed) +
 * payments (what actually got paid out). Real numbers from real history, not a
 * separate score anyone could drift out of sync with the underlying events. */
export function computeFreelancerStats(tasks: TaskRow[], decisions: DecisionRow[], payments: PaymentRow[]): FreelancerStats[] {
  const escrowToFreelancer = new Map<string, string>();
  const byAddress = new Map<string, { hires: Set<string>; earned: number; lastActive: number }>();

  for (const d of decisions) {
    if (d.type === "applicant_accepted" && d.target) {
      const addr = d.target.toLowerCase();
      escrowToFreelancer.set(d.task_id, addr);
      const entry = byAddress.get(addr) ?? { hires: new Set<string>(), earned: 0, lastActive: 0 };
      entry.hires.add(d.task_id);
      entry.lastActive = Math.max(entry.lastActive, d.timestamp);
      byAddress.set(addr, entry);
    }
  }

  for (const p of payments) {
    if (p.direction === "escrow_release" && p.escrow_id) {
      const addr = escrowToFreelancer.get(p.escrow_id);
      const entry = addr ? byAddress.get(addr) : undefined;
      if (entry) entry.earned += parseFloat(p.amount_usdc || "0");
    }
  }

  const taskByEscrow = new Map(tasks.filter((t) => t.escrowId).map((t) => [t.escrowId as string, t]));

  const stats: FreelancerStats[] = [];
  for (const [address, entry] of byAddress) {
    let completed = 0;
    for (const escrowId of entry.hires) {
      if (taskByEscrow.get(escrowId)?.status === "completed") completed++;
    }
    stats.push({
      address,
      hires: entry.hires.size,
      completedJobs: completed,
      totalEarnedUsdc: entry.earned,
      completionRate: entry.hires.size > 0 ? Math.round((completed / entry.hires.size) * 100) : 0,
      lastActiveAt: entry.lastActive,
    });
  }

  return stats.sort((a, b) => b.totalEarnedUsdc - a.totalEarnedUsdc || b.hires - a.hires);
}
