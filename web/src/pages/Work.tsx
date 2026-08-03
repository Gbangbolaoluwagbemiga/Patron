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

interface Me {
  id: string;
  handle: string;
  address: string | null;
  mode: "managed" | "own";
  balance: string | null;
}

interface Quest {
  escrowId: string;
  title: string;
  budget: number;
  durationDays: number;
  criteria: string[];
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
  const [submitFor, setSubmitFor] = useState<string | null>(null);
  const [deliverable, setDeliverable] = useState("");

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
        body: JSON.stringify({ handle, skills, channelRef: `web-${handle.trim().toLowerCase()}` }),
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
        body: JSON.stringify({ workerId: me.id, escrowId, coverLetter, proposedTimelineDays: 3 }),
      });
      setNotice({ text: "Applied. The guild master reviews every applicant — you'll see it on the ledger.", tx: r.txHash });
      setOpenQuest(null);
      setCoverLetter("");
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
        body: JSON.stringify({ workerId: me.id, escrowId, milestoneIndex: 0, description: deliverable }),
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
                  {q.durationDays} day{q.durationDays !== 1 ? "s" : ""} · {q.criteria.length} acceptance criteria
                </div>

                {openQuest === q.escrowId ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="brief-label">What they need</div>
                    <ul className="criteria-list" style={{ marginBottom: 14 }}>
                      {q.criteria.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                    <textarea
                      rows={3}
                      value={coverLetter}
                      onChange={(e) => setCoverLetter(e.target.value)}
                      placeholder="Why are you right for this one? Be specific — the guild master reads this and scores it."
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
