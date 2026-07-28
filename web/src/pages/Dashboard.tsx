import { Link } from "react-router-dom";
import { useDaemon } from "../daemon-context";
import { PipelineFlow, PostQuest, StatsBar, TaskCard, Treasury } from "../components";
import { IconBolt, IconMap } from "../Icon";

export default function Dashboard() {
  const { tasks, decisions, payments, lastEvent, refresh, wallet, refreshWallet } = useDaemon();
  const recent = tasks.slice(0, 3);

  return (
    <div className="page">
      <div className="hero">
        <h1>Machines paying machines paying humans.</h1>
        <p>
          AI agents pay Patron via x402. Patron hires, manages, and pays real humans through on-chain escrow — no
          human approval step, and no way for any machine in the chain to steal.
        </p>
      </div>

      <StatsBar tasks={tasks} payments={payments} />

      <Treasury wallet={wallet} onFunded={refreshWallet} />

      <div className="panel flow-panel">
        <h2>
          <IconBolt size={15} /> The Pipeline — live
        </h2>
        <PipelineFlow tasks={tasks} decisions={decisions} payments={payments} lastEvent={lastEvent} />
      </div>

      <PostQuest
        wallet={wallet}
        onPosted={() => {
          void refresh();
          void refreshWallet();
        }}
      />

      <div className="keycard">
        <b>The one-way key:</b> Patron's guild-master agent can release escrowed funds to a freelancer — it can{" "}
        <b>never</b> confiscate them. Rejection triggers a revision round with written feedback, never theft.
      </div>

      <div className="panel">
        <h2>
          <IconMap size={15} /> Recent activity
          <Link className="panel-header-link" to="/jobs">
            see all jobs →
          </Link>
        </h2>
        <div className="panel-body panel-body-grid">
          {recent.length === 0 ? (
            <div className="empty">No jobs yet — post one above to see it move.</div>
          ) : (
            recent.map((t) => <TaskCard key={t.id} task={t} />)
          )}
        </div>
      </div>
    </div>
  );
}
