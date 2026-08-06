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
