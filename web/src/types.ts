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
