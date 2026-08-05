// ApplicantEvidence — what we can CHECK about an applicant, as opposed to what
// they told us.
//
// The scorer used to receive an address, a proposed timeline, and a cover letter
// written by the applicant. Everything of substance in that is self-asserted:
// "experienced brand designer, 40+ logos delivered" is a sentence, not a fact,
// and the model had no way to tell the difference between someone who has done
// the work and someone who writes well about doing the work. Asked how we verify
// an applicant is qualified, the honest answer was that we largely didn't.
//
// Meanwhile Patron already holds real evidence and wasn't using it for the
// decision: every job is on a public chain, ratings are written to the contract
// on completion, and disputes are a matter of record. This module gathers that
// and hands it to the scorer as VERIFIED FACT, kept clearly apart from the
// untrusted letter.
//
// What this still cannot do: read the contents of a portfolio. We check that the
// link resolves and say so — a dead link is real information, and claiming to
// have reviewed someone's work we never opened would be exactly the dishonesty
// this file exists to remove.

import * as store from "../store.js";
import { getAverageRating } from "../web3/secureflow.js";

const LINK_TIMEOUT_MS = 8_000;

export interface ApplicantEvidence {
  address: string;
  /** On-chain, written to SecureFlow when a job completes. Verifiable by anyone. */
  rating: { average: number; count: number } | null;
  completedJobs: number;
  disputedJobs: number;
  totalEarnedUsdc: number;
  /** null when they gave no link; otherwise whether it actually resolves. */
  portfolio: { url: string; reachable: boolean; note: string } | null;
  firstSeen: number | null;
}

/** Pull the "Past work:" link the worker layer appends to a cover letter. */
function extractPortfolio(coverLetter: string): string | null {
  const labelled = coverLetter.match(/Past work:\s*(https?:\/\/\S+)/i);
  if (labelled?.[1]) return labelled[1];
  const any = coverLetter.match(/https?:\/\/\S+/);
  return any?.[0] ?? null;
}

/**
 * Does the link they gave actually exist?
 *
 * We cannot judge whether the work behind it is good — no vision model is
 * available and even with one, a portfolio is a website, not an image. But
 * "this resolves" versus "this 404s" is a real, checkable difference, and
 * pointing at something that isn't there is worth knowing.
 */
async function checkLink(url: string): Promise<{ url: string; reachable: boolean; note: string }> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(LINK_TIMEOUT_MS) });
    if (res.ok) return { url, reachable: true, note: `resolves (HTTP ${res.status})` };
    // Plenty of sites refuse HEAD but answer GET.
    const get = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(LINK_TIMEOUT_MS) });
    return get.ok
      ? { url, reachable: true, note: `resolves (HTTP ${get.status})` }
      : { url, reachable: false, note: `does not resolve (HTTP ${get.status})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { url, reachable: false, note: /timeout|abort/i.test(msg) ? "timed out" : "could not be reached" };
  }
}

/**
 * Everything checkable about one applicant.
 *
 * Completed/disputed counts come from Patron's own decision log, which is public
 * on the ledger and backed by on-chain transactions — so a judge or an applicant
 * can audit any of it rather than taking our word.
 */
export async function gatherEvidence(address: string, coverLetter: string): Promise<ApplicantEvidence> {
  const me = address.toLowerCase();

  const hiredFor = new Set(
    store
      .listDecisions(500)
      .filter((d: { type?: string; target?: string }) => d.type === "applicant_accepted" && d.target?.toLowerCase() === me)
      .map((d: { task_id?: string }) => d.task_id as string),
  );

  let completedJobs = 0;
  let disputedJobs = 0;
  for (const t of store.listTasks(200)) {
    if (!t.escrowId || !hiredFor.has(t.escrowId)) continue;
    if (t.status === "completed") completedJobs++;
    if (t.status === "disputed") disputedJobs++;
  }

  const totalEarnedUsdc = store
    .listPayments(500)
    .filter((p: { direction?: string; escrow_id?: string }) => p.direction === "escrow_release" && p.escrow_id && hiredFor.has(p.escrow_id))
    .reduce((sum: number, p: { amount_usdc?: string }) => sum + Number(p.amount_usdc || 0), 0);

  let rating: { average: number; count: number } | null = null;
  try {
    const r = await getAverageRating(address as `0x${string}`);
    rating = r.count > 0 ? r : null;
  } catch {
    // a chain hiccup must not stop the scoring pass
  }

  const link = extractPortfolio(coverLetter);
  const portfolio = link ? await checkLink(link) : null;

  const worker = store.getWorkerByAddress(address);

  return { address, rating, completedJobs, disputedJobs, totalEarnedUsdc, portfolio, firstSeen: worker?.createdAt ?? null };
}

/** Render for the prompt. Says plainly when there is nothing on record. */
export function renderEvidence(e: ApplicantEvidence): string {
  const lines: string[] = [];

  if (e.rating) lines.push(`- On-chain rating: ${e.rating.average.toFixed(1)}/5 across ${e.rating.count} completed job(s)`);
  if (e.completedJobs > 0) lines.push(`- Jobs completed through Patron: ${e.completedJobs} ($${e.totalEarnedUsdc.toFixed(2)} paid out)`);
  if (e.disputedJobs > 0) lines.push(`- Jobs that ended in dispute: ${e.disputedJobs}`);

  if (e.portfolio) {
    lines.push(
      e.portfolio.reachable
        ? `- Portfolio link: ${e.portfolio.url} — VERIFIED to exist (${e.portfolio.note}). Contents NOT inspected.`
        : `- Portfolio link: ${e.portfolio.url} — ${e.portfolio.note}. They pointed at something that isn't there.`,
    );
  }

  if (lines.length === 0) {
    return "- No track record on Patron yet, and no portfolio link given. This is not a mark against them — everyone starts here — but nothing in the letter is corroborated.";
  }
  return lines.join("\n");
}
