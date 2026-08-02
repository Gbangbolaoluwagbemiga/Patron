import { AnimatePresence } from "framer-motion";
import { useDaemon } from "../daemon-context";
import { SECUREFLOW_JOBS_URL, TaskCard } from "../components";

export default function Jobs() {
  const { tasks: allTasks } = useDaemon();
  // A "failed" row never opened an escrow — the brief or the createEscrow call
  // threw — so it isn't a commission and doesn't belong on the commission board.
  const tasks = allTasks.filter((t) => t.status !== "failed");

  return (
    <div className="page">
      <div className="page-header">
        <h1>Open Commissions</h1>
        <a className="tx-link" href={SECUREFLOW_JOBS_URL} target="_blank" rel="noreferrer">
          view all on SecureFlow ↗
        </a>
      </div>
      <p className="page-sub">
        Every commission Patron has posted, whether the client was a human or another machine. Open an entry for its
        full brief, milestones, and history.
      </p>

      <div className="job-grid">
        <AnimatePresence initial={false}>
          {tasks.length === 0 ? (
            <div className="empty">No jobs yet.</div>
          ) : (
            tasks.map((t) => <TaskCard key={t.id} task={t} />)
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
