// service.ts — everything a human can do, independent of how they reached us.
//
// This is the actual feature. The web page and the Telegram bot are both thin
// shells over these five functions; neither knows anything the other doesn't.
// Keeping the surface out of here is what makes the second door cost a day
// instead of a week, and what lets us change our minds about surfaces later.
//
// The architectural property that makes all of this cheap: Patron's poller reads
// the SecureFlow subgraph, not a list of applicants it maintains. It has no idea
// who produced an application. So a worker applying through this service flows
// into reviewApplications → acceptFreelancer → reviewMilestone → approveMilestone
// with zero changes to the scorer, the reviewer, the agent, the store, the SSE
// stream, or the frontend. The guild master genuinely cannot tell which door
// someone came through — and doesn't need to.

import crypto from "node:crypto";
import * as store from "../store.js";
import * as secureflow from "../web3/secureflow.js";
import { createSignerFor } from "../circle/circleSigner.js";
import { dripGas, provisionWorkerWallet, workerBalance, withdrawTo } from "./wallets.js";

export interface JoinParams {
  handle: string;
  channel: "web" | "telegram";
  channelRef?: string;
  skills?: string;
  /** Bring-your-own-wallet: they already have an address and will sign for themselves. */
  ownAddress?: `0x${string}`;
}

/**
 * Join the guild.
 *
 * Managed mode (the default) provisions a real MPC wallet and drips enough for
 * gas, and the person is never told either happened — because why would you tell
 * them. Bring-your-own mode records their address and provisions nothing; for
 * those users Patron is a notifier and coordinator, never a custodian.
 */
export async function join(params: JoinParams): Promise<store.WorkerRow> {
  const handle = params.handle.trim();
  if (!handle) throw new Error("A handle is required — it's the only thing you have to choose.");
  if (handle.length > 40) throw new Error("That handle is too long (40 characters max).");

  if (params.channelRef) {
    const existing = store.getWorkerByChannelRef(params.channel, params.channelRef);
    if (existing) return existing; // idempotent: tapping "join" twice is not two people
  }

  const id = crypto.randomUUID();

  if (params.ownAddress) {
    return store.insertWorker({
      id,
      handle,
      channel: params.channel,
      channelRef: params.channelRef ?? null,
      skills: params.skills ?? null,
      walletId: null,
      walletAddress: params.ownAddress,
      mode: "own",
    });
  }

  const wallet = await provisionWorkerWallet();
  const worker = store.insertWorker({
    id,
    handle,
    channel: params.channel,
    channelRef: params.channelRef ?? null,
    skills: params.skills ?? null,
    walletId: wallet.walletId,
    walletAddress: wallet.address,
    mode: "managed",
  });

  // Non-blocking: they are a real worker the moment the row exists. If the drip
  // fails they'll hit it when they act, which is a far better place to surface
  // it than the front door.
  void dripGas(wallet.address);

  return worker;
}

/** Open commissions a worker can actually apply to, with the ones they've already applied to marked. */
export function openQuests(): { escrowId: string; title: string; budget: number; durationDays: number; criteria: string[] }[] {
  return store
    .listTasks(50)
    .filter((t) => t.status === "posted" && t.escrowId && t.briefJson)
    .map((t) => {
      const brief = JSON.parse(t.briefJson as string);
      return {
        escrowId: t.escrowId as string,
        title: brief.title as string,
        budget: brief.budget as number,
        durationDays: brief.durationDays as number,
        criteria: (brief.criteria ?? []) as string[],
      };
    });
}

function signerFor(worker: store.WorkerRow) {
  if (worker.mode === "own") {
    throw new Error(
      "You signed up with your own wallet, so Patron can't sign for you — apply from SecureFlow with your wallet and Patron will still see it.",
    );
  }
  if (!worker.walletAddress) throw new Error("No wallet on this account yet.");
  return createSignerFor(worker.walletAddress as `0x${string}`);
}

/**
 * Apply to a commission.
 *
 * The freelancer's OWN wallet signs this, not Patron's — SecureFlow authorises
 * applyToJob on msg.sender, so an application signed by Patron would record
 * Patron as the applicant. Their tap is the instruction; Patron is the broker
 * executing it in their name.
 */
export async function apply(
  workerId: string,
  escrowId: string,
  coverLetter: string,
  proposedTimelineDays: number,
): Promise<{ txHash: string }> {
  const worker = store.getWorker(workerId);
  if (!worker) throw new Error("Unknown worker.");
  const letter = coverLetter.trim();
  if (!letter) throw new Error("Write a short note about why you're right for this one.");

  const txHash = await secureflow.applyToJob(BigInt(escrowId), letter, BigInt(proposedTimelineDays), signerFor(worker));
  return { txHash };
}

/**
 * Submit finished work for a milestone.
 *
 * `startWork` is called first and its failure swallowed on purpose: SecureFlow
 * requires the lifecycle step, but it reverts if the job is already in progress,
 * and a worker submitting their second milestone should not be shown a contract
 * error about a state transition that already happened.
 */
export async function submit(
  workerId: string,
  escrowId: string,
  milestoneIndex: number,
  description: string,
): Promise<{ txHash: string }> {
  const worker = store.getWorker(workerId);
  if (!worker) throw new Error("Unknown worker.");
  const text = description.trim();
  if (!text) throw new Error("Describe what you're delivering, and include a link to the file.");

  const signer = signerFor(worker);
  try {
    await secureflow.startWork(BigInt(escrowId), signer);
  } catch {
    // already started — expected on every milestone after the first
  }
  const txHash = await secureflow.submitMilestone(BigInt(escrowId), BigInt(milestoneIndex), text, signer);
  return { txHash };
}

/** What they've earned. On Arc this is both their spendable balance and their gas. */
export async function balance(workerId: string): Promise<{ balance: string; address: string }> {
  const worker = store.getWorker(workerId);
  if (!worker?.walletAddress) throw new Error("Unknown worker.");
  return { balance: await workerBalance(worker.walletAddress as `0x${string}`), address: worker.walletAddress };
}

/** The escape hatch. A withdrawal, not a key export — see workers/wallets.ts. */
export async function withdraw(workerId: string, destination: `0x${string}`, amountUsdc?: string) {
  const worker = store.getWorker(workerId);
  if (!worker) throw new Error("Unknown worker.");
  if (worker.mode === "own") throw new Error("You're already using your own wallet — the money is in it.");
  if (!worker.walletAddress) throw new Error("No wallet on this account yet.");
  return withdrawTo({ walletAddress: worker.walletAddress }, destination, amountUsdc);
}

/** Graduation: keep the account, move to self-custody. Mode A is a ramp, not a trap. */
export async function switchToOwnWallet(workerId: string, address: `0x${string}`) {
  const worker = store.getWorker(workerId);
  if (!worker) throw new Error("Unknown worker.");
  if (worker.mode === "managed" && worker.walletAddress) {
    // Sweep what they've earned before switching, or it's stranded in a wallet
    // they've just stopped using.
    try {
      await withdrawTo({ walletAddress: worker.walletAddress }, address);
    } catch {
      // nothing to sweep, or nothing worth the gas — the switch still stands
    }
  }
  store.setWorkerOwnWallet(workerId, address);
  return store.getWorker(workerId)!;
}
