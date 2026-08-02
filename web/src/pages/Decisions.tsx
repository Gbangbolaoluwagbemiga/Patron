import { AnimatePresence } from "framer-motion";
import { useDaemon } from "../daemon-context";
import { DecisionCard } from "../components";

export default function Decisions() {
  const { decisions } = useDaemon();

  return (
    <div className="page">
      <div className="page-header">
        <h1>The Guild Master's Hand</h1>
      </div>
      <p className="page-sub">
        Written in the margin beside every entry: the guild master's actual reasoning, verbatim and unedited, for
        every applicant scored, portfolio checked, human hired, and piece of work inspected.
      </p>

      <div className="job-grid marginalia">
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
