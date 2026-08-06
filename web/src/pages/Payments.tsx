import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useDaemon } from "../daemon-context";
import { PageCount, Pager, PaymentCard } from "../components";
import { LedgerSkeleton } from "../motion";
import { usePaged } from "../paged";
import type { PaymentRow } from "../types";

const PAGE_SIZE = 20;

export default function Payments() {
  const { payments: live, loaded } = useDaemon();
  const [page, setPage] = useState(0);

  // The totals come from HEADERS, summed in SQL across the whole table — not
  // from the rows on screen. Adding up the current page would have printed the
  // subtotal for page three under a heading that claims to be the full account.
  const { rows, total, headers, busy, pages } = usePaged<PaymentRow>(
    "/api/payments",
    page,
    PAGE_SIZE,
    page === 0 ? live.length : "static",
    ["X-Total-In", "X-Total-Out"],
  );

  const totalIn = Number(headers["X-Total-In"] ?? 0);
  const totalOut = Number(headers["X-Total-Out"] ?? 0);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Account of Monies</h1>
        <PageCount page={page} size={PAGE_SIZE} total={total} />
      </div>
      <p className="page-sub">
        Every sum Patron has taken in or paid out — ${totalIn.toFixed(2)} received from machines over x402, $
        {totalOut.toFixed(2)} released to humans out of escrow. Each line is a real transaction on Arc; follow any one
        of them to the explorer.
      </p>

      <div className="job-grid">
        <AnimatePresence initial={false}>
          {!loaded && rows.length === 0 ? (
            <LedgerSkeleton rows={4} />
          ) : rows.length === 0 ? (
            <div className="empty">No monies have moved yet.</div>
          ) : (
            rows.map((p) => <PaymentCard key={p.id} payment={p} />)
          )}
        </AnimatePresence>
      </div>

      <Pager page={page} pages={pages} onPage={setPage} busy={busy} />
    </div>
  );
}
