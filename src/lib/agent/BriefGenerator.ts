import Anthropic from "@anthropic-ai/sdk";
import type { AcceptanceBrief } from "../web3/types";

const client = new Anthropic({ apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are Patron's Brief Generator.
Your job is to take a vague human instruction and convert it into a precise,
enforceable acceptance brief for a freelance job.

You must return a valid JSON object with this exact shape:
{
  "title": "short job title",
  "budget": <number in USDC>,
  "durationDays": <number>,
  "criteria": ["criterion 1", "criterion 2", ...],  // 5-8 specific, measurable items
  "deliverableFormat": "exact format description",
  "revisionRounds": <number, default 2>
}

Criteria must be specific and measurable — not vague.
Bad: "The logo should look good"
Good: "Logo must be delivered in SVG and PNG formats, minimum 1000x1000px"

Extract budget and duration from the instruction. If not stated, use reasonable defaults.`;

export async function generateBrief(instruction: string): Promise<AcceptanceBrief> {
  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Convert this instruction into an acceptance brief:\n\n"${instruction}"`,
      },
    ],
  });

  const text = message.content[0].type === "text" ? message.content[0].text : "";

  // Extract JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Brief generation failed — no JSON returned");

  const parsed = JSON.parse(jsonMatch[0]);

  // Hash the criteria for on-chain posting
  const criteriaJson = JSON.stringify(parsed.criteria);
  const encoder = new TextEncoder();
  const data = encoder.encode(criteriaJson);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const briefHash = "0x" + hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  return { ...parsed, briefHash };
}
