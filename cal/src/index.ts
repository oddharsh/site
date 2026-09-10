// cal.aadhar.sh — coffee booking worker.
//
// flow:
//   1. visitor GET /         → renders booking page, slots injected from ICS
//   2. visitor POST /book    → creates pending booking in KV, emails host
//                              with signed approve/decline links
//   3. host clicks /approve  → marks confirmed, emails requester an .ics invite
//   4. host clicks /decline  → marks declined, frees the slot, emails a polite no
//   4b. after approval, three signed links keep working for as long as the
//       booking does: /location names the venue, /reschedule moves it onto
//       another open slot, /cancel withdraws it. All three GET a form and POST
//       the change, and each carries its OWN signature scope, so the link that
//       names a cafe cannot be replayed to call the coffee off.
//   5. expiry timer          → each booking's BookingWorkflow reclaims the slot
//                              if the host never acts within PENDING_TTL_DAYS
//
// design notes:
//   - all state in KV; nothing in memory, Worker can scale to zero
//   - no auth: the only "host" interaction is clicking signed URLs from email
//   - signing uses HMAC-SHA256 over `${id}|${action}` with SIGNING_SECRET
//   - timezones are real: HOST_TIMEZONE drives display + working hours
//   - the public ICS calendar is read-only; we never write back. a confirmed
//     event reaches the host's real calendar as its OWN PUBLISH .ics, mailed
//     separately from the guest's invitation, so the host owns and can edit
//     the entry. an edit made there reaches nobody: /location and its SEQUENCE
//     bump are still the only path a change takes to the guest.
//   - abandoned bookings expire via a durable per-booking Workflow, not a cron:
//     /book spins up one instance (id = booking id) that waits PENDING_TTL_DAYS
//     for a "host-decision" event; approve/decline fire that event to end it
//     early, and a timeout reclaims the slot (see cal/src/workflow.ts).

import { BOOK_MAX_STALE_MS }               from "./availability.ts";
import { listOpenSlots }                   from "./slots.ts";
import { createBooking, getBooking, setStatus,
         holdSlot, releaseSlot, setLocation, setSchedule,
         cancelBooking }                   from "./booking.ts";
import { releaseSlotClaim, reserveSlot }  from "./reservation.ts";
import { sendApprovalRequest, sendInvite, sendHostCopy,
         sendDecline, sendUpdate, sendCancel } from "./email.ts";
import { sign, verify }                    from "./sign.ts";
import { bookingPage, successPage,
         confirmedPage, declinedPage,
         locationPage, locationSavedPage,
         reschedulePage, rescheduledPage,
         cancelPage, cancelledPage,
         errorPage }                       from "./templates.ts";

// Re-export the expiry-timer Workflow so it resolves as a class_name both from
// the root worker (which imports this module) and from the Vitest pool, whose
// `main` is this file. Production's BOOKING_WORKFLOW binding is defined on the
// root aadhar-sh Worker; this named export just keeps the class reachable here.
export { BookingWorkflow } from "./workflow.ts";

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
      // GET renders the form, POST applies it. Both carry the same signature, so
      // the form is not a second capability: anyone who can open the page could
      // already have submitted it by hand.
      if (req.method === "GET"  && path === "/location")           return route_location_form(req, env, ctx, url);
      if (req.method === "POST" && path === "/location")           return route_location_save(req, env, ctx);
      // Reschedule and cancel are POST-applied for the same reason /location is,
      // and cancel has a second reason. A GET that writes would need adding to
      // BOTH lib/preview.ts's guard list and lib/early-data.ts's 425 list in the
      // root Worker, since those enumerate the GET-shaped writes on this origin;
      // a form keeps this feature out of that pair entirely. And a destructive
      // action reached from a mail client that prefetches links should not fire
      // because something looked at it.
      if (req.method === "GET"  && path === "/reschedule")         return route_reschedule_form(req, env, ctx, url);
      if (req.method === "POST" && path === "/reschedule")         return route_reschedule_save(req, env, ctx);
      if (req.method === "GET"  && path === "/cancel")             return route_cancel_form(req, env, ctx, url);
      if (req.method === "POST" && path === "/cancel")             return route_cancel_apply(req, env, ctx);
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

  // Filled phase by phase as the page is assembled (render, total, and the
  // fetch timings listOpenSlots adds), so the key set is not knowable here.
  const timings: Record<string, number> = {};
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
  // Optional. A blank answer is a real answer ("wherever, I'll travel"), and a
  // required field here would turn a nice-to-have into a reason a request fails.
  const area  = (payload.area  || "").toString().trim().slice(0, 120);
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
    // Blank stays undefined rather than "": JSON.stringify drops an undefined
    // key outright, so an unanswered field is ABSENT in KV rather than an empty
    // string every later reader has to remember to test for.
    area: area || undefined,
    start: slot.start, end: slot.end,
    created: Date.now(),
    status: "pending",
  });

  // Claim the slot ATOMICALLY before anything else happens. The availability
  // read above and the hold below are two separate steps, so two requests
  // arriving together both found this slot free; writing the hold synchronously
  // never closed that, because the check and the write still interleave (and KV
  // is eventually consistent between colos besides). The result was two
  // approvable bookings for one half hour. A per-slot Durable Object serializes
  // the pair, so exactly one of the two callers wins. See cal/src/reservation.ts.
  if (!(await reserveSlot(env, booking))) {
    // The record was already minted, so retire it rather than leaving a pending
    // booking nobody can act on: `expired` is the one status the approve path
    // refuses, and the 90-day TTL clears the row on its own.
    await setStatus(env, booking.id, "expired");
    return new Response(errorPage("someone just took that slot. pick another.", env),
                        { status: 409, headers: htmlHeaders() });
  }
  // The KV hold stays: it is what /slots and the SSR page read to draw
  // availability, and it carries the expiry the reservation deliberately does
  // not. The Durable Object decides WHO gets the slot; this records THAT it is
  // taken for every reader that is not racing for it.
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
  const locationSig = await sign(`${booking.id}|location`, env.SIGNING_SECRET);
  // include BASE_PATH: a booking made at aadhar.sh/coffee must email links under
  // /coffee/* (the worker's only zone route there) — bare /approve|/decline fall
  // through to the main site and 404, so the host can't act on the request.
  const base = `https://${new URL(req.url).host}${env.BASE_PATH || ""}`;
  const approveUrl = `${base}/approve?t=${booking.id}&sig=${approveSig}`;
  const declineUrl = `${base}/decline?t=${booking.id}&sig=${declineSig}`;
  const locationUrl = `${base}/location?t=${booking.id}&sig=${locationSig}`;

  ctx.waitUntil(sendApprovalRequest(env, booking, approveUrl, declineUrl, locationUrl));
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
  const links = await hostLinks(req, env, booking.id);
  if (booking.status !== "pending") {
    return new Response(confirmedPage(booking, env, /*already=*/true, links.location, links),
                        { headers: htmlHeaders() });
  }
  await setStatus(env, id, "confirmed");   // slot stays held (confirmed coffees hold their slot + count toward caps)
  ctx.waitUntil(sendInvite(env, booking));
  // Separate send, separate event: the guest gets an invitation and the host
  // gets a plain PUBLISH copy they own outright. See buildICS in email.ts.
  // The links ride that mail because it is the one the host keeps.
  ctx.waitUntil(sendHostCopy(env, booking, { links }));
  cancelExpiry(env, ctx, id);                                   // end the durable timer early
  ctx.waitUntil(caches.default.delete(calIndexKey(req, env)));  // pending slot resolved
  return new Response(confirmedPage({ ...booking, status: "confirmed" }, env, /*already=*/false, links.location, links),
                      { headers: htmlHeaders() });
}

async function hostLink(req, env, id: string, action: "location" | "reschedule" | "cancel") {
  const sig = await sign(`${id}|${action}`, env.SIGNING_SECRET);
  return `https://${new URL(req.url).host}${env.BASE_PATH || ""}/${action}?t=${id}&sig=${sig}`;
}


// Every link the host needs on a live booking, minted together because they are
// mailed together and a missing one is invisible until somebody needs it.
async function hostLinks(req, env, id: string) {
  const [location, reschedule, cancel] = await Promise.all([
    hostLink(req, env, id, "location"),
    hostLink(req, env, id, "reschedule"),
    hostLink(req, env, id, "cancel"),
  ]);
  return { location, reschedule, cancel };
}

// Shared by both halves of EVERY signed host action. Written as one function
// because the GET and the POST have to agree exactly on what is actionable: a
// form that renders for a declined booking and then refuses to save is a worse
// experience than one that never rendered, and two copies of this check is how
// they drift apart. Generalising it across the three actions is the same
// argument one step out.
//
// The signature is scoped per action (`${id}|location`, `${id}|cancel`), so the
// link that sets a venue cannot be replayed to call off the coffee.
const DEAD_END = { location: "place", reschedule: "move", cancel: "cancel" };

async function resolveHostAction(env, id, sig, action: "location" | "reschedule" | "cancel") {
  if (!id || !sig || !(await verify(`${id}|${action}`, sig, env.SIGNING_SECRET))) {
    return { err: new Response(errorPage(`${action} link invalid or expired.`, env),
                               { status: 401, headers: htmlHeaders() }) };
  }
  const booking = await getBooking(env, id);
  if (!booking) {
    return { err: new Response(errorPage("booking not found (already expired?).", env),
                               { status: 404, headers: htmlHeaders() }) };
  }
  // Only a live booking is worth acting on at all.
  if (booking.status === "declined" || booking.status === "expired" || booking.status === "cancelled") {
    return { err: new Response(errorPage(`this booking is ${booking.status}; there's nothing to ${DEAD_END[action]}.`, env),
                               { status: 409, headers: htmlHeaders() }) };
  }
  // Cancelling is the one action that needs a confirmed booking: a pending one
  // has no entry anywhere to withdraw, and /decline is the route that answers
  // it with the note a would-be guest should actually receive.
  if (action === "cancel" && booking.status !== "confirmed") {
    return { err: new Response(errorPage("this booking isn't confirmed yet — decline it from the request mail instead.", env),
                               { status: 409, headers: htmlHeaders() }) };
  }
  return { booking };
}

const resolveLocationTarget = (env, id, sig) => resolveHostAction(env, id, sig, "location");

async function route_location_form(req, env, ctx, url) {
  const id  = url.searchParams.get("t");
  const sig = url.searchParams.get("sig");
  const { booking, err } = await resolveLocationTarget(env, id, sig);
  if (err) return err;
  const action = `${env.BASE_PATH || ""}/location`;
  return new Response(locationPage(booking, env, action, sig), { headers: htmlHeaders() });
}

async function route_location_save(req, env, ctx) {
  const form = await req.formData();
  const id   = (form.get("t")   || "").toString();
  const sig  = (form.get("sig") || "").toString();
  const { err } = await resolveLocationTarget(env, id, sig);
  if (err) return err;

  const location = (form.get("location") || "").toString().trim().slice(0, 200);
  if (!location) {
    return new Response(errorPage("give it somewhere to be.", env),
                        { status: 400, headers: htmlHeaders() });
  }

  const updated = await setLocation(env, id, location);
  // resolveLocationTarget already found this record, so a null here means the KV
  // entry vanished between the two reads — its 90-day TTL landing mid-request.
  // Vanishingly rare and still a real state, so it gets the same 404 the read
  // path gives, rather than a `!` that would throw a 500 at the same moment.
  if (!updated) {
    return new Response(errorPage("booking not found (already expired?).", env),
                        { status: 404, headers: htmlHeaders() });
  }
  // A pending booking has no invite out yet, so there is nothing to update and
  // the address simply rides the first one. Mailing here would tell a guest
  // where to meet before telling them the meeting is happening.
  const mailed = updated.status === "confirmed";
  if (mailed) ctx.waitUntil(sendUpdate(env, updated));
  if (mailed) ctx.waitUntil(sendHostCopy(env, updated, { updated: true, links: await hostLinks(req, env, id) }));
  return new Response(locationSavedPage(updated, env, mailed), { headers: htmlHeaders() });
}

async function route_reschedule_form(req, env, ctx, url) {
  const id  = url.searchParams.get("t");
  const sig = url.searchParams.get("sig");
  const { booking, err } = await resolveHostAction(env, id, sig, "reschedule");
  if (err) return err;
  // allowStale on the RENDER, fail-closed on the SAVE below. Showing a slot
  // that turns out to be taken costs one retry; taking it does not.
  const { slots } = await listOpenSlots(env, ctx, null, { allowStale: true });
  const action = `${env.BASE_PATH || ""}/reschedule`;
  return new Response(reschedulePage(booking, env, action, sig, slots), { headers: htmlHeaders() });
}

async function route_reschedule_save(req, env, ctx) {
  const form = await req.formData();
  const id   = (form.get("t")   || "").toString();
  const sig  = (form.get("sig") || "").toString();
  const { booking, err } = await resolveHostAction(env, id, sig, "reschedule");
  if (err) return err;

  const start = parseInt((form.get("start") || "").toString(), 10);
  if (!Number.isFinite(start)) {
    return new Response(errorPage("pick a time.", env), { status: 400, headers: htmlHeaders() });
  }

  // Same fail-closed rule route_book runs on, and for the same reason: moving a
  // coffee onto a slot we cannot vouch for is the identical double-booking risk
  // as putting a new one there. A stale snapshot refuses rather than guesses.
  const { slots, cal } = await listOpenSlots(env, ctx);
  if (!cal.ok || cal.ageMs > BOOK_MAX_STALE_MS) {
    return new Response(errorPage("can't confirm the calendar right now — try again in a minute.", env),
                        { status: 503, headers: { ...htmlHeaders(), "retry-after": "60" } });
  }
  const slot = slots.find(sl => sl.start === start);
  if (!slot) {
    return new Response(errorPage("that slot was taken or expired. pick another.", env),
                        { status: 409, headers: htmlHeaders() });
  }

  // ORDER IS THE SAFETY PROPERTY. Take the new hold first, so no one can win a
  // race into it while this writes; then patch the record; then give the old one
  // back. Releasing first would open the old slot to a booking that still owns
  // it, and a failure in between would leave the coffee holding nothing at all.
  await holdSlot(env, { ...booking, start: slot.start, end: slot.end });
  const moved = await setSchedule(env, id, slot);
  if (!moved) {
    // The KV record's 90-day TTL landing between the two reads. Vanishingly
    // rare, still real, and the hold just taken has to go back.
    await releaseSlot(env, slot);
    return new Response(errorPage("booking not found (already expired?).", env),
                        { status: 404, headers: htmlHeaders() });
  }
  await releaseSlot(env, moved.was);

  const mailed = moved.booking.status === "confirmed";
  if (mailed) {
    ctx.waitUntil(sendUpdate(env, moved.booking));
    ctx.waitUntil(sendHostCopy(env, moved.booking, { updated: true, links: await hostLinks(req, env, id) }));
  }
  // Both slots changed state, so the cached index is wrong in two directions.
  ctx.waitUntil(caches.default.delete(calIndexKey(req, env)));
  return new Response(rescheduledPage(moved.booking, env, mailed), { headers: htmlHeaders() });
}

async function route_cancel_form(req, env, ctx, url) {
  const id  = url.searchParams.get("t");
  const sig = url.searchParams.get("sig");
  const { booking, err } = await resolveHostAction(env, id, sig, "cancel");
  if (err) return err;
  const action = `${env.BASE_PATH || ""}/cancel`;
  return new Response(cancelPage(booking, env, action, sig), { headers: htmlHeaders() });
}

async function route_cancel_apply(req, env, ctx) {
  const form = await req.formData();
  const id   = (form.get("t")   || "").toString();
  const sig  = (form.get("sig") || "").toString();
  const { booking, err } = await resolveHostAction(env, id, sig, "cancel");
  if (err) return err;

  const cancelled = await cancelBooking(env, id);
  if (!cancelled) {
    return new Response(errorPage("booking not found (already expired?).", env),
                        { status: 404, headers: htmlHeaders() });
  }
  // A cancelled coffee gives its slot back, which is what separates this from
  // the confirmed state it leaves: confirmed bookings hold their slot and count
  // toward the caps, and this one should do neither the moment it is called off.
  await releaseSlot(env, booking);
  cancelExpiry(env, ctx, id);
  ctx.waitUntil(sendCancel(env, cancelled));
  ctx.waitUntil(sendHostCopy(env, cancelled, { cancelled: true }));
  ctx.waitUntil(caches.default.delete(calIndexKey(req, env)));
  return new Response(cancelledPage(cancelled, env), { headers: htmlHeaders() });
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
  await releaseSlotClaim(env, booking);   // and give up the atomic claim, so the next booker can take it
  ctx.waitUntil(sendDecline(env, booking));
  cancelExpiry(env, ctx, id);                                   // end the durable timer early
  ctx.waitUntil(caches.default.delete(calIndexKey(req, env)));  // slot freed again
  return new Response(declinedPage(booking, env, /*already=*/false),
                      { headers: htmlHeaders() });
}

// one edge-cache entry per (origin, basePath): aadhar.sh/coffee and
// cal.aadhar.sh render different form actions, so they must not share a cached
// body; query strings and trailing slashes normalize away.
function calIndexKey(req, env) {
  const url = new URL(req.url);
  return new Request(`${url.origin}${env.BASE_PATH || ""}/__cal_index`, { method: "GET" });
}

// Typed because the values are interpolated into a Server-Timing header, and
// Object.entries over an untyped bag yields unknown. This is the timings record
// assembled above; durations are milliseconds.
function fmtServerTiming(t: Record<string, number>) {
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
