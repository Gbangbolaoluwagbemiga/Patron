// Circle Nanopayments — micro USDC payments for agent decision events
// Every AI decision emits an on-chain economic signal
// This makes every Claude API call a verifiable, paid action on Arc

export type NanopaymentReason =
  | "application_review"      // agent pays tiny fee per application reviewed
  | "brief_generation"        // agent pays tiny fee when brief is generated
  | "work_review"             // agent pays tiny fee per work submission reviewed
  | "decision_processing";    // catch-all for agent decisions

// Amounts in USDC micro-units (6 decimals)
export const NANOPAYMENT_AMOUNTS: Record<NanopaymentReason, string> = {
  application_review: "0.001",     // $0.001 per application reviewed
  brief_generation: "0.005",       // $0.005 per brief generated
  work_review: "0.002",            // $0.002 per milestone reviewed
  decision_processing: "0.0005",   // $0.0005 per decision
};

export interface NanopaymentConfig {
  recipientAddress: string;     // who receives the nano fee (agent treasury or burn)
  reason: NanopaymentReason;
  metadata?: string;            // optional decision ID for traceability
}

// TODO: Wire to Circle Nanopayments API in Week 2
// Each call to this creates an auditable on-chain trail of agent decisions
export async function emitNanopayment(config: NanopaymentConfig): Promise<string> {
  const amount = NANOPAYMENT_AMOUNTS[config.reason];
  console.log(`[Nanopayment] ${amount} USDC — ${config.reason} — ${config.metadata ?? ""}`);
  // Returns tx hash
  throw new Error("Nanopayments integration — implement in Week 2");
}
