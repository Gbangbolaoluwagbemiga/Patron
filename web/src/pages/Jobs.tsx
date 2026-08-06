import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useDaemon } from "../daemon-context";
import { PageCount, Pager, SECUREFLOW_JOBS_URL, TaskCard } from "../components";
import { LedgerSkeleton } from "../motion";
import { usePaged } from "../paged";
import type { TaskRow } from "../types";

const PAGE_SIZE = 12;

export default function Jobs() {
  const { tasks: live, loaded } = useDaemon();
  const [page, setPage] = useState(0);

  // /api/commissions, not /api/tasks: rows that never opened an escrow are
  // excluded in SQL. Filtering them out in the browser was correct while the
  // page held everything and wrong the moment it pages — the server would send
  // 12, the page would drop 3, and a control promising "1–12 of 60" would show
  // nine cards.
  const { rows, total, busy, pages } = usePaged<TaskRow>("/api/commissions", page, PAGE_SIZE, page === 0 ? live.length : "static");

  return (
    <div className="page">
      <div className="page-header">
        <h1>Open Commissions</h1>
        <div className="page-header-right">
          <PageCount page={page} size={PAGE_SIZE} total={total} />
          <a className="tx-link" href={SECUREFLOW_JOBS_URL} target="_blank" rel="noreferrer">
            view all on SecureFlow ↗
          </a>
        </div>
      </div>
      <p className="page-sub">
        Every commission Patron has posted, whether the client was a human or another machine. Open an entry for its
        full brief, milestones, and history.
      </p>

      <div className="job-grid">
        <AnimatePresence initial={false}>
          {!loaded && rows.length === 0 ? (
            <LedgerSkeleton rows={4} />
          ) : rows.length === 0 ? (
            <div className="empty">No commissions have been opened yet.</div>
          ) : (
            rows.map((t) => <TaskCard key={t.id} task={t} />)
          )}
        </AnimatePresence>
      </div>

      <Pager page={page} pages={pages} onPage={setPage} busy={busy} />
    </div>
  );
}
