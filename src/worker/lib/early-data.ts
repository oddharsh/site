// early-data.ts — refuse a side-effecting GET that arrived as TLS early data.
//
// With 0-RTT Connection Resumption on (Speed > Protocol Optimization; off by
// default on every plan), a returning client sends its first request inside the
// TLS handshake and saves a round trip. The price is that early data is
// REPLAYABLE: an attacker on the path, or an ordinary retransmit, can deliver
// the same bytes twice, and the server cannot tell the copy from the original.
// Cloudflare forwards such a request with `Early-Data: 1` (RFC 8470 section 5.1)
// and never sends a POST that way, so the exposure here is exactly the set of
// GET-shaped writes: a replayed /hit ticks the visit counter twice, a replayed
// /coffee/approve emails a real person twice.
//
// RFC 8470 section 5.2 gives the answer: 425 Too Early, sent only when the
// request carried Early-Data, and the client MUST retry after the handshake and
// MUST NOT retry in early data. Chrome honours it (its 145 regression that
// skipped the retry on query-string URLs is fixed in 145.0.7632.115). Every
// document and asset stays eligible for the fast path; only these routes pay a
// handshake, and only on a resumed connection.
//
// The list is preview.ts's GET-write list rather than a second copy of it. Those
// are the same routes for the same reason (a GET that changes durable state or
// sends something), and that list is pinned against both route tables by a
// contract test, so a route added there is guarded here the same day.

import { PREVIEW_GET_WRITES } from "./preview.ts";

export const EARLY_DATA_HEADER = "early-data";

// Pure over (headers, pathname), so the contract test can sweep the route
// table without booting a Worker. Returns the 425 to serve, or null.
export function earlyDataDenial(request: Request, pathname: string): Response | null {
  if (request.headers.get(EARLY_DATA_HEADER) !== "1") return null;
  if (!PREVIEW_GET_WRITES.has(pathname)) return null;
  return new Response(null, {
    status: 425,
    headers: {
      // A 425 is about THIS connection's handshake state, never about the
      // resource, so no cache may keep it and no intermediary may reuse it.
      "cache-control": "no-store",
    },
  });
}
