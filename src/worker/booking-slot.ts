import { DurableObject } from "cloudflare:workers";

type Reservation = { bookingId: string; start: number; end: number; reservedAt: number };

export class BookingSlot extends DurableObject<Env> {
  async reserve(bookingId: string, start: number, end: number): Promise<boolean> {
    const existing = await this.ctx.storage.get<Reservation>("reservation");
    if (existing && existing.end > Date.now()) return existing.bookingId === bookingId;
    await this.ctx.storage.put("reservation", { bookingId, start, end, reservedAt: Date.now() } satisfies Reservation);
    return true;
  }

  async release(bookingId: string): Promise<boolean> {
    const existing = await this.ctx.storage.get<Reservation>("reservation");
    if (!existing || existing.bookingId !== bookingId) return false;
    await this.ctx.storage.delete("reservation");
    return true;
  }
}
