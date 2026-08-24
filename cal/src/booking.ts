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

import { v4 as uuid } from "./uuid.ts";

// The booking record, written to KV and read back by every route that acts on
// one. Declared so `bun run typecheck` has a shape to enforce: in a .js file
// TypeScript treats an unannotated object literal as expandable, so a typo like
// `booking.statis` is only an error against a declaration like this one.
//
// `status` is a union rather than a string because the whole approve/decline
// flow turns on it, and `expired` in particular is the value that makes a record
// unactionable.
// REAL TYPE DECLARATIONS, not JSDoc @typedef. TypeScript reads JSDoc types in
// .js files only, so the moment this module became .ts both of these went inert
// and `import("./booking.ts").Booking` resolved to nothing — which is how
// cal/test/booking.test.js caught the conversion.
export type Booking = {
  id: string;
  name: string;
  email: string;
  topic: string;
  /** epoch ms */
  start: number;
  /** epoch ms */
  end: number;
  /** epoch ms */
  created: number;
  // A union rather than a string because the whole approve/decline flow turns on
  // it, and `expired` in particular is the value that makes a record unactionable.
  status: "pending" | "confirmed" | "declined" | "expired";
  /** epoch ms, set when the host decides */
  acted_at?: number;
};

/** A half-open interval on the calendar. */
export type Slot = { start: number; end: number };

const TTL_BOOKING_DAYS = 90; // booking records expire after 90d for cleanup

export async function createBooking(env, fields: Omit<Booking, "id">): Promise<Booking> {
  const id = await uuid();
  const booking = { id, ...fields };
  await putBooking(env, booking);
  return booking;
}

export async function getBooking(env, id: string): Promise<Booking | null> {
  const raw = await env.BOOKINGS.get(`booking:${id}`);
  return raw ? JSON.parse(raw) : null;
}

// patch a booking's status (pending → confirmed / declined / expired). Records
// only; slot-holding is a separate concern (holdSlot/releaseSlot), because a
// confirmed booking keeps its slot while a declined/expired one gives it back.
export async function setStatus(env, id: string, status: Booking["status"]): Promise<Booking | null> {
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
const heldKey = (b: Slot) => `held:${b.start}:${b.end}`;

// mark a slot held. Expires ~1d after the slot ends (absolute KV expiration),
// floored to a safe minimum so KV never rejects a near-term slot.
export async function holdSlot(env, b: Booking) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expiration = Math.max(Math.floor(b.end / 1000) + 86400, nowSec + 120);
  await env.BOOKINGS.put(heldKey(b), b.id, { expiration });
}

export async function releaseSlot(env, b: Slot) {
  await env.BOOKINGS.delete(heldKey(b));
}

// every currently-held slot, as { start, end }. Both pending and confirmed
// bookings hold slots; availability treats them identically (conflict + count
// toward the caps), so a single list is all generateSlots needs. start/end are
// encoded in the key name, so this is one list() with no per-key gets.
export async function listHeld(env): Promise<Slot[]> {
  // A REAL annotation. This was `/** @type {Slot[]} */`, which a .ts file
  // ignores, so the array inferred `never[]` the moment strictNullChecks came on.
  const held: Slot[] = [];
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
