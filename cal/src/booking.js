// booking.js — KV ops for bookings and the slots they hold.
//
// keys:
//   booking:<id>          full booking payload (JSON), kept 90d for rendering
//                         approve/decline pages and post-hoc introspection.
//   held:<start>:<end>    a slot currently held by a pending-or-confirmed
//                         booking. Presence = held; the value is the booking id
//                         (for debugging). One key PER SLOT, not a shared list.
//
// Why per-slot keys instead of the old `index:pending` / `index:confirmed`
// comma-joined lists: those lists were a single KV key every booking rewrote,
// so two concurrent writes could clobber each other (the old code flagged this
// and pointed at Durable Objects as the eventual fix). A slot can only be held
// once — /book checks availability before holding — so two bookings never write
// the same held key, and the clobber race is gone without any coordination.
//
// A held key self-expires ~1 day after its slot ends, so a confirmed booking
// keeps holding its slot (and counting toward the daily/weekly caps) right up to
// the event, and even a leaked hold can't shadow availability for a future slot.
// That also means there's nothing to sweep: the weekly cron is gone (the
// per-booking BookingWorkflow reclaims abandoned pending slots on timeout).

import { v4 as uuid } from "./uuid.js";

const TTL_BOOKING_DAYS = 90; // booking records expire after 90d for cleanup

export async function createBooking(env, fields) {
  const id = await uuid();
  const booking = { id, ...fields };
  await putBooking(env, booking);
  return booking;
}

export async function getBooking(env, id) {
  const raw = await env.BOOKINGS.get(`booking:${id}`);
  return raw ? JSON.parse(raw) : null;
}

// patch a booking's status (pending → confirmed / declined / expired). Records
// only; slot-holding is a separate concern (holdSlot/releaseSlot), because a
// confirmed booking keeps its slot while a declined/expired one gives it back.
export async function setStatus(env, id, status) {
  const b = await getBooking(env, id);
  if (!b) return null;
  b.status = status;
  b.acted_at = Date.now();
  await putBooking(env, b);
  return b;
}

async function putBooking(env, b) {
  await env.BOOKINGS.put(`booking:${b.id}`, JSON.stringify(b), {
    expirationTtl: TTL_BOOKING_DAYS * 86400,
  });
}

// ── held slots ──────────────────────────────────────────────────────────
const heldKey = (b) => `held:${b.start}:${b.end}`;

// mark a slot held. Expires ~1d after the slot ends (absolute KV expiration),
// floored to a safe minimum so KV never rejects a near-term slot.
export async function holdSlot(env, b) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expiration = Math.max(Math.floor(b.end / 1000) + 86400, nowSec + 120);
  await env.BOOKINGS.put(heldKey(b), b.id, { expiration });
}

export async function releaseSlot(env, b) {
  await env.BOOKINGS.delete(heldKey(b));
}

// every currently-held slot, as { start, end }. Both pending and confirmed
// bookings hold slots; availability treats them identically (conflict + count
// toward the caps), so a single list is all generateSlots needs. start/end are
// encoded in the key name, so this is one list() with no per-key gets.
export async function listHeld(env) {
  const held = [];
  let cursor;
  do {
    const page = await env.BOOKINGS.list({ prefix: "held:", cursor });
    for (const k of page.keys) {
      const [start, end] = k.name.slice("held:".length).split(":").map(Number);
      if (Number.isFinite(start) && Number.isFinite(end)) held.push({ start, end });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return held;
}
