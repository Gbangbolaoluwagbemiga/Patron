// structured.ts — Groq stand-in for Anthropic's `client.messages.parse()` +
// `zodOutputFormat`. Groq's `response_format: { type: "json_object" }` only
// guarantees syntactically valid JSON, not adherence to a shape — so unlike the
// Anthropic path, we describe the target schema in the prompt ourselves (via
// zod v4's built-in `z.toJSONSchema`) and validate the response with the same
// zod schema on the way back out. Swap agent/* back to Anthropic by pointing
// each `groqStructured(...)` call back at `client.messages.parse(...)` once the
// Anthropic account has a credit balance again — the zod schemas don't change.
import Groq from "groq-sdk";
import { z } from "zod";
import { config } from "../config.js";

const groq = new Groq({ apiKey: config.groqApiKey });

export interface GroqStructuredOpts<T> {
  model?: string;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  temperature?: number;
  /**
   * Optional shape-fixer applied to the parsed JSON before validation, for
   * variations that carry the right data in the wrong place (a bare array, an
   * aliased key). Kept separate from `schema` so the JSON schema advertised in
   * the prompt stays the strict, canonical one.
   */
  normalize?: (raw: unknown) => unknown;
}

export async function groqStructured<T>(opts: GroqStructuredOpts<T>): Promise<T> {
  const schemaJson = JSON.stringify(z.toJSONSchema(opts.schema));
  const system = `${opts.system}\n\nRespond with ONLY a single JSON object — no markdown fences, no prose before or after — matching exactly this JSON schema:\n${schemaJson}`;

  const models = [...new Set([opts.model ?? config.groqModel, config.groqFallbackModel].filter(Boolean))];
  let lastErr: unknown;
  // Tracked separately so the FINAL error names the real cause. When the primary
  // model is rate-limited the request silently falls through to the weaker
  // fallback, which then fails schema validation — and the only error anyone
  // ever saw was "output failed schema validation". That sends you debugging a
  // schema when the actual problem is an exhausted daily token budget. This is
  // not hypothetical: it took hiring down and read as a schema bug throughout.
  const rateLimited: string[] = [];

  // Two attempts per model before falling through to the next one. A schema
  // violation is a STOCHASTIC failure — the same model given the same prompt
  // usually complies on a second pass — so the old behaviour of abandoning a
  // model after a single malformed response threw away good attempts and, when
  // both models happened to miss, killed a whole scoring pass. On the retry we
  // hand the model its own validation error so it can correct the specific
  // field rather than re-rolling blind.
  for (const model of models) {
    let correction = "";

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const completion = await groq.chat.completions.create({
          model,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.4,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: correction ? `${opts.user}\n\n${correction}` : opts.user },
          ],
        });

        const choice = completion.choices[0];
        const raw = choice?.message?.content;
        if (!raw) throw new Error(`Groq (${model}) returned no content (finish_reason: ${choice?.finish_reason})`);

        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new Error(`Groq (${model}) returned invalid JSON: ${raw.slice(0, 300)}`);
        }

        const result = opts.schema.safeParse(opts.normalize ? opts.normalize(json) : json);
        if (!result.success) {
          correction = `Your previous response did not match the required schema. Fix exactly these problems and return the corrected JSON object only:\n${result.error.message}`;
          throw new Error(`Groq (${model}) output failed schema validation: ${result.error.message}`);
        }
        if (attempt > 1) console.warn(`[groq] ${model} succeeded on retry ${attempt}`);
        return result.data;
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number })?.status;
        if (status === 429) {
          if (!rateLimited.includes(model)) rateLimited.push(model);
          break; // retrying a rate-limited model immediately is pointless
        }
        // Otherwise retry the same model once with corrective feedback, then
        // fall through to the next model.
      }
    }
  }

  if (rateLimited.length > 0) {
    throw new Error(
      `Groq rate limit reached on ${rateLimited.join(", ")} — the daily token budget is exhausted. ` +
        `Any schema errors below are a symptom of falling back to a weaker model, not the cause. ` +
        `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
