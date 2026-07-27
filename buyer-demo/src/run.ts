// run.ts — the demo's "customer": a standalone AI agent, funded Circle Agent Wallet,
// no human in the loop. This is demo beats 1-2 from IMPLEMENTATION.md:
//
//   npm run demo -- "Get me a logo for my project, budget $80, 3 days."
//
// It discovers Patron's x402-gated /api/hire, gets 402 Payment Required, signs an
// EIP-3009 authorization via Circle MPC, retries with the payment attached, and
// prints the escrow Patron opened as a result. Nothing here is scripted around a
// human clicking anything — this is the actual robot-pays-robot half of the pitch.
import { config } from "./config.js";
import { payForHire } from "./x402-client.js";

async function main() {
  const instruction = process.argv.slice(2).join(" ").trim() || "I need a logo for my coffee shop, budget $10, 3 days.";

  console.log(`\n🤖 Buyer agent — instruction: "${instruction}"\n`);

  const result = await payForHire<{ taskId: string; escrowId: string; brief: { title: string; criteria: string[] } }>(
    `${config.patronUrl}/api/hire`,
    { instruction },
    (step) => console.log(`   ${step}`),
  );

  console.log(`\n✅ Paid $${result.formattedAmount} USDC — Patron accepted the order.`);
  if (result.transaction) console.log(`   settlement tx: ${result.transaction}`);
  console.log(`   escrow #${result.data.escrowId} — "${result.data.brief.title}" (${result.data.brief.criteria.length} acceptance criteria)`);
  console.log(`\n   → Robot paid Patron. Patron is now hiring a human for this job.\n`);
}

main().catch((err) => {
  console.error("\n✗ Buyer demo failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
