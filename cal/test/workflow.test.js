// The per-booking expiry timer (src/workflow.js), driven through wrangler's
// Workflow introspector. The workflow waits for a "host-decision" event and, if
// none arrives within PENDING_TTL_DAYS, reclaims an abandoned pending booking.
// It touches KV only (never sends mail), which is exactly why the
// confirm/decline emails stayed in the request routes — the introspector can
// drive KV outcomes, but a Workflow's outbound fetch is out of the test stub's
// reach.
//
// The workflow itself runs INSIDE the harness's workerd (it is the class
// wrangler.test.toml binds), while this file drives it from the host through
// the proxied binding. The KV it writes is the same KV `env.BOOKINGS` reads.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { bootCal } from "./harness.ts";
import { createBooking, getBooking, holdSlot, setStatus, listHeld } from "../src/booking.js";

/** @type {Awaited<ReturnType<typeof bootCal>>} */
let cal;
/** @type {import("./harness.ts").CalEnv} */
let env;
beforeAll(async () => {
  cal = await bootCal();
  env = cal.env;
});
afterAll(() => cal.close());
beforeEach(() => cal.clearBookings());
const introspectWorkflowInstance = (id) => cal.worker.introspectWorkflowInstance("BOOKING_WORKFLOW", id);

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
const soon = () => {
  const start = Date.now() + 48 * HOUR;
  return { start, end: start + 30 * 60_000 };
};
async function heldPending() {
  const b = await createBooking(env, { status: "pending", created: Date.now(), name: "Ada", email: "a@x.dev", topic: "coffee", ...soon() });
  await holdSlot(env, b);
  return b;
}

const WAIT_STEP = { name: "wait for host decision" };

describe("BookingWorkflow expiry timer", () => {
  it("abandoned pending booking → timeout expires it and frees the slot", async () => {
    const b = await heldPending();
    await using instance = await introspectWorkflowInstance(b.id);
    await instance.modify(async (m) => { await m.forceEventTimeout(WAIT_STEP); });

    await env.BOOKING_WORKFLOW.create({ id: b.id, params: { id: b.id } });
    await instance.waitForStatus("complete");

    expect(must(await getBooking(env, b.id)).status).toBe("expired");
    expect(await listHeld(env)).toHaveLength(0);
  });

  it("host decision arrives → timer ends early and leaves the booking untouched", async () => {
    const b = await heldPending();
    await setStatus(env, b.id, "confirmed");   // the route already confirmed it
    await using instance = await introspectWorkflowInstance(b.id);
    await instance.modify(async (m) => {
      await m.mockEvent({ type: "host-decision", payload: { resolved: true } });
    });

    await env.BOOKING_WORKFLOW.create({ id: b.id, params: { id: b.id } });
    await instance.waitForStatus("complete");

    expect(must(await getBooking(env, b.id)).status).toBe("confirmed");
    expect(await listHeld(env)).toContainEqual({ start: b.start, end: b.end });
  });

  it("timeout fires but the booking was already resolved → guard leaves it alone", async () => {
    const b = await heldPending();
    await setStatus(env, b.id, "confirmed");   // resolved, but pretend the cancel event was lost
    await using instance = await introspectWorkflowInstance(b.id);
    await instance.modify(async (m) => { await m.forceEventTimeout(WAIT_STEP); });

    await env.BOOKING_WORKFLOW.create({ id: b.id, params: { id: b.id } });
    await instance.waitForStatus("complete");

    // the "only expire if still pending" guard protects a confirmed booking
    expect(must(await getBooking(env, b.id)).status).toBe("confirmed");
    expect(await listHeld(env)).toContainEqual({ start: b.start, end: b.end });
  });
});
