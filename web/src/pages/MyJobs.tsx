// MyJobs.tsx — "where is my order".
//
// Everything on this page was already public: the decision log, the payment
// feed, the delivered work. But it was scattered across four pages and mixed in
// with everyone else's, so a client who had paid for something had to know
// which escrow number was theirs and then assemble the story by hand. That is
// not transparency, it is a filing cabinet.
//
// The model here is a parcel tracker rather than a dashboard: one row per
// commission, and inside it the sequence of things that have actually happened,
// in order, in plain language — posted, applicants arriving, who was hired and
// why, work delivered, money released.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useWallet } from "../wallet-context";
import { JudgingCountdown, Notice, TELEGRAM_BOT_URL, shorten, timeAgo } from "../components";
import { LedgerSkeleton } from "../motion";
import { IconBolt, IconCheck, IconCoin, IconGavel, IconRefresh, IconScroll, IconSearch, IconShrug, IconSplit, IconSwords, IconTelegram } from "../Icon";

interface ClientEvent {
  type: string;
  reasoning: string;
  score: number | null;
  target: string | null;
  at: number;
}

interface ClientJob {
  escrowId: string;
  title: string;
  budget: number | null;
  status: string;
  createdAt: number;
  closesAt: number;
  milestones: number;
  applicants: number;
  topScore: number;
  hiredAddress: string | null;
  paidOut: string;
  events: ClientEvent[];
}

/**
 * One line per thing that happened, in the client's language rather than ours.
 *
 * Anything missing here falls through to the raw event name, which is how a
 * client came to read a bare lowercase "escalated" at the end of their trail:
 * the daemon writes `escalated`, this map only knew `escalated_to_human`. The
 * fallback is deliberately quiet, so a gap looks like a typo rather than an
 * error — every type the daemon can emit is listed below.
 */
const EVENT_COPY: Record<string, { icon: typeof IconScroll; label: string }> = {
  application_scored: { icon: IconSwords, label: "Applicant scored" },
  portfolio_verified: { icon: IconSearch, label: "Portfolio checked" },
  applicant_accepted: { icon: IconCheck, label: "Freelancer hired" },
  no_suitable_applicant: { icon: IconShrug, label: "Nobody cleared the bar" },
  work_approved: { icon: IconCheck, label: "Work accepted" },
  work_rejected: { icon: IconScroll, label: "Revision requested" },
  escalated: { icon: IconShrug, label: "Escalated to a human arbiter" },
  escalated_to_human: { icon: IconShrug, label: "Escalated to a human arbiter" },
  dispute_resolved: { icon: IconGavel, label: "Arbiter ruled" },
  payment_released: { icon: IconCoin, label: "Payment released" },
  task_completed: { icon: IconCheck, label: "Commission closed" },
};

/** Where a commission has got to, as a client would describe it. */
function stageOf(j: ClientJob): { label: string; tone: string } {
  const ruled = j.events.some((e) => e.type === "dispute_resolved");
  if (j.status === "completed") return { label: ruled ? "Settled by arbiter" : "Finished and paid", tone: "done" };
  if (j.status === "cancelled") return { label: "Refunded — nobody suitable applied", tone: "refunded" };
  if (j.status === "disputed") return { label: "With a human arbiter", tone: "warn" };
  // A ruling settles the milestone it was raised over, not the commission. Say
  // so, or the card claims work is "in progress" that nobody is doing.
  if (ruled) return { label: "Arbiter ruled — remainder still escrowed", tone: "warn" };
  if (j.hiredAddress) return { label: "In progress — freelancer hired", tone: "active" };
  if (j.applicants > 0) return { label: `${j.applicants} applicant${j.applicants === 1 ? "" : "s"} being judged`, tone: "open" };
  return { label: "Open — waiting for applicants", tone: "open" };
}

export default function MyJobs() {
  const { address, connect, connecting, signMessage } = useWallet();
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [jobs, setJobs] = useState<ClientJob[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      setJobs(await api<ClientJob[]>(`/api/client/jobs?address=${address}`));
      setLastAt(Date.now());
    } catch {
      setJobs((j) => j ?? []);
    }
  }, [address]);

  /**
   * Manual refresh, alongside the poll.
   *
   * The page reloads itself every 15 seconds, which is fine except at exactly
   * the moment you care — you have just submitted something, or the guild
   * master is mid-decision, and waiting out a timer you cannot see feels like
   * the page is stuck. A button costs nothing and answers "is it just me?".
   */
  async function refreshNow() {
    setRefreshing(true);
    await load();
    // Deliberately visible for a beat. An instant flicker reads as nothing
    // having happened, which is the opposite of what the button is for.
    window.setTimeout(() => setRefreshing(false), 400);
  }

  /**
   * Call off a commission nobody has been hired for.
   *
   * Signed, because the endpoint underneath would otherwise take an escrow
   * number from anybody — and those are printed on every card. Only ever
   * offered while a job is still at "posted": the moment someone is hired their
   * claim on the escrow is the entire point of the product.
   */
  async function cancelJob(escrowId: string) {
    if (!address) return;
    setCancelling(escrowId);
    setNotice("");
    try {
      const message = `Patron cancel commission\nAddress: ${address.toLowerCase()}\nEscrow: ${escrowId}`;
      const signature = await signMessage(message);
      if (!signature) return;
      const r = await api<{ recovered: string }>(`/api/jobs/cancel`, {
        method: "POST",
        body: JSON.stringify({ escrowId, address, signature, message }),
      });
      setNotice(`Cancelled — $${Number(r.recovered).toFixed(2)} returned. SecureFlow deducts a small penalty when applicants have already applied.`);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setCancelling(null);
    }
  }

  useEffect(() => {
    if (!address) {
      setJobs(null);
      return;
    }
    void load();
    // These move on their own — an applicant arrives, the guild master decides,
    // money is released — so the page has to move without being told to.
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, [address, load]);

  if (!address) {
    return (
      <div className="page">
        <div className="page-header">
          <h1>Your Commissions</h1>
        </div>
        <p className="page-sub">
          Connect the wallet you commissioned with and every job you've paid for appears here — applicants as they
          arrive, the guild master's reasoning, the delivered file, and the money.
        </p>
        <div className="post-quest">
          <div className="post-quest-fields">
            <button onClick={connect} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect wallet →"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Your Commissions</h1>
        <div className="page-header-right">
          {jobs && jobs.length > 0 && <span className="page-count">{jobs.length}</span>}
          <button className="refresh-btn" onClick={() => void refreshNow()} disabled={refreshing} title="Check for updates now">
            <IconRefresh size={14} className={refreshing ? "spin" : ""} />
            {refreshing ? "Checking…" : "Refresh"}
          </button>
        </div>
      </div>
      <p className="page-sub">
        Everything commissioned by <code className="inline-addr">{shorten(address)}</code>, and exactly where each one
        has got to. Updates on its own every 15 seconds
        {lastAt ? ` — last checked ${new Date(lastAt).toLocaleTimeString()}` : ""}.
      </p>

      {/* One tap. Telegram passes whatever follows ?start= straight to the bot,
          so the address arrives with the person and nobody has to copy their own
          wallet into a chat window — which was the honest weak point of asking
          them to type /watch 0x… themselves. */}
      <a
        className="tg-invite-btn watch-cta"
        href={`${TELEGRAM_BOT_URL}?start=watch_${address}`}
        target="_blank"
        rel="noreferrer"
      >
        <IconTelegram size={15} /> Get these updates on Telegram
      </a>

      {notice && <Notice tone={notice.startsWith("Cancelled") ? "ok" : "error"} onDismiss={() => setNotice("")}>{notice}</Notice>}

      {jobs === null ? (
        <LedgerSkeleton rows={3} />
      ) : jobs.length === 0 ? (
        <div className="empty">
          Nothing commissioned from this wallet yet.{" "}
          <Link className="tx-link" to="/">
            Post one on the ledger
          </Link>{" "}
          — deposit, commission against it, and track it here.
        </div>
      ) : (
        <div className="job-grid">
          {jobs.map((j) => {
            const stage = stageOf(j);
            const expanded = open === j.escrowId;
            return (
              <div className={`track-card track-${stage.tone}`} key={j.escrowId}>
                <div className="track-head">
                  <div>
                    <div className="track-title">{j.title}</div>
                    <div className="track-meta">
                      escrow #{j.escrowId} · ${j.budget ?? "—"} · {j.milestones} milestone{j.milestones === 1 ? "" : "s"} ·{" "}
                      {timeAgo(j.createdAt)}
                    </div>
                  </div>
                  <span className={`track-stage track-stage-${stage.tone}`}>{stage.label}</span>
                </div>

                {/* Only while it is still taking applicants. */}
                {j.status === "posted" && !j.hiredAddress && (
                  <JudgingCountdown closesAt={j.closesAt} applicants={j.applicants} />
                )}

                <div className="track-figures">
                  <div>
                    <span>Applicants</span>
                    <b>{j.applicants}</b>
                  </div>
                  <div>
                    <span>Best score</span>
                    <b>{j.topScore > 0 ? `${j.topScore}/100` : "—"}</b>
                  </div>
                  <div>
                    <span>Hired</span>
                    <b>{j.hiredAddress ? shorten(j.hiredAddress) : "—"}</b>
                  </div>
                  <div>
                    <span>Paid out</span>
                    <b>${Number(j.paidOut).toFixed(2)}</b>
                  </div>
                </div>

                <div className="track-actions">
                  <button className="linklike" onClick={() => setOpen(expanded ? null : j.escrowId)}>
                    {expanded ? "Hide the trail" : `Show the trail (${j.events.length})`}
                  </button>
                  <div className="track-actions-right">
                    {/* Only while nobody has been hired. Once someone has a
                        claim on the escrow, that claim is the product. */}
                    {j.status === "posted" && !j.hiredAddress && (
                      <button
                        className="cancel-btn"
                        onClick={() => void cancelJob(j.escrowId)}
                        disabled={cancelling === j.escrowId}
                      >
                        {cancelling === j.escrowId ? "Signing…" : "Cancel & refund"}
                      </button>
                    )}
                    <Link className="tx-link" to={`/jobs/${j.escrowId}`}>
                      Full brief &amp; delivered work →
                    </Link>
                  </div>
                </div>

                {expanded && (
                  <ol className="trail">
                    <li className="trail-item">
                      <span className="trail-icon">
                        <IconBolt size={14} />
                      </span>
                      <div>
                        <b>Commissioned</b>
                        <div className="trail-note">
                          ${j.budget} locked in escrow before anyone applied. {timeAgo(j.createdAt)}
                        </div>
                      </div>
                    </li>
                    {j.events.map((e, i) => {
                      const meta = EVENT_COPY[e.type] ?? { icon: IconScroll, label: e.type.replace(/_/g, " ") };
                      return (
                        <li className="trail-item" key={i}>
                          <span className="trail-icon">
                            <meta.icon size={14} />
                          </span>
                          <div>
                            <b>
                              {meta.label}
                              {e.score != null && ` — ${e.score}/100`}
                            </b>
                            <div className="trail-note">{e.reasoning}</div>
                            {e.target && <div className="trail-who">{shorten(e.target)}</div>}
                          </div>
                        </li>
                      );
                    })}
                    {Number(j.paidOut) > 0 &&
                      (() => {
                        // Money that came out of a ruling did not "get released"
                        // — it was awarded, against a stake the arbiter split.
                        // Saying "paid to the freelancer" for a 50/50 ruling is
                        // how a client ends up believing they lost the lot.
                        const ruled = j.events.some((e) => e.type === "dispute_resolved");
                        return (
                          <li className="trail-item">
                            <span className="trail-icon">{ruled ? <IconSplit size={14} /> : <IconCoin size={14} />}</span>
                            <div>
                              <b>
                                {ruled ? "Awarded" : "Paid"} — ${Number(j.paidOut).toFixed(2)} USDC
                              </b>
                              <div className="trail-note">
                                {ruled
                                  ? "The arbiter's award, paid from escrow. Your share of the split went back to your Patron balance, and anything still undelivered stays in escrow."
                                  : "Released from escrow straight to the freelancer's wallet."}
                              </div>
                            </div>
                          </li>
                        );
                      })()}
                  </ol>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
