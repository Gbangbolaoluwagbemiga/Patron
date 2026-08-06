import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useDaemon } from "../daemon-context";
import { DecisionCard, MilestoneList, PaymentCard, SECUREFLOW_JOBS_URL, timeAgo } from "../components";
import { parseBrief } from "../types";
import { DAEMON_URL } from "../api";
import { IconBrain, IconCheck, IconCoin, IconScroll, IconSplit } from "../Icon";

/** One milestone as the chain actually has it — including what was delivered. */
interface DeliveredMilestone {
  index: number;
  planned: string;
  amount: number | null;
  status: string;
  statusCode: number;
  submittedAt: number | null;
  approvedAt: number | null;
  delivered: string | null;
  links: string[];
}

export default function JobDetail() {
  const { escrowId } = useParams();
  const { tasks, decisions, payments } = useDaemon();

  // The work itself, for the person who paid for it. Polled rather than pushed:
  // it changes a handful of times in a job's life, and the SSE stream carries
  // events rather than the contents of a delivery.
  const [work, setWork] = useState<DeliveredMilestone[]>([]);
  useEffect(() => {
    if (!escrowId) return;
    const load = () =>
      fetch(`${DAEMON_URL}/api/jobs/work?escrowId=${escrowId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d?.milestones && setWork(d.milestones))
        .catch(() => {});
    void load();
    const t = window.setInterval(load, 15_000);
    return () => window.clearInterval(t);
  }, [escrowId]);

  const delivered = work.filter((m) => m.delivered);

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

      {/* The delivered work.
          This is what the client actually bought, and until now there was
          nowhere to collect it: the submission went on-chain, was read by the
          reviewer, and was never shown to anyone. Approved and paid, with the
          logo nowhere in sight. */}
      <div className="panel" style={{ marginTop: 20 }}>
        <h2>
          <IconCheck size={15} /> The delivered work
          {delivered.length > 0 && (
            <span className="panel-header-link" style={{ color: "var(--faint)" }}>
              {delivered.length} of {work.length} delivered
            </span>
          )}
        </h2>
        <div className="panel-body">
          {delivered.length === 0 ? (
            <div className="empty">
              Nothing delivered yet. When the freelancer sends their work it appears here — the file, the link, and
              whether the guild master accepted it.
            </div>
          ) : (
            delivered.map((m) => (
              <div className="milestone" key={m.index} style={{ marginBottom: 12 }}>
                <div className="milestone-index">{m.index + 1}</div>
                <div className="milestone-body">
                  <div className="milestone-desc">{m.planned || `Milestone ${m.index + 1}`}</div>

                  <div className="brief-field" style={{ marginTop: 8 }}>
                    <div className="brief-label">What was delivered</div>
                    <div style={{ whiteSpace: "pre-wrap" }}>{m.delivered}</div>
                  </div>

                  {m.links.length > 0 && (
                    <div className="brief-field">
                      <div className="brief-label">{m.links.length === 1 ? "The file" : "The files"}</div>
                      {m.links.map((l) => (
                        <div key={l}>
                          <a className="tx-link" href={l} target="_blank" rel="noreferrer">
                            {l.length > 64 ? `${l.slice(0, 64)}…` : l} ↗
                          </a>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="milestone-meta">
                    {m.amount != null && <span className="amount">${m.amount}</span>}
                    <span className={`milestone-state milestone-state-${m.statusCode === 2 ? "paid" : "pending"}`}>{m.status}</span>
                    {m.submittedAt && <span>sent {timeAgo(m.submittedAt)}</span>}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

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
