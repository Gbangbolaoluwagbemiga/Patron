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

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useWallet } from "../wallet-context";
import { JudgingCountdown, TELEGRAM_BOT_URL, shorten, timeAgo } from "../components";
import { LedgerSkeleton } from "../motion";
import { IconBolt, IconCheck, IconCoin, IconScroll, IconSearch, IconShrug, IconSwords, IconTelegram } from "../Icon";

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

/** One line per thing that happened, in the client's language rather than ours. */
const EVENT_COPY: Record<string, { icon: typeof IconScroll; label: string }> = {
  application_scored: { icon: IconSwords, label: "Applicant scored" },
  portfolio_verified: { icon: IconSearch, label: "Portfolio checked" },
  applicant_accepted: { icon: IconCheck, label: "Freelancer hired" },
  no_suitable_applicant: { icon: IconShrug, label: "Nobody cleared the bar" },
  work_approved: { icon: IconCheck, label: "Work accepted" },
  work_rejected: { icon: IconScroll, label: "Revision requested" },
  escalated_to_human: { icon: IconShrug, label: "Escalated to a human arbiter" },
};

/** Where a commission has got to, as a client would describe it. */
function stageOf(j: ClientJob): { label: string; tone: string } {
  if (j.status === "completed") return { label: "Finished and paid", tone: "done" };
  if (j.status === "cancelled") return { label: "Refunded — nobody suitable applied", tone: "refunded" };
  if (j.status === "disputed") return { label: "With a human arbiter", tone: "warn" };
  if (j.hiredAddress) return { label: "In progress — freelancer hired", tone: "active" };
  if (j.applicants > 0) return { label: `${j.applicants} applicant${j.applicants === 1 ? "" : "s"} being judged`, tone: "open" };
  return { label: "Open — waiting for applicants", tone: "open" };
}

export default function MyJobs() {
  const { address, connect, connecting } = useWallet();
  const [jobs, setJobs] = useState<ClientJob[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setJobs(null);
      return;
    }
    const load = () =>
      api<ClientJob[]>(`/api/client/jobs?address=${address}`)
        .then(setJobs)
        .catch(() => setJobs([]));
    void load();
    // These move on their own — an applicant arrives, the guild master decides,
    // money is released — so the page has to move without being told to.
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [address]);

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
        {jobs && jobs.length > 0 && <span className="page-count">{jobs.length}</span>}
      </div>
      <p className="page-sub">
        Everything commissioned by <code className="inline-addr">{shorten(address)}</code>, and exactly where each one
        has got to. Updates on its own — you don't have to keep checking.
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
                  <Link className="tx-link" to={`/jobs/${j.escrowId}`}>
                    Full brief &amp; delivered work →
                  </Link>
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
                    {Number(j.paidOut) > 0 && (
                      <li className="trail-item">
                        <span className="trail-icon">
                          <IconCoin size={14} />
                        </span>
                        <div>
                          <b>Paid — ${Number(j.paidOut).toFixed(2)} USDC</b>
                          <div className="trail-note">Released from escrow straight to the freelancer's wallet.</div>
                        </div>
                      </li>
                    )}
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
