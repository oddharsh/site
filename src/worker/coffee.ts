import { json, withSiteHeaders } from "./http.ts";
import { sendEmail } from "./email.ts";
import { signValue, verifyValue } from "./signatures.ts";
import { releaseCoffeeSlot, reserveCoffeeSlot } from "./reservation.ts";

type CoffeeSecrets = { ICAL_URL?: string; SIGNING_SECRET?: string; RESEND_API_KEY?: string };
type Interval = { start: number; end: number };
type CalendarSnapshot = { busy: Interval[]; ts: number };
type Booking = { id: string; name: string; email: string; topic: string; start: number; end: number; created: number; status: "pending" | "confirming" | "confirmed" | "declined" | "expired" };

const calendarKey = "cal:busy";
const freshMs = 5 * 60_000;
const trustedMs = 15 * 60_000;
const dayMs = 86_400_000;

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function zoneParts(ms: number, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US-u-ca-gregory", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ms);
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
}

function zonedEpoch(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desired;
  for (let i = 0; i < 3; i++) {
    const p = zoneParts(guess, timeZone);
    const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += desired - represented;
  }
  return guess;
}

function parseIcsDate(value: string, parameters = ""): number {
  if (/^\d{8}$/.test(value)) return Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8));
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return Number.NaN;
  const [, year, month, day, hour, minute, second, zulu] = match;
  if (zulu) return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const timeZone = parameters.match(/(?:^|;)TZID=([^:;,]+)/)?.[1];
  return timeZone ? zonedEpoch(+year, +month, +day, +hour, +minute, timeZone) : Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
}

function expandEvent(start: number, end: number, rule: string | undefined, exclusions: Set<number>, now = Date.now()): Interval[] {
  const duration = Math.max(0, end - start);
  if (!rule) return [{ start, end }];
  const values = Object.fromEntries(rule.split(";").map((part) => part.split("=", 2))) as Record<string, string>;
  const frequency = values.FREQ;
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(frequency)) return [{ start, end }];
  const interval = Math.max(1, Number(values.INTERVAL) || 1);
  const count = values.COUNT ? Math.max(0, Number(values.COUNT)) : 400;
  const until = values.UNTIL ? parseIcsDate(values.UNTIL) : Number.POSITIVE_INFINITY;
  const windowStart = now - 2 * dayMs;
  const windowEnd = now + 120 * dayMs;
  const weekday = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 } as const;
  const byDay = (values.BYDAY ?? "").split(",").map((value) => weekday[value.slice(-2) as keyof typeof weekday]).filter((value) => value !== undefined);
  const candidates: number[] = [];
  if (frequency === "WEEKLY" && byDay.length) {
    const weekStart = start - new Date(start).getUTCDay() * dayMs;
    for (let week = 0; candidates.length < count && week < 400; week++) {
      for (const day of byDay) {
        const value = weekStart + week * interval * 7 * dayMs + day * dayMs;
        if (value >= start) candidates.push(value);
        if (candidates.length >= count) break;
      }
      if (weekStart + week * interval * 7 * dayMs > windowEnd) break;
    }
  } else {
    for (let index = 0; index < count && index < 400; index++) {
      const date = new Date(start);
      if (frequency === "DAILY") date.setUTCDate(date.getUTCDate() + index * interval);
      if (frequency === "WEEKLY") date.setUTCDate(date.getUTCDate() + index * interval * 7);
      if (frequency === "MONTHLY") date.setUTCMonth(date.getUTCMonth() + index * interval);
      if (frequency === "YEARLY") date.setUTCFullYear(date.getUTCFullYear() + index * interval);
      candidates.push(date.valueOf());
      if (date.valueOf() > windowEnd) break;
    }
  }
  return candidates.filter((value) => value <= until && value >= windowStart && value <= windowEnd && !exclusions.has(value)).map((value) => ({ start: value, end: value + duration }));
}

export function parseCalendar(source: string, now = Date.now()): Interval[] {
  const lines = source.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const busy: Interval[] = [];
  let event: Record<string, string | Set<number>> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { event = { exclusions: new Set<number>() }; continue; }
    if (line === "END:VEVENT") {
      if (event && event.start && event.end && event.status !== "CANCELLED" && event.transparency !== "TRANSPARENT") {
        busy.push(...expandEvent(Number(event.start), Number(event.end), event.rule as string | undefined, event.exclusions as Set<number>, now));
      }
      event = null; continue;
    }
    if (!event) continue;
    const match = line.match(/^([A-Z-]+)(;[^:]*)?:(.*)$/);
    if (!match) continue;
    const [, field, parameters = "", value] = match;
    if (field === "DTSTART") event.start = String(parseIcsDate(value, parameters));
    if (field === "DTEND") event.end = String(parseIcsDate(value, parameters));
    if (field === "STATUS") event.status = value;
    if (field === "TRANSP") event.transparency = value;
    if (field === "RRULE") event.rule = value;
    if (field === "EXDATE") for (const item of value.split(",")) (event.exclusions as Set<number>).add(parseIcsDate(item, parameters));
  }
  return busy.filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a, b) => a.start - b.start);
}

export async function refreshCoffeeCalendar(env: Env): Promise<CalendarSnapshot> {
  const url = (env as Env & CoffeeSecrets).ICAL_URL;
  if (!url) throw new Error("calendar source is not configured");
  const response = await fetch(url, { headers: { accept: "text/calendar" }, signal: AbortSignal.timeout(2000), cf: { cacheTtl: 0 } });
  if (!response.ok) throw new Error(`calendar source returned ${response.status}`);
  const source = await response.text();
  if (source.length > 2 * 1024 * 1024) throw new Error("calendar source exceeds 2 MiB");
  const snapshot = { busy: parseCalendar(source), ts: Date.now() };
  await env.BOOKINGS.put(calendarKey, JSON.stringify(snapshot));
  return snapshot;
}

async function calendar(env: Env, ctx: ExecutionContext | null, allowBackground: boolean): Promise<{ snapshot: CalendarSnapshot | null; source: string; ageMs: number }> {
  let snapshot: CalendarSnapshot | null = null;
  try { snapshot = await env.BOOKINGS.get<CalendarSnapshot>(calendarKey, "json"); } catch { /* fetch below */ }
  const ageMs = snapshot ? Math.max(0, Date.now() - snapshot.ts) : Number.POSITIVE_INFINITY;
  if (snapshot && ageMs < freshMs) return { snapshot, source: "fresh", ageMs };
  if (snapshot && allowBackground && ctx) {
    ctx.waitUntil(refreshCoffeeCalendar(env).catch(() => undefined));
    return { snapshot, source: "stale", ageMs };
  }
  try { return { snapshot: await refreshCoffeeCalendar(env), source: "live", ageMs: 0 }; }
  catch { return { snapshot, source: snapshot ? "stale" : "none", ageMs }; }
}

async function heldSlots(env: Env): Promise<Interval[]> {
  const held: Interval[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BOOKINGS.list({ prefix: "held:", cursor });
    for (const key of page.keys) {
      const [start, end] = key.name.slice(5).split(":").map(Number);
      if (Number.isFinite(start) && Number.isFinite(end) && end > Date.now()) held.push({ start, end });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return held;
}

function dateKey(ms: number, timeZone: string): string {
  const p = zoneParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function weekKey(ms: number, timeZone: string): string {
  const p = zoneParts(ms, timeZone);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  return `${date.getUTCFullYear()}-${Math.ceil(((date.valueOf() - yearStart) / dayMs + 1) / 7)}`;
}

export function generateCoffeeSlots(env: Env, busy: Interval[], held: Interval[], now = Date.now()): Interval[] {
  const timeZone = env.HOST_TIMEZONE || "UTC";
  const workDays = new Set(env.WORKING_DAYS.split(",").map(Number));
  const duration = Number(env.SLOT_MINUTES) * 60_000;
  const step = (Number(env.SLOT_MINUTES) + Number(env.BUFFER_MINUTES)) * 60_000;
  const earliest = now + Number(env.MIN_NOTICE_HOURS) * 3_600_000;
  const latest = now + Number(env.MAX_LOOKAHEAD_DAYS) * dayMs;
  const daily = new Map<string, number>();
  const weekly = new Map<string, number>();
  const conflicts = busy.concat(held);
  for (const slot of held) {
    const day = dateKey(slot.start, timeZone); const week = weekKey(slot.start, timeZone);
    daily.set(day, (daily.get(day) ?? 0) + 1); weekly.set(week, (weekly.get(week) ?? 0) + 1);
  }
  const today = zoneParts(now, timeZone);
  const slots: Interval[] = [];
  for (let index = 0; index <= Number(env.MAX_LOOKAHEAD_DAYS); index++) {
    const localDate = new Date(Date.UTC(today.year, today.month - 1, today.day + index));
    const year = localDate.getUTCFullYear(), month = localDate.getUTCMonth() + 1, day = localDate.getUTCDate();
    if (!workDays.has(localDate.getUTCDay())) continue;
    const noon = zonedEpoch(year, month, day, 12, 0, timeZone);
    if ((daily.get(dateKey(noon, timeZone)) ?? 0) >= Number(env.DAILY_LIMIT) || (weekly.get(weekKey(noon, timeZone)) ?? 0) >= Number(env.WEEKLY_LIMIT)) continue;
    const start = zonedEpoch(year, month, day, Number(env.WORKING_HOURS_START), 0, timeZone);
    const end = zonedEpoch(year, month, day, Number(env.WORKING_HOURS_END), 0, timeZone);
    for (let value = start; value + duration <= end; value += step) {
      const slot = { start: value, end: value + duration };
      if (slot.start < earliest || slot.end > latest) continue;
      if (conflicts.some((item) => slot.start < item.end && slot.end > item.start)) continue;
      slots.push(slot);
    }
  }
  return slots;
}

async function publicAvailability(env: Env, ctx: ExecutionContext | null, allowBackground = false) {
  const [cal, held] = await Promise.all([calendar(env, ctx, allowBackground), heldSlots(env)]);
  const available = Boolean(cal.snapshot) && cal.ageMs <= trustedMs;
  const slots = available ? generateCoffeeSlots(env, cal.snapshot!.busy, held) : [];
  return { available, stale: !available || cal.source === "stale", source: cal.source, checkedAt: new Date().toISOString(), ageSeconds: Number.isFinite(cal.ageMs) ? Math.floor(cal.ageMs / 1000) : null, timezone: env.HOST_TIMEZONE || "UTC", bookingUrl: "https://aadhar.sh/coffee", slots: slots.map(({ start, end }) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), startMs: start, endMs: end, durationMinutes: Math.round((end - start) / 60000) })) };
}

export async function coffeeAvailability(env: Env, ctx: ExecutionContext): Promise<Response> {
  const payload = await publicAvailability(env, ctx);
  return json(payload, { status: payload.available ? 200 : 503, headers: { "cache-control": "no-store", ...(payload.available ? {} : { "retry-after": "60" }), "x-robots-tag": "noindex" } });
}

export async function coffeeSlots(env: Env, ctx: ExecutionContext): Promise<Response> {
  const payload = await publicAvailability(env, ctx);
  return json({ slots: payload.slots, available: payload.available, checkedAt: payload.checkedAt, timezone: payload.timezone }, { status: payload.available ? 200 : 503, headers: { "cache-control": "no-store", ...(payload.available ? {} : { "retry-after": "60" }), "x-robots-tag": "noindex" } });
}

function slotLabel(start: number, end: number, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(start);
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return `${day} · ${time.format(start)}–${new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(end)}`;
}

export async function coffeePage(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const [response, availability] = await Promise.all([env.ASSETS.fetch(request), publicAvailability(env, ctx, true)]);
  const options = availability.slots.map((slot) => `<option value="${slot.startMs}">${escapeHtml(slotLabel(slot.startMs, slot.endMs, availability.timezone))}</option>`).join("");
  const transformed = new HTMLRewriter()
    .on("#coffee-status", { element(element) { element.setAttribute("class", `coffee-status ${availability.available ? "available" : "unavailable"}`); element.setInnerContent(availability.available ? `<h2>${availability.slots.length} verified times</h2><p>Calendar snapshot: ${escapeHtml(availability.source)} · ${availability.ageSeconds ?? 0}s old.</p>` : `<h2>No verified times right now</h2><p>The calendar could not be confirmed recently enough, so booking fails closed.</p>`, { html: true }); } })
    .on("#coffee-slot", { element(element) { if (availability.available && options) { element.removeAttribute("disabled"); element.setInnerContent(`<option value="">Choose a time…</option>${options}`, { html: true }); } } })
    .on(".coffee-form button[type=submit]", { element(element) { if (availability.available && options) element.removeAttribute("disabled"); } })
    .transform(response);
  const secured = withSiteHeaders(transformed, request); secured.headers.set("cache-control", "no-store"); secured.headers.set("x-robots-tag", "noindex"); return secured;
}

type JsonRecord = Record<string, unknown>;

async function resultPage(request: Request, env: Env, title: string, message: string, status = 200): Promise<Response> {
  const target = new URL("/coffee", request.url);
  const response = await env.ASSETS.fetch(new Request(target, request));
  const transformed = new HTMLRewriter().on(".document", { element(element) { element.setInnerContent(`<header><p class="eyebrow">Control Panel · Scheduled Tasks</p><h1>Coffee</h1></header><section class="coffee-result"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p><p><a href="/coffee">Return to availability</a></p></section>`, { html: true }); } }).transform(response);
  const secured = withSiteHeaders(transformed, request); secured.headers.set("cache-control", "no-store"); secured.headers.set("referrer-policy", "no-referrer"); secured.headers.set("x-robots-tag", "noindex");
  return new Response(secured.body, { status, headers: secured.headers });
}

async function releaseReservation(env: Env, booking: Booking): Promise<void> {
  await Promise.all([
    env.BOOKINGS.delete(`held:${booking.start}:${booking.end}`),
    releaseCoffeeSlot(env, booking.id, booking.start, booking.end),
  ]);
}

export async function coffeeBook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return resultPage(request, env, "Request refused", "The booking form must be submitted from this site.", 403);
  if (Number(request.headers.get("content-length") || 0) > 16 * 1024) return resultPage(request, env, "Request too large", "The booking form exceeded its 16 KiB limit.", 413);
  const secrets = env as Env & CoffeeSecrets;
  if (!secrets.SIGNING_SECRET || !secrets.RESEND_API_KEY) return resultPage(request, env, "Booking unavailable", "The private confirmation channel is not configured in this environment.", 503);
  let form: FormData;
  try { form = await request.formData(); } catch { return resultPage(request, env, "Invalid form", "The submitted form could not be read.", 400); }
  if (form.get("website")) return resultPage(request, env, "Request received", "Thanks. Your request is pending review.");
  const name = String(form.get("name") ?? "").trim().slice(0, 100);
  const email = String(form.get("email") ?? "").trim().slice(0, 200);
  const topic = String(form.get("topic") ?? "").trim().slice(0, 1000);
  const start = Number(form.get("start"));
  if (!name || !topic || !Number.isFinite(start) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return resultPage(request, env, "Check the form", "Name, valid email, topic, and a published time are all required.", 400);
  const availability = await publicAvailability(env, ctx);
  const selected = availability.slots.find((slot) => slot.startMs === start);
  if (!availability.available || !selected) return resultPage(request, env, "That time is no longer open", "The calendar changed or could not be verified. Please choose again.", 409);
  const booking: Booking = { id: crypto.randomUUID(), name, email, topic, start, end: selected.endMs, created: Date.now(), status: "pending" };
  if (!await reserveCoffeeSlot(env, booking.id, booking.start, booking.end)) return resultPage(request, env, "That time was just taken", "Someone else reserved this time first. Please choose another.", 409);
  try {
    await env.BOOKINGS.put(`booking:${booking.id}`, JSON.stringify(booking), { expirationTtl: 90 * 86400 });
    await env.BOOKINGS.put(`held:${booking.start}:${booking.end}`, booking.id, { expiration: Math.max(Math.floor(booking.end / 1000) + 86400, Math.floor(Date.now() / 1000) + 120) });
    const approve = await signValue(`${booking.id}|approve`, secrets.SIGNING_SECRET);
    const decline = await signValue(`${booking.id}|decline`, secrets.SIGNING_SECRET);
    const base = new URL(request.url).origin;
    await sendEmail(env, { from: "aadhar.sh coffee <noreply@aadhar.sh>", to: [env.HOST_EMAIL], reply_to: email, subject: `Coffee request from ${name}`, html: `<p><strong>${escapeHtml(name)}</strong> requested coffee for ${escapeHtml(slotLabel(booking.start, booking.end, env.HOST_TIMEZONE))}.</p><blockquote>${escapeHtml(topic)}</blockquote><p><a href="${base}/coffee/approve?t=${booking.id}&amp;sig=${approve}">Approve and send invitation</a> · <a href="${base}/coffee/decline?t=${booking.id}&amp;sig=${decline}">Decline</a></p>` });
  } catch {
    await Promise.allSettled([env.BOOKINGS.delete(`booking:${booking.id}`), releaseReservation(env, booking)]);
    return resultPage(request, env, "Request not sent", "The confirmation channel did not accept the request. Nothing was reserved; please try again.", 503);
  }
  const expiresAt = new Date(Date.now() + Number(env.PENDING_TTL_DAYS || 7) * dayMs).toISOString();
  ctx.waitUntil(env.BOOKING_WORKFLOW.create({ id: booking.id, params: { bookingId: booking.id, expiresAt } }).catch(() => undefined));
  return resultPage(request, env, "Request held", "I received it. The time stays pending until I approve or decline it by email.");
}

function calendarInvite(env: Env, booking: Booking): string {
  const timestamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const clean = (value: string) => value.replace(/[\\;,]/g, "\\$&").replaceAll("\n", "\\n");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//aadhar.sh//coffee//EN", "METHOD:REQUEST", "BEGIN:VEVENT", `UID:${booking.id}@aadhar.sh`, `DTSTAMP:${timestamp(Date.now())}`, `DTSTART:${timestamp(booking.start)}`, `DTEND:${timestamp(booking.end)}`, `SUMMARY:${clean(env.EVENT_TITLE)}`, `DESCRIPTION:${clean(booking.topic)}`, `ORGANIZER;CN=${clean(env.HOST_NAME)}:mailto:${env.HOST_EMAIL}`, `ATTENDEE;CN=${clean(booking.name)};RSVP=TRUE:mailto:${booking.email}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}

function base64Utf8(value: string): string {
  let binary = ""; for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte); return btoa(binary);
}

export async function coffeeDecision(request: Request, env: Env, action: "approve" | "decline"): Promise<Response> {
  const url = new URL(request.url); const id = url.searchParams.get("t") ?? ""; const signature = url.searchParams.get("sig") ?? "";
  const secret = (env as Env & CoffeeSecrets).SIGNING_SECRET;
  if (!secret || !id || !signature || !await verifyValue(`${id}|${action}`, signature, secret)) return resultPage(request, env, "Link refused", "This decision link is invalid or expired.", 401);
  const booking = await env.BOOKINGS.get<Booking>(`booking:${id}`, "json");
  if (!booking) return resultPage(request, env, "Booking not found", "The pending record expired or was already removed.", 404);
  if (action === "approve") {
    if (booking.status === "confirmed") return resultPage(request, env, "Already confirmed", "The invitation was already sent.");
    if (booking.status !== "pending" && booking.status !== "confirming") return resultPage(request, env, "Decision already recorded", `This request is ${booking.status}.`, 409);
    booking.status = "confirming"; await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(booking), { expirationTtl: 90 * 86400 });
    try {
      await sendEmail(env, { from: `${env.HOST_NAME} <${env.HOST_EMAIL}>`, to: [booking.email], cc: [env.HOST_EMAIL], subject: `Confirmed: ${env.EVENT_TITLE}`, html: `<p>Hi ${escapeHtml(booking.name.split(/\s+/)[0])}—</p><p>Confirmed for ${escapeHtml(slotLabel(booking.start, booking.end, env.HOST_TIMEZONE))}. The calendar invitation is attached.</p>`, attachments: [{ filename: "coffee.ics", content: base64Utf8(calendarInvite(env, booking)), content_type: "text/calendar; method=REQUEST" }] });
    } catch {
      booking.status = "pending";
      await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(booking), { expirationTtl: 90 * 86400 });
      return resultPage(request, env, "Confirmation not sent", "The request remains pending; retry this link when the email channel is available.", 503);
    }
    booking.status = "confirmed"; await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(booking), { expirationTtl: 90 * 86400 });
    return resultPage(request, env, "Confirmed", "The requester received a calendar invitation.");
  }
  if (booking.status === "declined") return resultPage(request, env, "Already declined", "The time is already open again.");
  if (booking.status !== "pending") return resultPage(request, env, "Decision already recorded", `This request is ${booking.status}.`, 409);
  booking.status = "declined"; await env.BOOKINGS.put(`booking:${id}`, JSON.stringify(booking), { expirationTtl: 90 * 86400 }); await releaseReservation(env, booking);
  await sendEmail(env, { from: `${env.HOST_NAME} <${env.HOST_EMAIL}>`, to: [booking.email], subject: `Re: ${env.EVENT_TITLE}`, html: `<p>Hi ${escapeHtml(booking.name.split(/\s+/)[0])}—</p><p>Thanks for reaching out. I cannot make this one work, but I appreciate the note.</p>` }).catch(() => undefined);
  return resultPage(request, env, "Declined", "The time is open again and the requester was notified.");
}
