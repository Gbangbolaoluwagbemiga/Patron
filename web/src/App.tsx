import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useDaemon } from "./daemon-context";
import { Nav, NotificationCenter } from "./components";
import { pageVariants } from "./motion";

function App() {
  const { connected, liveEvents } = useDaemon();
  const location = useLocation();

  return (
    <div className="app">
      <NotificationCenter liveEvents={liveEvents} />
      <Nav connected={connected} />

      {/* Keyed on pathname so each route genuinely enters and leaves — a page
          being turned rather than content swapped in place. mode="wait" so the
          two never overlap, which on a light background reads as a flicker
          rather than a transition. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={location.pathname} variants={pageVariants} initial="initial" animate="animate" exit="exit">
          <Outlet />
        </motion.div>
      </AnimatePresence>

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
  );
}

export default App;
