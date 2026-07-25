// AgentClient — the core orchestrator
// Human gives one instruction → AgentClient runs the full loop autonomously

import { generateBrief } from "./BriefGenerator";
import { pickBestApplicant } from "./ApplicationScorer";
import { reviewWork, buildRevisionRequest, shouldEscalateToHuman } from "./WorkReviewer";
import type { PatronTask, AcceptanceBrief, AgentDecision, Application } from "../web3/types";
import { graphQuery, isGraphConfigured } from "../graph/client";
import { GET_JOB_APPLICATIONS } from "../graph/queries";

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

export interface AgentEvent {
  type: AgentEventType;
  message: string;
  decision?: AgentDecision;
  timestamp: number;
}

export type AgentEventCallback = (event: AgentEvent) => void;

export class AgentClient {
  private agentWalletAddress: string;
  private onEvent: AgentEventCallback;
  private decisions: AgentDecision[] = [];

  constructor(agentWalletAddress: string, onEvent: AgentEventCallback) {
    this.agentWalletAddress = agentWalletAddress;
    this.onEvent = onEvent;
  }

  private emit(type: AgentEventType, message: string, decision?: AgentDecision) {
    this.onEvent({ type, message, decision, timestamp: Date.now() });
  }

  // ── STEP 1: Convert human instruction → Brief ────────────────────────────
  async processBrief(instruction: string): Promise<AcceptanceBrief> {
    this.emit("brief_generated", "Generating acceptance brief from your instruction...");
    const brief = await generateBrief(instruction);
    this.emit("brief_generated", `Brief generated: "${brief.title}" — ${brief.criteria.length} acceptance criteria`);
    return brief;
  }

  // ── STEP 2: Post job on SecureFlow ───────────────────────────────────────
  // Returns escrowId
  // Actual tx signing happens in the UI layer (connect agent wallet first)
  async postJob(brief: AcceptanceBrief, postJobFn: (brief: AcceptanceBrief) => Promise<string>): Promise<string> {
    this.emit("job_posted", "Posting job to SecureFlow escrow...");
    const escrowId = await postJobFn(brief);
    this.emit("job_posted", `Job posted on-chain. Escrow ID: ${escrowId}. Brief hash recorded.`);
    return escrowId;
  }

  // ── STEP 3: Poll for applications + auto-select best ─────────────────────
  async reviewApplications(escrowId: string, brief: AcceptanceBrief): Promise<Application | null> {
    if (!isGraphConfigured()) throw new Error("Subgraph not configured");

    this.emit("applications_fetched", "Fetching applications from subgraph...");

    const result = await graphQuery<{ escrow: { applications: any[] } }>(
      GET_JOB_APPLICATIONS,
      { escrowId }
    );

    const applications: Application[] = (result.escrow?.applications ?? []).map((a: any) => ({
      freelancerAddress: a.freelancer,
      coverLetter: a.coverLetter,
      proposedTimeline: Number(a.proposedTimeline),
      appliedAt: Number(a.appliedAt) * 1000,
      status: "pending" as const,
    }));

    this.emit("applications_fetched", `${applications.length} application(s) received. Scoring with Claude...`);

    const { winner, scores } = await pickBestApplicant(
      applications,
      brief,
      (decision) => {
        this.decisions.push(decision);
        this.emit("application_scored", `Scored ${decision.target?.slice(0, 8)}... — ${decision.score}/100`, decision);
      }
    );

    if (!winner) {
      this.emit("no_suitable_applicant", "No suitable applicant found (min score 70). Job remains open.");
      return null;
    }

    const winnerDecision: AgentDecision = {
      id: crypto.randomUUID(),
      taskId: escrowId,
      type: "applicant_accepted",
      reasoning: `Selected ${winner.freelancerAddress} as best applicant based on brief alignment and timeline.`,
      target: winner.freelancerAddress,
      timestamp: Date.now(),
    };
    this.decisions.push(winnerDecision);
    this.emit("applicant_accepted", `Selected ${winner.freelancerAddress.slice(0, 8)}... as the best applicant.`, winnerDecision);

    return winner;
  }

  // ── STEP 4: Review submitted milestone work ───────────────────────────────
  async reviewMilestone(
    submissionDescription: string,
    submissionLink: string,
    brief: AcceptanceBrief,
    milestoneDescription: string,
    revisionsUsed: number,
    approveWorkFn: () => Promise<void>,
    requestRevisionFn: (feedback: string) => Promise<void>,
    escalateToHumanFn: () => Promise<void>,
  ): Promise<void> {
    this.emit("work_submitted", "Work submitted. Reviewing against acceptance brief...");

    const review = await reviewWork(submissionDescription, submissionLink, brief, milestoneDescription);

    if (review.approved) {
      const decision: AgentDecision = {
        id: crypto.randomUUID(),
        taskId: "",
        type: "work_approved",
        reasoning: review.reasoning,
        timestamp: Date.now(),
      };
      this.decisions.push(decision);
      this.emit("work_approved", `Work approved (${review.score}/100). Releasing payment via Gateway...`, decision);
      await approveWorkFn();
      this.emit("payment_released", "Payment released. Task complete.");
      return;
    }

    // Rejection path — never final, always constructive
    const revisionsRemaining = brief.revisionRounds - revisionsUsed;

    if (shouldEscalateToHuman([review], brief.revisionRounds - revisionsUsed)) {
      const decision: AgentDecision = {
        id: crypto.randomUUID(),
        taskId: "",
        type: "escalated",
        reasoning: `After ${brief.revisionRounds} revision rounds, work still does not meet brief criteria. Escalating to human principal.`,
        timestamp: Date.now(),
      };
      this.decisions.push(decision);
      this.emit("escalated_to_human", "Max revisions reached. Escalating to human arbiter.", decision);
      await escalateToHumanFn();
      return;
    }

    const feedback = buildRevisionRequest(review, revisionsRemaining);
    const decision: AgentDecision = {
      id: crypto.randomUUID(),
      taskId: "",
      type: "work_rejected",
      reasoning: review.feedback,
      timestamp: Date.now(),
    };
    this.decisions.push(decision);
    this.emit("revision_requested", `Work scored ${review.score}/100. Revision requested (${revisionsRemaining} round(s) left).`, decision);
    await requestRevisionFn(feedback);
  }

  getDecisionLog(): AgentDecision[] {
    return [...this.decisions];
  }
}
