import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export interface BookingExpiryPayload {
  bookingId: string;
  expiresAt: string;
}

export class BookingWorkflow extends WorkflowEntrypoint<Env, BookingExpiryPayload> {
  async run(event: WorkflowEvent<BookingExpiryPayload>, step: WorkflowStep): Promise<void> {
    const delay = Math.max(0, Date.parse(event.payload.expiresAt) - Date.now());
    await step.sleep("wait until pending booking expires", delay);
    await step.do("expire pending booking", async () => {
      const raw = await this.env.BOOKINGS.get(`booking:${event.payload.bookingId}`);
      if (!raw) return;
      const booking = JSON.parse(raw) as { id: string; status?: string; start: number; end: number };
      if (booking.status !== "pending") return;
      booking.status = "expired";
      await this.env.BOOKINGS.put(`booking:${booking.id}`, JSON.stringify(booking), { expirationTtl: 90 * 86400 });
      await this.env.BOOKINGS.delete(`held:${booking.start}:${booking.end}`);
      await this.env.BOOKING_SLOTS.getByName(`${booking.start}:${booking.end}`).release(booking.id);
    });
  }
}
