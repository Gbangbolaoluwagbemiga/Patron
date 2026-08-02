import { ARC_EXPLORER } from "../api";
import { useDaemon } from "../daemon-context";
import { computeFreelancerStats } from "../types";
import { shorten } from "../components";

export default function Freelancers() {
  const { tasks, decisions, payments } = useDaemon();
  const stats = computeFreelancerStats(tasks, decisions, payments);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Freelancers</h1>
      </div>
      <p className="page-sub">
        No separate reputation table — every number here is derived live from real hire, completion, and payment
        history. Nothing to drift out of sync.
      </p>

      {stats.length === 0 ? (
        <div className="empty">No freelancer has been hired yet.</div>
      ) : (
        <div className="rep-table-wrap">
          <table className="rep-table">
            <thead>
              <tr>
                <th>Freelancer</th>
                <th>Hires</th>
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
