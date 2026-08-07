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
      const raw = await this.env.BOOKINGS.get(event.payload.bookingId);
      if (!raw) return;
      const booking = JSON.parse(raw) as { status?: string };
      if (booking.status !== "pending") return;
      await this.env.BOOKINGS.delete(event.payload.bookingId);
    });
  }
}
