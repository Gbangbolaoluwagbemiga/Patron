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
import {
  imageDimensions,
  readSvgSource,
  transcribeAudio,
  isAudio,
  readWebPage,
  readGitHubRepo,
  isReaderBlockedHost,
  readerBlockedNote,
} from "./DeliverableFacts.js";

/** What a vision model will accept. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** What we will pull down at all — audio is legitimately larger than an image. */
const MAX_FETCH_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

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
  /** Verbatim file contents when the file is genuinely text (SVG source). */
  sourceExcerpt?: string;
  /**
   * The HOST refused to serve a reader — not the freelancer failing to deliver.
   * The reviewer must not fail criteria on this basis; it asks for a readable
   * copy instead.
   */
  inspectionBlockedByHost?: boolean;
}

/**
 * Pull the first plausible image URL out of a freelancer's submission text.
 * They paste links; they don't fill in a structured field.
 */
/**
 * Strip the sentence off the end of a URL.
 *
 * People write "here is the repo https://github.com/me/thing." and the full
 * stop is not part of the address. This cost a real freelancer a rejection:
 * they delivered two working links, the trailing period was captured into the
 * first one, GitHub returned 404 for `…/foreman.`, and the reviewer correctly
 * reported that the deliverable did not resolve. Both links were live.
 *
 * Closing brackets are only stripped when unbalanced, because plenty of real
 * URLs legitimately end in one.
 */
function trimUrlPunctuation(url: string): string {
  let u = url;
  for (;;) {
    const last = u.at(-1);
    if (!last) break;
    if (".,;:!?'\"".includes(last)) {
      u = u.slice(0, -1);
      continue;
    }
    if ((last === ")" && !u.includes("(")) || (last === "]" && !u.includes("[")) || (last === "}" && !u.includes("{"))) {
      u = u.slice(0, -1);
      continue;
    }
    break;
  }
  return u;
}

/**
 * Every link in a submission, cleaned and ordered by how likely it is to BE
 * the deliverable.
 *
 * More than one, deliberately. "Here is the repo … and here is the deployed
 * site …" is how a developer hands over a web build, and inspecting only the
 * first meant half the delivery was never looked at — then judged as though it
 * had been.
 */
export function extractDeliverableUrls(text: string): string[] {
  const raw = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const r of raw) {
    const u = trimUrlPunctuation(r);
    if (u.length > 10 && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  }
  // A concrete file beats a page; everything else keeps the order it was written.
  const isFile = (u: string) => /\.(png|jpe?g|gif|webp|svg|pdf|mp3|wav|m4a|ogg|flac|webm)(\?|#|$)/i.test(u);
  return [...urls.filter(isFile), ...urls.filter((u) => !isFile(u))];
}

export function extractImageUrl(text: string): string | null {
  return extractDeliverableUrls(text)[0] ?? null;
}

/** True when some vision-capable model is configured and usable. */
export function visionAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

type FetchResult =
  /** Fetched. `buf` is kept for the model-free inspections in DeliverableFacts. */
  | { buf: Uint8Array; mediaType: string; bytes: number }
  | { error: string };

async function fetchImage(url: string): Promise<FetchResult> {
  try {
    // Identify ourselves. Sending no User-Agent gets a bare 403 from a lot of
    // image hosts (Wikimedia among them), and the failure was invisible: the
    // review degraded to "could not inspect" and read as a broken link, so
    // honest work was rejected for the crime of being hosted somewhere strict.
    // ApplicantEvidence already did this; the higher-stakes call did not.
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
      headers: { "User-Agent": "PatronBot/1.0 (+https://patron-guild.vercel.app)" },
    });
    if (!res.ok) return { error: `the link returned ${res.status}` };

    const mediaType = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (!mediaType) return { error: "the link returned no content type" };

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_FETCH_BYTES) return { error: `the file is ${(buf.byteLength / 1e6).toFixed(1)}MB, too large to inspect` };

    return { buf, mediaType, bytes: buf.byteLength };
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
/** How many links in one submission are worth opening. */
const MAX_LINKS_INSPECTED = 3;

/**
 * Inspect EVERY link in the submission, not just the first one.
 *
 * "Here is the repo … and here is the deployed site …" is how a developer
 * hands over a web build. Opening only the first meant the other half of the
 * delivery was never looked at, and then graded as if it had been — so one
 * unreachable link condemned a delivery whose other link was live and correct.
 *
 * Findings are merged: if ANY link could be inspected, the review is an
 * inspection, and every link's outcome is reported so the reviewer can see
 * which part of the delivery was verified and which was not.
 */
export async function inspectDeliverable(submissionText: string, criteria: string[]): Promise<VisionReview> {
  const urls = extractDeliverableUrls(submissionText).slice(0, MAX_LINKS_INSPECTED);
  if (!urls.length) {
    return { available: false, note: "No file link was included in the submission, so only the written description could be assessed.", findings: [] };
  }
  if (urls.length === 1) return inspectOne(urls[0]!, criteria);

  const results = await Promise.all(urls.map((u) => inspectOne(u, criteria)));
  const usable = results.filter((r) => r.available);
  const parts = results.map((r, i) => `Link ${i + 1} (${urls[i]}): ${r.description ?? r.note}`);

  return {
    available: usable.length > 0,
    // Only a blocked host if EVERY link was blocked — one dead link among
    // several is not a reason to stop reading the others.
    inspectionBlockedByHost: results.every((r) => r.inspectionBlockedByHost === true),
    note:
      `The submission contained ${urls.length} links and each was opened.\n${parts.join("\n")}` +
      (usable.length
        ? `\nAt least one part of the delivery WAS inspected. Judge each criterion against whichever link is relevant to it, and do not fail a criterion that a readable link satisfies merely because a different link was unreachable.`
        : ""),
    description: usable.map((r) => r.description).filter(Boolean).join(" · ") || undefined,
    findings: results.flatMap((r) => r.findings),
    sourceExcerpt: usable.map((r) => r.sourceExcerpt).filter(Boolean).join("\n\n---\n\n").slice(0, 6000) || undefined,
  };
}

async function inspectOne(url: string, criteria: string[]): Promise<VisionReview> {

  /**
   * Some hosts will never answer a server, and that is not the freelancer's
   * fault. Say so BEFORE fetching, because the fetch succeeds — x.com returns
   * a perfectly healthy 200 with an empty JavaScript shell — and the emptiness
   * then reads as "they delivered nothing".
   */
  const blockedHost = isReaderBlockedHost(url);
  if (blockedHost) {
    return {
      available: false,
      inspectionBlockedByHost: true,
      note: readerBlockedNote(blockedHost),
      findings: [],
    };
  }

  // Fetch FIRST. The old order bailed out here whenever no vision model was
  // configured — which threw away every model-free check along with it, and
  // that is the state we actually run in. Whether we can rasterise an image
  // has nothing to do with whether we can read an SVG or hear a voiceover.
  const file = await fetchImage(url);
  if ("error" in file) {
    return { available: false, note: `The delivered file could not be inspected: ${file.error}. Only the written description was assessed.`, findings: [] };
  }

  const sizeKb = `${(file.bytes / 1024).toFixed(0)}KB`;

  // ── An SVG is text. Read it. ────────────────────────────────────────────
  // The most likely logo deliverable there is, and we were filing it under
  // "cannot inspect" while the answer sat in plain XML.
  if (file.mediaType === "image/svg+xml") {
    const svg = readSvgSource(new TextDecoder().decode(file.buf));
    return {
      available: true,
      note: `The delivered file was fetched and its SVG source was read directly (${sizeKb}).`,
      description: `A genuine SVG file (${sizeKb}). Read from its source: ${svg.summary}.`,
      findings: [],
      sourceExcerpt: svg.excerpt,
    };
  }

  // ── Audio can be listened to. ──────────────────────────────────────────
  if (isAudio(file.mediaType)) {
    const transcript = await transcribeAudio(file.buf, url.split("/").pop() ?? "audio.mp3");
    if (transcript) {
      return {
        available: true,
        note: `The delivered audio was fetched (${sizeKb}) and transcribed. Judge the words against the brief.`,
        description: `A genuine ${file.mediaType} audio file (${sizeKb}). This is what it actually says, transcribed:\n"${transcript}"`,
        findings: [],
      };
    }
    return {
      available: false,
      note: `The delivered link resolves and is genuinely ${file.mediaType} (${sizeKb}), so the file and its FORMAT are verified, but it could not be transcribed. Judge its contents on the freelancer's description — never treat this as a broken link.`,
      findings: [],
    };
  }

  // ── A repository is a document. ────────────────────────────────────────
  // Checked BEFORE the content-type branches, because github.com serves
  // text/html and the page itself is mostly navigation chrome. The README is
  // what the freelancer actually wrote about what they built, and the API
  // answers "is it licensed" as a fact rather than a claim.
  const repo = await readGitHubRepo(url);
  if (repo) {
    return {
      available: true,
      note: "The delivered repository was read — its metadata from the GitHub API, and its README.",
      description: `A delivered GitHub repository. ${repo.summary}.`,
      findings: [],
      sourceExcerpt: repo.text || undefined,
    };
  }

  // ── A web page is text. ────────────────────────────────────────────────
  // This fell through to "contents not readable", so a build-me-a-website
  // brief — the one kind of job whose deliverable is most obviously
  // machine-readable — was judged on the freelancer's sentence about it.
  // Reading a page needs no vision model; it never did.
  if (file.mediaType.includes("html") || file.mediaType.startsWith("text/") || file.mediaType.includes("json")) {
    const page = readWebPage(new TextDecoder().decode(file.buf));

    /**
     * Reading NOTHING is not an inspection.
     *
     * A page that renders entirely client-side fetches fine and yields no text.
     * Reporting that as `available: true` sent the reviewer down the branch that
     * says "TRUST THE INSPECTION" — so an empty read became positive evidence
     * of an empty deliverable, every criterion was marked not-met, and the work
     * scored 0/100 through all three revision rounds. The freelancer had
     * delivered something real.
     *
     * With nothing to show, this is an inspection FAILURE, and the no-inspection
     * branch already knows not to fail a criterion it could not check.
     */
    if (!page.text || page.text.length < 40) {
      return {
        available: false,
        inspectionBlockedByHost: true,
        note:
          `The link at ${url} resolves and returns a page, but it renders its content with JavaScript and served ` +
          `no readable text to an automated reader — so the work itself COULD NOT BE INSPECTED. This is a property ` +
          `of how the page is built, NOT evidence that the work is missing or empty. Do not mark criteria as failed ` +
          `on this basis; ask for a readable copy — pasted text, a public document, or a screenshot.`,
        findings: [],
      };
    }

    return {
      available: true,
      note: `The delivered link was fetched (${sizeKb}) and ${page.summary}.`,
      description: `A live page at ${url} (${file.mediaType}, ${sizeKb}). ${page.summary}.`,
      findings: [],
      sourceExcerpt: page.text,
    };
  }

  // ── Rasters: dimensions are free, even with no model. ──────────────────
  const dims = imageDimensions(file.buf, file.mediaType);
  const dimFact = dims ? ` Its real dimensions are ${dims.width}×${dims.height}px, read from the file header.` : "";

  /**
   * The facts we hold regardless of whether any model runs. Appended to every
   * degraded path so a vision failure never downgrades us below what the bytes
   * already told us — the link resolves, the format is real, the size is known.
   */
  const verifiedTail =
    ` The link DOES resolve and the file is genuinely ${file.mediaType} (${sizeKb}) — never treat this as a broken link.${dimFact}` +
    (dims ? " Any criterion about resolution or print size is settled by those real dimensions, not by the freelancer's claim." : "");

  if (UNRASTERISABLE_IMAGE.has(file.mediaType) || !(file.mediaType in SUPPORTED)) {
    return {
      available: false,
      note:
        `The delivered link resolves and the file is genuinely ${file.mediaType} (${sizeKb}), so the file exists and its FORMAT is confirmed.${dimFact} ` +
        `Its visual contents could not be inspected, so judge appearance on the freelancer's description — but treat the format, size and the link as verified.`,
      findings: [],
    };
  }

  if (file.bytes > MAX_IMAGE_BYTES || !visionAvailable()) {
    const why = file.bytes > MAX_IMAGE_BYTES ? `it is ${(file.bytes / 1e6).toFixed(1)}MB, too large to send to a vision model` : "no vision-capable model is configured";
    return {
      available: false,
      note:
        `The delivered link resolves and is genuinely ${file.mediaType} (${sizeKb}), so the file and its FORMAT are verified.${dimFact} ` +
        `Its visual contents were NOT examined because ${why} — judge appearance on the freelancer's description, and never treat this as a broken link. ` +
        `Any criterion about size or resolution can be settled from the real dimensions above.`,
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
            { type: "image", source: { type: "base64", media_type: file.mediaType as SupportedMedia, data: Buffer.from(file.buf).toString("base64") } },
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
    if (!jsonMatch) return { available: false, note: `The vision model returned no usable result, so the file's appearance was not assessed.${verifiedTail}`, findings: [] };

    const parsed = JSON.parse(jsonMatch[0]) as { description?: string; findings?: unknown[] };
    const findings = z.array(VisionFindingSchema).safeParse(parsed.findings ?? []);

    return {
      available: true,
      note: `The delivered file was opened and inspected (${file.mediaType}, ${sizeKb}).${dimFact}`,
      description: parsed.description,
      findings: findings.success ? findings.data : [],
    };
  } catch (err) {
    // A vision model that is configured but unusable (no credit, rate limited,
    // down) must not cost us the facts we already established for free. The
    // first version returned a bare "could not be inspected" here and threw the
    // real dimensions away with it — so a 40x40 thumbnail sold as print-ready
    // went back to being judged on the freelancer's word.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      available: false,
      note: `The delivered file's appearance could not be inspected (${msg.slice(0, 100)}).${verifiedTail}`,
      findings: [],
    };
  }
}
