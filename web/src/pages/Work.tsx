// Work.tsx — the human front door.
//
// Everything else in this app is a window onto what Patron is doing. This is the
// one page where a person does something: joins the guild, takes a commission,
// sends work, gets paid. No wallet, no extension, no network to add by chain id.
//
// The identity is kept in localStorage on purpose. Real auth is the right answer
// for a real product and the wrong answer for this: the point we are making is
// that a stranger can go from a link to an on-chain application in about twenty
// seconds, and a signup flow with passwords and verification emails would be the
// very friction the whole layer exists to remove.

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ARC_EXPLORER, DAEMON_URL } from "../api";
import { cardMotion, shorten } from "../components";
import { IconCheck, IconCoin, IconScroll, IconSwords } from "../Icon";
import { useCountUp } from "../motion";

const STORAGE_KEY = "patron.worker.id";
const DEVICE_KEY = "patron.device.id";

/**
 * A stable per-browser id used as the join key.
 *
 * This used to be `web-${handle}`, which quietly made the handle a password:
 * join() treats a repeated channelRef as the SAME person and hands back the
 * existing worker, wallet and balance. Two people who both picked "alex" would
 * have shared one wallet, and the second could have withdrawn the first's
 * earnings. Telegram was never exposed — its channelRef is the chat id, which
 * is genuinely unique — but the web derived it from something the user types.
 *
 * A random id per browser keeps what the channelRef was actually for (tapping
 * "join" twice must not mint two wallets) without making a chosen name into
 * anyone's credential.
 */
function deviceRef(): string {
  let id = window.localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, id);
  }
  return `web-${id}`;
}

interface Me {
  id: string;
  handle: string;
  address: string | null;
  mode: "managed" | "own";
  balance: string | null;
}

/** One of this worker's own commissions — applied to, hired for, or finished. */
interface MyJob {
  escrowId: string;
  title: string;
  budget: number;
  status: string;
  icon: string;
}

interface Quest {
  escrowId: string;
  title: string;
  budget: number;
  durationDays: number;
  criteria: string[];
  milestones: { description: string; amount: number }[];
  closesAt: number;
}

/** When the guild master will judge — applicants shouldn't have to guess. */
function closesIn(ts: number): string {
  const ms = ts - Date.now();
  if (ms <= 0) return "judging now";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 60) return `judged in ~${mins} min`;
  return `judged in ~${Math.round(mins / 60)}h`;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body as T;
}

export default function Work() {
  const [me, setMe] = useState<Me | null>(null);
  const [quests, setQuests] = useState<Quest[]>([]);
  const [handle, setHandle] = useState("");
  const [skills, setSkills] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ text: string; tx?: string } | null>(null);
  const [openQuest, setOpenQuest] = useState<string | null>(null);
  const [coverLetter, setCoverLetter] = useState("");
  const [portfolio, setPortfolio] = useState("");
  const [submitFor, setSubmitFor] = useState<string | null>(null);
  const [deliverable, setDeliverable] = useState("");
  const [mine, setMine] = useState<MyJob[]>([]);

  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<"newest" | "budget">("newest");

  const balance = me?.balance ? parseFloat(me.balance) : 0;
  const animatedBalance = useCountUp(balance);

  // Same rules as the Telegram bot, so the two doors behave identically: a bare
  // number is a MINIMUM BUDGET, anything else is words that must all appear.
  // Someone typing "5" on a job board means "at least $5", not "contains a 5".
  const visible = quests
    .filter((q) => {
      const f = filter.toLowerCase().trim();
      if (!f) return true;
      const min = f.match(/^\$?(\d+(?:\.\d+)?)\+?$/);
      if (min?.[1]) return q.budget >= Number(min[1]);
      const haystack = `${q.title} ${q.criteria.join(" ")}`.toLowerCase();
      return f.split(/\s+/).every((w) => haystack.includes(w));
    })
    .sort((a, b) => (sort === "budget" ? b.budget - a.budget : Number(b.escrowId) - Number(a.escrowId)));

  async function refreshMe(id: string) {
    try {
      setMe(await api<Me>(`/api/worker/me?id=${id}`));
    } catch {
      window.localStorage.removeItem(STORAGE_KEY); // stale id (e.g. a reset database)
      setMe(null);
      setMine([]);
      return;
    }
    // Separate call, and a failure here must not sign anyone out: this is the
    // view of their own jobs, not their identity.
    try {
      setMine(await api<MyJob[]>(`/api/worker/mine?id=${id}`));
    } catch {
      /* leave whatever we last showed rather than blanking their work */
    }
  }

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved) void refreshMe(saved);
    void api<Quest[]>("/api/worker/quests").then(setQuests).catch(() => {});
    const t = window.setInterval(() => {
      void api<Quest[]>("/api/worker/quests").then(setQuests).catch(() => {});
      const id = window.localStorage.getItem(STORAGE_KEY);
      if (id) void refreshMe(id);
    }, 15_000);
    return () => window.clearInterval(t);
  }, []);

  async function join() {
    if (!handle.trim()) return;
    setBusy(true);
    setError("");
    try {
      const w = await api<{ id: string }>("/api/worker/join", {
        method: "POST",
        body: JSON.stringify({ handle, skills, channelRef: deviceRef() }),
      });
      window.localStorage.setItem(STORAGE_KEY, w.id);
      await refreshMe(w.id);
      setNotice({ text: "You're in the guild. A wallet was created for you — you don't have to do anything with it." });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyTo(escrowId: string) {
    if (!me || !coverLetter.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ txHash: string }>("/api/worker/apply", {
        method: "POST",
        body: JSON.stringify({ workerId: me.id, escrowId, coverLetter, proposedTimelineDays: 3, portfolioUrl: portfolio || undefined }),
      });
      setNotice({ text: "Applied. The guild master reviews every applicant — you'll see it on the ledger.", tx: r.txHash });
      setOpenQuest(null);
      setCoverLetter("");
      setPortfolio("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitWork(escrowId: string) {
    if (!me || !deliverable.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ txHash: string }>("/api/worker/submit", {
        method: "POST",
        body: JSON.stringify({ workerId: me.id, escrowId, description: deliverable }),
      });
      setNotice({ text: "Work sent. It gets reviewed against the acceptance criteria, then paid.", tx: r.txHash });
      setSubmitFor(null);
      setDeliverable("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // ── Not joined yet ───────────────────────────────────────────────────────
  if (!me) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Get paid by an AI</h1>
        </div>
        <p className="page-sub">
          An AI agent posts a job and locks the money on-chain before anyone applies. Do the work, get paid in USDC. No
          wallet to install, no crypto to learn — pick a name and you're in.
        </p>

        <div className="post-quest">
          <div className="post-quest-label">Join the guild</div>
          <input
            className="post-quest-title"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            placeholder="What should we call you?"
            maxLength={40}
          />
          <input value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="What kind of work do you do? (optional)" />
          <div className="post-quest-fields" style={{ marginTop: 18 }}>
            <button onClick={join} disabled={busy || !handle.trim()}>
              {busy ? "Setting you up…" : "Join →"}
            </button>
          </div>
          {error && <div className="post-quest-msg error">{error}</div>}
        </div>

        <div className="keycard">
          <b>Why you can trust this:</b> the money for every job is locked in an escrow contract before you apply. The
          AI can release it to you — it structurally <b>cannot</b> take it back. If it rejects your work it has to give
          you written feedback and a revision round, and after that a human arbiter steps in.
          <br />
          <br />
          <b>You keep 100%.</b> The figure on a job is what lands in your wallet — Patron takes nothing from it, and the
          1% network fee is paid by the client on top, not deducted from you. Compare that to the 10% a traditional
          freelance platform takes out of your side.
        </div>

        <QuestList quests={quests} />
      </div>
    );
  }

  // ── Joined ───────────────────────────────────────────────────────────────
  return (
    <div className="page">
      <div className="page-header">
        <h1>Hello, {me.handle}</h1>
      </div>

      <div className="stats" style={{ marginBottom: 34 }}>
        <div className="stat stat-hero">
          <div className="stat-value">${animatedBalance.toFixed(2)}</div>
          <div className="stat-label">yours, on-chain</div>
        </div>
        <div className="stat-rest">
          <div className="stat">
            <div className="stat-value" style={{ fontSize: 14, wordBreak: "break-all" }}>
              {me.address ? shorten(me.address) : "—"}
            </div>
            <div className="stat-label">your wallet</div>
          </div>
          <div className="stat">
            <div className="stat-value" style={{ fontSize: 16 }}>{me.mode === "managed" ? "Managed" : "Own wallet"}</div>
            <div className="stat-label">custody</div>
          </div>
          {me.address && (
            <div className="stat">
              <a className="tx-link" href={`${ARC_EXPLORER}/address/${me.address}`} target="_blank" rel="noreferrer">
                verify on Arcscan ↗
              </a>
              <div className="stat-label">it's really yours</div>
            </div>
          )}
        </div>
      </div>

      <AnimatePresence>
        {notice && (
          <motion.div className="post-quest-msg ok" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {notice.text}
            {notice.tx && (
              <>
                {" "}
                <a className="tx-link" href={`${ARC_EXPLORER}/tx/${notice.tx}`} target="_blank" rel="noreferrer">
                  view the transaction ↗
                </a>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      {error && <div className="post-quest-msg error">{error}</div>}

      {/* Your own commissions, before the open board.
          The board only ever lists jobs still at "posted", so being hired made
          a job VANISH from this page — along with the only button that could
          send work. The bot had /mine; the web had nothing, and a web user
          could be hired with no way to deliver. This is that missing view. */}
      {mine.length > 0 && (
        <div className="panel">
          <h2>
            <IconCheck size={15} /> Your commissions
            <span className="panel-header-link" style={{ color: "var(--faint)" }}>
              {mine.length}
            </span>
          </h2>
          <div className="panel-body">
            {mine.map((m) => (
              <motion.div key={m.escrowId} className="quest-card" {...cardMotion}>
                <div className="quest-head">
                  <b>
                    {m.icon} {m.title}
                  </b>
                  <span className="quest-budget">${m.budget}</span>
                </div>
                <div className="quest-meta">
                  #{m.escrowId} · {m.status.replace(/ with \/submit \d+/, "")}
                </div>

                {m.status.startsWith("You were hired") &&
                  (submitFor === m.escrowId ? (
                    <div style={{ marginTop: 14 }}>
                      <textarea
                        rows={3}
                        value={deliverable}
                        onChange={(e) => setDeliverable(e.target.value)}
                        placeholder="Describe what you're delivering and paste a link to the file."
                      />
                      <div className="post-quest-fields">
                        <button onClick={() => void submitWork(m.escrowId)} disabled={busy || !deliverable.trim()}>
                          {busy ? "Sending…" : "Send work →"}
                        </button>
                        <button className="treasury-connect-btn" onClick={() => setSubmitFor(null)} disabled={busy}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="post-quest-fields" style={{ marginTop: 14 }}>
                      <button onClick={() => setSubmitFor(m.escrowId)} disabled={busy}>
                        Send your work
                      </button>
                    </div>
                  ))}
              </motion.div>
            ))}
          </div>
        </div>
      )}

      <div className="panel">
        <h2>
          <IconSwords size={15} /> Open commissions
          <span className="panel-header-link" style={{ color: "var(--faint)" }}>
            {visible.length === quests.length ? `${quests.length} open` : `${visible.length} of ${quests.length}`}
          </span>
        </h2>

        <div className="filter-row">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter — a word like “logo”, or a minimum budget like “5”"
          />
          <button
            className="treasury-connect-btn"
            onClick={() => setSort(sort === "newest" ? "budget" : "newest")}
            title="Change ordering"
          >
            {sort === "newest" ? "Newest first" : "Best paid first"}
          </button>
        </div>

        <div className="panel-body">
          {quests.length === 0 ? (
            <div className="empty">No open commissions right now — they appear here the moment an agent posts one.</div>
          ) : visible.length === 0 ? (
            <div className="empty">
              Nothing matches “{filter}”.{" "}
              <a className="tx-link" onClick={() => setFilter("")} style={{ cursor: "pointer" }}>
                Show all {quests.length}
              </a>
            </div>
          ) : (
            visible.map((q) => (
              <motion.div className="card" key={q.escrowId} {...cardMotion}>
                <div className="card-row">
                  <span className="entry-no">ENTRY {q.escrowId.padStart(4, "0")}</span>
                  <span className="amount">${q.budget}</span>
                </div>
                <div className="card-title">{q.title}</div>
                <div className="card-milestones-preview">
                  {q.durationDays} day{q.durationDays !== 1 ? "s" : ""} · {q.criteria.length} acceptance criteria ·{" "}
                  <span style={{ color: "var(--gold)" }}>{closesIn(q.closesAt)}</span>
                </div>

                {openQuest === q.escrowId ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="brief-label">What they need</div>
                    <ul className="criteria-list" style={{ marginBottom: 14 }}>
                      {q.criteria.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                    {/* Parity with the bot, which shows this. Someone should not
                        discover a job pays in stages only after being hired. */}
                    {q.milestones && q.milestones.length > 1 && (
                      <>
                        <div className="brief-label">Paid in stages</div>
                        <ul className="criteria-list" style={{ marginBottom: 14 }}>
                          {q.milestones.map((m, i) => (
                            <li key={i}>
                              <span className="amount">${m.amount}</span> — {m.description}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <textarea
                      rows={3}
                      value={coverLetter}
                      onChange={(e) => setCoverLetter(e.target.value)}
                      placeholder="Why are you right for this one? Be specific — the guild master reads this and scores it."
                    />
                    {/* Evidence beats assertion, and testers were right that a
                        text box alone gives everyone the same voice. */}
                    <input
                      value={portfolio}
                      onChange={(e) => setPortfolio(e.target.value)}
                      placeholder="Link to past work — portfolio, CV, GitHub, Behance (optional, but it counts)"
                      style={{ marginBottom: 12 }}
                    />
                    <div className="post-quest-fields">
                      <button onClick={() => void applyTo(q.escrowId)} disabled={busy || !coverLetter.trim()}>
                        {busy ? "Applying…" : "Apply →"}
                      </button>
                      <button className="treasury-connect-btn" onClick={() => setOpenQuest(null)} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : submitFor === q.escrowId ? (
                  <div style={{ marginTop: 14 }}>
                    <textarea
                      rows={3}
                      value={deliverable}
                      onChange={(e) => setDeliverable(e.target.value)}
                      placeholder="Describe what you're delivering and paste a link to the file."
                    />
                    <div className="post-quest-fields">
                      <button onClick={() => void submitWork(q.escrowId)} disabled={busy || !deliverable.trim()}>
                        {busy ? "Sending…" : "Send work →"}
                      </button>
                      <button className="treasury-connect-btn" onClick={() => setSubmitFor(null)} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="post-quest-fields" style={{ marginTop: 14 }}>
                    <button onClick={() => setOpenQuest(q.escrowId)} disabled={busy}>
                      Apply
                    </button>
                    <button className="treasury-connect-btn" onClick={() => setSubmitFor(q.escrowId)} disabled={busy}>
                      I was hired — send work
                    </button>
                  </div>
                )}
              </motion.div>
            ))
          )}
        </div>
      </div>

      <div className="keycard">
        <b>How you get picked:</b> a job stays open for a while after it's posted so several people can apply. Then the
        guild master reads every application <b>together</b> and ranks them against each other — not first-come,
        first-served. It writes down exactly why it chose who it chose, and you can read that reasoning yourself on the
        ledger. Showing past work counts.
      </div>

      <div className="keycard">
        <b>Where your money is:</b> not with Patron. When your work is approved the escrow contract pays your wallet
        directly — Patron is never in the middle and cannot hold, delay, or freeze it. Your balance above is already
        yours, and you can move it to any address you control whenever you want.
      </div>
    </div>
  );
}

function QuestList({ quests }: { quests: Quest[] }) {
  return (
    <div className="panel">
      <h2>
        <IconScroll size={15} /> Work available right now
      </h2>
      <div className="panel-body">
        {quests.length === 0 ? (
          <div className="empty">No open commissions at this moment.</div>
        ) : (
          quests.slice(0, 5).map((q) => (
            <motion.div className="card" key={q.escrowId} {...cardMotion}>
              <div className="card-row">
                <span className="entry-no">ENTRY {q.escrowId.padStart(4, "0")}</span>
                <span className="amount">${q.budget}</span>
              </div>
              <div className="card-title">{q.title}</div>
              <div className="card-milestones-preview">
                <IconCoin size={13} /> locked in escrow before you apply · {q.durationDays} day
                {q.durationDays !== 1 ? "s" : ""}
              </div>
            </motion.div>
          ))
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 13.5, color: "var(--muted)" }}>
        <IconCheck size={14} /> Every amount above is already locked on-chain. Nobody can withdraw it but you, once your
        work is approved.
      </div>
    </div>
  );
}
