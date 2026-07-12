// booking.js — KV ops for pending / confirmed / declined bookings.
//
// keys:
//   booking:<id>        full booking payload (JSON)
//   index:pending       comma-separated ids of pending bookings (for sweep + listing)
//   index:confirmed     comma-separated ids of confirmed bookings (still hold their
//                       slot + count toward the caps, so availability must see them)
//
// the index keys let us list bookings without scanning all keys (KV doesn't
// support cheap key scans). a booking moves pending → confirmed (kept in the
// confirmed index) or pending → declined/expired (indexed nowhere: it holds no
// slot). dropping a confirmed booking from every index was a double-book bug —
// its slot reopened and the daily/weekly caps stopped counting it.

import { v4 as uuid } from "./uuid.js";

const TTL_BOOKING_DAYS = 90;   // confirmed/declined bookings expire after 90d for cleanup

export async function createBooking(env, fields) {
  const id = await uuid();
  const booking = { id, ...fields };
  await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(booking), {
    expirationTtl: TTL_BOOKING_DAYS * 86400,
  });
  await addToIndex(env, "pending", id);
  return booking;
}

export async function getBooking(env, id) {
  const raw = await env.BOOKINGS.get(`booking:${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function setStatus(env, id, status) {
  const b = await getBooking(env, id);
  if (!b) return null;
  b.status = status;
  b.acted_at = Date.now();
  await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(b), {
    expirationTtl: TTL_BOOKING_DAYS * 86400,
  });
  // a confirmed coffee moves from the pending index to the confirmed index so
  // availability still sees it (holds its slot, counts toward the caps). anything
  // else (declined/expired) holds nothing and leaves both indexes.
  if (status !== "pending") await removeFromIndex(env, "pending", id);
  if (status === "confirmed") await addToIndex(env, "confirmed", id);
  else await removeFromIndex(env, "confirmed", id);
  return b;
}

// list pending or confirmed bookings. used for availability (a slot another
// booking already holds must not be offered, and confirmed coffees count toward
// the caps) and for the weekly sweep.
export async function getRecent(env, status = "pending") {
  const name = status === "confirmed" ? "confirmed" : "pending";
  const ids = await readIndex(env, name);
  return (await Promise.all(ids.map(id => getBooking(env, id))))
    .filter(b => b && b.status === status);
}

export async function expireOld(env) {
  const ttl = +env.PENDING_TTL_DAYS * 86400 * 1000;
  const cutoff = Date.now() - ttl;
  const ids = await readIndex(env, "pending");
  let expired = 0;
  for (const id of ids) {
    const b = await getBooking(env, id);
    if (!b) {
      // already gone from KV (maybe TTL'd) — clean up the index
      await removeFromIndex(env, "pending", id);
      continue;
    }
    if (b.status === "pending" && b.created < cutoff) {
      b.status = "expired";
      b.acted_at = Date.now();
      await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(b), {
        expirationTtl: TTL_BOOKING_DAYS * 86400,
      });
      await removeFromIndex(env, "pending", id);
      expired++;
    }
  }
  // keep the confirmed index bounded: drop ids whose booking has TTL'd away.
  const confirmedIds = await readIndex(env, "confirmed");
  for (const id of confirmedIds) {
    if (!(await getBooking(env, id))) await removeFromIndex(env, "confirmed", id);
  }
  console.log(`sweep: expired ${expired} pending bookings`);
}

// ── pending index helpers ───────────────────────────────────────────────
// KV doesn't have lists or atomic ops. we serialize the pending-id list to
// a single key with comma separation. concurrent writes can race — but at
// personal volume (a few bookings/week) the race window is microscopic and
// the cron sweep cleans up any inconsistency. if this ever becomes a real
// problem, upgrade to Durable Objects for atomic list ops.

async function readIndex(env, name) {
  const raw = await env.BOOKINGS.get(`index:${name}`);
  return raw ? raw.split(",").filter(Boolean) : [];
}
async function writeIndex(env, name, ids) {
  await env.BOOKINGS.put(`index:${name}`, ids.join(","));
}
async function addToIndex(env, name, id) {
  const ids = await readIndex(env, name);
  if (!ids.includes(id)) {
    ids.push(id);
    await writeIndex(env, name, ids);
  }
}
async function removeFromIndex(env, name, id) {
  const ids = await readIndex(env, name);
  await writeIndex(env, name, ids.filter(x => x !== id));
}
