import { useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useDaemon } from "../daemon-context";
import { DecisionCard } from "../components";
import { LedgerSkeleton } from "../motion";
import { DAEMON_URL } from "../api";
import type { DecisionRow } from "../types";

const PAGE_SIZE = 20;

export default function Decisions() {
  // The live stream is still the reason to keep this page open, so page one
  // stays live: when a new decision lands over SSE the context updates, and
  // that re-triggers the fetch below. Older pages are a fixed window into the
  // past and have no business moving under the reader while they read.
  const { decisions: liveDecisions, loaded } = useDaemon();

  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<DecisionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setFetching(true);
    fetch(`${DAEMON_URL}/api/decisions?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        // Exposed via Access-Control-Expose-Headers — without that the browser
        // hides it and every page looks like the last one.
        const count = Number(r.headers.get("X-Total-Count") ?? 0);
        return { data: (await r.json()) as DecisionRow[], count };
      })
      .then(({ data, count }) => {
        if (cancelled) return;
        setRows(data);
        if (count) setTotal(count);
      })
      .catch(() => {
        /* keep whatever is on screen rather than blanking the ledger */
      })
      .finally(() => !cancelled && setFetching(false));
    return () => {
      cancelled = true;
    };
    // liveDecisions.length is the SSE heartbeat: a new decision arriving is
    // exactly when page one should refresh.
  }, [page, page === 0 ? liveDecisions.length : 0]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = Math.min((page + 1) * PAGE_SIZE, total);
  const showSkeleton = !loaded && rows.length === 0;

  return (
    <div className="page">
      <div className="page-header">
        <h1>The Guild Master's Hand</h1>
        {total > 0 && (
          <span className="page-count">
            {first}–{last} of {total}
          </span>
        )}
      </div>
      <p className="page-sub">
        Written in the margin beside every entry: the guild master's actual reasoning, verbatim and unedited, for every
        applicant scored, portfolio checked, human hired, and piece of work inspected.
      </p>

      <div className="job-grid marginalia">
        <AnimatePresence initial={false}>
          {showSkeleton ? (
            <LedgerSkeleton rows={5} />
          ) : rows.length === 0 ? (
            <div className="empty">The guild master has not written anything yet.</div>
          ) : (
            rows.map((d) => <DecisionCard key={d.id} decision={d} />)
          )}
        </AnimatePresence>
      </div>

      {pages > 1 && (
        <div className="pager">
          <button className="pager-btn" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || fetching}>
            ← Newer
          </button>

          <div className="pager-pages">
            {pageWindow(page, pages).map((p, i) =>
              p === null ? (
                <span key={`gap-${i}`} className="pager-gap">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  className={`pager-num ${p === page ? "current" : ""}`}
                  onClick={() => setPage(p)}
                  disabled={fetching}
                  aria-current={p === page ? "page" : undefined}
                >
                  {p + 1}
                </button>
              ),
            )}
          </div>

          <button
            className="pager-btn"
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1 || fetching}
          >
            Older →
          </button>
        </div>
      )}

      {page > 0 && (
        <div className="pager-note">
          Reading the archive. New decisions land on <button className="linklike" onClick={() => setPage(0)}>page 1</button>.
        </div>
      )}
    </div>
  );
}

/**
 * A short window of page numbers around the current one, with gaps.
 *
 * Rendering every page is fine at four pages and unusable at four hundred —
 * which is the situation this whole change exists to prepare for.
 */
function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const out: (number | null)[] = [0];
  const from = Math.max(1, current - 1);
  const to = Math.min(total - 2, current + 1);
  if (from > 1) out.push(null);
  for (let p = from; p <= to; p++) out.push(p);
  if (to < total - 2) out.push(null);
  out.push(total - 1);
  return out;
}
