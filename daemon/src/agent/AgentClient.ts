// AgentClient — the guild master. Runs the full hire loop headlessly on the
// server: brief → escrow → applications → hire → review → pay. No browser
// involved; the React app only ever watches this over SSE.
//
// Two bugs fixed from the v1 (browser) prototype:
//   1. Escalation counter — `shouldEscalateToHuman` now receives the FULL review
//      history for a milestone (persisted in SQLite via store.appendReview) and
//      a FIXED max (brief.revisionRounds), instead of a single-element array and
//      a number that shrank every call (which meant it could never escalate).
//      History is persisted rather than held in memory because a daemon restart
//      mid-dispute would otherwise reset the rejection count to zero.
//   2. Application scoring is one comparative call across all applicants
//      (ApplicationScorer.pickBestApplicant), not N isolated calls with no
//      cross-applicant context and a bigger prompt-injection surface.

import { generateBrief } from "./BriefGenerator.js";
import { pickBestApplicant } from "./ApplicationScorer.js";
import { reviewWork, buildRevisionRequest, shouldEscalateToHuman, type WorkReviewResult } from "./WorkReviewer.js";
import type { AcceptanceBrief, AgentDecision, Application } from "../web3/types.js";
import { graphQuery, isGraphConfigured } from "../graph/client.js";
import { GET_JOB_APPLICATIONS, type GQLApplication } from "../graph/queries.js";
import * as secureflow from "../web3/secureflow.js";
import type { PatronGateway } from "../circle/gateway.js";
import { config } from "../config.js";
import * as store from "../store.js";
import { parseUnits } from "viem";

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

export interface AgentEvent {
  type: AgentEventType;
  message: string;
  decision?: AgentDecision;
  escrowId?: string;
  txHash?: string;
  /** USDC amount tied to this event (job budget on post, milestone amount on release) — surfaced in the payment feed. */
  amountUsdc?: string;
  /** Who Patron paid/was paid by — only set on payment-bearing events. */
  counterparty?: string;
  timestamp: number;
}

export type AgentEventCallback = (event: AgentEvent) => void;

export class AgentClient {
  private onEvent: AgentEventCallback;
  private decisions: AgentDecision[] = [];
  /** Lazily resolved — the daemon still boots without Circle configured; only this buy-side call needs it. */
  private getGateway?: () => PatronGateway;

  constructor(onEvent: AgentEventCallback, getGateway?: () => PatronGateway) {
    this.onEvent = onEvent;
    this.getGateway = getGateway;
  }

  private emit(type: AgentEventType, message: string, extra?: Partial<AgentEvent>) {
    this.onEvent({ type, message, timestamp: Date.now(), ...extra });
  }

  // ── STEP 1: instruction → brief → posted escrow ──────────────────────────
  async processInstruction(instruction: string): Promise<{ brief: AcceptanceBrief; escrowId: bigint }> {
    this.emit("brief_generated", "Generating acceptance brief from the client's instruction...");
    const { brief } = await generateBrief(instruction);
    this.emit(
      "brief_generated",
      `Brief generated: "${brief.title}" — ${brief.criteria.length} acceptance criteria, ${brief.milestones.length} milestone(s)`,
    );

    this.emit("job_posted", "Posting job to SecureFlow escrow on Arc...");
    const escrowId = await secureflow.createEscrow({
      totalAmount: parseUnits(brief.budget.toString(), 6),
      durationDays: BigInt(brief.durationDays),
      milestoneAmounts: brief.milestones.map((m) => parseUnits(m.amount.toString(), 6)),
      milestoneDescriptions: brief.milestones.map((m) => m.description),
      projectTitle: brief.title,
      // briefHash appended so the brief can't be silently altered after the escrow
      // is live, but as plain readable text — SecureFlow's own UI renders this field
      // raw for freelancers, and nothing downstream ever parses it back as JSON, so
      // JSON.stringify()-ing it just showed up as gibberish on a real, live-facing surface.
      projectDescription: `${instruction}\n\nCriteria hash (verifies the brief hasn't changed): ${brief.briefHash}`,
    });
    this.emit("job_posted", `Job posted on-chain. Escrow ID: ${escrowId}.`, {
      escrowId: escrowId.toString(),
      amountUsdc: brief.budget.toString(),
    });

    return { brief, escrowId };
  }

  // ── STEP 2: poll applications, comparative-score, hire ───────────────────
  async reviewApplications(escrowId: bigint, brief: AcceptanceBrief): Promise<Application | null> {
    if (!isGraphConfigured()) throw new Error("Subgraph not configured (GRAPH_URL)");

    this.emit("applications_fetched", "Fetching applications from subgraph...");
    const result = await graphQuery<{ escrow: { applications: GQLApplication[] } | null }>(GET_JOB_APPLICATIONS, {
      escrowId: escrowId.toString(),
    });

    const applications: Application[] = (result.escrow?.applications ?? []).map((a) => ({
      freelancerAddress: a.freelancer,
      coverLetter: a.coverLetter,
      proposedTimeline: Number(a.proposedTimeline),
      appliedAt: Number(a.timestamp) * 1000,
      status: "pending" as const,
    }));

    this.emit("applications_fetched", `${applications.length} application(s) received. Scoring comparatively...`);

    const { winner } = await pickBestApplicant(applications, brief, (decision) => {
      this.decisions.push({ ...decision, taskId: escrowId.toString() });
      this.emit("application_scored", `Scored ${decision.target?.slice(0, 8)}... — ${decision.score}/100`, {
        decision: { ...decision, taskId: escrowId.toString() },
        escrowId: escrowId.toString(),
      });
    });

    if (!winner) {
      this.emit("no_suitable_applicant", "No suitable applicant found (min score 70). Job remains open.", {
        escrowId: escrowId.toString(),
      });
      return null;
    }

    // Buy-side x402: pay a marketplace service to verify the leading applicant's
    // portfolio before committing to hire — real robot-to-robot payment, mid-decision.
    // Non-fatal: a verification-service outage shouldn't block hiring a real human.
    if (config.portfolioCheckUrl && this.getGateway) {
      try {
        const gateway = this.getGateway();
        const result = await gateway.pay<{ reputationScore: number; verified: boolean; summary: string }>(
          `${config.portfolioCheckUrl}/verify?address=${winner.freelancerAddress}`,
        );
        const verifyDecision: AgentDecision = {
          id: crypto.randomUUID(),
          taskId: escrowId.toString(),
          type: "portfolio_verified",
          reasoning: `Paid $${result.formattedAmount} to verify ${winner.freelancerAddress.slice(0, 8)}...'s track record: score ${result.data.reputationScore}/100 — ${result.data.summary}`,
          target: winner.freelancerAddress,
          score: result.data.reputationScore,
          timestamp: Date.now(),
        };
        this.decisions.push(verifyDecision);
        this.emit("portfolio_verified", verifyDecision.reasoning, {
          decision: verifyDecision,
          escrowId: escrowId.toString(),
          txHash: result.transaction,
          amountUsdc: result.formattedAmount,
          counterparty: "PortfolioCheck service",
        });
      } catch (err) {
        this.emit(
          "portfolio_verified",
          `Portfolio verification unavailable (${err instanceof Error ? err.message : String(err)}) — proceeding on application score alone.`,
          { escrowId: escrowId.toString() },
        );
      }
    }

    const txHash = await secureflow.acceptFreelancer(escrowId, winner.freelancerAddress as `0x${string}`);
    const winnerDecision: AgentDecision = {
      id: crypto.randomUUID(),
      taskId: escrowId.toString(),
      type: "applicant_accepted",
      reasoning: `Selected ${winner.freelancerAddress} as best applicant — highest comparative score meeting the brief's criteria.`,
      target: winner.freelancerAddress,
      timestamp: Date.now(),
    };
    this.decisions.push(winnerDecision);
    this.emit("applicant_accepted", `Hired ${winner.freelancerAddress.slice(0, 8)}...`, {
      decision: winnerDecision,
      escrowId: escrowId.toString(),
      txHash,
    });

    return winner;
  }

  // ── STEP 3: review submitted milestone work ───────────────────────────────
  async reviewMilestone(
    escrowId: bigint,
    milestoneIndex: bigint,
    submissionDescription: string,
    submissionLink: string,
    brief: AcceptanceBrief,
    milestoneDescription: string,
  ): Promise<void> {
    this.emit("work_submitted", "Work submitted. Reviewing against acceptance brief...", { escrowId: escrowId.toString() });

    const review = await reviewWork(submissionDescription, submissionLink, brief, milestoneDescription);

    // Persisted, not in-memory: a daemon restart used to wipe this Map and hand
    // the freelancer unlimited fresh revision rounds. Append first, then read
    // the whole history back, so `history` always includes this review.
    const eId = escrowId.toString();
    const mIdx = milestoneIndex.toString();
    store.appendReview(eId, mIdx, review);
    const history = store.listReviews<WorkReviewResult>(eId, mIdx);

    if (review.approved) {
      const decision: AgentDecision = {
        id: crypto.randomUUID(),
        taskId: escrowId.toString(),
        type: "work_approved",
        reasoning: review.reasoning,
        timestamp: Date.now(),
      };
      this.decisions.push(decision);
      this.emit("work_approved", `Work approved (${review.score}/100). Releasing payment on-chain...`, {
        decision,
        escrowId: escrowId.toString(),
      });

      const txHash = await secureflow.approveMilestone(escrowId, milestoneIndex);
      const milestoneAmount = brief.milestones[Number(milestoneIndex)]?.amount;
      this.emit("payment_released", "Payment released. Milestone complete.", {
        escrowId: escrowId.toString(),
        txHash,
        amountUsdc: milestoneAmount != null ? milestoneAmount.toString() : undefined,
      });
      store.clearReviews(eId, mIdx);
      return;
    }

    // Rejection path — never final, always constructive. Uses the FIXED
    // brief.revisionRounds against the FULL history for this milestone.
    if (shouldEscalateToHuman(history, brief.revisionRounds)) {
      const decision: AgentDecision = {
        id: crypto.randomUUID(),
        taskId: escrowId.toString(),
        type: "escalated",
        reasoning: `After ${brief.revisionRounds} revision round(s), work still does not meet brief criteria. Escalating to human arbiter via SecureFlow's dispute system.`,
        timestamp: Date.now(),
      };
      this.decisions.push(decision);
      const txHash = await secureflow.disputeMilestone(
        escrowId,
        milestoneIndex,
        `Patron AI: ${history.length} revision rounds exhausted, work still fails brief criteria.`,
      );
      this.emit("escalated_to_human", "Max revisions reached. Escalated to human arbiter.", {
        decision,
        escrowId: escrowId.toString(),
        txHash,
      });
      return;
    }

    const revisionsRemaining = brief.revisionRounds - history.filter((r) => !r.approved).length;
    const feedback = buildRevisionRequest(review, revisionsRemaining);
    const decision: AgentDecision = {
      id: crypto.randomUUID(),
      taskId: escrowId.toString(),
      type: "work_rejected",
      reasoning: review.feedback,
      timestamp: Date.now(),
    };
    this.decisions.push(decision);
    const txHash = await secureflow.rejectMilestone(escrowId, milestoneIndex, feedback);
    this.emit(
      "revision_requested",
      `Work scored ${review.score}/100. Revision requested (${revisionsRemaining} round(s) left).`,
      { decision, escrowId: escrowId.toString(), txHash },
    );
  }

  getDecisionLog(): AgentDecision[] {
    return [...this.decisions];
  }
}
