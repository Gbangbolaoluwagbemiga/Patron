import { Outlet, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { useDaemon } from "./daemon-context";
import { Nav, NotificationCenter } from "./components";
import { pageVariants } from "./motion";

function App() {
  const { connected, liveEvents } = useDaemon();
  const location = useLocation();

  return (
    <div className="app-shell">
      <NotificationCenter liveEvents={liveEvents} />
      <Nav connected={connected} />
      <div className="app">

      {/* Keyed on pathname so each route genuinely enters rather than having its
          content swapped in place.

          This used to be wrapped in <AnimatePresence mode="wait">. That mode
          holds the INCOMING page at its initial state — opacity 0 — until the
          outgoing one reports that it has finished exiting. Every list page
          contains its own <AnimatePresence> full of cards animating `layout`,
          and when one of those exits stalls, the promise never resolves: the
          new page is mounted, laid out, and completely invisible. Navigating to
          the ledger and back left an empty screen with a working sidebar, which
          reads as a page that takes forever to load.

          A keyed entrance needs no coordination between the two pages, so there
          is nothing left to hang on. */}
      <motion.div key={location.pathname} variants={pageVariants} initial="initial" animate="animate">
        <Outlet />
      </motion.div>

      {/* /work is the one page where a person acts rather than watches, so the
          read-only note would be plainly false there. */}
      <div className="footer">
        {location.pathname === "/work" ? (
          <>
            Your wallet is a Circle MPC wallet held in split shares — no private key exists to be exported, by you or by
            anyone else. Patron signs on your instruction and never holds your money: approved work is paid to you
            directly by the escrow contract, and you can move your balance to any address you control at any time.
          </>
        ) : (
          <>
            Read-only viewer — no wallet connect needed for Patron's own keys, no auth. Everything above is served live
            by the Patron daemon over SSE. Connecting your own wallet only ever funds the treasury from your own
            signature.
          </>
        )}
        </div>
      </div>
    </div>
  );
}

export default App;
