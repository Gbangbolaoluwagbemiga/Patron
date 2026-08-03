// seed-submission.ts — the hired freelancer (FREELANCER_1_KEY, the "strong
// applicant" from seed-freelancers.ts) submits work for a milestone.
//
//   npm run seed:submission -- <escrowId> <milestoneIndex> ["submission text"]

import "dotenv/config";
import { createPublicClient, createWalletClient, http, type Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, config, rpcUrl } from "../src/config.js";
import secureFlowAbi from "../src/web3/SecureFlowABI.json" with { type: "json" };

const abi = secureFlowAbi as Abi;

const escrowId = BigInt(process.argv[2] ?? "0");
const milestoneIndex = BigInt(process.argv[3] ?? "0");
const description =
  process.argv[4] ??
  "Delivered: primary logo mark in SVG and PNG (1200x1200px), plus 2 color variants (light/dark). Link: https://example.com/patron-logo-draft";

async function main() {
  const key = process.env.FREELANCER_1_KEY?.trim() as `0x${string}` | undefined;
  if (!key) {
    console.error("FREELANCER_1_KEY not set in daemon/.env — run seed:freelancers first and save the printed key.");
    process.exit(1);
  }

  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(rpcUrl) });

  console.log(`Submitting milestone ${milestoneIndex} for escrow #${escrowId} as ${account.address}...`);

  // SecureFlow requires the lifecycle step before a submission is accepted, and
  // submitMilestone reverts without it. This script didn't call it — so
  // submitting to a freshly hired escrow failed with a bare "execution
  // reverted", which reads like a broken submission rather than a missing
  // transition. The e2e loop always called it; this path never did.
  // Swallowed on failure because it reverts once work has already started,
  // which is the normal case for every milestone after the first.
  try {
    const startHash = await walletClient.writeContract({
      chain: arcTestnet,
      account,
      address: config.secureflowAddress,
      abi,
      functionName: "startWork",
      args: [escrowId],
    });
    await publicClient.waitForTransactionReceipt({ hash: startHash });
    console.log(`  startWork ok — ${startHash}`);
  } catch {
    console.log("  (work already started)");
  }

  const hash = await walletClient.writeContract({
    chain: arcTestnet,
    account,
    address: config.secureflowAddress,
    abi,
    functionName: "submitMilestone",
    args: [escrowId, milestoneIndex, description],
  });
  await publicClient.waitForTransactionReceipt({ hash });

  console.log(`✓ Submitted — tx ${hash}`);
  console.log("Patron's poller (every 15s) will pick this up and review it against the brief.");
}

main().catch((err) => {
  console.error("✗ seed:submission failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
