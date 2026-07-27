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
}

export async function groqStructured<T>(opts: GroqStructuredOpts<T>): Promise<T> {
  const schemaJson = JSON.stringify(z.toJSONSchema(opts.schema));
  const system = `${opts.system}\n\nRespond with ONLY a single JSON object — no markdown fences, no prose before or after — matching exactly this JSON schema:\n${schemaJson}`;

  const models = [...new Set([opts.model ?? config.groqModel, config.groqFallbackModel].filter(Boolean))];
  let lastErr: unknown;

  for (const model of models) {
    try {
      const completion = await groq.chat.completions.create({
        model,
        max_tokens: opts.maxTokens ?? 2048,
        temperature: opts.temperature ?? 0.4,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: opts.user },
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

      const result = opts.schema.safeParse(json);
      if (!result.success) {
        throw new Error(`Groq (${model}) output failed schema validation: ${result.error.message}`);
      }
      return result.data;
    } catch (err) {
      lastErr = err;
      // try the next model (e.g. primary rate-limited) before giving up
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
