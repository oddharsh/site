// workflow.js — the durable per-booking expiry timer.
//
// Replaces the weekly cron sweep (expireOld) that used to reclaim pending
// bookings the host never acted on. Instead of one batch job scanning a shared
// index every Sunday, every booking gets its own Workflow instance whose whole
// job is: wait up to PENDING_TTL_DAYS for the host to decide, and if they never
// do, expire the booking and free its slot.
//
// The confirm/decline transitions themselves stay in the request routes
// (index.js) — they're synchronous, instantly reflected in /slots, and their
// emails are covered by the integration tests' fetch stub, which can't reach a
// Workflow's outbound calls. So the workflow deliberately does NOT send mail;
// its only side effect is a guarded KV reclaim. When the host DOES act, the
// route fires a "host-decision" event that resolves the wait early, so the
// instance completes in milliseconds instead of sitting in `waiting` for a week.
//
// The instance id IS the booking id (see route_book), so the routes can address
// the exact instance with env.BOOKING_WORKFLOW.get(bookingId).sendEvent(...).
//
// This class is exported from the ROOT worker entry (holding/_worker.js/index.js
// re-exports it) because the `workflows` binding's class_name must resolve on
// the deployed Worker, the same way the Counter Durable Object does.

import { WorkflowEntrypoint } from "cloudflare:workers";
import { getBooking, releaseSlot, setStatus } from "./booking.js";

export class BookingWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { id } = event.payload;
    const ttlDays = +this.env.PENDING_TTL_DAYS || 7;

    // Block until the host approves/declines (the route sends this event) OR the
    // pending window elapses. waitForEvent throws on timeout; a clean return
    // means the host acted and the route already moved the booking + slot.
    let acted = false;
    try {
      await step.waitForEvent("wait for host decision", {
        type: "host-decision",
        timeout: `${ttlDays} days`,
      });
      acted = true;
    } catch {
      acted = false; // timed out — the host never clicked
    }
    if (acted) return;

    // Timed out. Reclaim the slot, but only if it's still pending: an event we
    // failed to receive (redeploy, missed sendEvent) must never clobber a
    // booking the route already confirmed. The guard makes the reclaim safe
    // even when the cancel event is lost.
    await step.do("expire-if-still-pending", async () => {
      const booking = await getBooking(this.env, id);
      if (booking && booking.status === "pending") {
        await setStatus(this.env, id, "expired");
        await releaseSlot(this.env, booking);
      }
    });
  }
}
