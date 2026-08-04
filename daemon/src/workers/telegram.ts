// telegram.ts — the second door into the worker layer.
//
// This is a shell. Every action it performs is a call into workers/service.ts,
// the same functions the /work page calls. That is the whole point of having
// built the layer first: this file adds a surface, not a feature, and if it
// were deleted tomorrow nothing else would change.
//
// Long-polling (getUpdates) rather than webhooks, deliberately: no public
// callback URL, no second service, no inbound port. It runs inside the daemon
// that is already deployed, needing nothing but a bot token — and if that token
// is absent the bot simply doesn't start and the rest of Patron is unaffected.

import * as store from "../store.js";
import * as workers from "./service.js";
import * as secureflow from "../web3/secureflow.js";
import { config } from "../config.js";
import { llmPaused, llmPauseRemaining } from "../llm-status.js";

const API = (method: string) => `https://api.telegram.org/bot${config.telegramBotToken}/${method}`;

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number };
  text?: string;
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
}

/**
 * What the bot is waiting for from a given chat.
 *
 * In-memory on purpose, and worth saying why given how much state in this
 * project was moved INTO SQLite this week: the difference is consequence.
 * A half-typed cover letter lost to a restart costs someone one retype. A lost
 * revision count silently grants unlimited revision rounds and a lost scoring
 * marker skips a job forever — those had to be durable. This does not, and
 * persisting every keystroke of conversation state would be complexity bought
 * for nothing. Identity and wallets, the parts that matter, live in `workers`.
 */
type Pending =
  | { kind: "handle" }
  | { kind: "cover"; escrowId: string }
  | { kind: "portfolio"; escrowId: string; coverLetter: string }
  | { kind: "deliverable"; escrowId: string; milestoneIndex: number }
  | { kind: "withdraw" };

const pending = new Map<number, Pending>();

async function call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(API(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    });
    const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) {
      console.warn(`[telegram] ${method} failed: ${json.description}`);
      return null;
    }
    return json.result ?? null;
  } catch (err) {
    // A network blip must never kill the poll loop.
    console.warn(`[telegram] ${method} error:`, err instanceof Error ? err.message : err);
    return null;
  }
}

function send(chatId: number, text: string, keyboard?: { text: string; callback_data: string }[][]) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

function workerFor(tgUserId: number) {
  return store.getWorkerByChannelRef("telegram", String(tgUserId));
}

const WEB = "https://web-plum-one-12.vercel.app";

/**
 * Testers said the bot felt like "one linear thing" with no sense of what else
 * it could do. That was fair — the old help was five lines and mentioned nothing
 * about who you are, what you hold, or where to see the AI's actual reasoning.
 * Discoverability is a feature; a capable tool that hides its capabilities is
 * just a confusing one.
 */
const HELP = [
  "🏰 <b>Patron</b> — an AI posts a job, locks the money before anyone applies, and pays you when your work is accepted.",
  "",
  "<b>Finding work</b>",
  "/jobs — everything open right now",
  "/jobs logo — filter by word",
  "/jobs 5 — only jobs paying $5 or more",
  "",
  "<b>Doing the work</b>",
  "/submit &lt;id&gt; — send in finished work (the id is on the job)",
  "/mine — jobs you've applied to or been hired for",
  "",
  "<b>Your money</b>",
  "/balance — what you've earned",
  "/wallet — your address, and how custody actually works",
  "/withdraw — send earnings to any address you control",
  "",
  "<b>You</b>",
  "/profile — your handle, skills and rating",
  "/skills &lt;text&gt; — tell the guild what you do",
  "/link 0x… — use your own wallet instead of the one we made you",
  "",
  "<b>Seeing everything</b>",
  `The full ledger — every job, every payment, and the AI's actual reasoning for`,
  `every decision it has ever made — is public at ${WEB}`,
  `Your own page: ${WEB}/work`,
  "",
  "You keep 100% of what a job pays. The 1% network fee is paid by the client, not taken from you.",
].join("\n");

const PAGE_SIZE = 5;

/**
 * One compact message listing the board, not one message per job.
 *
 * The original sent a separate message per commission, capped at six. With a
 * handful of jobs that's noisy; with thirty it's either a flood or it silently
 * hides most of the work someone could be doing — the exact opposite of what a
 * job board is for. Now: a single scannable list, a button per job, and paging.
 */
function matchesFilter(q: { title: string; criteria: string[]; budget: number }, filter: string): boolean {
  if (!filter) return true;
  const f = filter.toLowerCase().trim();

  // "$5" / "5+" — a minimum budget rather than a word to match.
  const min = f.match(/^\$?(\d+(?:\.\d+)?)\+?$/);
  if (min?.[1]) return q.budget >= Number(min[1]);

  const haystack = `${q.title} ${q.criteria.join(" ")}`.toLowerCase();
  // Every word must appear, so "logo png" narrows rather than widens.
  return f.split(/\s+/).every((word) => haystack.includes(word));
}

async function showJobs(chatId: number, tgUserId: number, filter = "", page = 0) {
  const all = workers.openQuests();
  const quests = all.filter((q) => matchesFilter(q, filter));

  if (all.length === 0) {
    return send(chatId, "No open commissions this minute. I'll message you the moment one is posted.");
  }
  if (quests.length === 0) {
    return send(chatId, `Nothing matches “${filter}”. Send /jobs to see all ${all.length}, or try a word like <code>logo</code> or a minimum like <code>5</code>.`);
  }

  const pages = Math.ceil(quests.length / PAGE_SIZE);
  const p = Math.max(0, Math.min(page, pages - 1));
  const slice = quests.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE);
  const worker = workerFor(tgUserId);

  const header = filter
    ? `<b>${quests.length}</b> of ${all.length} commissions match “${filter}”`
    : `<b>${all.length}</b> open commission${all.length !== 1 ? "s" : ""}, all funded up front`;

  const body = slice.map((q) => {
    const crit = q.criteria.slice(0, 3).map((c) => `   · ${c}`).join("\n");
    return [
      `<b>${q.title}</b> — 💰 $${q.budget} · ${q.durationDays}d`,
      crit,
      q.criteria.length > 3 ? `   · …and ${q.criteria.length - 3} more` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  // One button per job, two per row, so the list stays tappable as it grows.
  const jobButtons: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < slice.length; i += 2) {
    jobButtons.push(
      slice.slice(i, i + 2).map((q) => ({
        text: worker ? `Apply · ${q.title.slice(0, 18)}` : `Join to apply`,
        callback_data: worker ? `apply:${q.escrowId}` : "join",
      })),
    );
  }

  const nav: { text: string; callback_data: string }[] = [];
  if (p > 0) nav.push({ text: "‹ Back", callback_data: `page:${p - 1}:${filter}` });
  if (p < pages - 1) nav.push({ text: `More (${p + 1}/${pages}) ›`, callback_data: `page:${p + 1}:${filter}` });
  if (nav.length) jobButtons.push(nav);

  await send(
    chatId,
    [
      header,
      "",
      body.join("\n\n"),
      "",
      pages > 1 ? `<i>Page ${p + 1} of ${pages}</i>` : "",
      llmPaused()
        ? `⏳ <i>The guild master is rate-limited and resumes in ${llmPauseRemaining()}. You can still apply now — applications are on-chain and queue up.</i>`
        : "",
      `<i>Filter with</i> <code>/jobs logo</code> <i>or a minimum budget:</i> <code>/jobs 5</code>`,
    ]
      .filter(Boolean)
      .join("\n"),
    jobButtons,
  );
}

async function handleText(msg: TgMessage) {
  const chatId = msg.chat.id;
  const tgUserId = msg.from?.id;
  if (!tgUserId) return;
  const text = (msg.text ?? "").trim();

  // ── Commands ──
  if (text.startsWith("/")) {
    const cmd = text.split(/\s+/)[0]?.toLowerCase();
    const rest = text.slice(cmd?.length ?? 0).trim();

    if (cmd === "/start") {
      const existing = workerFor(tgUserId);
      if (existing) {
        await send(chatId, `Welcome back, ${existing.handle}. /jobs to see what's open.`);
        return;
      }
      pending.set(chatId, { kind: "handle" });
      await send(
        chatId,
        [
          "🏰 <b>Patron</b> — an AI posts a job, locks the money on-chain, and pays you when the work is accepted.",
          "",
          "No wallet to install. No crypto to learn. You'll be set up in about ten seconds.",
          "",
          "First — what should I call you?",
        ].join("\n"),
      );
      return;
    }

    if (cmd === "/help") return void (await send(chatId, HELP));
    if (cmd === "/jobs" || cmd === "/quests") return void (await showJobs(chatId, tgUserId, rest));

    if (cmd === "/submit") {
      const worker = workerFor(tgUserId);
      if (!worker) return void (await send(chatId, "You're not in the guild yet — send /start."));
      const id = rest.trim();
      if (!id) {
        return void (await send(chatId, "Which commission? Send <code>/submit 31</code> using the entry number from /jobs."));
      }
      pending.set(chatId, { kind: "deliverable", escrowId: id, milestoneIndex: 0 });
      return void (await send(chatId, "Describe what you're delivering, and paste a link to the file."));
    }

    // ── /wallet — the question testers actually asked: where is my wallet,
    //    and can I have the seed phrase? Answered precisely, because a vague
    //    answer here reads as evasive about someone's money.
    if (cmd === "/wallet") {
      const worker = workerFor(tgUserId);
      if (!worker) return void (await send(chatId, "You're not in the guild yet — send /start."));
      if (worker.mode === "own") {
        return void (await send(
          chatId,
          [`You're using your own wallet:`, `<code>${worker.walletAddress}</code>`, "", "You hold the keys. Patron only tells you when work appears."].join("\n"),
        ));
      }
      return void (await send(
        chatId,
        [
          "<b>Your wallet</b>",
          `<code>${worker.walletAddress}</code>`,
          `<a href="https://testnet.arcscan.app/address/${worker.walletAddress}">See it on the block explorer</a> — it's a real address on a public chain, and anything in it is yours.`,
          "",
          "<b>Is there a seed phrase?</b>",
          "No — and that's the honest answer rather than a refusal.",
          "",
          "It's an MPC wallet (Circle). The key was never created as one piece: it exists as separate",
          "shares held apart, and it is never assembled anywhere. So there is no seed phrase or private",
          "key in existence to give you — not to you, not to us, not to Circle.",
          "",
          "<b>Then how do I get my money out?</b>",
          "/withdraw — send it to any address you control, any time, no permission needed.",
          "",
          "The precise version: <i>your money is fully yours and fully extractable. The key is not",
          "extractable by anyone.</i> Same model as Coinbase or Venmo — you've never seen their keys",
          "either; you withdraw to an address you own.",
          "",
          "Want real self-custody instead? /link 0xYourAddress switches you over and sweeps what",
          "you've earned across. Nobody is locked in.",
        ].join("\n"),
      ));
    }

    if (cmd === "/profile") {
      const worker = workerFor(tgUserId);
      if (!worker) return void (await send(chatId, "You're not in the guild yet — send /start."));
      let rating = "no ratings yet";
      try {
        if (worker.walletAddress) {
          const r = await secureflow.getAverageRating(worker.walletAddress as `0x${string}`);
          if (r.count > 0) rating = `${"★".repeat(Math.round(r.average))} ${r.average.toFixed(1)}/5 from ${r.count} job(s)`;
        }
      } catch {
        /* chain hiccup — the rest of the profile is still worth showing */
      }
      const joined = new Date(worker.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
      return void (await send(
        chatId,
        [
          `<b>${worker.handle}</b>`,
          `Joined ${joined} · ${worker.mode === "managed" ? "wallet managed for you" : "your own wallet"}`,
          "",
          `<b>What you do:</b> ${worker.skills || "not set — /skills to tell the guild"}`,
          `<b>On-chain rating:</b> ${rating}`,
          "",
          "Your rating is written to the contract when a job completes, so it's verifiable by anyone and not something we can quietly change.",
        ].join("\n"),
      ));
    }

    if (cmd === "/skills") {
      const worker = workerFor(tgUserId);
      if (!worker) return void (await send(chatId, "You're not in the guild yet — send /start."));
      if (!rest) return void (await send(chatId, "Tell me what you do, like: <code>/skills logo design, brand identity</code>"));
      store.setWorkerSkills(worker.id, rest.slice(0, 200));
      return void (await send(chatId, `Noted — <b>${rest.slice(0, 200)}</b>. /profile to see it.`));
    }

    if (cmd === "/mine") {
      const worker = workerFor(tgUserId);
      if (!worker) return void (await send(chatId, "You're not in the guild yet — send /start."));
      const mine = await workers.myWork(worker.id);
      if (mine.length === 0) {
        return void (await send(chatId, "You haven't applied to anything yet. /jobs to see what's open."));
      }
      return void (await send(
        chatId,
        ["<b>Your jobs</b>", "", ...mine.map((m) => `${m.icon} <b>${m.title}</b> — $${m.budget}\n   ${m.status}`)].join("\n"),
      ));
    }

    if (cmd === "/balance") {
      const worker = workerFor(tgUserId);
      if (!worker) return void (await send(chatId, "You're not in the guild yet — send /start."));
      try {
        const { balance, address } = await workers.balance(worker.id);
        await send(
          chatId,
          [
            `💰 <b>$${Number(balance).toFixed(2)} USDC</b>`,
            "",
            "This is already yours — it sits in your own wallet, not with Patron.",
            `<code>${address}</code>`,
            "",
            "/withdraw to move it to any address you control.",
          ].join("\n"),
        );
      } catch (err) {
        await send(chatId, `Couldn't read your balance: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    if (cmd === "/withdraw") {
      const worker = workerFor(tgUserId);
      if (!worker) return void (await send(chatId, "You're not in the guild yet — send /start."));
      if (rest.startsWith("0x")) return void (await doWithdraw(chatId, worker.id, rest as `0x${string}`));
      pending.set(chatId, { kind: "withdraw" });
      await send(chatId, "Paste the wallet address you'd like your earnings sent to (it starts with 0x).");
      return;
    }

    if (cmd === "/link") {
      const worker = workerFor(tgUserId);
      if (!rest.startsWith("0x")) return void (await send(chatId, "Usage: /link 0xYourAddress"));
      if (!worker) {
        await workers.join({
          handle: msg.from?.first_name ?? "Adventurer",
          channel: "telegram",
          channelRef: String(tgUserId),
          ownAddress: rest as `0x${string}`,
        });
        return void (await send(chatId, "Linked. You sign for yourself — I'll just tell you when work appears."));
      }
      await workers.switchToOwnWallet(worker.id, rest as `0x${string}`);
      return void (await send(chatId, "Done — future earnings go straight to your own wallet, and anything you'd already earned has been swept there."));
    }

    return void (await send(chatId, HELP));
  }

  // ── Freeform replies to whatever we last asked ──
  const state = pending.get(chatId);
  if (!state) return void (await send(chatId, HELP));

  if (state.kind === "handle") {
    pending.delete(chatId);
    try {
      const worker = await workers.join({
        handle: text,
        channel: "telegram",
        channelRef: String(tgUserId),
      });
      await send(
        chatId,
        [
          `You're in the guild, <b>${worker.handle}</b>.`,
          "",
          "I've set up a wallet for you in the background — you don't have to do anything with it, and nobody can take what's in it.",
          "",
          "/jobs to see what's open right now.",
        ].join("\n"),
      );
    } catch (err) {
      await send(chatId, `Couldn't set you up: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }

  const worker = workerFor(tgUserId);
  if (!worker) {
    pending.delete(chatId);
    return void (await send(chatId, "You're not in the guild yet — send /start."));
  }

  // Ask for evidence before applying. Testers pointed out that with only a text
  // box every applicant sounds equally confident, and someone with real work to
  // show had no way to show it.
  if (state.kind === "cover") {
    pending.set(chatId, { kind: "portfolio", escrowId: state.escrowId, coverLetter: text });
    await send(
      chatId,
      [
        "Got it. Now — got a link to past work? A portfolio, CV, GitHub, Behance, Drive folder, anything.",
        "",
        "It counts: applicants who show work they've actually shipped score higher than the same claim without one.",
        "",
        "Send the link, or /skip if you'd rather not.",
      ].join("\n"),
    );
    return;
  }

  if (state.kind === "portfolio") {
    const skipped = /^\/skip$/i.test(text);
    pending.delete(chatId);
    await send(chatId, "Applying…");
    try {
      const { txHash } = await workers.apply(worker.id, state.escrowId, state.coverLetter, 3, skipped ? undefined : text);
      await send(
        chatId,
        [
          "✅ Applied.",
          "",
          // Never promise a reply we currently cannot produce. Applying is
          // entirely on-chain and works regardless; it is the SCORING that needs
          // the model, so when it's paused say so rather than going quiet.
          llmPaused()
            ? `Your application is on-chain and safe. The guild master is rate-limited right now and resumes in ${llmPauseRemaining()} — I'll message you as soon as it has scored everyone.`
            : "The guild master scores every applicant against the brief and hires one. I'll message you either way.",
          `<a href="https://testnet.arcscan.app/tx/${txHash}">See it on the block explorer</a>`,
        ].join("\n"),
      );
    } catch (err) {
      await send(chatId, `Couldn't apply: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }

  if (state.kind === "deliverable") {
    pending.delete(chatId);
    await send(chatId, "Sending your work…");
    try {
      const { txHash } = await workers.submit(worker.id, state.escrowId, state.milestoneIndex, text);
      await send(
        chatId,
        [
          "📮 Sent.",
          "",
          "It gets reviewed against every acceptance criterion. If it passes, the escrow pays you immediately. If not, you'll get specific written feedback and another go.",
          `<a href="https://testnet.arcscan.app/tx/${txHash}">See it on the block explorer</a>`,
        ].join("\n"),
      );
    } catch (err) {
      await send(chatId, `Couldn't send that: ${err instanceof Error ? err.message : err}`);
    }
    return;
  }

  if (state.kind === "withdraw") {
    pending.delete(chatId);
    if (!text.startsWith("0x")) return void (await send(chatId, "That doesn't look like an address — it should start with 0x."));
    await doWithdraw(chatId, worker.id, text as `0x${string}`);
  }
}

async function doWithdraw(chatId: number, workerId: string, destination: `0x${string}`) {
  try {
    const { txHash, amount } = await workers.withdraw(workerId, destination);
    await send(
      chatId,
      [
        `✅ Sent $${Number(amount).toFixed(2)} USDC to your wallet.`,
        `<a href="https://testnet.arcscan.app/tx/${txHash}">See it on the block explorer</a>`,
      ].join("\n"),
    );
  } catch (err) {
    await send(chatId, `Couldn't withdraw: ${err instanceof Error ? err.message : err}`);
  }
}

async function handleCallback(cq: NonNullable<TgUpdate["callback_query"]>) {
  const chatId = cq.message?.chat.id;
  const tgUserId = cq.from.id;
  if (!chatId) return;
  await call("answerCallbackQuery", { callback_query_id: cq.id });

  const [action, arg] = (cq.data ?? "").split(":");

  if (action === "page") {
    const [, pageStr, ...filterParts] = (cq.data ?? "").split(":");
    return void (await showJobs(chatId, tgUserId, filterParts.join(":"), Number(pageStr) || 0));
  }

  if (action === "join") {
    pending.set(chatId, { kind: "handle" });
    return void (await send(chatId, "What should I call you?"));
  }

  const worker = workerFor(tgUserId);
  if (!worker) return void (await send(chatId, "You're not in the guild yet — send /start."));

  if (action === "apply" && arg) {
    pending.set(chatId, { kind: "cover", escrowId: arg });
    return void (await send(
      chatId,
      "Tell me why you're right for this one — be specific about what you'd deliver. The guild master reads this and scores it.",
    ));
  }

  if (action === "submit" && arg) {
    pending.set(chatId, { kind: "deliverable", escrowId: arg, milestoneIndex: 0 });
    return void (await send(chatId, "Describe what you're delivering, and paste a link to the file."));
  }
}

/** Tell every Telegram worker that new paid work exists. This is the notification the web page can't match. */
export async function broadcastNewQuest(title: string, budget: number, escrowId: string): Promise<void> {
  if (!config.telegramBotToken) return;
  const recipients = store.listWorkers(200).filter((w) => w.channel === "telegram" && w.channelRef);
  for (const w of recipients) {
    await send(
      Number(w.channelRef),
      [`🔔 <b>New quest:</b> ${title}`, `💰 $${budget} USDC — already locked in escrow.`].join("\n"),
      [[{ text: "Apply", callback_data: `apply:${escrowId}` }]],
    );
  }
}

/** DM a worker something that happened to them specifically (hired, approved, paid). */
export async function notifyWorkerByAddress(address: string, text: string): Promise<void> {
  if (!config.telegramBotToken) return;
  const worker = store.getWorkerByAddress(address);
  if (worker?.channel === "telegram" && worker.channelRef) await send(Number(worker.channelRef), text);
}

/**
 * Notify whoever was hired for a given escrow.
 *
 * Review and payment events carry the escrow, not the person — so the hire is
 * looked up from the decision log, which is the one place that records who was
 * accepted for which job. No new bookkeeping: it's already written there for
 * the command center.
 */
export async function notifyWorkerForEscrow(escrowId: string, text: string): Promise<void> {
  if (!config.telegramBotToken) return;
  const hire = store
    .listDecisions(300)
    .find((d: { task_id?: string; type?: string; target?: string }) => d.task_id === escrowId && d.type === "applicant_accepted" && d.target);
  if (hire?.target) await notifyWorkerByAddress(hire.target, text);
}

/**
 * Long-poll forever. Never throws out of the loop — a bot that dies on one bad
 * update takes the daemon's whole worker channel with it.
 */
export function startTelegramBot(): void {
  if (!config.telegramBotToken) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN not set — bot is dormant (everything else runs normally)");
    return;
  }

  let offset = 0;
  const loop = async () => {
    for (;;) {
      const updates = await call<TgUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] });
      if (updates?.length) {
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1);
          try {
            if (u.message?.text) await handleText(u.message);
            else if (u.callback_query) await handleCallback(u.callback_query);
          } catch (err) {
            console.error("[telegram] update failed:", err instanceof Error ? err.message : err);
          }
        }
      } else if (updates === null) {
        // transport failure — back off rather than hammer
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  };

  void loop();
  console.log("[telegram] bot listening (long-poll)");
}
