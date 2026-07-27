import { ARC_EXPLORER, useDaemonFeed } from "./api";
import type { DecisionRow, PaymentRow, TaskRow } from "./types";

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function shorten(addr: string | null | undefined): string {
  if (!addr) return "—";
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

function TaskCard({ task }: { task: TaskRow }) {
  return (
    <div className="card">
      <div className="card-row">
        <span className={`badge ${task.clientType}`}>{task.clientType === "agent" ? "AI Agent" : "Human"}</span>
        <span className={`badge status-${task.status}`}>{task.status}</span>
      </div>
      <div className="card-title">{task.instruction}</div>
      <div className="card-row" style={{ marginTop: 8, marginBottom: 0 }}>
        <span>{timeAgo(task.createdAt)}</span>
        {task.escrowId && (
          <a className="tx-link" href={`${ARC_EXPLORER}/address/${task.escrowId}`} target="_blank" rel="noreferrer">
            escrow #{task.escrowId} ↗
          </a>
        )}
      </div>
    </div>
  );
}

function DecisionCard({ decision }: { decision: DecisionRow }) {
  const isInjection = decision.reasoning.includes("[PROMPT INJECTION DETECTED]");
  return (
    <div className="card">
      <div className="card-row">
        <span className="badge">{decision.type.replace(/_/g, " ")}</span>
        {decision.score != null && <span className="amount">{decision.score}/100</span>}
      </div>
      <div className={`card-reasoning ${isInjection ? "injection" : ""}`}>{decision.reasoning}</div>
      {decision.target && <div className="card-row" style={{ marginTop: 6, marginBottom: 0 }}>{shorten(decision.target)}</div>}
    </div>
  );
}

function PaymentCard({ payment }: { payment: PaymentRow }) {
  const label: Record<PaymentRow["direction"], string> = {
    in: "Robot → Patron",
    out: "Patron → Service",
    escrow_lock: "Locked in Escrow",
    escrow_release: "Escrow → Human",
  };
  return (
    <div className="card">
      <div className="card-row">
        <span className={`badge direction-${payment.direction}`}>{label[payment.direction]}</span>
        <span className="amount">{payment.amount_usdc ? `$${payment.amount_usdc}` : ""}</span>
      </div>
      <div className="card-row" style={{ marginBottom: 0 }}>
        <span>{timeAgo(payment.timestamp)}</span>
        {payment.tx_hash && (
          <a className="tx-link" href={`${ARC_EXPLORER}/tx/${payment.tx_hash}`} target="_blank" rel="noreferrer">
            view tx ↗
          </a>
        )}
      </div>
    </div>
  );
}

function App() {
  const { connected, tasks, decisions, payments } = useDaemonFeed();

  return (
    <div className="app">
      <div className="header">
        <div className="brand">
          <h1>PATRON</h1>
          <span>Command Center — the human-labor endpoint of the agent economy</span>
        </div>
        <div className="status">
          <span className={`dot ${connected ? "live" : ""}`} />
          {connected ? "Live — connected to the daemon" : "Disconnected"}
        </div>
      </div>

      <div className="keycard">
        <b>The one-way key:</b> Patron's guild-master agent can release escrowed funds to a freelancer — it can{" "}
        <b>never</b> confiscate them. Rejection triggers a revision round with written feedback, never theft. Every
        decision below is Claude's actual reasoning, verbatim, and every payment links to Arc Testnet.
      </div>

      <div className="grid">
        <div className="panel">
          <h2>🗺️ Quest Board — jobs</h2>
          <div className="panel-body">
            {tasks.length === 0 ? (
              <div className="empty">No jobs yet — waiting for an agent or human to post one.</div>
            ) : (
              tasks.map((t) => <TaskCard key={t.id} task={t} />)
            )}
          </div>
        </div>

        <div className="panel">
          <h2>🧠 Decision Log — Claude's reasoning</h2>
          <div className="panel-body">
            {decisions.length === 0 ? (
              <div className="empty">No decisions yet.</div>
            ) : (
              decisions.map((d) => <DecisionCard key={d.id} decision={d} />)
            )}
          </div>
        </div>

        <div className="panel">
          <h2>💸 Payment Feed</h2>
          <div className="panel-body">
            {payments.length === 0 ? (
              <div className="empty">No payments yet.</div>
            ) : (
              payments.map((p) => <PaymentCard key={p.id} payment={p} />)
            )}
          </div>
        </div>
      </div>

      <div className="footer">
        Read-only viewer — no wallet connect, no keys, no auth. Everything above is served live by the Patron daemon over SSE.
      </div>
    </div>
  );
}

export default App;
