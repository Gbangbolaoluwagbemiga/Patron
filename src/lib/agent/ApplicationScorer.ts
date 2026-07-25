import Anthropic from "@anthropic-ai/sdk";
import type { Application, AcceptanceBrief, AgentDecision } from "../web3/types";

const client = new Anthropic({ apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY });

export interface ScoredApplication {
  application: Application;
  score: number;         // 0-100
  reasoning: string;
  recommendation: "accept" | "reject";
}

const SYSTEM_PROMPT = `You are Patron's Application Reviewer.
You score freelancer applications for a job against an acceptance brief.

For each application, return a JSON object:
{
  "score": <0-100>,
  "reasoning": "2-3 sentence explanation of the score",
  "recommendation": "accept" | "reject"
}

Scoring guidelines:
- 80-100: Strong match, clear capability, realistic timeline
- 60-79: Decent match, some concerns
- 40-59: Weak match, significant gaps
- 0-39: Poor match, reject immediately

Be strict. Only recommend accept for scores >= 70.
Be specific about WHY in your reasoning — reference the brief criteria.`;

export async function scoreApplication(
  application: Application,
  brief: AcceptanceBrief
): Promise<ScoredApplication> {
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `
Brief:
Title: ${brief.title}
Budget: $${brief.budget} USDC
Duration: ${brief.durationDays} days
Acceptance Criteria:
${brief.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}
Deliverable Format: ${brief.deliverableFormat}

Application:
Cover Letter: ${application.coverLetter}
Proposed Timeline: ${application.proposedTimeline} days
Freelancer: ${application.freelancerAddress}
        `.trim(),
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Scoring failed");

  const result = JSON.parse(jsonMatch[0]);

  return {
    application,
    score: result.score,
    reasoning: result.reasoning,
    recommendation: result.recommendation,
  };
}

export async function pickBestApplicant(
  applications: Application[],
  brief: AcceptanceBrief,
  onDecision?: (decision: AgentDecision) => void
): Promise<{ winner: Application | null; scores: ScoredApplication[] }> {
  const scores: ScoredApplication[] = [];

  for (const app of applications) {
    const scored = await scoreApplication(app, brief);
    scores.push(scored);

    onDecision?.({
      id: crypto.randomUUID(),
      taskId: "",
      type: "application_scored",
      reasoning: scored.reasoning,
      target: app.freelancerAddress,
      score: scored.score,
      timestamp: Date.now(),
    });
  }

  // Sort by score descending, pick top if score >= 70
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];

  if (!best || best.score < 70 || best.recommendation !== "accept") {
    return { winner: null, scores };
  }

  return { winner: best.application, scores };
}
