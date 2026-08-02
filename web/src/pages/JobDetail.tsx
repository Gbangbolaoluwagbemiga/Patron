import { Link, useParams } from "react-router-dom";
import { useDaemon } from "../daemon-context";
import { DecisionCard, MilestoneList, PaymentCard, SECUREFLOW_JOBS_URL, timeAgo } from "../components";
import { parseBrief } from "../types";
import { IconBrain, IconCoin, IconScroll, IconSplit } from "../Icon";

export default function JobDetail() {
  const { escrowId } = useParams();
  const { tasks, decisions, payments } = useDaemon();

  const task = tasks.find((t) => t.escrowId === escrowId);

  if (!task) {
    return (
      <div className="page">
        <Link className="tx-link" to="/jobs">
          ← back to Open Commissions
        </Link>
        <div className="empty" style={{ marginTop: 20 }}>
          Job #{escrowId} not found (yet — if you just posted it, give the daemon a moment and refresh).
        </div>
      </div>
    );
  }

  const brief = parseBrief(task);
  const jobDecisions = decisions.filter((d) => d.task_id === escrowId);
  const jobPayments = payments.filter((p) => p.escrow_id === escrowId);

  return (
    <div className="page">
      <Link className="tx-link" to="/jobs">
        ← back to Open Commissions
      </Link>

      <div className="page-header" style={{ marginTop: 12 }}>
        <h1>{brief?.title ?? task.instruction}</h1>
        <a className="tx-link" href={SECUREFLOW_JOBS_URL} target="_blank" rel="noreferrer">
          view on SecureFlow ↗
        </a>
      </div>

      <div className="card-row" style={{ marginBottom: 20 }}>
        <span className={`badge ${task.clientType}`}>{task.clientType === "agent" ? "AI Agent client" : "Human client"}</span>
        <span className={`badge status-${task.status}`}>{task.status}</span>
        <span>escrow #{task.escrowId}</span>
        <span>{timeAgo(task.createdAt)}</span>
      </div>

      {!brief ? (
        <div className="empty">Brief still generating…</div>
      ) : (
        <div className="grid-2">
          <div className="panel">
            <h2>
              <IconScroll size={15} /> Acceptance Brief
            </h2>
            <div className="panel-body">
              <div className="brief-field">
                <div className="brief-label">Instruction</div>
                <div>{task.instruction}</div>
              </div>
              <div className="brief-field">
                <div className="brief-label">Budget / Duration</div>
                <div>
                  ${brief.budget} USDC · {brief.durationDays} day(s) · up to {brief.revisionRounds} revision round(s)
                </div>
              </div>
              <div className="brief-field">
                <div className="brief-label">Deliverable Format</div>
                <div>{brief.deliverableFormat}</div>
              </div>
              <div className="brief-field">
                <div className="brief-label">Acceptance Criteria</div>
                <ul className="criteria-list">
                  {brief.criteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
              <div className="brief-field">
                <div className="brief-label">Criteria hash (on-chain, in projectDescription)</div>
                <code className="treasury-address">{brief.briefHash}</code>
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>
              <IconSplit size={15} /> Milestones — how the budget is split
            </h2>
            <div className="panel-body">
              <MilestoneList task={task} payments={jobPayments} />
            </div>
          </div>
        </div>
      )}

      <div className="grid-2" style={{ marginTop: 20 }}>
        <div className="panel">
          <h2>
            <IconBrain size={15} /> The guild master's hand, on this entry
          </h2>
          <div className="panel-body">
            {jobDecisions.length === 0 ? (
              <div className="empty">No decisions yet.</div>
            ) : (
              jobDecisions.map((d) => <DecisionCard key={d.id} decision={d} />)
            )}
          </div>
        </div>
        <div className="panel">
          <h2>
            <IconCoin size={15} /> Monies against this entry
          </h2>
          <div className="panel-body">
            {jobPayments.length === 0 ? (
              <div className="empty">No payments yet.</div>
            ) : (
              jobPayments.map((p) => <PaymentCard key={p.id} payment={p} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
