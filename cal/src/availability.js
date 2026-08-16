// availability.js — read the host's calendar as an ICS feed, compute free
// intervals within configured working hours, slice into bookable slots.
//
// ICS parsing here reads DTSTART / DTEND on VEVENT blocks to determine "busy",
// and EXPANDS recurring events (RRULE). The RRULE gap had teeth: Google/iCloud
// secret-ICS feeds emit a standing weekly meeting as ONE VEVENT carrying its
// RRULE, so seeing only the first occurrence meant every later week's slot looked
// free and was bookable over a real meeting. We now expand FREQ=DAILY|WEEKLY|
// MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL, BYDAY (weekly), and honor EXDATE, out
// to RRULE_HORIZON_DAYS and capped at RRULE_MAX_INSTANCES per rule.
//
// Known deviations, all on the SAFE side (fail-closed: over-block a slot, never
// under-block one): occurrences step in whole UTC days, so a recurrence that
// crosses a DST boundary can land ~1h off for occurrences past the shift; an RRULE
// shape we cannot parse keeps just the base occurrence rather than dropping the
// event; VTIMEZONE blocks are not expanded (TZID resolves through Intl instead).

import { span } from "./trace.js";

// ── calendar snapshot (stale-while-revalidate) ──────────────────────────────
// The ICS upstream can be slow or briefly down, and the old fetchBusy() gated
// the whole page on it AND returned [] on failure — which silently made EVERY
// slot look free during an outage, a double-booking risk. fetchBusySWR keeps the
// last-good PARSED busy[] in KV with a timestamp, caps the upstream fetch with a
// hard deadline so a slow origin can't gate the page, and falls back to the
// snapshot when the fetch fails. It returns freshness metadata so the booking
// path can fail CLOSED — never confirm a slot against a calendar we can't vouch
// for. The GET page, by contrast, renders happily from a stale snapshot.
export const BUSY_KEY = "cal:busy";            // KV: { busy:[{start,end}], ts }
export const CAL_FRESH_MS = 5 * 60_000;        // snapshot is "fresh" under 5 min
export const CAL_DEADLINE_MS = 2_000;          // hard cap on a blocking ICS fetch
export const BOOK_MAX_STALE_MS = 15 * 60_000;  // booking refuses a calendar older than this

// returns { busy, ageMs, ok, source }. ok:false only when there is neither a live
// fetch nor any stored snapshot — that is the signal for the booking path to
// refuse. source is one of fresh | live | stale | none (surfaced in Server-Timing).
// Traced on `source`, which is the single most diagnostic value in this module
// and until now existed only in a Server-Timing header on whichever request
// happened to produce it — so there was no history of it at all.
//
// The case that matters is source:"none" with ok:false. That is the fail-closed
// branch: no fresh calendar, no live fetch, and no stored snapshot, so /book 503s
// rather than risk booking over a meeting it cannot see. Correct behavior, and
// completely silent — the way you learned it happened was a person telling you
// they couldn't book a coffee. It is now a span attribute, which makes "how often
// did booking refuse last week" a query.
//
// Both catch blocks below swallow their reason by design (a KV blip and a dead
// ICS feed both just mean "fall back"). The reason is now recorded before it is
// discarded, so a week of source:"stale" can be traced to which of the two.
export async function fetchBusySWR(env, ctx, { allowStale = false } = {}) {
  return span("cal.busy", (s) => fetchBusySWRInner(env, ctx, allowStale, s), {
    "cal.allow_stale": allowStale,
  });
}

async function fetchBusySWRInner(env, ctx, allowStale, s) {
  const kv = env.BOOKINGS;
  const now = Date.now();
  let snap = null;
  try { snap = kv ? await kv.get(BUSY_KEY, "json") : null; } catch (e) {
    s.setAttribute("cal.snapshot_read_error", (e && e.message) || String(e));
  }
  const age = snap && Number.isFinite(snap.ts) ? now - snap.ts : Infinity;
  // Infinity is not a valid attribute value and "no snapshot" is not an age.
  // Omitted rather than coerced, same discipline as the photo metadata.
  if (Number.isFinite(age)) s.setAttribute("cal.snapshot_age_ms", age);

  const done = (result) => {
    s.setAttribute("cal.source", result.source);
    s.setAttribute("cal.ok", result.ok);
    s.setAttribute("cal.busy_intervals", result.busy.length);
    // the booking path's own bar (BOOK_MAX_STALE_MS). A calendar that is servable
    // to the GET page but too old to book against is the interesting middle state.
    s.setAttribute("cal.bookable", result.ok && result.ageMs <= BOOK_MAX_STALE_MS);
    return result;
  };

  // fresh snapshot → serve it, skip the upstream entirely (no per-request writes)
  if (snap && age < CAL_FRESH_MS) return done({ busy: snap.busy || [], ageMs: age, ok: true, source: "fresh" });

  // The initial GET page may render from a last-good snapshot while the refresh
  // continues after the response. Booking and /slots callers leave this false:
  // they must still wait for a live calendar or fail closed.
  if (snap && allowStale) {
    // cal MUST NOT import www/_worker.js/lib/parse.js: cal's Vitest pool boots from
  // cal/src/index.js alone, so that edge would make cal untestable without the
  // site tree (gotcha 16, the same constraint that keeps cal/src/trace.js a
  // deliberate duplicate). One binding check does not earn a second parse layer.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(span("cal.refresh_background", () => refreshBusy(env)).catch(() => {}));
    }
    return done({ busy: snap.busy || [], ageMs: age, ok: true, source: "stale" });
  }

  // stale or missing → refresh under a deadline
  try {
    const fresh = await span("cal.refresh", () => refreshBusy(env));
    return done({ busy: fresh.busy, ageMs: 0, ok: true, source: "live" });
  } catch (e) {
    // upstream slow/down → serve the last-good snapshot if we have one
    s.setAttribute("cal.refresh_error", (e && e.message) || String(e));
    if (snap) return done({ busy: snap.busy || [], ageMs: age, ok: true, source: "stale" });
    // THE fail-closed branch. ageMs stays Infinity in the returned object (its
    // callers compare against it), but the span records the state by name.
    s.setAttribute("cal.fail_closed", true);
    return done({ busy: [], ageMs: Infinity, ok: false, source: "none" });
  }
}

// fetch + parse the ICS under a deadline and persist the snapshot. throws on any
// failure (no ICAL_URL, non-2xx, timeout) so fetchBusySWR can fall back.
async function refreshBusy(env) {
  const url = env.ICAL_URL;
  if (!url) throw new Error("no ICAL_URL");
  const r = await fetch(url, {
    cf: { cacheTtl: 300, cacheEverything: true },  // 5min edge cache in front of KV
    signal: AbortSignal.timeout(CAL_DEADLINE_MS),
  });
  if (!r.ok) throw new Error(`ICS ${r.status}`);
  const busy = parseICS(await r.text());
  const snap = { busy, ts: Date.now() };
  if (env.BOOKINGS) { try { await env.BOOKINGS.put(BUSY_KEY, JSON.stringify(snap)); } catch {} }
  return snap;
}

function parseICS(text) {
  // unfold ICS line continuations (lines beginning with whitespace continue
  // the previous one — RFC 5545 §3.1)
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const now = Date.now();
  const windowStart = now - 2 * 86_400_000;                    // catch an in-progress recurrence
  const windowEnd = now + RRULE_HORIZON_DAYS * 86_400_000;

  const busy = [];
  let inEvent = false;
  let dtstart, dtend, status, transp, rrule, exdates;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      dtstart = dtend = status = transp = rrule = undefined;
      exdates = new Set();
      continue;
    }
    if (line === "END:VEVENT") {
      // ignore cancelled events and events marked TRANSP:TRANSPARENT (free time)
      if (inEvent && dtstart && dtend && status !== "CANCELLED" && transp !== "TRANSPARENT") {
        for (const iv of expandEvent(dtstart, dtend, rrule, exdates, windowStart, windowEnd)) busy.push(iv);
      }
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;

    // matches both "DTSTART:..." and "DTSTART;TZID=America/New_York:..."
    const m = /^([A-Z-]+)(;[^:]*)?:(.+)$/.exec(line);
    if (!m) continue;
    const [, key, params = "", value] = m;

    if (key === "DTSTART") dtstart = parseICSDate(value, params);
    if (key === "DTEND")   dtend   = parseICSDate(value, params);
    if (key === "STATUS")  status  = value;
    if (key === "TRANSP")  transp  = value;
    if (key === "RRULE")   rrule   = value;
    // EXDATE can carry several comma-separated values, and repeat across lines
    if (key === "EXDATE") for (const v of value.split(",")) { const t = parseICSDate(v, params); if (Number.isFinite(t)) exdates.add(t); }
  }
  return busy;
}

// how far out to expand recurrences, and a hard per-rule cap so a malformed RRULE
// cannot hang or blow memory. The horizon comfortably exceeds MAX_LOOKAHEAD_DAYS
// and is re-anchored to "now" on every snapshot refresh (fetchBusySWR).
export const RRULE_HORIZON_DAYS = 120;
export const RRULE_MAX_INSTANCES = 400;

const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_MS = 86_400_000;

function addMonthsUTC(ms, n) { const d = new Date(ms); d.setUTCMonth(d.getUTCMonth() + n); return d.getTime(); }
function addYearsUTC(ms, n)  { const d = new Date(ms); d.setUTCFullYear(d.getUTCFullYear() + n); return d.getTime(); }

// Expand one VEVENT into busy intervals. A non-recurring event yields its single
// interval; a recurring one yields every occurrence whose START falls within
// [windowStart, windowEnd], each keeping the base DURATION, minus EXDATEs. An RRULE
// we cannot parse yields just the base occurrence — over-block, never under-block.
function expandEvent(dtstart, dtend, rrule, exdates, windowStart, windowEnd) {
  const dur = dtend > dtstart ? dtend - dtstart : 0;
  const iv = (start) => ({ start, end: start + dur });
  const ex = exdates || new Set();
  if (!rrule) return [iv(dtstart)];

  const R = {};
  for (const part of rrule.split(";")) { const i = part.indexOf("="); if (i > 0) R[part.slice(0, i).toUpperCase()] = part.slice(i + 1); }
  const freq = (R.FREQ || "").toUpperCase();
  const interval = Math.max(1, parseInt(R.INTERVAL, 10) || 1);
  const count = R.COUNT ? parseInt(R.COUNT, 10) : null;
  const until = R.UNTIL ? parseICSDate(R.UNTIL, "") : null;
  if (["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].indexOf(freq) === -1) return [iv(dtstart)];  // unknown FREQ → base only

  const out = [];
  let n = 0;   // occurrence index (counts toward COUNT even before the window)
  // returns false when the series is exhausted (UTIL / COUNT / cap / past window)
  const stop = (start) => (until && start > until) || (count != null && n >= count) || n >= RRULE_MAX_INSTANCES || start > windowEnd;
  const emit = (start) => { if (!ex.has(start) && start >= windowStart && start <= windowEnd) out.push(iv(start)); n++; };

  const byday = R.BYDAY ? R.BYDAY.split(",").map((s) => DOW[s.trim().slice(-2).toUpperCase()]).filter((x) => x != null).sort((a, b) => a - b) : null;

  if (freq === "WEEKLY" && byday && byday.length) {
    const weekSunday = dtstart - new Date(dtstart).getUTCDay() * DAY_MS;   // whole-day shift keeps time-of-day
    // fast-forward whole blocks that end before the window, so a weekly meeting from
    // long ago doesn't burn the instance budget before reaching today. n advances by
    // one block's worth of occurrences so COUNT/cap stay roughly honest.
    let block = 0;
    if (windowStart > weekSunday + 6 * DAY_MS) {
      block = Math.floor((windowStart - weekSunday) / (interval * 7 * DAY_MS));
      n = block * byday.length;
    }
    for (; block < 100000; block++) {
      const weekBase = weekSunday + block * interval * 7 * DAY_MS;
      if (weekBase - 7 * DAY_MS > windowEnd) break;
      for (const dow of byday) {
        const occ = weekBase + dow * DAY_MS;
        if (occ < dtstart) continue;      // before the series actually starts
        if (stop(occ)) return out;
        emit(occ);
      }
    }
    return out;
  }

  const stepMs = freq === "DAILY" ? interval * DAY_MS : freq === "WEEKLY" ? interval * 7 * DAY_MS : 0;
  const advance = (k) =>
    freq === "MONTHLY" ? addMonthsUTC(dtstart, k * interval) :
    freq === "YEARLY"  ? addYearsUTC(dtstart, k * interval) :
                         dtstart + k * stepMs;
  // fast-forward arithmetic freqs into the window (monthly/yearly steps are large,
  // so from k=0 they reach the window in well under the cap even from years back).
  let k = 0;
  if (stepMs && windowStart > dtstart) { k = Math.floor((windowStart - dtstart) / stepMs); n = k; }
  for (; ; k++) {
    const occ = advance(k);
    if (stop(occ)) break;
    emit(occ);
  }
  return out;
}

// parse "20260512T143000Z" or "20260512T143000" or "20260512" → unix-ms.
// a DTSTART;TZID=America/New_York:...  local time is resolved through Intl to
// the zone's offset at that instant (Google/iCloud "secret ICS" feeds emit
// exactly this shape for timed events). a bare floating time with no TZID and
// no Z is still treated as UTC — we can't know its zone, and that's the rare
// case for personal calendars. Slot generation (atLocalHour/tzOffsetMinutes)
// uses the same offset math, so a real 2:30pm event blocks the 2:30pm slot.
function parseICSDate(value, params = "") {
  // YYYYMMDD all-day events — treat as full UTC day
  if (/^\d{8}$/.test(value)) {
    const y = +value.slice(0, 4), m = +value.slice(4, 6) - 1, d = +value.slice(6, 8);
    return Date.UTC(y, m, d);
  }
  // YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return NaN;
  const [, Y, M, D, h, min, s, Z] = m;
  const ms = Date.UTC(+Y, +M - 1, +D, +h, +min, +s);
  if (Z) return ms;                          // explicit UTC — already correct
  // local time: shift by the TZID zone's offset at this instant. the wall clock
  // was read as if UTC, so adding the offset (positive = west of UTC) lands the
  // real instant: 14:30 in a UTC-4 zone becomes 18:30Z. NaN (floating or an
  // unknown TZID we can't resolve) falls back to the old treat-as-UTC behavior.
  const tzid = (/;TZID=([^:;,]+)/.exec(params) || [])[1];
  const offMin = icsZoneOffsetMinutes(ms, tzid);
  return Number.isFinite(offMin) ? ms + offMin * 60000 : ms;
}

// offset (minutes, positive = west of UTC) of an IANA zone at a given instant.
// mirrors tzOffsetMinutes but tolerates a missing/invalid TZID (Windows-style
// zone names, junk) by returning NaN so the caller keeps the raw UTC value.
function icsZoneOffsetMinutes(ms, tzid) {
  if (!tzid) return NaN;
  try {
    const d = new Date(ms);
    const utc   = d.toLocaleString("en-US", { timeZone: "UTC",  hour12: false });
    const local = d.toLocaleString("en-US", { timeZone: tzid,   hour12: false });
    return (Date.parse(utc) - Date.parse(local)) / 60000;
  } catch { return NaN; }
}

// generate bookable slots from now+min_notice through max_lookahead.
//
// two distinct inputs, deliberately NOT merged:
//   busy     — the host's real calendar (free/busy ICS). ONLY used to filter
//              out overlapping slots. a packed calendar shrinks availability
//              but must never trip the booking caps below.
//   bookings — coffee bookings this system owns (pending + confirmed). these
//              block their own slot AND count toward DAILY/WEEKLY_LIMIT, which
//              cap how many *coffees* the host agrees to — not how many
//              meetings they already have.
//
// conflating the two was a real bug: counting every calendar event toward the
// daily limit zeroed out availability for anyone with a busy calendar.
// returns [{start, end}, ...] in unix-ms.
export function generateSlots(env, busy, bookings = []) {
  const tz       = env.HOST_TIMEZONE;
  const minNotice = +env.MIN_NOTICE_HOURS * 3600_000;
  const lookahead = +env.MAX_LOOKAHEAD_DAYS * 86400_000;
  const slotMin   = +env.SLOT_MINUTES;
  const bufferMin = +env.BUFFER_MINUTES;
  const stepMs    = (slotMin + bufferMin) * 60_000;
  const slotMs    = slotMin * 60_000;
  const workStart = +env.WORKING_HOURS_START;
  const workEnd   = +env.WORKING_HOURS_END;
  const workDays  = env.WORKING_DAYS.split(",").map(n => +n);

  const now = Date.now();
  const earliest = now + minNotice;
  const latest   = now + lookahead;

  // limits — bookings already pending+confirmed within a day/week count
  const dailyLimit  = +env.DAILY_LIMIT;
  const weeklyLimit = +env.WEEKLY_LIMIT;

  // build slots by walking each day in the lookahead window in HOST_TIMEZONE.
  // for each day, generate slot starts at every (slotMin+bufferMin) interval
  // between workStart and workEnd, filter conflicts.
  // a slot is unbookable if it overlaps EITHER a real calendar event or an
  // existing coffee booking. limits, below, only count the coffee bookings.
  const conflicts = [...busy, ...bookings];

  const slots = [];
  const dayCounts = {};   // YYYY-MM-DD → count of coffee bookings (pending+confirmed)
  const weekCounts = {};  // YYYY-WW → count

  for (const b of bookings) {
    const k = ymd(b.start, tz);
    dayCounts[k]  = (dayCounts[k]  || 0) + 1;
    weekCounts[yw(b.start, tz)] = (weekCounts[yw(b.start, tz)] || 0) + 1;
  }

  let cursorDay = startOfDay(now, tz);
  for (let d = 0; d < +env.MAX_LOOKAHEAD_DAYS + 1; d++) {
    const dayStart = addDays(cursorDay, d);
    const dow = dayOfWeek(dayStart, tz);
    if (!workDays.includes(dow)) continue;

    const dayKey = ymd(dayStart, tz);
    const weekKey = yw(dayStart, tz);
    if ((dayCounts[dayKey]  || 0) >= dailyLimit)  continue;
    if ((weekCounts[weekKey] || 0) >= weeklyLimit) continue;

    // local working hours on this day
    const dayHourMs = (h) => atLocalHour(dayStart, tz, h);
    let t = dayHourMs(workStart);
    const endOfWork = dayHourMs(workEnd);

    while (t + slotMs <= endOfWork) {
      const slotStart = t;
      const slotEnd   = t + slotMs;
      t += stepMs;

      if (slotStart < earliest || slotEnd > latest) continue;
      if (intersectsAny(slotStart, slotEnd, conflicts)) continue;
      slots.push({ start: slotStart, end: slotEnd });
    }
  }
  return slots;
}

function intersectsAny(start, end, intervals) {
  for (const i of intervals) {
    if (start < i.end && end > i.start) return true;
  }
  return false;
}

// timezone helpers using Intl. enough for our purposes — we don't need
// arbitrary tz math, just "what's the local day/hour for this instant?"
function ymd(ms, tz) {
  const d = new Date(ms);
  return d.toLocaleDateString("en-CA", { timeZone: tz });  // YYYY-MM-DD
}
function yw(ms, tz) {
  // approximate ISO week — fine for our daily/weekly limit purposes
  const d = new Date(ms);
  const localDate = new Date(d.toLocaleString("en-US", { timeZone: tz }));
  const onejan = new Date(localDate.getFullYear(), 0, 1);
  // .getTime() rather than subtracting the Dates directly: identical at runtime
  // (subtraction coerces through valueOf) and it says the units out loud.
  const week = Math.ceil(((localDate.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
  return `${localDate.getFullYear()}-W${week}`;
}
function dayOfWeek(ms, tz) {
  const d = new Date(ms);
  return new Date(d.toLocaleString("en-US", { timeZone: tz })).getDay();
}
function startOfDay(ms, tz) {
  // local midnight, expressed as unix-ms
  const d = new Date(ms);
  const local = d.toLocaleString("en-CA", { timeZone: tz, hour12: false }); // YYYY-MM-DD HH:MM:SS
  const [date] = local.split(",");
  return atLocalHour(Date.parse(date + "T00:00:00Z"), tz, 0);
}
function addDays(ms, days) { return ms + days * 86400000; }
function atLocalHour(dayStartMs, tz, hour) {
  // return the unix-ms for `hour:00` local time on the day containing dayStartMs.
  // does the rough thing by adding hour*3600000 to a UTC midnight, then
  // correcting by the tz offset at that instant.
  const utcMidnight = new Date(dayStartMs).setUTCHours(0, 0, 0, 0);
  const wallTime = new Date(utcMidnight + hour * 3600000);
  const offsetMin = tzOffsetMinutes(wallTime, tz);
  return wallTime.getTime() + offsetMin * 60000;
}
function tzOffsetMinutes(date, tz) {
  // distance between UTC and local at this instant, in minutes (positive = west of UTC)
  const utc = date.toLocaleString("en-US", { timeZone: "UTC", hour12: false });
  const local = date.toLocaleString("en-US", { timeZone: tz, hour12: false });
  return (Date.parse(utc) - Date.parse(local)) / 60000;
}
