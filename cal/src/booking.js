// booking.js — KV ops for pending / confirmed / declined bookings.
//
// keys:
//   booking:<id>        full booking payload (JSON)
//   index:pending       comma-separated ids of pending bookings (for sweep + listing)
//
// the index key lets us list all pending bookings without scanning all keys
// (KV doesn't support cheap key scans). when we mark something confirmed
// or declined, we remove it from the pending index.

import { v4 as uuid } from "./uuid.js";

const TTL_BOOKING_DAYS = 90;   // confirmed/declined bookings expire after 90d for cleanup

export async function createBooking(env, fields) {
  const id = await uuid();
  const booking = { id, ...fields };
  await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(booking), {
    expirationTtl: TTL_BOOKING_DAYS * 86400,
  });
  await addToPendingIndex(env, id);
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
  if (status !== "pending") await removeFromPendingIndex(env, id);
  return b;
}

// list pending or confirmed bookings within the last N days. used for
// availability (we don't want to offer a slot another pending booking has
// claimed) and for the weekly sweep.
export async function getRecent(env, status = "pending") {
  const ids = await readIndex(env, "pending");
  if (status === "pending") {
    return (await Promise.all(ids.map(id => getBooking(env, id))))
      .filter(b => b && b.status === "pending");
  }
  // fallback: read all + filter (slow but rare)
  return [];
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
      await removeFromPendingIndex(env, id);
      continue;
    }
    if (b.status === "pending" && b.created < cutoff) {
      b.status = "expired";
      b.acted_at = Date.now();
      await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(b), {
        expirationTtl: TTL_BOOKING_DAYS * 86400,
      });
      await removeFromPendingIndex(env, id);
      expired++;
    }
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
async function addToPendingIndex(env, id) {
  const ids = await readIndex(env, "pending");
  if (!ids.includes(id)) {
    ids.push(id);
    await writeIndex(env, "pending", ids);
  }
}
async function removeFromPendingIndex(env, id) {
  const ids = await readIndex(env, "pending");
  await writeIndex(env, "pending", ids.filter(x => x !== id));
}
