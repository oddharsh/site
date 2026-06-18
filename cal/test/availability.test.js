// generateSlots() (src/availability.js) — the core scheduling logic that turns
// "busy intervals + working-hours config" into bookable slots. generateSlots
// takes env as a plain argument, so we pass purpose-built config objects rather
// than the worker env; this keeps each invariant isolated and tz-explicit.
//
// It reads the real wall clock (Date.now()), so assertions are written as
// structural invariants relative to "now" rather than fixed timestamps — no
// fake timers, which are unreliable under the workers runtime.
import { describe, it, expect } from "vitest";
import { generateSlots } from "../src/availability.js";

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
  return {
    dow: wk[p.find((x) => x.type === "weekday").value],
    hour: +p.find((x) => x.type === "hour").value % 24,
  };
};

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

  it("skips a whole day once DAILY_LIMIT busy events land on it", () => {
    const free = generateSlots(baseEnv, []);
    const target = free[Math.floor(free.length / 2)];
    const day = localDay(target.start);
    // three busy entries on that local day → dayCounts hits DAILY_LIMIT (3)
    const busy = [0, 1, 2].map(() => ({ start: target.start, end: target.end }));

    const after = generateSlots(baseEnv, busy);
    const sameDay = after.filter((s) => localDay(s.start) === day);
    expect(sameDay).toHaveLength(0);
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
