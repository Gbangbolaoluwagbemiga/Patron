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
import { config } from "../config.js";

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

const HELP = [
  "<b>Patron</b> — an AI hires you, and pays you.",
  "",
  "/jobs — see work available right now",
  "/balance — what you've earned",
  "/withdraw — move it to your own wallet",
  "/help — this message",
].join("\n");

async function showJobs(chatId: number, tgUserId: number) {
  const quests = workers.openQuests();
  if (quests.length === 0) {
    return send(chatId, "No open commissions this minute. I'll message you the moment one is posted.");
  }
  const worker = workerFor(tgUserId);
  for (const q of quests.slice(0, 6)) {
    const lines = [
      `<b>${q.title}</b>`,
      `💰 $${q.budget} USDC · ${q.durationDays} day${q.durationDays !== 1 ? "s" : ""}`,
      "",
      "<i>What they need:</i>",
      ...q.criteria.slice(0, 6).map((c) => `• ${c}`),
      "",
      `The $${q.budget} is already locked in escrow — it can't be taken back, not even by the AI.`,
    ];
    await send(
      chatId,
      lines.join("\n"),
      worker
        ? [
            [
              { text: "Apply", callback_data: `apply:${q.escrowId}` },
              { text: "I was hired — send work", callback_data: `submit:${q.escrowId}` },
            ],
          ]
        : [[{ text: "Join first", callback_data: "join" }]],
    );
  }
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
    if (cmd === "/jobs" || cmd === "/quests") return void (await showJobs(chatId, tgUserId));

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

  if (state.kind === "cover") {
    pending.delete(chatId);
    await send(chatId, "Applying…");
    try {
      const { txHash } = await workers.apply(worker.id, state.escrowId, text, 3);
      await send(
        chatId,
        [
          "✅ Applied.",
          "",
          "The guild master scores every applicant against the brief and hires one. I'll message you either way.",
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
