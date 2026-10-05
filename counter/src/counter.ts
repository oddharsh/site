import { claimReservation, dropReservation } from "../../cal/src/reservation.ts";
import { jsonResponse, PLAIN_JSON } from "../../src/worker/lib/http.ts";

// Same bytes and headers as json(): this only ever answers aadhar-sh.
const json = (body, status = 200) => jsonResponse(body, status, PLAIN_JSON, { pretty: false });

// counter.ts — the Counter Durable Object, which aadhar-counter implements and
// aadhar-sh binds as COUNTER.
//
// It lived in the site Worker (src/worker/counter.ts) from 2026-07-01 until it
// moved here by transfer on 2026-09-29, because a Worker that implements a
// Durable Object gets no preview URLs (CLAUDE.md, "Moving Counter out"). The
// code moved unchanged. So did the data: the transfer kept the namespace, so
// "homepage-visits" and every coffee slot claim are the same objects they were.
//
// Same wire protocol the site's /hit handler speaks: GET https://do/ increments
// and returns {n}; ?peek=1 reads without bumping (bots, prerender). Storage is
// the per-object SQLite-backed KV (state.storage).
//
// This class also backs the coffee slot reservations, under instance names of
// the form `coffee-slot:<start>:<end>`. Two jobs in one class is deliberate:
// instances are isolated by name, so a slot shares nothing with
// "homepage-visits", and the storage keys differ as well ("reservation" vs
// "n"). A second class would be a lifecycle change for no gain. The
// reservation logic itself lives in cal/src/reservation.ts, pure over a storage
// interface, so it is tested without a runtime. See that file for why the pair
// has to be atomic at all.
//
// It is hand-rolled rather than extending DurableObject from
// "cloudflare:workers", for the reason gotcha 16 gives: the contract suite
// imports these modules outside workerd, where that scheme does not resolve.
export class Counter {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // The reservation paths come first: they are addressed by pathname and must
    // never fall through to the odometer, which would bump a visit count on a
    // slot instance.
    if (url.pathname === "/reserve" || url.pathname === "/release") {
      let payload;
      try { payload = await request.json(); } catch { return json({ error: "invalid body" }, 400); }
      const bookingId = String(payload?.bookingId || "");
      if (!bookingId) return json({ error: "bookingId is required" }, 400);
      if (url.pathname === "/release") {
        return json({ released: await dropReservation(this.state.storage, bookingId) });
      }
      const claimed = await claimReservation(
        this.state.storage, bookingId, Number(payload.start), Number(payload.end),
      );
      return json({ claimed });
    }

    let n = (await this.state.storage.get<number>("n")) || 0;

    // read-only: bots + speculative prerenders see the value without bumping it
    if (url.searchParams.has("peek")) return json({ n });

    // default: atomic increment (classic-90s-counter behavior, no session dedup)
    n += 1;
    await this.state.storage.put("n", n);
    return json({ n });
  }
}
