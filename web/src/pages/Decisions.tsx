import { AnimatePresence } from "framer-motion";
import { useDaemon } from "../daemon-context";
import { DecisionCard } from "../components";

export default function Decisions() {
  const { decisions } = useDaemon();

  return (
    <div className="page">
      <div className="page-header">
        <h1>Decision Log</h1>
      </div>
      <p className="page-sub">Claude's actual reasoning, verbatim, for every applicant score, hire, and work review Patron has ever made.</p>

      <div className="job-grid">
        <AnimatePresence initial={false}>
          {decisions.length === 0 ? (
            <div className="empty">No decisions yet.</div>
          ) : (
            decisions.map((d) => <DecisionCard key={d.id} decision={d} />)
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
