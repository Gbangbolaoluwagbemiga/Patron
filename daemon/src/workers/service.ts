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
import { config } from "../config.js";
import { dripGas, provisionWorkerWallet, workerBalance, withdrawTo } from "./wallets.js";

/**
 * An error whose message was written to be read by the person who caused it.
 *
 * The API sanitises errors before returning them, which is right for raw upstream
 * failures (a provider 401 has no business in an HTTP response) and wrong for
 * these: "that portfolio link doesn't look like a URL" is already the most useful
 * thing we could say, and it was being replaced with "Could not open this
 * commission. The failure has been logged." — unhelpful, and about a commission
 * on an endpoint that has nothing to do with commissions.
 */
export class UserFacingError extends Error {}

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
  if (!handle) throw new UserFacingError("A handle is required — it's the only thing you have to choose.");
  if (handle.length > 40) throw new UserFacingError("That handle is too long (40 characters max).");

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

export interface Quest {
  escrowId: string;
  title: string;
  budget: number;
  durationDays: number;
  criteria: string[];
  /** When applications close and the guild master judges them together. */
  closesAt: number;
  /** Only set when a worker was supplied — lets a surface hide "Apply" on ones they've taken. */
  alreadyApplied?: boolean;
}

/** Open commissions, optionally marked up for one worker. */
export function openQuests(): Quest[] {
  return store
    .listTasks(50)
    .filter((t) => t.status === "posted" && t.escrowId && t.briefJson)
    .map((t) => {
      const brief = JSON.parse(t.briefJson as string);
      const windowMinutes = (brief.applicationWindowMinutes as number | undefined) ?? config.applicationWindowMinutes;
      return {
        escrowId: t.escrowId as string,
        title: brief.title as string,
        budget: brief.budget as number,
        durationDays: brief.durationDays as number,
        criteria: (brief.criteria ?? []) as string[],
        closesAt: t.createdAt + windowMinutes * 60_000,
      };
    });
}

/**
 * The same board, marked with what this person has already applied to.
 *
 * Separate from openQuests() because it costs one chain read per job: the plain
 * list is used on every poll and by anonymous visitors, and making that pay for
 * a personalisation nobody asked for would be the wrong default.
 */
export async function openQuestsFor(workerId: string): Promise<Quest[]> {
  const worker = store.getWorker(workerId);
  const quests = openQuests();
  if (!worker?.walletAddress) return quests;
  const address = worker.walletAddress as `0x${string}`;
  return Promise.all(
    quests.map(async (q) => {
      try {
        return { ...q, alreadyApplied: await secureflow.hasApplied(BigInt(q.escrowId), address) };
      } catch {
        return q; // a chain hiccup must not empty someone's job board
      }
    }),
  );
}

function signerFor(worker: store.WorkerRow) {
  if (worker.mode === "own") {
    throw new UserFacingError(
      "You signed up with your own wallet, so Patron can't sign for you — apply from SecureFlow with your wallet and Patron will still see it.",
    );
  }
  if (!worker.walletAddress) throw new UserFacingError("No wallet on this account yet.");
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
  /**
   * A link to past work — portfolio, CV, Behance, a repo, anything.
   *
   * Testers asked for this: with only a text box, everyone sounds equally
   * confident and the only thing separating applicants is how well they write.
   * Someone with ten years of logos had no way to show it.
   *
   * A LINK rather than an upload, deliberately. Patron has no file storage, and
   * the obvious shortcut — accepting a Telegram upload and putting its URL
   * on-chain — would be a security hole: Telegram's file URLs embed the bot
   * token, so that would publish our credentials permanently on a public chain.
   * A link the applicant already controls is both safer and more durable.
   */
  portfolioUrl?: string,
): Promise<{ txHash: string }> {
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
  const letter = coverLetter.trim();
  if (!letter) throw new UserFacingError("Write a short note about why you're right for this one.");

  const portfolio = portfolioUrl?.trim();
  if (portfolio && !/^https?:\/\/\S+$/i.test(portfolio)) {
    throw new UserFacingError("That portfolio link doesn't look like a URL — it should start with http:// or https://");
  }

  // Check BEFORE spending their gas. The contract tracks this and would happily
  // record a second application: two rows on-chain for one person, gas paid
  // twice, and the scorer ranking someone against themselves.
  const signer = signerFor(worker);
  if (await secureflow.hasApplied(BigInt(escrowId), signer.address)) {
    throw new UserFacingError(
      "You've already applied to this one — the guild master has your application and will come back to you either way.",
    );
  }

  // Labelled rather than concatenated, so the scorer can tell the applicant's
  // own words from a link they provided, and so the link survives as something
  // readable on-chain and on SecureFlow's own interface.
  const full = portfolio ? `${letter}\n\nPast work: ${portfolio}` : letter;

  const txHash = await secureflow.applyToJob(BigInt(escrowId), full, BigInt(proposedTimelineDays), signer);
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
  if (!worker) throw new UserFacingError("Unknown worker.");
  const text = description.trim();
  if (!text) throw new UserFacingError("Describe what you're delivering, and include a link to the file.");

  const signer = signerFor(worker);
  try {
    await secureflow.startWork(BigInt(escrowId), signer);
  } catch {
    // already started — expected on every milestone after the first
  }
  const txHash = await secureflow.submitMilestone(BigInt(escrowId), BigInt(milestoneIndex), text, signer);
  return { txHash };
}

/**
 * Everything this person is involved in, and where it stands.
 *
 * Built from the decision log and task list rather than new bookkeeping — the
 * hire is already recorded there for the command center, so a worker's view of
 * their own jobs is a different reading of the same facts, not a second copy of
 * them that could drift.
 */
export async function myWork(
  workerId: string,
): Promise<{ escrowId: string; title: string; budget: number; status: string; icon: string }[]> {
  const worker = store.getWorker(workerId);
  if (!worker?.walletAddress) return [];
  const me = worker.walletAddress.toLowerCase();

  const hiredFor = new Set(
    store
      .listDecisions(300)
      .filter((d: { type?: string; target?: string }) => d.type === "applicant_accepted" && d.target?.toLowerCase() === me)
      .map((d: { task_id?: string }) => d.task_id),
  );

  const out: { escrowId: string; title: string; budget: number; status: string; icon: string }[] = [];
  for (const t of store.listTasks(100)) {
    if (!t.escrowId || !t.briefJson) continue;
    const hired = hiredFor.has(t.escrowId);
    let applied = false;
    if (!hired) {
      try {
        applied = await secureflow.hasApplied(BigInt(t.escrowId), worker.walletAddress as `0x${string}`);
      } catch {
        continue;
      }
    }
    if (!hired && !applied) continue;

    const brief = JSON.parse(t.briefJson);
    const [icon, status] = hired
      ? t.status === "completed"
        ? ["✅", "Finished and paid"]
        : t.status === "disputed"
          ? ["⚖️", "With a human arbiter"]
          : ["🔨", "You were hired — send your work with /submit " + t.escrowId]
      : t.status === "posted"
        ? ["⏳", "Applied, waiting on the guild master"]
        : ["—", "Applied, but someone else was hired"];

    out.push({ escrowId: t.escrowId, title: brief.title, budget: brief.budget, status, icon });
  }
  return out;
}

/** What they've earned. On Arc this is both their spendable balance and their gas. */
export async function balance(workerId: string): Promise<{ balance: string; address: string }> {
  const worker = store.getWorker(workerId);
  if (!worker?.walletAddress) throw new UserFacingError("Unknown worker.");
  return { balance: await workerBalance(worker.walletAddress as `0x${string}`), address: worker.walletAddress };
}

/** The escape hatch. A withdrawal, not a key export — see workers/wallets.ts. */
export async function withdraw(workerId: string, destination: `0x${string}`, amountUsdc?: string) {
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
  if (worker.mode === "own") throw new UserFacingError("You're already using your own wallet — the money is in it.");
  if (!worker.walletAddress) throw new UserFacingError("No wallet on this account yet.");
  return withdrawTo({ walletAddress: worker.walletAddress }, destination, amountUsdc);
}

/** Graduation: keep the account, move to self-custody. Mode A is a ramp, not a trap. */
export async function switchToOwnWallet(workerId: string, address: `0x${string}`) {
  const worker = store.getWorker(workerId);
  if (!worker) throw new UserFacingError("Unknown worker.");
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
