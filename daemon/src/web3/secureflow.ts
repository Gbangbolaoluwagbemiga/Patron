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
  /** uint8, 1–5. Clamped here rather than trusted — the contract would revert, and a
   *  revert on the rating would look like the payment itself failed. */
  score: number,
  review: string,
  as: CircleSigner = createCircleSigner(),
): Promise<`0x${string}`> {
  const clamped = Math.max(1, Math.min(5, Math.round(score)));
  return write("submitRating", [escrowId, clamped, review], as);
}

/**
 * Returns (averageX100, count) — the contract stores the average multiplied by
 * 100 to keep a fraction in an integer, so 470 means 4.70 stars over `count`
 * ratings. Reading it wrong by a factor of 100 would put "470 stars" on screen.
 */
export async function getAverageRating(who: `0x${string}`): Promise<{ average: number; count: number }> {
  const [averageX100, count] = (await getPublicClient().readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "getAverageRating",
    args: [who],
  })) as [bigint, bigint];
  return { average: Number(averageX100) / 100, count: Number(count) };
}

// ── Getting the money back out ──────────────────────────────────────────────
// These exist on the contract and were never wired, which left real funds
// stranded: a job that attracts no suitable applicant keeps its budget locked
// in escrow with no recovery path. Several of ours are sitting like that now.
//
// This matters beyond bookkeeping. Patron's central claim is that no machine in
// the chain can take your money — and the honest completion of that claim is
// that money nobody earned comes back, rather than staying locked forever
// because we never implemented the return path.

/**
 * Cancel an unfilled job and return its budget to whoever funded it.
 *
 * Only valid before a freelancer is hired — once someone is working, their
 * claim on the escrow is exactly what makes Patron trustworthy, and the
 * contract enforces that.
 */
export async function cancelJob(escrowId: bigint, as: CircleSigner = createCircleSigner()): Promise<`0x${string}`> {
  return write("cancelJob", [escrowId], as);
}

/**
 * What an arbiter actually awarded, in the contract's own words.
 *
 * Every previous version of the settlement inferred this. The first read the
 * brief and announced "$2.50 each" when the arbiter had awarded $1.25. The
 * second read `totalAmount` and concluded $3.70 had come back when nothing
 * had — `totalAmount` is not decremented for the client's share, so it cannot
 * answer this question either.
 *
 * SecureFlow emits the answer directly:
 *
 *   DisputeResolved(escrowId, milestoneIndex, arbiter, freelancerAmount,
 *                   clientAmount, timestamp)
 *
 * Two numbers, stated by the contract at the moment it moved the money, and
 * verifiable against the USDC Transfer log in the same block. There is nothing
 * left to infer.
 *
 * Scanned backwards in widening windows because the poller notices a
 * resolution within seconds of it landing — the event is almost always in the
 * most recent chunk, and the wider passes only exist so a daemon that was
 * asleep still finds it.
 */
export interface DisputeAward {
  milestoneIndex: number;
  freelancerAmount: number;
  clientAmount: number;
  blockNumber: bigint;
}

const DISPUTE_RESOLVED = {
  type: "event",
  name: "DisputeResolved",
  inputs: [
    { name: "escrowId", type: "uint256", indexed: true },
    { name: "milestoneIndex", type: "uint256", indexed: true },
    { name: "arbiter", type: "address", indexed: true },
    { name: "freelancerAmount", type: "uint256", indexed: false },
    { name: "clientAmount", type: "uint256", indexed: false },
    { name: "timestamp", type: "uint256", indexed: false },
  ],
} as const;

export async function disputeAwards(escrowId: bigint): Promise<DisputeAward[]> {
  const pc = getPublicClient();
  const head = await pc.getBlockNumber();
  const awards = new Map<number, DisputeAward>();

  // ~9k blocks is roughly two hours on Arc; the last window reaches back a week.
  for (const span of [9_000n, 90_000n, 900_000n]) {
    const fromBlock = head > span ? head - span : 0n;
    try {
      const logs = await pc.getLogs({
        address: config.secureflowAddress as `0x${string}`,
        event: DISPUTE_RESOLVED,
        args: { escrowId },
        fromBlock,
        toBlock: head,
      });
      for (const l of logs) {
        const a = l.args as { milestoneIndex?: bigint; freelancerAmount?: bigint; clientAmount?: bigint };
        if (a.clientAmount === undefined || a.freelancerAmount === undefined) continue;
        awards.set(Number(a.milestoneIndex ?? 0n), {
          milestoneIndex: Number(a.milestoneIndex ?? 0n),
          freelancerAmount: Number(a.freelancerAmount) / 1e6,
          clientAmount: Number(a.clientAmount) / 1e6,
          blockNumber: l.blockNumber ?? 0n,
        });
      }
      if (awards.size) break;
    } catch {
      // Providers cap log ranges; a refused window is not a missing award, so
      // fall through to the next span rather than reporting "nothing awarded".
    }
  }
  return [...awards.values()].sort((a, b) => a.milestoneIndex - b.milestoneIndex);
}

/** Last resort: reclaim after the deadline has passed, when a job stalled with work in progress. */
export async function emergencyRefundAfterDeadline(
  escrowId: bigint,
  as: CircleSigner = createCircleSigner(),
): Promise<`0x${string}`> {
  return write("emergencyRefundAfterDeadline", [escrowId], as);
}

export async function getEscrow(escrowId: bigint) {
  return getPublicClient().readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "getEscrow",
    args: [escrowId],
  });
}

/**
 * Has this address already applied to this job?
 *
 * Asked for by testers after they hit it: applying twice puts two applications
 * on-chain for one person, costs them gas twice, and gives the scorer the same
 * applicant to rank against themselves. The contract has always tracked this —
 * we simply never asked before letting someone spend a transaction.
 */
export async function hasApplied(escrowId: bigint, who: `0x${string}`): Promise<boolean> {
  return getPublicClient().readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "hasApplied",
    args: [escrowId, who],
  }) as Promise<boolean>;
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
