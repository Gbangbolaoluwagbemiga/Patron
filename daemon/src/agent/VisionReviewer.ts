// VisionReviewer — actually look at the deliverable.
//
// The hole this closes: WorkReviewer grades the freelancer's DESCRIPTION of
// their work. Given "delivered as SVG and PNG at 2400px, CMYK, trademark-cleared"
// it would happily write back "the submission meets all critical criteria,
// including delivery in SVG and PNG formats" — asserting as fact something it
// had only been told. Our pitch says "a logo with taste". You cannot judge taste,
// or resolution, or whether the thing is even a logo, from a sentence about it.
//
// So: when a submission carries an image and a vision-capable model is available,
// look at it and report what is actually there.
//
// When one ISN'T available, this returns `available: false` and the reviewer
// says plainly that it assessed a description rather than an artifact. That
// matters more than it sounds — silently grading a claim while sounding like
// you inspected a file is the single most misleading thing this system could do.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** Types a vision model can actually look at. */
const SUPPORTED = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
} as const;
type SupportedMedia = keyof typeof SUPPORTED;

/**
 * Real image types that simply cannot be rasterised here.
 *
 * SVG is the single most likely deliverable for a logo brief, and treating it as
 * an error was actively harmful: the reviewer was told "the link is
 * image/svg+xml, which cannot be inspected", read that as a broken link, and
 * rejected correct work asking for "a working link". Fetching one is positive
 * evidence — the file exists, resolves, and IS the format the brief asked for.
 * We just can't see inside it.
 */
const UNRASTERISABLE_IMAGE = new Set(["image/svg+xml", "application/pdf", "image/tiff", "image/avif", "image/heic"]);

export const VisionFindingSchema = z.object({
  criterion: z.string(),
  /** What the model can actually tell from the image — not what it was told. */
  observed: z.string(),
  verdict: z.enum(["met", "not_met", "cannot_tell"]),
});

export interface VisionReview {
  available: boolean;
  /** Why vision didn't run, when it didn't. Surfaced to the reviewer verbatim. */
  note: string;
  findings: { criterion: string; observed: string; verdict: "met" | "not_met" | "cannot_tell" }[];
  description?: string;
}

/**
 * Pull the first plausible image URL out of a freelancer's submission text.
 * They paste links; they don't fill in a structured field.
 */
export function extractImageUrl(text: string): string | null {
  const urls = text.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
  // svg/pdf included: they are the most likely design deliverables, and leaving
  // them out meant a submission linking one fell through to "first URL found".
  const imageLike = urls.find((u) => /\.(png|jpe?g|gif|webp|svg|pdf)(\?|#|$)/i.test(u));
  return imageLike ?? urls[0] ?? null;
}

/** True when some vision-capable model is configured and usable. */
export function visionAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

type FetchResult =
  | { base64: string; mediaType: SupportedMedia; bytes: number }
  /** Fetched fine and is a genuine file of a known type — just not one we can rasterise. */
  | { confirmedType: string; bytes: number }
  | { error: string };

async function fetchImage(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
    if (!res.ok) return { error: `the link returned ${res.status}` };

    const mediaType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (mediaType && UNRASTERISABLE_IMAGE.has(mediaType)) {
      return { confirmedType: mediaType, bytes: Number(res.headers.get("content-length") ?? 0) };
    }
    if (!mediaType || !(mediaType in SUPPORTED)) {
      return { error: `the link returned ${mediaType || "an unknown type"} rather than a file` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) return { error: `the file is ${(buf.byteLength / 1e6).toFixed(1)}MB, too large to inspect` };

    return { base64: buf.toString("base64"), mediaType: mediaType as SupportedMedia, bytes: buf.byteLength };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: /timeout|abort/i.test(msg) ? "the link timed out" : `the link could not be fetched (${msg})` };
  }
}

/**
 * Inspect the delivered artifact against the brief's criteria.
 *
 * Never throws: a vision failure must degrade the review to text-only, not fail
 * a freelancer's submission. Someone's payment should not hinge on whether an
 * image host was reachable.
 */
export async function inspectDeliverable(submissionText: string, criteria: string[]): Promise<VisionReview> {
  const url = extractImageUrl(submissionText);
  if (!url) {
    return { available: false, note: "No file link was included in the submission, so only the written description could be assessed.", findings: [] };
  }
  if (!visionAvailable()) {
    return {
      available: false,
      note: "No vision-capable model is configured, so the delivered file was not opened — only the freelancer's description of it was assessed.",
      findings: [],
    };
  }

  const image = await fetchImage(url);
  if ("error" in image) {
    return { available: false, note: `The delivered file could not be inspected: ${image.error}. Only the written description was assessed.`, findings: [] };
  }

  // The file is real and its type is confirmed, even though we can't look inside
  // it. Say exactly that — it settles any format criterion on its own, and the
  // reviewer must not mistake it for a broken link.
  if ("confirmedType" in image) {
    return {
      available: false,
      note:
        `The delivered link resolves and the file is genuinely ${image.confirmedType}` +
        (image.bytes ? ` (${(image.bytes / 1024).toFixed(0)}KB)` : "") +
        `, so the file exists and its FORMAT is confirmed. Its visual contents could not be rasterised for inspection, ` +
        `so judge appearance on the freelancer's description — but treat the format and the link as verified.`,
      findings: [],
    };
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      system: [
        "You inspect delivered freelance work against acceptance criteria.",
        "",
        "Report ONLY what you can actually see in the image. If a criterion cannot be judged",
        'visually (licensing, file format, colour profile, originality), say so with "cannot_tell"',
        "rather than guessing — an honest 'cannot_tell' is far more useful than a confident guess,",
        "because a payment depends on this.",
        "",
        "Return JSON: {\"description\": string, \"findings\": [{\"criterion\": string, \"observed\": string, \"verdict\": \"met\"|\"not_met\"|\"cannot_tell\"}]}",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
            {
              type: "text",
              text: `Acceptance criteria:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nDescribe what this image actually is, then judge each criterion.`,
            },
          ],
        },
      ],
    });

    const text = response.content.find((c) => c.type === "text");
    const raw = text && "text" in text ? text.text : "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { available: false, note: "The vision model returned no usable result; only the description was assessed.", findings: [] };

    const parsed = JSON.parse(jsonMatch[0]) as { description?: string; findings?: unknown[] };
    const findings = z.array(VisionFindingSchema).safeParse(parsed.findings ?? []);

    return {
      available: true,
      note: "The delivered file was opened and inspected.",
      description: parsed.description,
      findings: findings.success ? findings.data : [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      note: `The delivered file could not be inspected (${msg.slice(0, 120)}). Only the written description was assessed.`,
      findings: [],
    };
  }
}
