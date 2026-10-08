// slotLabels() (src/templates.ts) caches the two formatters a slot listing
// labels with, in place of a toLocaleDateString and a toLocaleTimeString per
// slot. The listing is the island body every visitor reads, so the cached
// strings must be the toLocale strings exactly: every 97 minutes of 2026, and
// six hours around each New York transition minute by minute, in the host
// zone and three others.
import { describe, it, expect } from "bun:test";
import { renderSlotList, slotLabels } from "../src/templates.js";

const ZONES = ["America/New_York", "America/Los_Angeles", "Asia/Kolkata", "UTC", undefined];
/** @type {Intl.DateTimeFormatOptions} */
const DAY = { weekday: "long", month: "long", day: "numeric" };
/** @type {Intl.DateTimeFormatOptions} */
const TIME = { hour: "numeric", minute: "2-digit" };

function instants() {
  const out = [];
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 97 * 60_000) out.push(t);
  // 2026-03-08 07:00Z and 2026-11-01 06:00Z are 2 a.m. New York, either side.
  for (const at of [Date.UTC(2026, 2, 8, 7), Date.UTC(2026, 10, 1, 6)]) {
    for (let t = at - 3 * 3_600_000; t <= at + 3 * 3_600_000; t += 60_000) out.push(t);
  }
  return out;
}

describe("slotLabels", () => {
  it("formats exactly what toLocaleDateString and toLocaleTimeString did", () => {
    const ts = instants();
    let compared = 0;
    for (const tz of ZONES) {
      const l = slotLabels(tz);
      for (const t of ts) {
        const d = new Date(t);
        if (l.day.format(t) !== d.toLocaleDateString("en-US", { timeZone: tz, ...DAY })) throw new Error(`day label differs at ${d.toISOString()} in ${tz}`);
        if (l.time.format(t) !== d.toLocaleTimeString("en-US", { timeZone: tz, ...TIME })) throw new Error(`time label differs at ${d.toISOString()} in ${tz}`);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(30_000);
  }, 30_000);

  it("hands back the same formatters for a zone", () => {
    expect(slotLabels("America/New_York")).toBe(slotLabels("America/New_York"));
    expect(slotLabels("America/New_York")).not.toBe(slotLabels("UTC"));
  });

  it("labels a listing by its host-zone day and time", () => {
    // 2026-11-02 14:00Z is Monday 9:00 AM in New York, the morning after DST ends.
    const start = Date.UTC(2026, 10, 2, 14);
    const html = renderSlotList({ slots: [{ start, end: start + 30 * 60_000 }] }, { HOST_TIMEZONE: "America/New_York" });
    const time = new Date(start).toLocaleTimeString("en-US", { timeZone: "America/New_York", ...TIME });
    expect(html).toContain(`<div class="xp-day-label">Monday, November 2</div>`);
    expect(html).toContain(`aria-label="Monday, November 2, ${time}"><span>${time}</span>`);
  });
});
