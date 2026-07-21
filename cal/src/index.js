// cal.aadhar.sh — coffee booking worker.
//
// flow:
//   1. visitor GET /         → renders booking page, slots injected from ICS
//   2. visitor POST /book    → creates pending booking in KV, emails host
//                              with signed approve/decline links
//   3. host clicks /approve  → marks confirmed, emails requester an .ics invite
//   4. host clicks /decline  → marks declined, frees the slot, emails a polite no
//   5. expiry timer          → each booking's BookingWorkflow reclaims the slot
//                              if the host never acts within PENDING_TTL_DAYS
//
// design notes:
//   - all state in KV; nothing in memory, Worker can scale to zero
//   - no auth: the only "host" interaction is clicking signed URLs from email
//   - signing uses HMAC-SHA256 over `${id}|${action}` with SIGNING_SECRET
//   - timezones are real: HOST_TIMEZONE drives display + working hours
//   - the public ICS calendar is read-only; we never write back. confirmed
//     events are pushed to the host's real calendar via the .ics invite
//     they accept in their own inbox.
//   - abandoned bookings expire via a durable per-booking Workflow, not a cron:
//     /book spins up one instance (id = booking id) that waits PENDING_TTL_DAYS
//     for a "host-decision" event; approve/decline fire that event to end it
//     early, and a timeout reclaims the slot (see cal/src/workflow.js).

import { generateSlots, fetchBusySWR,
         BOOK_MAX_STALE_MS }               from "./availability.js";
import { createBooking, getBooking, setStatus,
         holdSlot, releaseSlot, listHeld } from "./booking.js";
import { sendApprovalRequest, sendInvite,
         sendDecline }                     from "./email.js";
import { sign, verify }                    from "./sign.js";
import { bookingPage, successPage,
         confirmedPage, declinedPage,
         errorPage }                       from "./templates.js";

// Re-export the expiry-timer Workflow so it resolves as a class_name both from
// the root worker (which imports this module) and from the Vitest pool, whose
// `main` is this file. Production's BOOKING_WORKFLOW binding is defined on the
// root aadhar-sh Worker; this named export just keeps the class reachable here.
export { BookingWorkflow } from "./workflow.js";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    // Prefix-aware: the worker is routed under both cal.aadhar.sh/* and
    // aadhar.sh/coffee/*. Detect which prefix this request used so all
    // form actions + redirects stay on the same path. env is patched
    // per-request (no shared state — workers fetch is request-scoped).
    const basePath = url.pathname.startsWith("/coffee") ? "/coffee" : "";
    const path = basePath ? (url.pathname.slice(basePath.length) || "/") : url.pathname;
    env = { ...env, BASE_PATH: basePath };

    try {
      // routing — small enough not to need a router lib
      if (req.method === "GET"  && (path === "/" || path === ""))  return route_index(req, env, ctx);
      if (req.method === "GET"  && path === "/slots")              return route_slots(req, env, ctx);
      if (req.method === "POST" && path === "/book")               return route_book(req, env, ctx);
      if (req.method === "GET"  && path === "/approve")            return route_approve(req, env, ctx, url);
      if (req.method === "GET"  && path === "/decline")            return route_decline(req, env, ctx, url);
      return new Response(errorPage("not found", env), { status: 404, headers: htmlHeaders() });
    } catch (e) {
      console.error("unhandled", e?.stack || e);
      return new Response(errorPage("something broke. try again in a minute.", env),
                          { status: 500, headers: htmlHeaders() });
    }
  },
};

async function route_index(req, env, ctx) {
  // initial page is server-rendered with the next ~14 days of slots embedded
  // so the page works without JS for screen readers / scrapers / no-JS humans.
  // the form posts to /book; if JS is on, the page replaces the listing with
  // a live-updating slot view that re-fetches /slots after a booking.
  //
  // Cached 30s at the edge (caches.default). Safe because the live /slots JSON
  // is uncached AND /book re-validates the slot, so a briefly stale SSR listing
  // can never confirm a taken slot. Invalidated on book/approve/decline.
  const cache = caches.default;
  const key = calIndexKey(req, env);
  const hit = await cache.match(key);
  if (hit) { const r = new Response(hit.body, hit); r.headers.set("x-cal-cache", "hit"); return r; }

  const timings = {};
  const t0 = Date.now();
  const { slots, cal } = await listOpenSlots(env, ctx, timings, { allowStale: true });
  const rs = Date.now();
  const html = bookingPage(slots, env);
  timings.render = Date.now() - rs;
  timings.total = Date.now() - t0;

  const headers = {
    ...htmlHeaders(),
    // edge-cache 30s (caches.default keys on s-maxage), browser always
    // revalidates (max-age=0) so a returning visitor never sees a stale slot list.
    "cache-control": "public, max-age=0, s-maxage=30",
    "server-timing": fmtServerTiming(timings),
    "x-cal-source": cal.source,   // fresh | live | stale | none
  };
  const cached = new Response(html, { headers });
  if (ctx) ctx.waitUntil(cache.put(key, cached.clone()));
  return new Response(html, { headers: { ...headers, "x-cal-cache": "miss" } });
}

async function route_slots(req, env, ctx) {
  // live path — never cached, so the JS view always reflects the latest slots.
  const { slots } = await listOpenSlots(env, ctx);
  return Response.json({ slots });
}

async function route_book(req, env, ctx) {
  const ct = req.headers.get("content-type") || "";
  let payload;
  if (ct.includes("application/json")) {
    payload = await req.json();
  } else {
    const form = await req.formData();
    payload = Object.fromEntries(form);
  }

  // basic validation. real abuse prevention happens in the slot check below
  // (you can't double-book a slot that's already pending).
  const name  = (payload.name  || "").toString().trim().slice(0, 100);
  const email = (payload.email || "").toString().trim().slice(0, 200);
  const topic = (payload.topic || "").toString().trim().slice(0, 1000);
  const start = parseInt(payload.start, 10);

  if (!name || !email || !topic || !Number.isFinite(start)) {
    return new Response(errorPage("missing one of: name / email / topic / slot.", env),
                        { status: 400, headers: htmlHeaders() });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(errorPage("that email doesn't look right.", env),
                        { status: 400, headers: htmlHeaders() });
  }

  // verify the slot is still open RIGHT NOW (race window) against a calendar we
  // can vouch for. fail CLOSED: if the ICS upstream is down and the last-good
  // snapshot is too old, refuse rather than book over a real event we can't see.
  const { slots, cal } = await listOpenSlots(env, ctx);
  if (!cal.ok || cal.ageMs > BOOK_MAX_STALE_MS) {
    return new Response(errorPage("can't confirm the calendar right now — grab a slot again in a minute.", env),
                        { status: 503, headers: { ...htmlHeaders(), "retry-after": "60" } });
  }
  const slot = slots.find(s => s.start === start);
  if (!slot) {
    return new Response(errorPage("that slot was taken or expired. pick another.", env),
                        { status: 409, headers: htmlHeaders() });
  }

  // honeypot: if the hidden 'website' field is filled, silently accept-and-drop.
  // bots fill every visible-looking field; humans never see this one.
  if (payload.website) {
    return new Response(successPage(env), { headers: htmlHeaders() });
  }

  const booking = await createBooking(env, {
    name, email, topic,
    start: slot.start, end: slot.end,
    created: Date.now(),
    status: "pending",
  });
  // hold the slot SYNCHRONOUSLY (before responding) so a second booker in the
  // same instant can't grab it — /slots and the next /book both read this.
  await holdSlot(env, booking);

  // spin up the durable expiry timer for this booking. Instance id = booking id,
  // so approve/decline can address it directly. Best-effort + guarded: if the
  // binding is missing (older config) the booking still works, it just won't
  // auto-expire — no worse than before, and there's no cron to lean on now.
  if (env.BOOKING_WORKFLOW) {
    ctx.waitUntil((async () => {
      try {
        await env.BOOKING_WORKFLOW.create({ id: booking.id, params: { id: booking.id } });
      } catch (e) {
        console.error("booking workflow create failed", e?.stack || e);
      }
    })());
  }

  // sign approve/decline links so only someone with the secret can act on them
  const approveSig = await sign(`${booking.id}|approve`, env.SIGNING_SECRET);
  const declineSig = await sign(`${booking.id}|decline`, env.SIGNING_SECRET);
  // include BASE_PATH: a booking made at aadhar.sh/coffee must email links under
  // /coffee/* (the worker's only zone route there) — bare /approve|/decline fall
  // through to the main site and 404, so the host can't act on the request.
  const base = `https://${new URL(req.url).host}${env.BASE_PATH || ""}`;
  const approveUrl = `${base}/approve?t=${booking.id}&sig=${approveSig}`;
  const declineUrl = `${base}/decline?t=${booking.id}&sig=${declineSig}`;

  ctx.waitUntil(sendApprovalRequest(env, booking, approveUrl, declineUrl));
  ctx.waitUntil(caches.default.delete(calIndexKey(req, env)));  // slot now held: drop the stale SSR page

  return new Response(successPage(env), { headers: htmlHeaders() });
}

// tell a booking's expiry timer the host has acted, so it stops waiting and
// completes instead of sitting idle until the PENDING_TTL_DAYS timeout. Fire-
// and-forget: if the instance is already gone (completed/expired), sendEvent
// throws and we swallow it — the route already owns the state transition, so a
// missed cancel only means the workflow times out later and no-ops on the guard.
function cancelExpiry(env, ctx, id) {
  if (!env.BOOKING_WORKFLOW) return;
  ctx.waitUntil((async () => {
    try {
      const instance = await env.BOOKING_WORKFLOW.get(id);
      await instance.sendEvent({ type: "host-decision", payload: { resolved: true } });
    } catch { /* instance already finished or never created */ }
  })());
}

async function route_approve(req, env, ctx, url) {
  const id  = url.searchParams.get("t");
  const sig = url.searchParams.get("sig");
  if (!id || !sig || !(await verify(`${id}|approve`, sig, env.SIGNING_SECRET))) {
    return new Response(errorPage("approval link invalid or expired.", env),
                        { status: 401, headers: htmlHeaders() });
  }
  const booking = await getBooking(env, id);
  if (!booking) {
    return new Response(errorPage("booking not found (already expired?).", env),
                        { status: 404, headers: htmlHeaders() });
  }
  if (booking.status !== "pending") {
    return new Response(confirmedPage(booking, env, /*already=*/true),
                        { headers: htmlHeaders() });
  }
  await setStatus(env, id, "confirmed");   // slot stays held (confirmed coffees hold their slot + count toward caps)
  ctx.waitUntil(sendInvite(env, booking));
  cancelExpiry(env, ctx, id);                                   // end the durable timer early
  ctx.waitUntil(caches.default.delete(calIndexKey(req, env)));  // pending slot resolved
  return new Response(confirmedPage(booking, env, /*already=*/false),
                      { headers: htmlHeaders() });
}

async function route_decline(req, env, ctx, url) {
  const id  = url.searchParams.get("t");
  const sig = url.searchParams.get("sig");
  if (!id || !sig || !(await verify(`${id}|decline`, sig, env.SIGNING_SECRET))) {
    return new Response(errorPage("decline link invalid or expired.", env),
                        { status: 401, headers: htmlHeaders() });
  }
  const booking = await getBooking(env, id);
  if (!booking) {
    return new Response(errorPage("booking not found (already expired?).", env),
                        { status: 404, headers: htmlHeaders() });
  }
  if (booking.status !== "pending") {
    return new Response(declinedPage(booking, env, /*already=*/true),
                        { headers: htmlHeaders() });
  }
  await setStatus(env, id, "declined");
  await releaseSlot(env, booking);         // free the slot NOW so /slots reoffers it immediately
  ctx.waitUntil(sendDecline(env, booking));
  cancelExpiry(env, ctx, id);                                   // end the durable timer early
  ctx.waitUntil(caches.default.delete(calIndexKey(req, env)));  // slot freed again
  return new Response(declinedPage(booking, env, /*already=*/false),
                      { headers: htmlHeaders() });
}

// returns { slots, cal } where cal is the SWR calendar metadata (busy, ageMs,
// ok, source). Callers that only need the listing destructure { slots };
// route_book also reads { cal } to fail closed on an unvouchable calendar.
// timings (optional) collects per-step durations for a Server-Timing header.
async function listOpenSlots(env, ctx, timings = null, options = {}) {
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

// one edge-cache entry per (origin, basePath): aadhar.sh/coffee and
// cal.aadhar.sh render different form actions, so they must not share a cached
// body; query strings and trailing slashes normalize away.
function calIndexKey(req, env) {
  const url = new URL(req.url);
  return new Request(`${url.origin}${env.BASE_PATH || ""}/__cal_index`, { method: "GET" });
}

function fmtServerTiming(t) {
  return Object.entries(t).map(([k, v]) => `${k};dur=${v}`).join(", ");
}

function htmlHeaders() {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
}
