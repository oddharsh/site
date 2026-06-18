// Booking KV lifecycle (src/booking.js). Runs against a real (miniflare) KV
// binding from wrangler.toml — the BOOKINGS namespace. The pool isolates
// storage per test, so the pending index starts empty in every case and
// bookings don't leak between tests.
//
// env here is the worker env: it carries the [vars] from wrangler.toml
// (PENDING_TTL_DAYS = "7") and the BOOKINGS binding.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  createBooking, getBooking, setStatus, getRecent, expireOld,
} from "../src/booking.js";

// start each test with an empty pool — storage isn't reliably per-test in this
// pool version, so clear the booking keys + index so counts are exact.
beforeEach(async () => {
  const { keys } = await env.BOOKINGS.list();
  await Promise.all(keys.map((k) => env.BOOKINGS.delete(k.name)));
});

const DAY = 86400_000;
const pending = (fields = {}) => ({ status: "pending", created: Date.now(), ...fields });

describe("booking KV lifecycle", () => {
  it("creates a booking and reads it back by id", async () => {
    const b = await createBooking(env, pending({ name: "Jo", email: "jo@x.dev" }));
    expect(b.id).toMatch(/^[0-9a-f]{32}$/); // 32 hex from uuid.v4()
    expect(await getBooking(env, b.id)).toMatchObject({ id: b.id, name: "Jo", status: "pending" });
  });

  it("getBooking returns null for an unknown id", async () => {
    expect(await getBooking(env, "nope")).toBeNull();
  });

  it("a freshly created booking shows up in the pending index", async () => {
    const b = await createBooking(env, pending());
    const ids = (await getRecent(env, "pending")).map((x) => x.id);
    expect(ids).toContain(b.id);
  });

  it("confirming updates status and drops it from the pending index", async () => {
    const b = await createBooking(env, pending());
    const updated = await setStatus(env, b.id, "confirmed");
    expect(updated.status).toBe("confirmed");
    expect(updated.acted_at).toBeTypeOf("number");
    expect((await getBooking(env, b.id)).status).toBe("confirmed");
    const ids = (await getRecent(env, "pending")).map((x) => x.id);
    expect(ids).not.toContain(b.id);
  });

  it("setStatus on a missing booking returns null (no throw)", async () => {
    expect(await setStatus(env, "does-not-exist", "confirmed")).toBeNull();
  });

  it("getRecent('pending') returns only still-pending bookings", async () => {
    const stays = await createBooking(env, pending());
    const goes = await createBooking(env, pending());
    await setStatus(env, goes.id, "declined");
    const ids = (await getRecent(env, "pending")).map((x) => x.id);
    expect(ids).toContain(stays.id);
    expect(ids).not.toContain(goes.id);
  });

  it("expireOld sweeps stale pending bookings but keeps fresh ones", async () => {
    const stale = await createBooking(env, pending({ created: Date.now() - 8 * DAY })); // > 7d TTL
    const fresh = await createBooking(env, pending({ created: Date.now() }));

    await expireOld(env); // PENDING_TTL_DAYS = 7 (from wrangler.toml vars)

    expect((await getBooking(env, stale.id)).status).toBe("expired");
    expect((await getBooking(env, fresh.id)).status).toBe("pending");
    const ids = (await getRecent(env, "pending")).map((x) => x.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(stale.id);
  });
});
