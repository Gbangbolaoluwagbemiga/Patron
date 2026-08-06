// paged.ts — one server-paged list, fetched.
//
// The ledger pages were all written when the data was short: load everything,
// map over it, scroll. That was fine at 23 commissions and became a problem at
// 98 decisions, where the API's own cap started deleting history off the bottom
// of the page with nothing to say so.
//
// The totals matter as much as the rows. A page of payments that sums only the
// rows it is holding will happily print "$0.50 released to humans" while
// standing on page four of a ledger that has paid out $3.50 — so anything the
// server can total across the whole table comes back in a header, and this hook
// hands those back untouched.

import { useEffect, useState } from "react";
import { DAEMON_URL } from "./api";

export interface PagedResult<T> {
  rows: T[];
  total: number;
  /** Extra whole-table figures the endpoint chose to expose, e.g. X-Total-In. */
  headers: Record<string, string>;
  busy: boolean;
  pages: number;
}

/**
 * @param path      endpoint, without query
 * @param page      zero-based
 * @param size      rows per page
 * @param refreshOn a value that, when it changes, refetches — used to keep page
 *                  one live off the SSE stream. Pass a constant for pages that
 *                  should sit still while they're read.
 * @param extraHeaders header names to read off the response
 */
export function usePaged<T>(
  path: string,
  page: number,
  size: number,
  refreshOn: unknown = 0,
  extraHeaders: string[] = [],
): PagedResult<T> {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    fetch(`${DAEMON_URL}${path}?limit=${size}&offset=${page * size}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const got: Record<string, string> = {};
        for (const h of extraHeaders) {
          const v = r.headers.get(h);
          if (v !== null) got[h] = v;
        }
        return { data: (await r.json()) as T[], count: Number(r.headers.get("X-Total-Count") ?? 0), got };
      })
      .then(({ data, count, got }) => {
        if (cancelled) return;
        setRows(data);
        if (count) setTotal(count);
        if (Object.keys(got).length) setHeaders(got);
      })
      .catch(() => {
        /* keep what is on screen — a blank ledger reads as "nothing happened" */
      })
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, page, size, refreshOn]);

  return { rows, total, headers, busy, pages: Math.max(1, Math.ceil(total / size)) };
}
