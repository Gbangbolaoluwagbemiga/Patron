import { useEffect, useState } from "react";
import { ARC_EXPLORER, DAEMON_URL } from "../api";
import { useDaemon } from "../daemon-context";
import { computeFreelancerStats } from "../types";
import { PageCount, Pager, shorten } from "../components";
import { LedgerSkeleton } from "../motion";

interface Rating {
  average: number;
  count: number;
}

const PAGE_SIZE = 15;

export default function Freelancers() {
  const { tasks, decisions, payments, loaded } = useDaemon();
  const stats = computeFreelancerStats(tasks, decisions, payments);
  const [ratings, setRatings] = useState<Record<string, Rating>>({});
  const [handles, setHandles] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);

  const addressKey = stats.map((s) => s.address).join(",");

  useEffect(() => {
    if (!addressKey) return;
    // Ratings come from the CONTRACT, not from our own numbers — the whole point
    // of putting them on-chain is that a stranger can check them without
    // trusting us, so the page reads the same source they would.
    fetch(`${DAEMON_URL}/api/ratings?addresses=${addressKey}`)
      .then((r) => r.json())
      .then(setRatings)
      .catch(() => {});
    fetch(`${DAEMON_URL}/api/workers`)
      .then((r) => r.json())
      .then((ws: { handle: string; address: string | null }[]) =>
        setHandles(Object.fromEntries(ws.filter((w) => w.address).map((w) => [w.address!.toLowerCase(), w.handle]))),
      )
      .catch(() => {});
  }, [addressKey]);

  // Paged in the BROWSER, unlike the other ledgers. This register isn't a table
  // the server keeps — it's derived by walking every task, decision and payment
  // and folding them per person, so there is no query to offset. The rows are
  // people rather than events, which also means it grows far more slowly than
  // the feeds do.
  const pages = Math.max(1, Math.ceil(stats.length / PAGE_SIZE));
  const visible = stats.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Register of Adventurers</h1>
        <PageCount page={page} size={PAGE_SIZE} total={stats.length} />
      </div>
      <p className="page-sub">
        Every human who has taken a commission from Patron. The <b>on-chain rating</b> is written to the SecureFlow
        contract when a job completes and read back from it here — not computed by us, and verifiable by anyone
        without trusting us. Every other number is derived live from real hire, completion, and payment history, so
        nothing here can drift out of step with what actually happened.
      </p>

      {!loaded ? (
        <LedgerSkeleton rows={3} />
      ) : stats.length === 0 ? (
        <div className="empty">No adventurer has taken a commission yet.</div>
      ) : (
        <div className="rep-table-wrap">
          <table className="rep-table">
            <thead>
              <tr>
                <th>Adventurer</th>
                <th>On-chain rating</th>
                <th>Commissions</th>
                <th>Completed</th>
                <th>Completion Rate</th>
                <th>Total Earned</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.address}>
                  <td>
                    <a className="tx-link" href={`${ARC_EXPLORER}/address/${s.address}`} target="_blank" rel="noreferrer">
                      {handles[s.address.toLowerCase()] ?? shorten(s.address)} ↗
                    </a>
                  </td>
                  <td>
                    <OnChainRating rating={ratings[s.address.toLowerCase()]} />
                  </td>
                  <td>{s.hires}</td>
                  <td>{s.completedJobs}</td>
                  <td>
                    <span className={`rep-rate ${s.completionRate === 100 ? "rep-rate-perfect" : ""}`}>{s.completionRate}%</span>
                  </td>
                  <td className="amount">${s.totalEarnedUsdc.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pager page={page} pages={pages} onPage={setPage} newestLabel="Previous" oldestLabel="Next" />
    </div>
  );
}

/**
 * Ratings read from SecureFlow's own contract, not computed here.
 *
 * "No ratings yet" is shown rather than a zero: an unrated freelancer has no
 * score, which is a different thing from a score of zero, and showing 0.0 stars
 * next to someone who has simply never been rated would be a lie about them.
 */
function OnChainRating({ rating }: { rating?: { average: number; count: number } }) {
  if (!rating || rating.count === 0) return <span style={{ color: "var(--faint)", fontSize: 13 }}>no ratings yet</span>;
  const full = Math.round(rating.average);
  return (
    <span title={`${rating.average.toFixed(2)} from ${rating.count} rating${rating.count !== 1 ? "s" : ""}, on-chain`}>
      <span style={{ color: "var(--gold)", letterSpacing: 1 }}>{"★".repeat(full)}{"☆".repeat(Math.max(0, 5 - full))}</span>{" "}
      <span style={{ color: "var(--muted)", fontSize: 13 }}>
        {rating.average.toFixed(1)} ({rating.count})
      </span>
    </span>
  );
}
