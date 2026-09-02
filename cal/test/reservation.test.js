import { describe, expect, it } from "bun:test";
import {
  claimReservation,
  dropReservation,
  readReservation,
  releaseSlotClaim,
  reservationName,
  reserveSlot,
} from "../src/reservation.js";

// A Durable Object's storage is a get/put/delete surface, so a Map stands in for
// it exactly. What a Map CANNOT model is the serialization the real thing gives,
// which is the whole point of using a Durable Object: these tests pin the
// decision logic, and the runtime pins that only one caller runs it at a time.
function fakeStorage() {
  const records = new Map();
  return {
    get: async (key) => records.get(key),
    put: async (key, value) => { records.set(key, value); },
    delete: async (key) => { records.delete(key); },
  };
}

const start = Date.UTC(2026, 7, 10, 14);
const end = start + 30 * 60_000;
// Every claim below passes this explicitly. `claimReservation` defaults `now` to
// `Date.now()`, and the slot above is a FIXED wall-clock instant, so a test that
// omits the argument asserts a different thing depending on when it runs: once
// real time passes `end`, the reservation is correctly expired and a rival's
// claim is correctly admitted. That is the production rule working, reported as
// a test failure. It cost a red `validate` on 2026-08-10 at 14:30:00 UTC, the
// exact minute this slot ended, on a PR that touched none of this.
const NOW = start - 1;

describe("slot reservations", () => {
  it("names an instance after the slot, so one time is always one instance", () => {
    expect(reservationName(start, end)).toBe(`coffee-slot:${start}:${end}`);
    expect(reservationName(start, end)).toBe(reservationName(start, end));
    expect(reservationName(start + 1, end)).not.toBe(reservationName(start, end));
  });

  it("lets exactly one booking win a contested slot", async () => {
    const storage = fakeStorage();
    expect(await claimReservation(storage, "first", start, end, NOW)).toBe(true);
    expect(await claimReservation(storage, "second", start, end, NOW)).toBe(false);
    expect((await readReservation(storage)).bookingId).toBe("first");
  });

  it("is idempotent for the booking that already holds it", async () => {
    const storage = fakeStorage();
    await claimReservation(storage, "first", start, end, NOW);
    expect(await claimReservation(storage, "first", start, end, NOW)).toBe(true);
  });

  it("only lets the holder release it", async () => {
    const storage = fakeStorage();
    await claimReservation(storage, "first", start, end, NOW);
    expect(await dropReservation(storage, "second")).toBe(false);
    expect((await readReservation(storage)).bookingId).toBe("first");
    expect(await dropReservation(storage, "first")).toBe(true);
    expect(await readReservation(storage)).toBe(null);
    expect(await claimReservation(storage, "second", start, end, NOW)).toBe(true);
  });

  it("frees a slot once the slot's own end time has passed", async () => {
    const storage = fakeStorage();
    await claimReservation(storage, "first", start, end, NOW);
    expect(await claimReservation(storage, "second", start, end, end - 1)).toBe(false);
    expect(await claimReservation(storage, "second", start, end, end + 1)).toBe(true);
  });

  it("reports a lost race through the binding", async () => {
    const booking = { id: "first", start, end };
    const rival = { id: "second", start, end };
    const storage = fakeStorage();
    const env = {
      COUNTER: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (_url, init) => {
            const body = JSON.parse(init.body);
            return Response.json({
              claimed: await claimReservation(storage, body.bookingId, body.start, body.end, NOW),
            });
          },
        }),
      },
    };
    expect(await reserveSlot(env, booking)).toBe(true);
    expect(await reserveSlot(env, rival)).toBe(false);
  });

  // Booking must keep working where no Durable Object is bound, the same way a
  // missing BOOKING_WORKFLOW only costs the expiry timer. Production always
  // binds it, and a contract test asserts that, so this cannot become the quiet
  // default.
  it("does not block booking when no Durable Object is bound", async () => {
    expect(await reserveSlot({}, { id: "x", start, end })).toBe(true);
    expect(await releaseSlotClaim({}, { id: "x", start, end })).toBe(false);
  });

  it("survives a Durable Object that throws on release", async () => {
    const env = { COUNTER: { idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error("unreachable"); } }) } };
    expect(await releaseSlotClaim(env, { id: "x", start, end })).toBe(false);
  });
});
