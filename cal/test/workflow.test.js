// The per-booking expiry timer (src/workflow.js), driven through the Vitest
// pool's Workflow introspector. The workflow waits for a "host-decision" event
// and, if none arrives within PENDING_TTL_DAYS, reclaims an abandoned pending
// booking. It touches KV only (never sends mail), which is exactly why the
// confirm/decline emails stayed in the request routes — the introspector can
// drive KV outcomes, but a Workflow's outbound fetch is out of the test stub's
// reach.
import { describe, it, expect, beforeEach } from "vitest";
import { env, introspectWorkflowInstance } from "cloudflare:test";
import { createBooking, getBooking, holdSlot, setStatus, listHeld } from "../src/booking.js";

// NOTE: the two forceEventTimeout tests below each print one
// "WorkflowTimeoutError: Execution timed out" line. That's the miniflare
// workflows emulator surfacing its internal timeout promise; run() catches the
// timeout and behaves correctly (the assertions prove it), and the suite exits
// 0. It's cosmetic, not a failure.

beforeEach(async () => {
  const { keys } = await env.BOOKINGS.list();
  await Promise.all(keys.map((k) => env.BOOKINGS.delete(k.name)));
});

const HOUR = 3600_000;
const soon = () => {
  const start = Date.now() + 48 * HOUR;
  return { start, end: start + 30 * 60_000 };
};
async function heldPending() {
  const b = await createBooking(env, { status: "pending", created: Date.now(), name: "Ada", email: "a@x.dev", ...soon() });
  await holdSlot(env, b);
  return b;
}

const WAIT_STEP = { name: "wait for host decision" };

describe("BookingWorkflow expiry timer", () => {
  it("abandoned pending booking → timeout expires it and frees the slot", async () => {
    const b = await heldPending();
    await using instance = await introspectWorkflowInstance(env.BOOKING_WORKFLOW, b.id);
    await instance.modify(async (m) => { await m.forceEventTimeout(WAIT_STEP); });

    await env.BOOKING_WORKFLOW.create({ id: b.id, params: { id: b.id } });
    await instance.waitForStatus("complete");

    expect((await getBooking(env, b.id)).status).toBe("expired");
    expect(await listHeld(env)).toHaveLength(0);
  });

  it("host decision arrives → timer ends early and leaves the booking untouched", async () => {
    const b = await heldPending();
    await setStatus(env, b.id, "confirmed");   // the route already confirmed it
    await using instance = await introspectWorkflowInstance(env.BOOKING_WORKFLOW, b.id);
    await instance.modify(async (m) => {
      await m.mockEvent({ type: "host-decision", payload: { resolved: true } });
    });

    await env.BOOKING_WORKFLOW.create({ id: b.id, params: { id: b.id } });
    await instance.waitForStatus("complete");

    expect((await getBooking(env, b.id)).status).toBe("confirmed");
    expect(await listHeld(env)).toContainEqual({ start: b.start, end: b.end });
  });

  it("timeout fires but the booking was already resolved → guard leaves it alone", async () => {
    const b = await heldPending();
    await setStatus(env, b.id, "confirmed");   // resolved, but pretend the cancel event was lost
    await using instance = await introspectWorkflowInstance(env.BOOKING_WORKFLOW, b.id);
    await instance.modify(async (m) => { await m.forceEventTimeout(WAIT_STEP); });

    await env.BOOKING_WORKFLOW.create({ id: b.id, params: { id: b.id } });
    await instance.waitForStatus("complete");

    // the "only expire if still pending" guard protects a confirmed booking
    expect((await getBooking(env, b.id)).status).toBe("confirmed");
    expect(await listHeld(env)).toContainEqual({ start: b.start, end: b.end });
  });
});
