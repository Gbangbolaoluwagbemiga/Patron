/**
 * Does the chain-native applicant reader agree with reality?
 *
 * Pre-registration — what would make this look good for an uninteresting reason:
 *   - every escrow having zero applicants, so "roster matches logs" is 0 == 0
 *   - every cover letter coming back null, which the merge would still call a
 *     "match" on count alone
 * So this prints the non-empty count and the null count separately, and fails
 * if nothing with an actual applicant was ever examined.
 */
const { config } = await import("../src/config.js");
const sf = await import("../src/web3/secureflow.js");

console.log(`contract=${config.secureflowAddress} chain=${process.env.ARC_CHAIN_ID ?? "default"}\n`);
const next = Number(await sf.nextEscrowId());
console.log(`escrows on chain: ${next}\n`);

let withApplicants = 0, totalApps = 0, nullLetters = 0, mismatches = 0;
const start = Math.max(0, next - 25); // newest 25, where logs are still in range

let reverted = 0;
for (let i = start; i < next; i++) {
  /*
   * A reverting id is not a failure of the reader.
   *
   * SecureFlow has deleteEscrow, so ids inside 0..nextEscrowId can be absent
   * and getEscrowApplications reverts with EscrowNotFound. The first version of
   * this script let that throw and killed the whole run on escrow #47 — which
   * reported nothing about the 20 escrows that DID have applicants.
   */
  let roster: readonly string[];
  try {
    roster = await sf.getEscrowApplications(BigInt(i));
  } catch {
    reverted++;
    continue;
  }
  if (!roster.length) continue;
  withApplicants++;
  const apps = await sf.getApplications(BigInt(i));
  totalApps += apps.length;
  const nulls = apps.filter((a) => a.coverLetter === null).length;
  nullLetters += nulls;
  if (apps.length !== roster.length) { mismatches++; console.log(`  MISMATCH #${i}: roster ${roster.length} vs merged ${apps.length}`); }
  const sample = apps.find((a) => a.coverLetter);
  console.log(
    `  #${i}: ${roster.length} applicant(s), ${nulls} unreadable` +
    (sample ? `  e.g. ${sample.freelancerAddress.slice(0,10)}… "${sample.coverLetter!.slice(0,52).replace(/\n/g," ")}…" timeline=${sample.proposedTimeline}` : ""),
  );
}

console.log(`\nescrows absent/reverting:  ${reverted}`);
console.log(`escrows with applicants: ${withApplicants}`);
console.log(`applications merged:     ${totalApps}`);
console.log(`cover letters readable:  ${totalApps - nullLetters}`);
console.log(`cover letters null:      ${nullLetters}`);
console.log(`roster/merge mismatches: ${mismatches}`);

const ok = withApplicants > 0 && mismatches === 0 && totalApps - nullLetters > 0;
console.log(`\n${ok ? "PASS" : "FAIL"} — ${ok ? "roster is exact and letters actually came back" : "nothing meaningful was verified"}`);
process.exit(ok ? 0 : 1);
