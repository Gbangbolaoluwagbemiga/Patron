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
import { createCircleSigner, type CircleSigner } from "../circle/circleSigner.js";

// Cast to viem's `Abi` type (not a tighter `as const` literal, since this is loaded
// from JSON) so `writeContract` can still resolve stateMutability (payable vs not)
// and accept `value` on `createEscrow` — a looser `unknown[]` cast defeats that.
const abi = secureFlowAbi as Abi;

// Arc's USDC precompile (config.usdcAddress) is a non-zero address, so SecureFlow's
// createEscrow treats it as an ERC20 (NATIVE_TOKEN in the contract is address(0) —
// see SecureFlow.sol): it requires msg.value === 0 and pulls funds itself via
// safeTransferFrom, which needs a prior `approve`. quoteDeposit's return is already
// in the token's own 6-decimal units — it is NOT a native `value` to attach.
const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

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
/**
 * Returns the new escrow id AND the creating transaction hash. The hash used to
 * be discarded, which meant the moment the money is actually locked — the
 * single most important payment in the whole story, and the one the pitch tells
 * a judge to click through to Arcscan — was never recorded in the payment feed
 * at all. Every "Locked in Escrow" row that ever appeared there came from an
 * unrelated event falling through a catch-all.
 */
export async function createEscrow(params: CreateEscrowParams): Promise<{ escrowId: bigint; txHash: `0x${string}` }> {
  const signer = createCircleSigner();
  const client = getPublicClient();

  const [deposit] = (await client.readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "quoteDeposit",
    args: [params.totalAmount],
  })) as [bigint, bigint];

  // Approve SecureFlow to pull `deposit` (totalAmount + platform fee, in USDC's own
  // 6-decimal units) via safeTransferFrom — required before createEscrow will accept
  // a non-native token; sending it as msg.value instead reverts with InvalidAmount.
  const approveHash = await signer.walletClient.writeContract({
    chain: arcTestnet,
    account: signer.address,
    address: config.usdcAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [config.secureflowAddress, deposit],
  });
  await client.waitForTransactionReceipt({ hash: approveHash });

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
  return { escrowId: nextId - 1n, txHash: hash };
}

/**
 * Every SecureFlow write, funnelled through one place.
 *
 * `as` is who signs. It defaults to the Patron treasury, which is what every
 * call site did implicitly before — Patron's own actions (hiring, approving,
 * rejecting, escalating) are unchanged and still go out as Patron.
 *
 * Passing a different signer is what the managed-worker layer needs: applying
 * to a job and submitting work must be signed BY THE FREELANCER, because
 * SecureFlow authorises those on `msg.sender`. Patron cannot apply on someone's
 * behalf from its own wallet — the contract would record Patron as the
 * applicant. So the worker's own Circle wallet signs, on their instruction.
 */
async function write(
  functionName: string,
  args: readonly unknown[],
  as: CircleSigner = createCircleSigner(),
): Promise<`0x${string}`> {
  const hash = await as.walletClient.writeContract({
    chain: arcTestnet,
    account: as.address,
    address: config.secureflowAddress,
    abi,
    functionName,
    args: args as unknown[],
  });
  await getPublicClient().waitForTransactionReceipt({ hash });
  return hash;
}

// ── Patron's own actions (signed by the treasury) ───────────────────────────

export async function acceptFreelancer(escrowId: bigint, freelancer: `0x${string}`): Promise<`0x${string}`> {
  return write("acceptFreelancer", [escrowId, freelancer]);
}

export async function approveMilestone(escrowId: bigint, milestoneIndex: bigint): Promise<`0x${string}`> {
  return write("approveMilestone", [escrowId, milestoneIndex]);
}

export async function rejectMilestone(escrowId: bigint, milestoneIndex: bigint, reason: string): Promise<`0x${string}`> {
  return write("rejectMilestone", [escrowId, milestoneIndex, reason]);
}

/** Human-arbiter escalation path — Patron's one-way key can never do this itself; it only calls it after max revisions. */
export async function disputeMilestone(escrowId: bigint, milestoneIndex: bigint, reason: string): Promise<`0x${string}`> {
  return write("disputeMilestone", [escrowId, milestoneIndex, reason]);
}

// ── A freelancer's own actions (signed by THEIR wallet) ─────────────────────
// SecureFlow authorises each of these on msg.sender, so the signer here is the
// freelancer, never Patron. In managed mode that wallet is a Circle MPC wallet
// Patron provisioned for them; in bring-your-own mode these never run at all
// because the freelancer signs from their own wallet via SecureFlow's dApp.

export async function applyToJob(
  escrowId: bigint,
  coverLetter: string,
  proposedTimelineDays: bigint,
  as: CircleSigner,
): Promise<`0x${string}`> {
  return write("applyToJob", [escrowId, coverLetter, proposedTimelineDays], as);
}

export async function startWork(escrowId: bigint, as: CircleSigner): Promise<`0x${string}`> {
  return write("startWork", [escrowId], as);
}

export async function submitMilestone(
  escrowId: bigint,
  milestoneIndex: bigint,
  description: string,
  as: CircleSigner,
): Promise<`0x${string}`> {
  return write("submitMilestone", [escrowId, milestoneIndex, description], as);
}

/**
 * On-chain reputation. Present in the ABI and previously unused — this is what
 * makes Patron's reputation real rather than derived: humans and clients rating
 * each other on the contract, readable by anyone, not computed from our own
 * database.
 */
export async function submitRating(
  escrowId: bigint,
  rating: bigint,
  comment: string,
  as: CircleSigner = createCircleSigner(),
): Promise<`0x${string}`> {
  return write("submitRating", [escrowId, rating, comment], as);
}

export async function getAverageRating(who: `0x${string}`): Promise<bigint> {
  return getPublicClient().readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "getAverageRating",
    args: [who],
  }) as Promise<bigint>;
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
