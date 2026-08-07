import { useEffect, useRef, useState } from "react";
import type { AgentEvent, DecisionRow, PaymentRow, TaskRow } from "./types";

export const DAEMON_URL = import.meta.env.VITE_DAEMON_URL ?? "http://localhost:8787";
export const ARC_EXPLORER = "https://testnet.arcscan.app";

/**
 * One request helper, surfacing the daemon's own error text.
 *
 * The daemon answers failures with { error: "a sentence written for a human" },
 * and a helper that throws "500" instead of that sentence discards the single
 * most useful thing in the response.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string })?.error ?? `${path} → ${res.status}`);
  return body as T;
}

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
    case "portfolio_verified":
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

export interface WalletInfo {
  address: string;
  balance: string;
  explorerUrl: string;
}

/** Patron's treasury address + live balance — read-only, no keys involved. Polled
 * rather than pushed over SSE since it changes only when a job is posted/paid. */
export function useWallet() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);

  async function refresh() {
    try {
      setWallet(await getJson<WalletInfo>("/api/wallet"));
    } catch {
      // leave the last known value in place rather than blanking it on a hiccup
    }
  }

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(interval);
  }, []);

  return { wallet, refreshWallet: refresh };
}

/** Polls a REST snapshot once, then keeps it fresh by prepending live SSE events. */
export function useDaemonFeed() {
  const [connected, setConnected] = useState(false);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [liveEvents, setLiveEvents] = useState<AgentEvent[]>([]);
  const [lastEvent, setLastEvent] = useState<AgentEvent | null>(null);
  // Distinguishes "no data yet" from "genuinely nothing here". Without it the
  // first paint shows the empty-state copy for a beat before real rows arrive,
  // which reads as a broken page — and on a slow connection, as an empty product.
  const [loaded, setLoaded] = useState(false);
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
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void refresh();

    const source = new EventSource(`${DAEMON_URL}/events`);
    source.onopen = () => {
      setConnected(true);
      // The browser's EventSource auto-reconnects silently after any daemon restart
      // or network blip — without this, whatever happened during the gap (a hire, a
      // payment) never reaches this tab, and the pipeline/stats visibly desync from
      // reality until the next unrelated live event papers over it.
      void refresh();
    };
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

    // Belt-and-braces: resync periodically regardless of SSE state, so a long-open
    // tab can never drift far from the daemon even if a reconnect is itself missed.
    const fallback = window.setInterval(() => void refresh(), 20_000);

    return () => {
      source.close();
      window.clearInterval(fallback);
    };
  }, []);

  return { connected, tasks, decisions, payments, liveEvents, lastEvent, loaded, refresh };
}
