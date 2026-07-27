import { AnimatePresence } from "framer-motion";
import { useDaemon } from "../daemon-context";
import { PaymentCard } from "../components";

export default function Payments() {
  const { payments } = useDaemon();
  const totalIn = payments.filter((p) => p.direction === "in").reduce((s, p) => s + parseFloat(p.amount_usdc || "0"), 0);
  const totalOut = payments.filter((p) => p.direction === "escrow_release").reduce((s, p) => s + parseFloat(p.amount_usdc || "0"), 0);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Payment Feed</h1>
      </div>
      <p className="page-sub">
        Every payment Patron has ever made or received — ${totalIn.toFixed(2)} received from agents over x402, $
        {totalOut.toFixed(2)} released to humans from escrow. Every entry links to Arc Testnet.
      </p>

      <div className="job-grid">
        <AnimatePresence initial={false}>
          {payments.length === 0 ? (
            <div className="empty">No payments yet.</div>
          ) : (
            payments.map((p) => <PaymentCard key={p.id} payment={p} />)
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
