// Reads from the same SecureFlow v3 subgraph — Patron queries jobs it posted
import { config } from "../config.js";

export function isGraphConfigured(): boolean {
  return Boolean(config.graphUrl);
}

export async function graphQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!config.graphUrl) throw new Error("GRAPH_URL is not set");

  const res = await fetch(config.graphUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return json.data as T;
}
