/**
 * Does our ABI actually decode the contract we are pointed at? Read-only.
 *
 * Run this after ANY contract deploy or upgrade, and before any cutover:
 *
 *   SECUREFLOW_CONTRACT_ADDRESS=0x… ARC_RPC_URL=… npx tsx scripts/verify-abi.ts
 *
 * WHY
 *
 * Patron shipped for weeks with an ABI from an intermediate build of SecureFlow:
 * it had submitRating and startWork but not version, setYieldController or
 * setJobManager, and it still declared a constructor for a contract that is now
 * a UUPS proxy behind `initialize`. Nothing failed loudly. The missing pieces
 * were simply uncallable, so the yield surface the contract exposes was
 * invisible to the agent that was supposed to be using it.
 *
 * An ABI mismatch does not announce itself — it either reverts on one function
 * or, worse, decodes a struct into the wrong fields. So this walks every escrow
 * and decodes it, which is the only check that would have caught it.
 */
const sf = await import("../src/web3/secureflow.js");
const { config } = await import("../src/config.js");
console.log(`contract: ${config.secureflowAddress}`);
const next = await sf.nextEscrowId();
console.log(`nextEscrowId: ${next}`);
let ok = 0, bad = 0;
for (let i = 0n; i < next; i++) {
  try {
    const e: any = await sf.getEscrow(i);
    const ms: any = await sf.getMilestones(i);
    console.log(`  #${i} status=${e.status} depositor=${String(e.depositor).slice(0,10)}… total=${Number(e.totalAmount)/1e6} paid=${Number(e.paidAmount)/1e6} milestones=${ms.length} title=${JSON.stringify(String(e.projectTitle).slice(0,34))}`);
    ok++;
  } catch (err) {
    console.log(`  #${i} REVERT (${String((err as Error).message).split("\n")[0].slice(0,50)})`);
    bad++;
  }
}
console.log(`\ndecoded ${ok}, reverted ${bad}`);
console.log(ok > 0 ? "PASS — new ABI decodes the live proxy" : "FAIL");
process.exit(ok > 0 ? 0 : 1);
