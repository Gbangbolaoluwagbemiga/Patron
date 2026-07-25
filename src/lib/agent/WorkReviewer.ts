import Anthropic from "@anthropic-ai/sdk";
import type { AcceptanceBrief, AgentDecision } from "../web3/types";

const client = new Anthropic({ apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY });

export interface WorkReviewResult {
  approved: boolean;
  score: number;           // 0-100
  reasoning: string;
  feedback: string;        // specific feedback if rejected — used in revision request
  criteriaResults: { criterion: string; passed: boolean; note: string }[];
}

const SYSTEM_PROMPT = `You are Patron's Work Reviewer.
You review submitted freelance work against the original acceptance brief.

Return a JSON object:
{
  "approved": true | false,
  "score": <0-100>,
  "reasoning": "overall assessment in 2-3 sentences",
  "feedback": "specific actionable feedback if not approved (empty string if approved)",
  "criteriaResults": [
    { "criterion": "criterion text", "passed": true|false, "note": "brief note" }
  ]
}

IMPORTANT: Only approve if ALL critical criteria are met (score >= 75).
If rejecting, your feedback must be specific and actionable — the freelancer
must know exactly what to fix. Vague feedback is not allowed.

Remember: rejection is NOT final. It triggers a revision round. Be constructive.`;

export async function reviewWork(
  submissionDescription: string,
  submissionLink: string,
  brief: AcceptanceBrief,
  milestoneDescription: string,
): Promise<WorkReviewResult> {
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `
Milestone: ${milestoneDescription}

Acceptance Criteria:
${brief.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}
Expected Format: ${brief.deliverableFormat}

Submitted Work:
Description: ${submissionDescription}
Link/Reference: ${submissionLink || "No link provided"}
        `.trim(),
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Work review failed");

  return JSON.parse(jsonMatch[0]);
}

export function buildRevisionRequest(
  review: WorkReviewResult,
  revisionsRemaining: number
): string {
  return `
Your submission has been reviewed by Patron AI.

Score: ${review.score}/100
Status: Revision Required (${revisionsRemaining} revision round${revisionsRemaining !== 1 ? "s" : ""} remaining)

${review.feedback}

Criteria breakdown:
${review.criteriaResults.map(r => `${r.passed ? "✓" : "✗"} ${r.criterion}${r.note ? ` — ${r.note}` : ""}`).join("\n")}

Please address the above and resubmit.
  `.trim();
}

export function shouldEscalateToHuman(
  reviewHistory: WorkReviewResult[],
  maxRevisions: number
): boolean {
  const rejections = reviewHistory.filter(r => !r.approved).length;
  return rejections >= maxRevisions;
}
