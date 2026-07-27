import { useEffect, useRef, useState } from "react";
import type { AgentEvent, DecisionRow, PaymentRow, TaskRow } from "./types";

export const DAEMON_URL = import.meta.env.VITE_DAEMON_URL ?? "http://localhost:8787";
export const ARC_EXPLORER = "https://testnet.arcscan.app";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${DAEMON_URL}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export async function postInstruction(instruction: string): Promise<{ taskId: string; escrowId: string }> {
  const res = await fetch(`${DAEMON_URL}/api/instruct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body;
}

/** Which pipeline stage a given AgentEvent (or task status) belongs to, for the flow diagram. */
export type Stage = "intake" | "brief" | "escrow" | "applicants" | "review" | "payout";

export function stageForEventType(type: string): Stage | null {
  switch (type) {
    case "brief_generated":
      return "brief";
    case "job_posted":
      return "escrow";
    case "applications_fetched":
    case "application_scored":
    case "applicant_accepted":
    case "no_suitable_applicant":
      return "applicants";
    case "work_submitted":
    case "work_approved":
    case "work_rejected":
    case "revision_requested":
    case "escalated_to_human":
      return "review";
    case "payment_released":
    case "task_completed":
      return "payout";
    default:
      return null;
  }
}

/** Polls a REST snapshot once, then keeps it fresh by prepending live SSE events. */
export function useDaemonFeed() {
  const [connected, setConnected] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<AgentEvent | null>(null);
  const refreshTimer = useRef<number | null>(null);

  async function refresh() {
    try {
      const [t, d, p] = await Promise.all([
        getJson<TaskRow[]>("/api/tasks"),
        getJson<DecisionRow[]>("/api/decisions"),
        getJson<PaymentRow[]>("/api/payments"),
      ]);
      setTasks(t);
      setDecisions(d);
      setPayments(p);
    } catch {
      // daemon unreachable — the connection banner already reflects this via SSE state
    }
  }

  useEffect(() => {
    void refresh();

    const source = new EventSource(`${DAEMON_URL}/events`);
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as AgentEvent;
        setLiveEvents((prev) => [event, ...prev].slice(0, 200));
        setLastEvent(event);
        // A new decision or payment landed server-side — pull the authoritative rows.
        if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
        refreshTimer.current = window.setTimeout(() => void refresh(), 300);
      } catch {
        // ignore malformed/keepalive frames
      }
    };

    return () => source.close();
  }, []);

  return { connected, tasks, decisions, payments, liveEvents, lastEvent, refresh };
}
