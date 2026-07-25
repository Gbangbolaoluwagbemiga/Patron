// Reads from the same SecureFlow v3 subgraph — Patron queries jobs it posted
const GRAPH_URL = (import.meta.env.VITE_GRAPH_URL as string | undefined)?.trim() ?? "";

export function isGraphConfigured(): boolean {
  return Boolean(GRAPH_URL);
}

export async function graphQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  if (!GRAPH_URL) throw new Error("VITE_GRAPH_URL is not set");

  const res = await fetch(GRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data as T;
}
