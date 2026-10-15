/**
 * CCTP v2 — paying a contractor on a chain other than the one we hold USDC on.
 *
 * WHY THIS EXISTS
 *
 * Patron settles on Arc because that is where the escrow is. A contractor does
 * not care: they want paying somewhere they already keep money, which is
 * usually Base, Arbitrum or Ethereum. Before this, "I don't use Arc" was the
 * end of the conversation.
 *
 * CCTP burns USDC here and mints native USDC there. It is not a bridge and
 * there is no wrapped asset, no liquidity pool and no bridge operator to trust:
 * Circle attests to the burn and the destination contract mints against that
 * attestation. The failure mode of a bridge — the pool is drained and your
 * wrapped token is worthless — does not exist.
 *
 * THE THREE STEPS, AND WHO DOES THEM
 *
 *   1. burn here      — approve + depositForBurn on Arc. This code.
 *   2. attest         — Circle observes the burn and signs it. Their API.
 *   3. mint there     — receiveMessage on the destination chain. Needs gas ON
 *                       THAT CHAIN, which Patron does not hold, so it is left
 *                       to the recipient or a relayer. burnForContractor()
 *                       returns everything needed to do it.
 *
 * Step 3 being someone else's problem is a real limitation and is stated
 * plainly rather than hidden: the money is burned and attested, and it is not
 * spendable until somebody mints it.
 */
import { encodeFunctionData, pad, type Abi } from "viem";
import { config, explorerTx } from "../config.js";
import * as secureflow from "./secureflow.js";
import type { CircleSigner } from "../circle/circleSigner.js";

/** Verified on Arc mainnet: localDomain() == 26, and the messenger is bound to both. */
export const ARC_DOMAIN = 26;
export const TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as const;
export const MESSAGE_TRANSMITTER = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as const;

/**
 * Circle's domain ids. These are CCTP's own numbering and have nothing to do
 * with EVM chain ids — Base is chain 8453 and domain 6 — so they are written
 * out rather than derived, and the name is what a contractor actually picks.
 */
export const DOMAINS: Record<string, number> = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  base: 6,
  polygon: 7,
  unichain: 10,
  linea: 11,
  arc: 26,
};

/**
 * Standard transfer. Fast (1000) costs a fee on most routes and settles in
 * seconds; standard waits for hard finality and is free. Both quote 0 on Arc
 * today, but defaulting to the free one cannot surprise anybody with a bill.
 */
export const FINALITY_STANDARD = 2000;
export const FINALITY_FAST = 1000;

const tokenMessengerAbi = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ type: "bool" }],
  },
] as const satisfies Abi;

const IRIS = "https://iris-api.circle.com";

export interface FeeQuote {
  finalityThreshold: number;
  minimumFeeBps: number;
}

/**
 * What Circle will charge to move USDC from here to `destinationDomain`.
 *
 * Asked rather than assumed. depositForBurn reverts if maxFee is below the
 * minimum for the chosen finality, so a hardcoded zero would work until the
 * day Circle starts charging and then fail every payout at once.
 */
export async function quoteFees(destinationDomain: number): Promise<FeeQuote[]> {
  const res = await fetch(`${IRIS}/v2/burn/USDC/fees/${ARC_DOMAIN}/${destinationDomain}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Circle fee quote failed: ${res.status}`);
  const rows = (await res.json()) as { finalityThreshold: number; minimumFee: number }[];
  return rows.map((r) => ({ finalityThreshold: r.finalityThreshold, minimumFeeBps: r.minimumFee }));
}

export interface BurnResult {
  txHash: `0x${string}`;
  explorerUrl: string;
  destinationDomain: number;
  /** Base units (6dp) actually burned. */
  amountUnits: bigint;
  maxFeeUnits: bigint;
  finalityThreshold: number;
  recipient: `0x${string}`;
}

/**
 * Burn USDC on Arc so it can be minted to `recipient` on another chain.
 *
 * `destinationCaller` is left as bytes32(0) on purpose: it restricts WHO may
 * call receiveMessage on the far side, and naming an address there would mean
 * only that address could complete the payout. Zero lets the contractor — or
 * anyone willing to pay the gas — finish it, which is the point.
 */
export async function burnForContractor(args: {
  recipient: `0x${string}`;
  amountUsdc: string;
  destination: string;
  as: CircleSigner;
  fast?: boolean;
}): Promise<BurnResult> {
  const domain = DOMAINS[args.destination.toLowerCase()];
  if (domain === undefined) {
    throw new Error(`Unknown destination "${args.destination}". Known: ${Object.keys(DOMAINS).join(", ")}`);
  }
  if (domain === ARC_DOMAIN) throw new Error("Destination is Arc — use an ordinary transfer, not CCTP.");

  const amountUnits = BigInt(Math.round(Number(args.amountUsdc) * 1e6));
  if (amountUnits <= 0n) throw new Error("Amount must be greater than zero.");

  const wanted = args.fast ? FINALITY_FAST : FINALITY_STANDARD;
  const quotes = await quoteFees(domain);
  const quote = quotes.find((q) => q.finalityThreshold === wanted) ?? quotes[0];
  if (!quote) throw new Error(`Circle quoted no fee tiers for domain ${domain}.`);

  // minimumFee is in basis points of the amount. Rounded UP, because a maxFee
  // one unit below what the contract wants reverts the whole burn.
  const maxFeeUnits = (amountUnits * BigInt(quote.minimumFeeBps) + 9_999n) / 10_000n;
  if (maxFeeUnits >= amountUnits) {
    throw new Error(`Fee (${maxFeeUnits}) would consume the whole payout (${amountUnits}). Send more, or use standard finality.`);
  }

  const client = secureflow.client();

  // CCTP pulls the tokens, so it needs an allowance. Exact amount, never
  // maxUint256 — same rule as the escrow approve.
  const approveHash = await args.as.walletClient.writeContract({
    chain: secureflow.chain(),
    account: args.as.address,
    address: config.usdcAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [TOKEN_MESSENGER, amountUnits],
  });
  await client.waitForTransactionReceipt({ hash: approveHash });

  const txHash = await args.as.walletClient.writeContract({
    chain: secureflow.chain(),
    account: args.as.address,
    address: TOKEN_MESSENGER,
    abi: tokenMessengerAbi,
    functionName: "depositForBurn",
    args: [
      amountUnits,
      domain,
      pad(args.recipient, { size: 32 }),
      config.usdcAddress,
      pad("0x0000000000000000000000000000000000000000", { size: 32 }),
      maxFeeUnits,
      quote.finalityThreshold,
    ],
  });
  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`depositForBurn reverted (${txHash})`);

  return {
    txHash,
    explorerUrl: explorerTx(txHash),
    destinationDomain: domain,
    amountUnits,
    maxFeeUnits,
    finalityThreshold: quote.finalityThreshold,
    recipient: args.recipient,
  };
}

export interface Attestation {
  status: string;
  /** Present once Circle has signed. Both are needed by receiveMessage. */
  message?: `0x${string}`;
  attestation?: `0x${string}`;
  eventNonce?: string;
}

/**
 * Ask Circle whether the burn has been attested yet.
 *
 * Returns the pending status rather than throwing while it waits, so a caller
 * can show "still settling" instead of "failed" — the two look identical from
 * the outside and only one of them is a problem.
 */
export async function attestationFor(burnTxHash: string): Promise<Attestation> {
  const res = await fetch(`${IRIS}/v2/messages/${ARC_DOMAIN}?transactionHash=${burnTxHash}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return { status: "pending_confirmations" };
  if (!res.ok) throw new Error(`Circle attestation lookup failed: ${res.status}`);
  const body = (await res.json()) as { messages?: Attestation[] };
  const first = body.messages?.[0];
  if (!first) return { status: "pending_confirmations" };

  /*
   * "PENDING" IS NOT AN ATTESTATION.
   *
   * While Circle is still waiting on finality it returns the message row with
   * the attestation field set to the literal string "PENDING". That is truthy,
   * so `if (att.attestation)` reads as signed — a caller then builds
   * receiveMessage calldata out of the word PENDING, and a test that polls
   * until it is set exits immediately and reports success.
   *
   * That happened on the first mainnet burn. Normalising it here means no
   * caller can make that mistake: unsigned is undefined.
   */
  const signed = typeof first.attestation === "string" && first.attestation.startsWith("0x");
  return signed ? first : { ...first, attestation: undefined, message: undefined };
}

/** Has Circle actually signed this one? The only question worth asking. */
export function isAttested(a: Attestation): boolean {
  return typeof a.attestation === "string" && a.attestation.startsWith("0x") && !!a.message;
}

/** The call the recipient (or a relayer) makes on the destination chain. */
export function mintCalldata(a: Attestation): { to: string; data: `0x${string}` } | null {
  if (!a.message || !a.attestation) return null;
  return {
    to: "MessageTransmitterV2 on the destination chain",
    data: encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "receiveMessage",
          stateMutability: "nonpayable",
          inputs: [{ name: "message", type: "bytes" }, { name: "attestation", type: "bytes" }],
          outputs: [{ type: "bool" }],
        },
      ] as const satisfies Abi,
      functionName: "receiveMessage",
      args: [a.message, a.attestation],
    }),
  };
}
