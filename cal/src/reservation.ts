// reservation.js — the exclusivity gate for one coffee slot.
//
// WHY THIS EXISTS. The booking flow reads availability, finds the slot free, and
// then writes a `held:` key. Those are two steps, so two requests arriving
// together both pass the read before either write lands and both get a booking
// for the same half hour. The old comment on holdSlot said writing the hold
// synchronously stopped that; it cannot, because the check and the write are
// still separate operations, and KV is eventually consistent across colos on top
// of it. The host then receives two approvable requests for one slot.
//
// The fix is to make claiming a slot a single operation that cannot interleave.
// A Durable Object gives that for free: requests to one instance are serialized,
// so the get/put pair below runs to completion before the next caller is
// admitted. One instance per slot, named by the slot itself, means two different
// times never contend and one time is always the same instance.
//
// WHY IT REUSES THE COUNTER NAMESPACE rather than adding a class. Adding a
// Durable Object class needs a `new_sqlite_classes` migration, and the release
// path here publishes with `wrangler versions upload`, which cannot apply one
// (see CLAUDE.md). Instances are isolated by name, so `coffee-slot:<start>:<end>`
// shares nothing with `homepage-visits`; the keys differ too ("reservation" vs
// "n"). The cost is one class doing two jobs, which is worth one comment and no
// migration deadlock.
//
// The functions below are PURE over a storage interface (get/put/delete) so they
// can be tested against a Map with no bindings and no Workers runtime. That is
// the same reason the rest of cal/src keeps its logic out of its handlers.

/** Storage key inside a per-slot instance. One instance holds one reservation. */
const RESERVATION_KEY = "reservation";

/** Name the instance for a slot. The slot IS the identity, so the same half hour
 *  always resolves to the same Durable Object wherever the request lands. */
export function reservationName(start, end) {
  return `coffee-slot:${start}:${end}`;
}

/**
 * Claim a slot for one booking.
 *
 * Idempotent for the SAME booking id, so a retry of a request that already
 * succeeded does not report the slot as taken. Exclusive against every other id
 * until the slot's own end time passes, after which the row is reusable — a
 * reservation cannot outlive the time it reserves.
 *
 */
export async function claimReservation(storage, bookingId, start, end, now = Date.now()): Promise<boolean> {
  const existing = await storage.get(RESERVATION_KEY);
  if (existing && existing.bookingId !== bookingId && Number(existing.end) > now) return false;
  await storage.put(RESERVATION_KEY, { bookingId, start, end });
  return true;
}

/**
 * Release a slot, but only for the booking that holds it. A stale decline must
 * not free a slot someone else has since claimed, which is why this compares the
 * id rather than deleting unconditionally.
 *
 */
export async function dropReservation(storage, bookingId) {
  const existing = await storage.get(RESERVATION_KEY);
  if (!existing || existing.bookingId !== bookingId) return false;
  await storage.delete(RESERVATION_KEY);
  return true;
}

/** Read the current holder, for diagnostics. */
export async function readReservation(storage) {
  return (await storage.get(RESERVATION_KEY)) || null;
}

// ── the binding side ────────────────────────────────────────────────────────
// Addressed over the Durable Object's `fetch` rather than as RPC methods on
// purpose: the Counter class is hand-rolled precisely so nothing imports
// `cloudflare:workers` (gotcha 16, which keeps the node-run contract tests
// importable), and RPC needs the DurableObject base class. A URL and a JSON body
// cost nothing here and keep that constraint intact.

/**
 * Claim the slot for a booking through the COUNTER namespace.
 *
 * Returns `true` when the binding is absent, which keeps cal runnable and
 * testable without a Durable Object, the same way a missing BOOKING_WORKFLOW
 * only costs the expiry timer. Production always binds it, and a contract test
 * asserts that, so the fallback cannot become the quiet default.
 */
export async function reserveSlot(env, booking) {
  if (!env?.COUNTER) return true;
  const stub = env.COUNTER.get(env.COUNTER.idFromName(reservationName(booking.start, booking.end)));
  const response = await stub.fetch("https://do/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookingId: booking.id, start: booking.start, end: booking.end }),
  });
  if (!response.ok) return false;
  const body = await response.json();
  return body.claimed === true;
}

/** Release the slot this booking holds. Best-effort: a failure here leaves the
 *  slot reserved until its own end time, which is the safe direction. */
export async function releaseSlotClaim(env, booking) {
  if (!env?.COUNTER) return false;
  try {
    const stub = env.COUNTER.get(env.COUNTER.idFromName(reservationName(booking.start, booking.end)));
    const response = await stub.fetch("https://do/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bookingId: booking.id }),
    });
    if (!response.ok) return false;
    return (await response.json()).released === true;
  } catch (e) {
    console.error("slot release failed", e?.message || e);
    return false;
  }
}
