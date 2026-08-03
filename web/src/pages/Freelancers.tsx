import { ARC_EXPLORER } from "../api";
import { useDaemon } from "../daemon-context";
import { computeFreelancerStats } from "../types";
import { shorten } from "../components";
import { LedgerSkeleton } from "../motion";

export default function Freelancers() {
  const { tasks, decisions, payments, loaded } = useDaemon();
  const stats = computeFreelancerStats(tasks, decisions, payments);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Register of Adventurers</h1>
      </div>
      <p className="page-sub">
        Every human who has taken a commission from Patron. There is no separate reputation score kept anywhere —
        each number below is read straight out of real hire, completion, and payment history, so there is nothing
        that can drift out of step with what actually happened.
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
                <th>Commissions</th>
                <th>Completed</th>
                <th>Completion Rate</th>
                <th>Total Earned</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((s) => (
                <tr key={s.address}>
                  <td>
                    <a className="tx-link" href={`${ARC_EXPLORER}/address/${s.address}`} target="_blank" rel="noreferrer">
                      {shorten(s.address)} ↗
                    </a>
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
    </div>
  );
}
