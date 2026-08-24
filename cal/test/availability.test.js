// generateSlots() (src/availability.js) — the core scheduling logic that turns
// "busy intervals + working-hours config" into bookable slots. generateSlots
// takes env as a plain argument, so we pass purpose-built config objects rather
// than the worker env; this keeps each invariant isolated and tz-explicit.
//
// It reads the real wall clock (Date.now()), so assertions are written as
// structural invariants relative to "now" rather than fixed timestamps — no
// fake timers, which are unreliable under the workers runtime.
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchBusySWR, generateSlots, CAL_FRESH_MS } from "../src/availability.js";

const TZ = "America/New_York";
const baseEnv = {
  HOST_TIMEZONE: TZ,
  WORKING_HOURS_START: "9",
  WORKING_HOURS_END: "18",
  WORKING_DAYS: "1,2,3,4,5", // mon–fri
  SLOT_MINUTES: "30",
  BUFFER_MINUTES: "15",
  MIN_NOTICE_HOURS: "24",
  MAX_LOOKAHEAD_DAYS: "14",
  DAILY_LIMIT: "3",
  WEEKLY_LIMIT: "5",
};

// local calendar day (YYYY-MM-DD) for an instant, in the host tz
const localDay = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: TZ });
// local weekday (0=Sun) + hour for an instant, in the host tz
const localParts = (ms) => {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", hour: "numeric", hour12: false,
  }).formatToParts(new Date(ms));
  const wk = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // `find` can miss, and the old `.value` on the result would have thrown a bare
  // TypeError naming neither the part nor the formatter. Both parts are requested
  // above, so a miss means Intl changed under us — worth saying so out loud.
  const part = (type) => {
    const hit = p.find((x) => x.type === type);
    if (!hit) throw new Error(`Intl.DateTimeFormat produced no "${type}" part for ${TZ}`);
    return hit.value;
  };
  return {
    dow: wk[part("weekday")],
    hour: +part("hour") % 24,
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("fetchBusySWR — stale GET behavior", () => {
  it("serves a stale snapshot immediately and refreshes in the background when allowed", async () => {
    const snapshot = { busy: [{ start: 100, end: 200 }], ts: Date.now() - CAL_FRESH_MS - 1 };
    const env = {
      BOOKINGS: {
        get: vi.fn(async () => snapshot),
        put: vi.fn(),
      },
      ICAL_URL: "https://calendar.test/availability.ics",
    };
    const ctx = { waitUntil: vi.fn() };
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("calendar unavailable"); }));

    const result = await fetchBusySWR(env, ctx, { allowStale: true });

    expect(result).toMatchObject({ busy: snapshot.busy, ok: true, source: "stale" });
    expect(result.ageMs).toBeGreaterThanOrEqual(CAL_FRESH_MS);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(env.BOOKINGS.put).not.toHaveBeenCalled();
  });

  it("still blocks on a stale snapshot for strict callers", async () => {
    const snapshot = { busy: [{ start: 100, end: 200 }], ts: Date.now() - CAL_FRESH_MS - 1 };
    const env = {
      BOOKINGS: {
        get: vi.fn(async () => snapshot),
        put: vi.fn(),
      },
      ICAL_URL: "https://calendar.test/availability.ics",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
      status: 200,
      headers: { "content-type": "text/calendar" },
    })));

    const result = await fetchBusySWR(env, null);

    expect(result).toMatchObject({ busy: [], ok: true, source: "live", ageMs: 0 });
    expect(env.BOOKINGS.put).toHaveBeenCalledTimes(1);
  });
});

describe("generateSlots — invariants", () => {
  it("produces slots that obey window, length, working days and hours", () => {
    const now = Date.now();
    const slots = generateSlots(baseEnv, []);
    expect(slots.length).toBeGreaterThan(0);

    const slotMs = 30 * 60_000;
    const earliest = now + 24 * 3600_000;
    const latest = now + 14 * 86400_000;

    for (const s of slots) {
      expect(s.end - s.start).toBe(slotMs);            // exact slot length
      expect(s.start).toBeGreaterThanOrEqual(earliest); // min-notice respected
      expect(s.end).toBeLessThanOrEqual(latest);        // lookahead respected
      const { dow, hour } = localParts(s.start);
      expect([1, 2, 3, 4, 5]).toContain(dow);           // weekday only
      expect(hour).toBeGreaterThanOrEqual(9);           // within working hours
      expect(hour).toBeLessThan(18);
    }
  });

  it("slots never overlap each other", () => {
    const slots = generateSlots(baseEnv, []).sort((a, b) => a.start - b.start);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].start).toBeGreaterThanOrEqual(slots[i - 1].end);
    }
  });

  it("never offers a slot that overlaps a busy interval", () => {
    const free = generateSlots(baseEnv, []);
    const target = free[Math.floor(free.length / 2)];
    const busy = [{ start: target.start, end: target.end }];

    const after = generateSlots(baseEnv, busy);
    expect(after.find((s) => s.start === target.start)).toBeUndefined();
    for (const s of after) {
      expect(s.start < busy[0].end && s.end > busy[0].start).toBe(false);
    }
  });

  it("skips a whole day once DAILY_LIMIT coffee bookings land on it", () => {
    const free = generateSlots(baseEnv, []);
    const target = free[Math.floor(free.length / 2)];
    const day = localDay(target.start);
    // three BOOKINGS on that local day → dayCounts hits DAILY_LIMIT (3).
    // (bookings are the 3rd arg; busy calendar events must NOT count here.)
    const bookings = [0, 1, 2].map(() => ({ start: target.start, end: target.end }));

    const after = generateSlots(baseEnv, [], bookings);
    const sameDay = after.filter((s) => localDay(s.start) === day);
    expect(sameDay).toHaveLength(0);
  });

  it("a packed busy calendar shrinks but never zeroes availability", () => {
    // regression: busy events must NOT count toward DAILY/WEEKLY_LIMIT.
    // fill a day with far more than DAILY_LIMIT busy blocks; OTHER days stay open.
    const free = generateSlots(baseEnv, []);
    const target = free[Math.floor(free.length / 2)];
    const day = localDay(target.start);
    const busy = Array.from({ length: 10 }, () => ({ start: target.start, end: target.end }));

    const after = generateSlots(baseEnv, busy);
    expect(after.length).toBeGreaterThan(0);                       // not zeroed
    expect(after.find((s) => s.start === target.start)).toBeUndefined(); // that slot blocked
    expect(after.some((s) => localDay(s.start) !== day)).toBe(true);     // other days survive
  });

  it("honors MIN_NOTICE_HOURS — a longer notice removes near-term slots", () => {
    const soon = generateSlots({ ...baseEnv, MIN_NOTICE_HOURS: "24" }, []);
    const later = generateSlots({ ...baseEnv, MIN_NOTICE_HOURS: "120" }, []); // +5 days
    expect(later.length).toBeLessThan(soon.length);
    expect(Math.min(...later.map((s) => s.start)))
      .toBeGreaterThan(Math.min(...soon.map((s) => s.start)));
  });

  it("yields no slots when the working window is empty (start ≥ end)", () => {
    expect(generateSlots({ ...baseEnv, WORKING_HOURS_START: "18", WORKING_HOURS_END: "18" }, []))
      .toHaveLength(0);
  });
});
