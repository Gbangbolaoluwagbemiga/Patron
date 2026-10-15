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

import { createPublicClient, http, zeroAddress, type Abi, type AbiEvent, type PublicClient } from "viem";
import secureFlowAbi from "./SecureFlowABI.json" with { type: "json" };
import { arcTestnet, config, explorerTx, rpcUrl } from "../config.js";
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

/**
 * Arc's RPC refuses any getLogs range wider than this. Measured, not guessed:
 * 9,000 blocks is accepted and 90,000 is rejected outright.
 *
 * The first version of this asked for 90k and 900k windows, got "RPC Request
 * failed" for both, swallowed it in a catch, and returned "no awards" — so the
 * settlement it fed looked like it worked and silently did nothing at all. A
 * range limit has to be respected by chunking, never by asking for more and
 * hoping.
 */
const LOG_WINDOW = 9_000n;

/**
 * The widest getLogs range this RPC will actually serve, discovered at runtime.
 *
 * WHY THIS IS NOT A CONSTANT
 *
 * It was one, set to 9,000 and documented as "measured, not guessed". The
 * measurement was real — and taken against a different endpoint than the one
 * ARC_RPC_URL points at. On the configured dRPC node, 9,000 is refused and
 * ~100 is the ceiling, so EVERY log scan in this file failed, was swallowed by
 * the catch below, and reported "nothing found".
 *
 * That is not a cosmetic bug. `disputeAwards` reads the DisputeResolved event to
 * decide how a disputed escrow is split, and it is the only authority on that
 * split. A silent empty answer there is a settlement computed from no evidence.
 *
 * A measured constant is a fact about one provider, not about the protocol. So
 * the width is now a question asked of whatever node we are actually talking
 * to: start wide, halve on refusal, remember what worked.
 */
const LOG_WINDOW_FLOOR = 50n;
let workingWindow: bigint | null = null;

/** True when the last chunked scan had a window refused outright. */
export interface ScanHealth {
  /** Windows the RPC refused even at the floor width — ranges never actually examined. */
  blindWindows: number;
}

/**
 * getLogs with the range the node will serve, rather than the range we wish it would.
 *
 * Narrows on refusal and keeps the working width for later calls. A refusal that
 * survives all the way down to the floor is reported to the caller rather than
 * returned as an empty list, because "I looked and there was nothing" and "I was
 * not allowed to look" are different answers and only one of them is safe to act on.
 */
/** The only parts of a decoded log this file ever reads. */
type DecodedLog = { args: Record<string, unknown>; blockNumber: bigint | null };

/**
 * The block at (or just before) a timestamp, by bisection.
 *
 * WHY A SEARCH IS WORTH 25 RPC CALLS
 *
 * Every scan in this file used to start at the chain head and walk backwards,
 * which silently assumes the thing we are looking for happened recently. For a
 * dispute that is true — the poller reacts within seconds. For an APPLICATION it
 * is false: the applicants on a job whose window closed three weeks ago are
 * three weeks back, and at 9,000 blocks a window that is 24 chunks of walking to
 * reach the first one. The first version of this did exactly that, hit its
 * request cap on every escrow, and read nothing while looking busy.
 *
 * An escrow knows roughly when it happened — its applications all precede its
 * deadline — so anchoring the walk there turns a hopeless sweep into two or
 * three queries.
 */
async function blockAtTimestamp(target: bigint): Promise<bigint> {
  const pc = getPublicClient();
  let lo = 0n;
  let hi = await pc.getBlockNumber();
  const headBlock = await pc.getBlock({ blockNumber: hi });
  if (headBlock.timestamp <= target) return hi;

  // 48 iterations covers any chain height we will ever see; the loop exits on
  // convergence long before that.
  for (let i = 0; i < 48 && lo < hi; i++) {
    const mid = (lo + hi) / 2n;
    if (mid === lo) break;
    const b = await pc.getBlock({ blockNumber: mid });
    if (b.timestamp < target) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function getLogsChunked(
  event: AbiEvent,
  args: Record<string, unknown> | undefined,
  spanBlocks: bigint,
  onLogs: (logs: DecodedLog[]) => boolean | void,
  /** Walk back from here instead of the chain head. */
  anchorBlock?: bigint,
): Promise<ScanHealth> {
  const pc = getPublicClient();
  const chainHead = await pc.getBlockNumber();
  const head = anchorBlock !== undefined && anchorBlock < chainHead ? anchorBlock : chainHead;
  const earliest = head > spanBlocks ? head - spanBlocks : 0n;
  let blindWindows = 0;
  let toBlock = head;

  /*
   * A ceiling on requests, not on blocks.
   *
   * The span asked for is expressed in blocks, but the width we get is the
   * node's to decide. On an endpoint that caps ranges at ~100 blocks, covering
   * a day of history would be two thousand sequential calls — so the honest
   * outcome there is a short scan that REPORTS it was short, not a poller that
   * hangs for ten minutes on every pass.
   */
  const MAX_REQUESTS = 64;
  let requests = 0;

  while (toBlock > earliest) {
    if (requests++ >= MAX_REQUESTS) {
      // Ran out of budget before reaching the far end of the span. The unscanned
      // remainder was never examined, which is exactly what blindWindows means.
      blindWindows++;
      break;
    }
    let width = workingWindow ?? LOG_WINDOW;
    let logs: DecodedLog[] | null = null;

    while (logs === null) {
      const fromBlock = toBlock > width ? toBlock - width + 1n : 0n;
      try {
        logs = (await pc.getLogs({
          address: config.secureflowAddress as `0x${string}`,
          event,
          ...(args ? { args } : {}),
          fromBlock,
          toBlock,
        } as Parameters<PublicClient["getLogs"]>[0])) as unknown as DecodedLog[];
        workingWindow = width; // this width works here — stop rediscovering it
      } catch {
        if (width <= LOG_WINDOW_FLOOR) {
          // Cannot see this range at any width. Say so; do not call it empty.
          blindWindows++;
          break;
        }
        width = width / 2n > LOG_WINDOW_FLOOR ? width / 2n : LOG_WINDOW_FLOOR;
      }
    }

    const consumedWidth = workingWindow ?? LOG_WINDOW;
    if (logs && onLogs(logs) === true) break; // caller has what it needs
    toBlock = toBlock > consumedWidth ? toBlock - consumedWidth : 0n;
    if (toBlock === 0n) break;
  }

  return { blindWindows };
}

/** ~1.94 blocks/sec on Arc, so one window is roughly 75 minutes. */
export const CHUNKS_PER_DAY = 12;

async function scanDisputes(
  chunks: number,
  escrowId?: bigint,
): Promise<{ found: Map<string, Map<number, DisputeAward>>; health: ScanHealth }> {
  const found = new Map<string, Map<number, DisputeAward>>();

  const health = await getLogsChunked(
    DISPUTE_RESOLVED,
    escrowId === undefined ? undefined : { escrowId },
    LOG_WINDOW * BigInt(chunks),
    (logs) => {
      for (const l of logs) {
        const a = l.args as { escrowId?: bigint; milestoneIndex?: bigint; freelancerAmount?: bigint; clientAmount?: bigint };
        if (a.clientAmount === undefined || a.freelancerAmount === undefined) continue;
        const key = String(a.escrowId ?? escrowId ?? "");
        const forEscrow = found.get(key) ?? new Map<number, DisputeAward>();
        const idx = Number(a.milestoneIndex ?? 0n);
        forEscrow.set(idx, {
          milestoneIndex: idx,
          freelancerAmount: Number(a.freelancerAmount) / 1e6,
          clientAmount: Number(a.clientAmount) / 1e6,
          blockNumber: l.blockNumber ?? 0n,
        });
        found.set(key, forEscrow);
      }
      // Looking for one escrow and we have it: stop. A sweep keeps going.
      return escrowId !== undefined && found.size > 0;
    },
  );

  return { found, health };
}

/**
 * What the arbiter awarded on one escrow.
 *
 * A day deep by default. The poller notices a resolution within seconds, so the
 * award is nearly always in the newest window and the scan stops there — but a
 * daemon that was restarting when the arbiter ruled would otherwise never look
 * far enough back to find it, and the settlement would hang forever on an
 * escrow whose money had already moved. This costs a few seconds, and only
 * while a dispute is actually waiting to be settled.
 */
export async function disputeAwards(escrowId: bigint, chunks = CHUNKS_PER_DAY): Promise<DisputeAward[]> {
  const { found, health } = await scanDisputes(chunks, escrowId);
  const forEscrow = found.get(String(escrowId));

  /*
   * An empty result from a scan that could not see is not "no award".
   *
   * This event is the ONLY authority on how a disputed escrow was split, and
   * the caller turns the answer into the figures a client and a freelancer are
   * each told they received. Returning [] after the RPC refused every range
   * would have those numbers derived from an absence of evidence — which is how
   * a $1.25/$1.25 split once got reported as $3.70.
   *
   * So this throws, and the poller's existing retry treats it as what it is: a
   * read that has not happened yet.
   */
  if (!forEscrow && health.blindWindows > 0) {
    throw new Error(
      `cannot read DisputeResolved for escrow ${escrowId}: ${health.blindWindows} block range(s) refused by this RPC`,
    );
  }

  return forEscrow ? [...forEscrow.values()].sort((a, b) => a.milestoneIndex - b.milestoneIndex) : [];
}

/**
 * Every award in recent history, keyed by escrow — one sweep for all of them.
 *
 * Used by the boot backfill, where asking per-escrow would multiply the same
 * chunked scan by the number of commissions.
 */
export async function recentDisputeAwards(chunks: number): Promise<Map<string, DisputeAward[]>> {
  const { found } = await scanDisputes(chunks);
  return new Map(
    [...found.entries()].map(([id, byIndex]) => [id, [...byIndex.values()].sort((a, b) => a.milestoneIndex - b.milestoneIndex)]),
  );
}

/**
 * Escalate a commission that has run past its deadline to a human arbiter.
 *
 * The path that was missing. A job whose delivery window has elapsed cannot be
 * cancelled (a freelancer has a claim) and cannot be emergency-refunded for
 * another 30 days — so nine commissions holding $79.60 sat "overdue" with no
 * route to resolution at all. SecureFlow built this for exactly that case.
 *
 * It does NOT refund. It hands the decision to a person, which is correct: a
 * freelancer who is late but delivered something should not be ruled against
 * automatically.
 */
export async function raiseOverdueDispute(
  escrowId: bigint,
  reason: string,
  as: CircleSigner = createCircleSigner(),
): Promise<`0x${string}`> {
  return write("raiseOverdueDispute", [escrowId, reason.slice(0, 500)], as);
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

/** How many escrows the contract has ever created. The authoritative list of what exists. */
export async function nextEscrowId(): Promise<bigint> {
  return (await getPublicClient().readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "nextEscrowId",
  })) as bigint;
}

/** Every milestone with its amount and status — the only reliable answer to "is money still at stake". */
export async function getMilestones(escrowId: bigint) {
  return getPublicClient().readContract({
    address: config.secureflowAddress,
    abi,
    functionName: "getMilestones",
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

const APPLICATION_SUBMITTED = {
  type: "event",
  name: "ApplicationSubmitted",
  inputs: [
    { name: "escrowId", type: "uint256", indexed: true },
    { name: "freelancer", type: "address", indexed: true },
    { name: "coverLetter", type: "string", indexed: false },
    { name: "proposedTimeline", type: "uint256", indexed: false },
  ],
} as const;

export interface ChainApplication {
  freelancerAddress: `0x${string}`;
  /**
   * null means "we could not read it", NEVER "they wrote nothing".
   *
   * The distinction is the whole point. An empty string handed to the scorer is
   * an applicant with no case for themselves, which scores near zero — so a log
   * window the RPC happened to refuse would quietly become a rejection on
   * merit. Unreadable is our limitation, not theirs, and the caller is made to
   * say what it wants done about it.
   */
  coverLetter: string | null;
  proposedTimeline: number | null;
  blockNumber: bigint | null;
}

/**
 * Who applied to a job, read from the chain instead of the subgraph.
 *
 * WHY THIS EXISTS
 *
 * Hiring — the single most consequential thing Patron does — ran entirely
 * through a Goldsky subgraph. That made a hosted index a hard dependency of
 * deciding who gets paid, and it indexed exactly one deployment: repointing the
 * contract silently emptied the applicant list, which does not read as an
 * outage. It reads as "nobody applied", and the honest-looking consequence is
 * that Patron hires no one and the job quietly expires.
 *
 * The contract already holds both halves of the answer:
 *
 *   - the roster is STORED (`escrowApplications`), so it is exact and cheap
 *   - the cover letter is only EMITTED, so it comes from ApplicationSubmitted
 *
 * The roster is therefore the authority on who applied, and the logs merely
 * enrich it. A refused or short log window can cost us a cover letter; it can
 * no longer cost us an applicant.
 */
export async function getApplications(escrowId: bigint, chunks = CHUNKS_PER_DAY * 2): Promise<ChainApplication[]> {
  const roster = await getEscrowApplications(escrowId);
  if (!roster.length) return [];

  const byAddress = new Map<string, ChainApplication>(
    roster.map((a) => [a.toLowerCase(), { freelancerAddress: a, coverLetter: null, proposedTimeline: null, blockNumber: null }]),
  );

  let missing = roster.length;

  /*
   * Anchor the walk at the escrow's own deadline, not at the chain head.
   *
   * Applications are only possible while a job is open, which is strictly
   * before its deadline — so the deadline is an upper bound on where they can
   * be, and for any job that is not brand new it is a far tighter one than
   * "now". A job whose window closed weeks ago is found in two queries from
   * here and was unreachable from the head.
   *
   * Falls back to the head if the deadline cannot be read, which is the old
   * behaviour and still correct for a job posted minutes ago.
   */
  let anchor: bigint | undefined;
  try {
    const esc = (await getEscrow(escrowId)) as { deadline?: bigint };
    const deadline = esc?.deadline ?? 0n;
    // +1 hour of slack: the deadline is a timestamp, and the last application
    // can share a block with it.
    if (deadline > 0n) anchor = await blockAtTimestamp(deadline + 3600n);
  } catch {
    /* no anchor — scan from the head as before */
  }

  const health = await getLogsChunked(APPLICATION_SUBMITTED, { escrowId }, LOG_WINDOW * BigInt(chunks), (logs) => {
    for (const l of logs) {
      const a = l.args as { freelancer?: `0x${string}`; coverLetter?: string; proposedTimeline?: bigint };
      if (!a.freelancer) continue;
      const row = byAddress.get(a.freelancer.toLowerCase());
      // Only addresses on the stored roster count. A log for anyone else is not
      // an applicant on this job, whatever it says.
      if (!row || row.coverLetter !== null) continue;
      row.coverLetter = a.coverLetter ?? "";
      row.proposedTimeline = a.proposedTimeline === undefined ? null : Number(a.proposedTimeline);
      row.blockNumber = l.blockNumber ?? null;
      missing--;
    }
    return missing === 0; // everyone accounted for — stop walking back
  }, anchor);

  if (missing > 0 && health.blindWindows > 0) {
    console.warn(
      `[secureflow] escrow ${escrowId}: ${missing} cover letter(s) unread and ` +
        `${health.blindWindows} block range(s) could not be queried on this RPC — ` +
        `these applicants are UNASSESSED, not unqualified.`,
    );
  }

  return [...byAddress.values()];
}

export function explorerUrl(txHash: string): string {
  return explorerTx(txHash);
}
