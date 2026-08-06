import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useDaemon } from "../daemon-context";
import { DecisionCard, PageCount, Pager } from "../components";
import { LedgerSkeleton } from "../motion";
import { usePaged } from "../paged";
import type { DecisionRow } from "../types";

const PAGE_SIZE = 20;

export default function Decisions() {
  const { decisions: live, loaded } = useDaemon();
  const [page, setPage] = useState(0);

  // Page one stays LIVE — the reason to keep this page open is watching the
  // guild master think, so a decision arriving over SSE refreshes it. Older
  // pages are a fixed window into the past and must not shuffle mid-read.
  const { rows, total, busy, pages } = usePaged<DecisionRow>("/api/decisions", page, PAGE_SIZE, page === 0 ? live.length : "static");

  return (
    <div className="page">
      <div className="page-header">
        <h1>The Guild Master's Hand</h1>
        <PageCount page={page} size={PAGE_SIZE} total={total} />
      </div>
      <p className="page-sub">
        Written in the margin beside every entry: the guild master's actual reasoning, verbatim and unedited, for every
        applicant scored, portfolio checked, human hired, and piece of work inspected.
      </p>

      <div className="job-grid marginalia">
        <AnimatePresence initial={false}>
          {!loaded && rows.length === 0 ? (
            <LedgerSkeleton rows={5} />
          ) : rows.length === 0 ? (
            <div className="empty">The guild master has not written anything yet.</div>
          ) : (
            rows.map((d) => <DecisionCard key={d.id} decision={d} />)
          )}
        </AnimatePresence>
      </div>

      <Pager page={page} pages={pages} onPage={setPage} busy={busy} />

      {page > 0 && (
        <div className="pager-note">
          Reading the archive. New decisions land on{" "}
          <button className="linklike" onClick={() => setPage(0)}>
            page 1
          </button>
          .
        </div>
      )}
    </div>
  );
}
