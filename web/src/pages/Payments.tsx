import { AnimatePresence } from "framer-motion";
import { useDaemon } from "../daemon-context";
import { PaymentCard } from "../components";
import { LedgerSkeleton } from "../motion";

export default function Payments() {
  const { payments, loaded } = useDaemon();
  const totalIn = payments.filter((p) => p.direction === "in").reduce((s, p) => s + parseFloat(p.amount_usdc || "0"), 0);
  const totalOut = payments.filter((p) => p.direction === "escrow_release").reduce((s, p) => s + parseFloat(p.amount_usdc || "0"), 0);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Account of Monies</h1>
      </div>
      <p className="page-sub">
        Every sum Patron has taken in or paid out — ${totalIn.toFixed(2)} received from machines over x402, $
        {totalOut.toFixed(2)} released to humans out of escrow. Each line is a real transaction on Arc; follow any
        one of them to the explorer.
      </p>

      <div className="job-grid">
        <AnimatePresence initial={false}>
          {!loaded ? (
            <LedgerSkeleton rows={4} />
          ) : payments.length === 0 ? (
            <div className="empty">No monies have moved yet.</div>
          ) : (
            payments.map((p) => <PaymentCard key={p.id} payment={p} />)
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
