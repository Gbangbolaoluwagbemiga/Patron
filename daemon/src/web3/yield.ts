/**
 * The productive-escrow controller — SecureFlowYield.
 *
 * WHY THIS IS A SEPARATE MODULE FROM secureflow.ts
 *
 * It is a separate CONTRACT. SecureFlow holds the money and exposes
 * yieldController(); the controller decides what, if any, of it is safe to put
 * to work. Patron shipped for weeks without an ABI for it at all, which is why
 * the yield surface the escrow has had attached the whole time was invisible to
 * the agent supposed to be managing it.
 *
 * WHAT OPTING IN ACTUALLY MEANS
 *
 * The contract's rules, not ours:
 *
 *   - only the escrow's DEPOSITOR may choose, which for Patron's own
 *     commissions is Patron;
 *   - the choice is ONE-WAY and permanent (ChoiceAlreadyMade), so a term
 *     offered to a freelancer can never be withdrawn;
 *   - the window closes when work starts or the escrow leaves Pending
 *     (TooLateToChoose), because after that somebody is relying on the terms.
 *
 * And the honest part: opting in is NOT the same as earning. An open job is
 * refundable in full by cancelJob at any instant, so its investable ceiling is
 * zero until a freelancer is assigned — and nothing can be deployed at all
 * unless a venue is configured for the token. On Arc mainnet today no venue is,
 * so every opted-in escrow correctly earns exactly nothing. See yieldState().
 */
import type { Abi } from "viem";
import yieldAbiJson from "./SecureFlowYieldABI.json" with { type: "json" };
import { config } from "../config.js";
import * as secureflow from "./secureflow.js";
import type { CircleSigner } from "../circle/circleSigner.js";

const yieldAbi = yieldAbiJson as Abi;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

/**
 * The controller address, asked of the escrow rather than configured.
 *
 * setYieldController is an owner call on the escrow, so the escrow is the only
 * thing that knows which controller is current. A second env var would be a
 * second source of truth that silently goes stale the moment one is swapped.
 */
let cached: `0x${string}` | null = null;
export async function controllerAddress(): Promise<`0x${string}` | null> {
  if (cached) return cached;
  try {
    const addr = (await secureflow.readContract("yieldController", [])) as `0x${string}`;
    if (!addr || addr === ZERO) return null;
    cached = addr;
    return addr;
  } catch {
    return null;
  }
}

async function read<T>(fn: string, args: unknown[] = []): Promise<T | null> {
  const addr = await controllerAddress();
  if (!addr) return null;
  try {
    return (await secureflow.client().readContract({
      address: addr,
      abi: yieldAbi,
      functionName: fn,
      args,
    })) as T;
  } catch {
    return null;
  }
}

export interface YieldState {
  /** Is a controller attached to the escrow at all? */
  controller: `0x${string}` | null;
  /** Has the depositor answered the question for this escrow yet? */
  choiceMade: boolean;
  /** Did they say yes? */
  optedIn: boolean;
  /** USDC currently out at the venue for this escrow. */
  deployed: number;
  /** USDC this escrow has earned so far. */
  earned: number;
  /** The venue for this escrow's token, or null when none is set. */
  venue: `0x${string}` | null;
  /** The freelancer's share of whatever is earned, as a percentage. */
  freelancerSharePct: number | null;
  /**
   * Can this escrow earn anything right now? False whenever there is no venue,
   * which on Arc mainnet is always — stated here so no caller has to infer it
   * from a zero that could equally mean "nothing yet".
   */
  canEarn: boolean;
}

export async function yieldState(escrowId: bigint): Promise<YieldState> {
  const controller = await controllerAddress();
  if (!controller) {
    return { controller: null, choiceMade: false, optedIn: false, deployed: 0, earned: 0, venue: null, freelancerSharePct: null, canEarn: false };
  }

  // The adapter map is keyed by TOKEN, and Arc escrows record USDC as the
  // ERC-20 precompile address rather than address(0). Both are checked because
  // native and the precompile are the same balance on Arc, and a venue
  // registered under either key is a venue.
  const [choiceMade, optedIn, deployed, earned, venueErc, venueNative, shareBP] = await Promise.all([
    read<boolean>("yieldChoiceMade", [escrowId]),
    read<boolean>("yieldOptIn", [escrowId]),
    read<bigint>("escrowDeployed", [escrowId]),
    read<bigint>("escrowYield", [escrowId]),
    read<`0x${string}`>("yieldAdapter", [config.usdcAddress]),
    read<`0x${string}`>("yieldAdapter", [ZERO]),
    read<bigint>("freelancerShareBP", []),
  ]);

  const venue = [venueErc, venueNative].find((v) => v && v !== ZERO) ?? null;

  return {
    controller,
    choiceMade: choiceMade ?? false,
    optedIn: optedIn ?? false,
    deployed: Number(deployed ?? 0n) / 1e6,
    earned: Number(earned ?? 0n) / 1e6,
    venue,
    freelancerSharePct: shareBP === null ? null : Number(shareBP) / 100,
    canEarn: !!venue,
  };
}

/** Is there a venue at all? Asked once, to decide whether opting in is worth a transaction. */
export async function venueConfigured(): Promise<boolean> {
  const [a, b] = await Promise.all([
    read<`0x${string}`>("yieldAdapter", [config.usdcAddress]),
    read<`0x${string}`>("yieldAdapter", [ZERO]),
  ]);
  return [a, b].some((v) => !!v && v !== ZERO);
}

/**
 * Put this escrow's idle budget to work, with the return shared with whoever
 * takes the job.
 *
 * Returns null when there is nothing to do — no controller, the question
 * already answered, or the window closed — rather than throwing, because none
 * of those is an error and a failed opt-in must never fail the commission that
 * triggered it. Money being locked correctly matters; earning on it is a bonus.
 */
export async function optIn(
  escrowId: bigint,
  as: CircleSigner,
): Promise<`0x${string}` | null> {
  const addr = await controllerAddress();
  if (!addr) return null;

  const already = await read<boolean>("yieldChoiceMade", [escrowId]);
  if (already) return null; // one-way by design; asking twice reverts

  const hash = await as.walletClient.writeContract({
    chain: secureflow.chain(),
    account: as.address,
    address: addr,
    abi: yieldAbi,
    functionName: "setYieldOptIn",
    args: [escrowId, true],
  });
  await secureflow.client().waitForTransactionReceipt({ hash });
  return hash;
}
