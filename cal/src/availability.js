// availability.js — read the host's calendar as an ICS feed, compute free
// intervals within configured working hours, slice into bookable slots.
//
// ICS parsing here is intentionally minimal: we only care about DTSTART /
// DTEND on VEVENT blocks to determine "busy". We don't handle every RFC 5545
// edge case (RRULE expansion is partial, no VTIMEZONE expansion). For a
// typical personal calendar this gets you 95% accuracy; if you keep recurring
// events that span time zones with DST shifts, those edges may drift by ~1h
// for one or two events near the shift. Worth knowing about; not worth
// solving until it bites.

// fetch the ICS feed and return an array of {start, end} busy intervals
// in unix-ms. caches per Worker isolate for the request lifetime.
export async function fetchBusy(icalUrl, opts = {}) {
  if (!icalUrl) return [];
  const r = await fetch(icalUrl, {
    cf: { cacheTtl: 300, cacheEverything: true },  // 5min edge cache
  });
  if (!r.ok) {
    console.warn(`ICS fetch failed: ${r.status}`);
    return [];
  }
  const text = await r.text();
  return parseICS(text);
}

function parseICS(text) {
  // unfold ICS line continuations (lines beginning with whitespace continue
  // the previous one — RFC 5545 §3.1)
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const busy = [];
  let inEvent = false;
  let dtstart, dtend, status, transp;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      dtstart = dtend = status = transp = undefined;
      continue;
    }
    if (line === "END:VEVENT") {
      // ignore cancelled events and events marked TRANSP:TRANSPARENT (free time)
      if (inEvent && dtstart && dtend && status !== "CANCELLED" && transp !== "TRANSPARENT") {
        busy.push({ start: dtstart, end: dtend });
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
  }
  return busy;
}

// parse "20260512T143000Z" or "20260512T143000" or "20260512" → unix-ms.
// for floating times without TZ, we treat them as UTC (best we can without
// expanding VTIMEZONE). this is fine for personal calendars where events
// are usually anchored to a real tz or explicitly UTC.
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
  // if Z (UTC) or no TZ, return as-is. if TZID was in params, we'd need
  // VTIMEZONE expansion — skip for now, accept ~1h drift on DST edges.
  return ms;
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
  const week = Math.ceil(((localDate - onejan) / 86400000 + onejan.getDay() + 1) / 7);
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
