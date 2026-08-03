import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { DaemonProvider } from "./daemon-context.tsx";
import Dashboard from "./pages/Dashboard.tsx";
import Jobs from "./pages/Jobs.tsx";
import JobDetail from "./pages/JobDetail.tsx";
import Decisions from "./pages/Decisions.tsx";
import Payments from "./pages/Payments.tsx";
import Freelancers from "./pages/Freelancers.tsx";
import Work from "./pages/Work.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <DaemonProvider>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Dashboard />} />
            <Route path="jobs" element={<Jobs />} />
            <Route path="jobs/:escrowId" element={<JobDetail />} />
            <Route path="decisions" element={<Decisions />} />
            <Route path="payments" element={<Payments />} />
            <Route path="freelancers" element={<Freelancers />} />
          <Route path="work" element={<Work />} />
          </Route>
        </Routes>
      </DaemonProvider>
    </BrowserRouter>
  </StrictMode>,
);
