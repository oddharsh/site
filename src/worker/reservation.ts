export type Reservation = { bookingId: string; start: number; end: number; reservedAt: number };

export type ReservationStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
};

export async function claimReservation(storage: ReservationStorage, bookingId: string, start: number, end: number, now = Date.now()): Promise<boolean> {
  if (!bookingId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const existing = await storage.get<Reservation>("reservation");
  if (existing && existing.end > now) return existing.bookingId === bookingId;
  await storage.put("reservation", { bookingId, start, end, reservedAt: now } satisfies Reservation);
  return true;
}

export async function dropReservation(storage: ReservationStorage, bookingId: string): Promise<boolean> {
  const existing = await storage.get<Reservation>("reservation");
  if (!existing || existing.bookingId !== bookingId) return false;
  await storage.delete("reservation");
  return true;
}

function slotStub(env: Env, start: number, end: number) {
  return env.COUNTER.getByName(`coffee-slot:${start}:${end}`);
}

export function reserveCoffeeSlot(env: Env, bookingId: string, start: number, end: number): Promise<boolean> {
  return slotStub(env, start, end).reserve(bookingId, start, end);
}

export function releaseCoffeeSlot(env: Env, bookingId: string, start: number, end: number): Promise<boolean> {
  return slotStub(env, start, end).release(bookingId);
}
