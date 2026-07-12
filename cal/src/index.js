// cal.aadhar.sh — coffee booking worker.
//
// flow:
//   1. visitor GET /         → renders booking page, slots injected from ICS
//   2. visitor POST /book    → creates pending booking in KV, emails host
//                              with signed approve/decline links
//   3. host clicks /approve  → marks confirmed, emails requester an .ics invite
//   4. host clicks /decline  → marks declined, emails requester a polite no
//   5. cron sweep            → expires pending bookings older than PENDING_TTL_DAYS
//
// design notes:
//   - all state in KV; nothing in memory, Worker can scale to zero
//   - no auth: the only "host" interaction is clicking signed URLs from email
//   - signing uses HMAC-SHA256 over `${id}|${action}` with SIGNING_SECRET
//   - timezones are real: HOST_TIMEZONE drives display + working hours
//   - the public ICS calendar is read-only; we never write back. confirmed
//     events are pushed to the host's real calendar via the .ics invite
//     they accept in their own inbox.

import { generateSlots, fetchBusySWR,
         BOOK_MAX_STALE_MS }               from "./availability.js";
import { createBooking, getBooking,
         setStatus, expireOld, getRecent } from "./booking.js";
import { sendApprovalRequest, sendInvite,
         sendDecline }                     from "./email.js";
import { sign, verify }                    from "./sign.js";
import { bookingPage, successPage,
         confirmedPage, declinedPage,
         errorPage }                       from "./templates.js";

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

  // weekly cleanup — expire pending bookings the host never acted on so their
  // slots become bookable again. doesn't email anyone; silent reclaim.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(expireOld(env));
  }
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
  const { slots, cal } = await listOpenSlots(env, ctx, timings);
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
  await setStatus(env, id, "confirmed");
  ctx.waitUntil(sendInvite(env, booking));
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
  ctx.waitUntil(sendDecline(env, booking));
  ctx.waitUntil(caches.default.delete(calIndexKey(req, env)));  // slot freed again
  return new Response(declinedPage(booking, env, /*already=*/false),
                      { headers: htmlHeaders() });
}

// returns { slots, cal } where cal is the SWR calendar metadata (busy, ageMs,
// ok, source). Callers that only need the listing destructure { slots };
// route_book also reads { cal } to fail closed on an unvouchable calendar.
// timings (optional) collects per-step durations for a Server-Timing header.
async function listOpenSlots(env, ctx, timings = null) {
  const mark = (name, p) => {
    if (!timings) return p;
    const s = Date.now();
    return p.then(v => { timings[name] = Date.now() - s; return v; },
                  e => { timings[name] = Date.now() - s; throw e; });
  };
  // pending bookings hold slots optimistically (reserved until the host approves
  // or declines; the cron sweep reclaims stale pending after TTL). confirmed
  // bookings hold their slot for real — both must be seen or an approved coffee's
  // slot reopens and the caps undercount.
  const [cal, pending, confirmed] = await Promise.all([
    mark("ics", fetchBusySWR(env, ctx)),
    mark("pending", getRecent(env, "pending")),
    mark("confirmed", getRecent(env, "confirmed")),
  ]);
  const held = [...pending, ...confirmed].map(b => ({ start: b.start, end: b.end }));
  // busy → conflict-only (your real calendar); coffee bookings (pending +
  // confirmed) → conflict + count toward DAILY/WEEKLY_LIMIT. keeping them
  // separate is what stops a packed calendar from zeroing out availability.
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
