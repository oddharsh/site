import assert from "node:assert/strict";
import test from "node:test";
import { prefersMarkdown } from "../src/worker/http.ts";
import { validateLensTarget } from "../src/worker/lens.ts";
import { generateCoffeeSlots, parseCalendar } from "../src/worker/coffee.ts";

function request(accept) {
  return new Request("https://aadhar.sh/", { headers: { accept } });
}

test("Markdown negotiation requires an explicit media type", () => {
  assert.equal(prefersMarkdown(request("*/*")), false);
  assert.equal(prefersMarkdown(request("text/html")), false);
  assert.equal(prefersMarkdown(request("text/markdown")), true);
});

test("Markdown negotiation respects weights and client order", () => {
  assert.equal(prefersMarkdown(request("text/markdown;q=0.7, text/html;q=0.9")), false);
  assert.equal(prefersMarkdown(request("text/html;q=0.5, text/markdown;q=0.8")), true);
  assert.equal(prefersMarkdown(request("text/markdown;q=0, text/html;q=1")), false);
});

test("Lens accepts only ordinary public web targets", () => {
  assert.equal(validateLensTarget("https://example.com/path").target?.href, "https://example.com/path");
  for (const value of [
    "javascript:alert(1)", "file:///etc/passwd", "http://localhost/", "http://127.0.0.1/",
    "http://10.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "https://user:pass@example.com/",
    "https://example.com:8443/",
  ]) assert.ok(validateLensTarget(value).error, `${value} should be refused`);
});

test("coffee calendar parsing expands recurring busy time", () => {
  const source = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;TZID=America/New_York:20260105T090000\nDTEND;TZID=America/New_York:20260105T100000\nRRULE:FREQ=WEEKLY;COUNT=3;BYDAY=MO\nEND:VEVENT\nEND:VCALENDAR`;
  const busy = parseCalendar(source, Date.UTC(2026, 0, 4));
  assert.equal(busy.length, 3);
  assert.equal(busy[0].end - busy[0].start, 60 * 60_000);
});

test("coffee slots respect working hours, conflicts, and booking limits", () => {
  const env = {
    HOST_TIMEZONE: "America/New_York", WORKING_DAYS: "1,2,3,4,5", WORKING_HOURS_START: "9", WORKING_HOURS_END: "12",
    SLOT_MINUTES: "30", BUFFER_MINUTES: "0", MIN_NOTICE_HOURS: "0", MAX_LOOKAHEAD_DAYS: "1", DAILY_LIMIT: "2", WEEKLY_LIMIT: "5",
  };
  const now = Date.UTC(2026, 0, 5, 12);
  const first = Date.UTC(2026, 0, 5, 14);
  const slots = generateCoffeeSlots(env, [{ start: first, end: first + 30 * 60_000 }], [], now);
  assert.ok(slots.length > 0);
  assert.ok(slots.every(({ start }) => start !== first));
  const capped = generateCoffeeSlots(env, [], [{ start: first, end: first + 30 * 60_000 }, { start: first + 60 * 60_000, end: first + 90 * 60_000 }], now);
  assert.ok(capped.every(({ start }) => new Date(start).getUTCDate() !== 5));
});
