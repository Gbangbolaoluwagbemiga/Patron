// secureflow.ts — the only place Patron actually writes to the SecureFlow contract.
//
// Writes go through the Patron Agent Wallet's viem WalletClient (Circle MPC-backed,
// see circle/circleSigner.ts). `writeContract` ABI-encodes calldata the same way for
// any function shape — arrays, strings, structs — so the same MPC wallet that signs
// x402 payments also signs createEscrow's array/string params with no special
// handling. This is what resolves Phase 0's Spike A question: no hybrid custody
// (Agent Wallet for payments + separate hot wallet for contract calls) is needed.
//
// Reads go through a plain public client — no signing, no cost, no custody question.

import { createPublicClient, http, zeroAddress, type Abi, type PublicClient } from "viem";
import secureFlowAbi from "./SecureFlowABI.json" with { type: "json" };
import { arcTestnet, config, rpcUrl } from "../config.js";
import { createCircleSigner } from "../circle/circleSigner.js";

// Cast to viem's `Abi` type (not a tighter `as const` literal, since this is loaded
// from JSON) so `writeContract` can still resolve stateMutability (payable vs not)
// and accept `value` on `createEscrow` — a looser `unknown[]` cast defeats that.
const abi = secureFlowAbi as Abi;

let publicClient: PublicClient | null = null;
function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({ chain: arcTestnet, transport: http(rpcUrl) });
  }
  return publicClient;
}

export interface CreateEscrowParams {
  totalAmount: bigint; // in USDC base units (6 decimals)
  durationDays: bigint;
  milestoneAmounts: bigint[];
  milestoneDescriptions: string[];
  projectTitle: string;
  projectDescription: string; // briefHash embedded here — see BriefGenerator
  arbiters?: `0x${string}`[];
  requiredConfirmations?: bigint;
}

/** Posts an open job on SecureFlow (beneficiary = zero address = open for applications). Returns the escrowId. */
export async function createEscrow(params: CreateEscrowParams): Promise<bigint> {
  const signer = createCircleSigner();
  const client = getPublicClient();

  const [deposit] = (await client.readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "quoteDeposit",
    args: [params.totalAmount],
  })) as [bigint, bigint];

  const hash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: config.secureflowAddress,
    abi,
    functionName: "createEscrow",
    args: [
      zeroAddress, // beneficiary — unset until an applicant is hired
      config.usdcAddress,
      params.totalAmount,
      params.durationDays,
      params.arbiters ?? [],
      params.requiredConfirmations ?? 0n,
      params.milestoneAmounts,
      params.milestoneDescriptions,
      params.projectTitle,
      params.projectDescription,
    ],
    value: deposit,
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  const created = receipt.logs.find((log) => log.address.toLowerCase() === config.secureflowAddress.toLowerCase());
  if (!created) throw new Error(`createEscrow tx ${hash} mined but no SecureFlow log found`);

  // escrowId is nextEscrowId - 1 right after creation — simplest reliable read post-tx.
  const nextId = (await client.readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "nextEscrowId",
  })) as bigint;
  return nextId - 1n;
}

export async function acceptFreelancer(escrowId: bigint, freelancer: `0x${string}`): Promise<`0x${string}`> {
  const signer = createCircleSigner();
  const hash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: config.secureflowAddress,
    abi,
    functionName: "acceptFreelancer",
    args: [escrowId, freelancer],
  });
  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

export async function approveMilestone(escrowId: bigint, milestoneIndex: bigint): Promise<`0x${string}`> {
  const signer = createCircleSigner();
  const hash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: config.secureflowAddress,
    abi,
    functionName: "approveMilestone",
    args: [escrowId, milestoneIndex],
  });
  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

export async function rejectMilestone(escrowId: bigint, milestoneIndex: bigint, reason: string): Promise<`0x${string}`> {
  const signer = createCircleSigner();
  const hash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: config.secureflowAddress,
    abi,
    functionName: "rejectMilestone",
    args: [escrowId, milestoneIndex, reason],
  });
  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

/** Human-arbiter escalation path — Patron's one-way key can never do this itself; it only calls it after max revisions. */
export async function disputeMilestone(escrowId: bigint, milestoneIndex: bigint, reason: string): Promise<`0x${string}`> {
  const signer = createCircleSigner();
  const hash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: config.secureflowAddress,
    abi,
    functionName: "disputeMilestone",
    args: [escrowId, milestoneIndex, reason],
  });
  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

export async function getEscrow(escrowId: bigint) {
  return getPublicClient().readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "getEscrow",
    args: [escrowId],
  });
}

export async function getEscrowApplications(escrowId: bigint) {
  return getPublicClient().readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "getEscrowApplications",
    args: [escrowId],
  }) as Promise<`0x${string}`[]>;
}

export function explorerUrl(txHash: string): string {
  return `https://testnet.arcscan.app/tx/${txHash}`;
}
