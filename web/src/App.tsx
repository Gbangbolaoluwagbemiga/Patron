import { Outlet } from "react-router-dom";
import { useDaemon } from "./daemon-context";
import { Nav, NotificationCenter } from "./components";

function App() {
  const { connected, liveEvents } = useDaemon();

  return (
    <div className="app">
      <NotificationCenter liveEvents={liveEvents} />
      <Nav connected={connected} />
      <Outlet />
      <div className="footer">
        Read-only viewer — no wallet connect needed for Patron's own keys, no auth. Everything above is served live by
        the Patron daemon over SSE. Connecting your own wallet only ever funds the treasury from your own signature.
      </div>
    </div>
  );
}

export default App;
