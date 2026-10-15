/**
 * Prove Patron can actually open an escrow on Arc mainnet. Spends real USDC.
 *
 *   npx tsx scripts/mainnet-smoke.ts
 *
 * Signing and reading were both verified before this (verify-circle,
 * verify-mainnet, verify-abi) and neither of them writes. createEscrow is the
 * first call that moves money, and it is the one the whole product rests on —
 * so it gets proven on a job worth 20 cents, deliberately, rather than
 * discovered during a demo.
 *
 * It opens an OPEN job (no beneficiary), which is the same shape every real
 * commission has. Nobody is hired, so the budget is reclaimable through the
 * ordinary cancel path.
 */
const { config, chainId, explorerTx, explorerAddress } = await import("../src/config.js");
const secureflow = await import("../src/web3/secureflow.js");

if (chainId !== 5042) {
  console.error(`refusing to run: chainId is ${chainId}, not Arc mainnet (5042)`);
  process.exit(1);
}

const BUDGET = 0.20;
const units = BigInt(Math.round(BUDGET * 1e6));

console.log(`contract : ${config.secureflowAddress}`);
console.log(`treasury : ${config.circleWalletAddress}`);
console.log(`budget   : $${BUDGET.toFixed(2)} USDC\n`);

const before = await secureflow.nextEscrowId();
console.log(`nextEscrowId before: ${before}`);

const t0 = Date.now();
const { escrowId, txHash } = await secureflow.createEscrow({
  totalAmount: units,
  durationDays: 1n,
  milestoneAmounts: [units],
  milestoneDescriptions: ["Square app icon as SVG + 1024px PNG, linked publicly"],
  projectTitle: "Patron mainnet proof",
  projectDescription: "First escrow opened by the Patron agent on Arc mainnet.",
});

console.log(`\nescrow #${escrowId} created in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`tx      : ${explorerTx(txHash)}`);
console.log(`escrow  : ${explorerAddress(config.secureflowAddress)}`);

const e: any = await secureflow.getEscrow(escrowId);
const ms: any = await secureflow.getMilestones(escrowId);
console.log(`\nread back from chain:`);
console.log(`  depositor   : ${e.depositor}`);
console.log(`  beneficiary : ${e.beneficiary}  (zero = open for applications)`);
console.log(`  totalAmount : $${Number(e.totalAmount) / 1e6}`);
console.log(`  isOpenJob   : ${e.isOpenJob}`);
console.log(`  milestones  : ${ms.length}`);

const ok =
  String(e.depositor).toLowerCase() === config.circleWalletAddress.toLowerCase() &&
  Number(e.totalAmount) === Number(units) &&
  ms.length === 1;
console.log(`\n${ok ? "PASS — Patron can open escrow on Arc mainnet" : "FAIL — escrow does not read back as expected"}`);
process.exit(ok ? 0 : 1);
