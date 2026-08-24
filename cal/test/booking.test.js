// Booking KV lifecycle (src/booking.js). Runs against a real (miniflare) KV
// binding from wrangler.test.toml — the BOOKINGS namespace.
//
// The old pending/confirmed comma-indexes (and the cron-driven expireOld sweep)
// are gone: bookings now hold slots via per-slot `held:<start>:<end>` keys, and
// abandoned pending bookings are reclaimed by their BookingWorkflow, not a batch
// job. These tests cover the booking-record CRUD + the held-slot helpers; the
// expiry timer itself is covered in workflow.test.js.
//
// env here is the worker env: it carries the [vars] from wrangler.test.toml
// (PENDING_TTL_DAYS = "7") and the BOOKINGS binding.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  createBooking, getBooking, setStatus,
  holdSlot, releaseSlot, listHeld,
} from "../src/booking.js";

// start each test with an empty pool — storage isn't reliably per-test in this
// pool version, so clear every key so counts are exact.
beforeEach(async () => {
  const { keys } = await env.BOOKINGS.list();
  await Promise.all(keys.map((k) => env.BOOKINGS.delete(k.name)));
});

// getBooking and setStatus both answer `Booking | null`, and every assertion
// below reads through the result. A miss means the record was not written,
// which is worth saying out loud rather than surfacing as a TypeError on the
// next property access.
/** @param {Awaited<ReturnType<typeof getBooking>>} b */
const must = (b) => {
  if (!b) throw new Error("expected a booking record, got null");
  return b;
};

const HOUR = 3600_000;
// a slot a comfortable distance in the future, so held-key absolute expiration
// is always valid (KV rejects expirations under 60s out).
const soon = (offsetH = 48) => {
  const start = Date.now() + offsetH * HOUR;
  return { start, end: start + 30 * 60_000 };
};
/** @typedef {import("../src/booking.js").Booking} Booking */

// name/email/topic are REQUIRED on Omit<Booking, "id">, and this helper omitted
// all three until the suite joined a tsc program (2026-08-23). Nothing failed:
// createBooking spreads whatever it is handed, so seven call sites were writing
// records with three undefined fields and asserting only on the fields they set.
// Defaults here rather than at each call site, so a test that cares about a name
// still overrides it through `fields`.
//
// The return annotation is doing work too. Without it the literal widens
// `status` to `string`, which is not the four-member union the record declares,
// so the helper produces a shape createBooking would refuse.
/**
 * @param {Partial<Omit<Booking, "id">>} [fields]
 * @returns {Omit<Booking, "id">}
 */
const pending = (fields = {}) => ({
  status: "pending", created: Date.now(),
  name: "Test Requester", email: "test@example.dev", topic: "coffee",
  ...soon(), ...fields,
});

describe("booking record CRUD", () => {
  it("creates a booking and reads it back by id", async () => {
    const b = await createBooking(env, pending({ name: "Jo", email: "jo@x.dev" }));
    expect(b.id).toMatch(/^[0-9a-f]{32}$/); // 32 hex from uuid.v4()
    expect(await getBooking(env, b.id)).toMatchObject({ id: b.id, name: "Jo", status: "pending" });
  });

  it("getBooking returns null for an unknown id", async () => {
    expect(await getBooking(env, "nope")).toBeNull();
  });

  it("setStatus patches status + acted_at and persists it", async () => {
    const b = await createBooking(env, pending());
    const updated = must(await setStatus(env, b.id, "confirmed"));
    expect(updated.status).toBe("confirmed");
    expect(updated.acted_at).toBeTypeOf("number");
    expect(must(await getBooking(env, b.id)).status).toBe("confirmed");
  });

  it("setStatus on a missing booking returns null (no throw)", async () => {
    expect(await setStatus(env, "does-not-exist", "confirmed")).toBeNull();
  });
});

describe("held slots (per-slot keys)", () => {
  it("holdSlot marks a slot held; listHeld reports it as { start, end }", async () => {
    const b = await createBooking(env, pending());
    await holdSlot(env, b);
    const held = await listHeld(env);
    expect(held).toContainEqual({ start: b.start, end: b.end });
  });

  it("releaseSlot frees the slot again", async () => {
    const b = await createBooking(env, pending());
    await holdSlot(env, b);
    await releaseSlot(env, b);
    const held = await listHeld(env);
    expect(held.find((h) => h.start === b.start)).toBeUndefined();
  });

  it("distinct bookings hold distinct slots without clobbering each other", async () => {
    const a = await createBooking(env, pending(soon(48)));
    const c = await createBooking(env, pending(soon(72)));
    await holdSlot(env, a);
    await holdSlot(env, c);
    const starts = (await listHeld(env)).map((h) => h.start).sort();
    expect(starts).toEqual([a.start, c.start].sort());
  });

  it("a released slot leaves the booking record intact (record != hold)", async () => {
    const b = await createBooking(env, pending());
    await holdSlot(env, b);
    await setStatus(env, b.id, "declined");
    await releaseSlot(env, b);
    // the record still exists (kept 90d) even though the slot is free again
    expect(must(await getBooking(env, b.id)).status).toBe("declined");
    expect(await listHeld(env)).toHaveLength(0);
  });
});
