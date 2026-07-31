// Slot computation, split out of index.js so it can be imported without
// pulling in the Workflow class.
//
// index.js re-exports BookingWorkflow (cal/src/workflow.js), which imports
// `cloudflare:workers`. That's fine inside wrangler, which resolves the scheme
// at bundle time, but plain `node --test` can't load it: the default ESM loader
// only understands file:, data:, and node:. So anything a Node test touches has
// to reach the slot logic WITHOUT going through index.js. The site worker's
// /coffee/availability.json route and contract-tests.mjs both import from here
// for that reason.

import { generateSlots, fetchBusySWR, BOOK_MAX_STALE_MS } from "./availability.js";
import { listHeld } from "./booking.js";

// returns { slots, cal } where cal is the SWR calendar metadata (busy, ageMs,
// ok, source). Callers that only need the listing destructure { slots };
// route_book also reads { cal } to fail closed on an unvouchable calendar.
// timings (optional) collects per-step durations for a Server-Timing header.
export async function listOpenSlots(env, ctx, timings = null, options = {}) {
  const mark = (name, p) => {
    if (!timings) return p;
    const s = Date.now();
    return p.then(v => { timings[name] = Date.now() - s; return v; },
                  e => { timings[name] = Date.now() - s; throw e; });
  };
  // every held slot (pending reservation OR confirmed coffee) blocks its exact
  // slot AND counts toward the caps. A pending hold is reclaimed by the booking's
  // expiry Workflow if the host never acts; a confirmed hold self-expires just
  // after the event. listHeld reads them all in one shot (one key per slot).
  const [cal, held] = await Promise.all([
    mark("ics", fetchBusySWR(env, ctx, options)),
    mark("held", listHeld(env)),
  ]);
  // busy → conflict-only (your real calendar); coffee bookings (held) → conflict
  // + count toward DAILY/WEEKLY_LIMIT. keeping them separate is what stops a
  // packed calendar from zeroing out availability.
  const t = Date.now();
  const slots = generateSlots(env, cal.busy, held);
  if (timings) timings.slots = Date.now() - t;
  return { slots, cal };
}

// Public read-only availability. Unlike the human booking page's stale render,
// this contract is a scheduling signal: it returns no slots when the calendar
// cannot be vouched for within the same 15-minute bound used by /book.
export async function getPublicAvailability(env, ctx) {
  const { slots, cal } = await listOpenSlots(env, ctx);
  const ageMs = Number.isFinite(cal.ageMs) ? Math.max(0, cal.ageMs) : null;
  const available = !!cal.ok && ageMs != null && ageMs <= BOOK_MAX_STALE_MS;
  return {
    available,
    stale: !available || cal.source === "stale",
    source: cal.source,
    checkedAt: new Date().toISOString(),
    ageSeconds: ageMs == null ? null : Math.floor(ageMs / 1000),
    timezone: env.HOST_TIMEZONE || "UTC",
    bookingUrl: "https://aadhar.sh/coffee",
    slots: available ? slots.map(({ start, end }) => ({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      startMs: start,
      endMs: end,
      durationMinutes: Math.round((end - start) / 60000),
    })) : [],
  };
}
