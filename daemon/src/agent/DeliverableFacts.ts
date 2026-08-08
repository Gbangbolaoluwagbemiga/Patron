// DeliverableFacts — what we can establish about a delivered file WITHOUT a
// vision model.
//
// The reviewer's honest fallback ("I judged a description, not the work") is
// correct but weak, and it is the state we are actually in: the Anthropic
// account has no credit, and Groq serves no vision model. Left there, a
// freelancer who uploads any real file and describes it confidently is judged
// on the description alone.
//
// But "we cannot rasterise it" was doing far more damage than it needed to,
// because a lot of a deliverable is checkable with no model at all:
//
//   - An SVG *is* text. It is also the single most likely logo deliverable.
//     Reading the XML tells you whether it is a real drawing or an empty file
//     with one rectangle, and embedded <title>/<text> often names what it is.
//   - PNG/JPEG/GIF dimensions live in the file header, six bytes in. "Legible
//     at small sizes" and "2400px" stop being claims.
//   - Audio can be transcribed by Whisper, which Groq does serve free. A
//     voiceover script criterion becomes literally checkable.
//
// None of this judges taste. It does mean a freelancer cannot be paid for an
// empty file, a 40x40 thumbnail sold as print-ready, or a voiceover that says
// something other than the script.

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

export interface FileFacts {
  /** Hard facts, phrased for the reviewer. Empty when we learned nothing. */
  facts: string[];
  /** Real readable contents (SVG source, audio transcript) when we have them. */
  contents: string | null;
  /** What the contents ARE, so the reviewer knows how to read them. */
  contentsKind: "svg-source" | "audio-transcript" | null;
}

/** Width/height straight out of the file header. No decoding, no dependencies. */
export function imageDimensions(buf: Uint8Array, mediaType: string): { width: number; height: number } | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  try {
    if (mediaType.includes("png") && buf.byteLength > 24) {
      // 8-byte signature, 4-byte chunk length, "IHDR", then width/height.
      return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
    }
    if (mediaType.includes("gif") && buf.byteLength > 10) {
      return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
    }
    if (mediaType.includes("jpeg") || mediaType.includes("jpg")) {
      // Walk the marker segments to a Start-Of-Frame, which carries the size.
      let i = 2;
      while (i + 9 < buf.byteLength) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1]!;
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: dv.getUint16(i + 5, false), width: dv.getUint16(i + 7, false) };
        i += 2 + dv.getUint16(i + 2, false);
      }
    }
  } catch {
    // A malformed header is not worth failing a review over.
  }
  return null;
}

/**
 * Read an SVG as what it is: text.
 *
 * Returns a summary the reviewer can reason about — how much drawing is
 * actually in there, plus any human-readable strings the file carries. An
 * "original logo" that is one <rect>, or whose <title> names a different
 * brand, is visible from the source without ever rendering it.
 */
export function readSvgSource(source: string): { summary: string; excerpt: string } {
  const count = (re: RegExp) => (source.match(re) ?? []).length;
  const shapes = {
    path: count(/<path[\s>]/gi),
    circle: count(/<circle[\s>]/gi),
    rect: count(/<rect[\s>]/gi),
    polygon: count(/<polygon[\s>]/gi),
    ellipse: count(/<ellipse[\s>]/gi),
    line: count(/<(?:line|polyline)[\s>]/gi),
    group: count(/<g[\s>]/gi),
  };
  const totalShapes = shapes.path + shapes.circle + shapes.rect + shapes.polygon + shapes.ellipse + shapes.line;

  // Human-readable strings: <title>, <desc>, and any rendered <text>.
  const strings = [
    ...(source.match(/<title[^>]*>([\s\S]*?)<\/title>/gi) ?? []),
    ...(source.match(/<desc[^>]*>([\s\S]*?)<\/desc>/gi) ?? []),
    ...(source.match(/<text[^>]*>([\s\S]*?)<\/text>/gi) ?? []),
  ]
    .map((s) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const viewBox = source.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1];
  const hasRasterEmbed = /<image[\s>]/i.test(source);

  const parts: string[] = [];
  parts.push(
    totalShapes === 0
      ? "it contains NO drawing elements at all — this is an empty or near-empty SVG"
      : `it contains ${totalShapes} drawing element(s) (${Object.entries(shapes)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${n} ${k}`)
          .join(", ")})`,
  );
  if (viewBox) parts.push(`viewBox is "${viewBox}", so it is genuinely scalable vector artwork`);
  if (hasRasterEmbed) parts.push("NOTE: it embeds a raster <image>, so it is not true vector artwork despite being an SVG file");
  if (strings.length) parts.push(`text inside the file reads: ${strings.slice(0, 6).map((s) => `"${s.slice(0, 80)}"`).join(", ")}`);
  else parts.push("it contains no text elements");

  return {
    summary: parts.join("; "),
    excerpt: source.replace(/\s+/g, " ").slice(0, 1200),
  };
}

/**
 * Transcribe a delivered audio file with Whisper.
 *
 * Groq serves this on the same free key that runs the rest of the pipeline, so
 * a voiceover — one of the few briefs where "a human did this" is the whole
 * point — can be checked against the script rather than taken on trust.
 */
export async function transcribeAudio(buf: Uint8Array, filename: string): Promise<string | null> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key || buf.byteLength > MAX_AUDIO_BYTES) return null;
  try {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(buf)]), filename);
    form.append("model", "whisper-large-v3-turbo");
    form.append("response_format", "text");
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.length ? text.slice(0, 4000) : null;
  } catch {
    return null;
  }
}

export function isAudio(mediaType: string): boolean {
  return /^audio\//.test(mediaType) || mediaType === "video/mp4" || mediaType === "video/webm";
}

/**
 * Read a delivered WEB PAGE.
 *
 * "Patron has no vision credit so it couldn't open your site" was true and
 * beside the point: a web page is text. The reviewer was told a live URL
 * "resolves but its contents are not readable" and then judged the freelancer's
 * sentence about it — for a build-me-a-website brief, which is the one kind of
 * job where the deliverable is most obviously machine-readable.
 *
 * Same extraction as an applicant's portfolio: prefer <main>, fall back to
 * <article>, drop the chrome. A single-page app that renders client-side still
 * publishes its description in metadata, which is better than nothing.
 */
/**
 * Hosts that serve nothing to a server-side reader, by design.
 *
 * Measured, not assumed. A real submission linked to a tweet:
 *
 *   x.com/…/status/…        → HTTP 200, 4,299 bytes, ZERO readable text,
 *                             no og:description. A JavaScript shell.
 *   linkedin.com/…          → HTTP 302 to a login wall, zero bytes.
 *
 * The reviewer handled that correctly and reported it disastrously: it said
 * "no readable text is provided to verify the word count" against every single
 * acceptance criterion, scored the work 0/100, and burned all three revision
 * rounds doing it. The freelancer had delivered something real and was being
 * failed for the platform they posted it on.
 *
 * "I could not read this" and "this is empty" are completely different
 * findings, and only one of them is the freelancer's fault.
 */
const READER_BLOCKED_HOSTS = [
  "x.com",
  "twitter.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "threads.net",
  "tiktok.com",
];

export function isReaderBlockedHost(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return READER_BLOCKED_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) ?? null;
  } catch {
    return null;
  }
}

/** What to tell the reviewer, and the freelancer, when the host is the problem. */
export function readerBlockedNote(host: string): string {
  return (
    `the deliverable is hosted on ${host}, which serves no readable content to an automated reader — ` +
    `it returns a JavaScript shell or a login wall, so the work itself COULD NOT BE INSPECTED. ` +
    `This is a limitation of ${host}, NOT evidence that the work is missing or empty. ` +
    `Do not score the criteria as failed on this basis. Treat every criterion that depends on reading ` +
    `the deliverable as UNVERIFIED, and ask for a readable copy — pasted text, a public document, or a ` +
    `screenshot — rather than rejecting the work.`
  );
}

export function readWebPage(raw: string): { summary: string; text: string } {
  const region =
    raw.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    raw.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    raw.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
    raw;

  const text = region
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

  const title = raw.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ?? "";
  const meta = (raw.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? "").trim();

  if (text.length < 60) {
    const fallback = [title, meta].filter(Boolean).join(" — ");
    return {
      summary: fallback
        ? `the page loads but renders its content with JavaScript, so only its published description could be read: "${fallback}"`
        : "the page loads but serves no readable text (a JavaScript app that cannot be rendered here)",
      text: fallback,
    };
  }
  return { summary: `the page loads and its text was read${title ? ` — titled "${title}"` : ""}`, text: text.slice(0, 3500) };
}

/**
 * Read a delivered GITHUB REPOSITORY.
 *
 * "Here is the repo" is how a developer delivers code, and a repo page stripped
 * of markup is mostly navigation. The API gives the description, language and
 * size directly, and the README is the document the freelancer actually wrote
 * to explain what they built — which is precisely what a reviewer needs to
 * check "properly documented" against.
 */
export async function readGitHubRepo(url: string): Promise<{ summary: string; text: string } | null> {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/i);
  if (!m) return null;
  const [, owner, repo] = m;
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "PatronBot/1.0" };

  try {
    const metaRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!metaRes.ok) return null;
    const meta = (await metaRes.json()) as {
      description?: string;
      language?: string;
      stargazers_count?: number;
      pushed_at?: string;
      license?: { spdx_id?: string } | null;
      default_branch?: string;
    };

    let readme = "";
    try {
      const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
        headers: { ...headers, Accept: "application/vnd.github.raw" },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.ok) readme = (await r.text()).replace(/\s+/g, " ").trim();
    } catch {
      /* a repo with no README is a finding in itself, not an error */
    }

    const facts = [
      meta.description ? `described as "${meta.description}"` : "no description set",
      meta.language ? `primary language ${meta.language}` : "",
      // Licence matters: "include an open source license" is a real acceptance
      // criterion, and this answers it as a fact rather than a claim.
      meta.license?.spdx_id && meta.license.spdx_id !== "NOASSERTION"
        ? `licensed ${meta.license.spdx_id}`
        : "NO LICENSE FILE detected",
      meta.pushed_at ? `last pushed ${meta.pushed_at.slice(0, 10)}` : "",
      readme ? `README present (${readme.length} chars)` : "NO README found",
    ].filter(Boolean);

    return {
      summary: `a public GitHub repository — ${facts.join(", ")}`,
      text: readme.slice(0, 3500),
    };
  } catch {
    return null;
  }
}
