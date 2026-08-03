import { AnimatePresence } from "framer-motion";
import { useDaemon } from "../daemon-context";
import { DecisionCard } from "../components";
import { LedgerSkeleton } from "../motion";

export default function Decisions() {
  const { decisions, loaded } = useDaemon();

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
          {!loaded ? (
            <LedgerSkeleton rows={5} />
          ) : decisions.length === 0 ? (
            <div className="empty">The guild master has not written anything yet.</div>
          ) : (
            decisions.map((d) => <DecisionCard key={d.id} decision={d} />)
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
