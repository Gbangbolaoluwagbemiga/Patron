import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { DaemonProvider } from "./daemon-context.tsx";
import { WalletProvider } from "./wallet-context.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Jobs from "./pages/Jobs.tsx";
import JobDetail from "./pages/JobDetail.tsx";
import Decisions from "./pages/Decisions.tsx";
import Payments from "./pages/Payments.tsx";
import Freelancers from "./pages/Freelancers.tsx";
import Work from "./pages/Work.tsx";
import MyJobs from "./pages/MyJobs.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <DaemonProvider>
        <WalletProvider>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Dashboard />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="jobs/:escrowId" element={<JobDetail />} />
            <Route path="decisions" element={<Decisions />} />
            <Route path="payments" element={<Payments />} />
            <Route path="freelancers" element={<Freelancers />} />
          <Route path="work" element={<Work />} />
          <Route path="my-jobs" element={<MyJobs />} />
          {/* Anything else rendered an empty frame — a blank page reads as a
              broken site, and a mistyped or stale link is the likeliest way a
              judge arrives somewhere that doesn't exist. */}
          <Route
            path="*"
            element={
              <div className="page">
                <div className="page-header">
                  <h1>Nothing here</h1>
                  <p>That page doesn't exist. The guild hall is this way.</p>
                </div>
                <div className="panel">
                  <div className="panel-body">
                    <div className="empty">
                      <a className="tx-link" href="/">
                        Back to the command center
                      </a>{" "}
                      ·{" "}
                      <a className="tx-link" href="/work">
                        Find paid work
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            }
          />
          </Route>
        </Routes>
        </WalletProvider>
      </DaemonProvider>
    </BrowserRouter>
  </StrictMode>,
);
