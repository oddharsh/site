// email.js — outbound transactional mail via Resend (resend.com).
// free tier: 3,000/month, 100/day. more than enough for personal coffee
// requests. switch to Postmark/SES later if volume changes.

const RESEND_API = "https://api.resend.com/emails";

export async function sendApprovalRequest(env, booking, approveUrl, declineUrl) {
  const { name, email, topic, start, end } = booking;
  const when = fmtRange(start, end, env.HOST_TIMEZONE);
  const html = `
    <p><strong>${esc(name)}</strong> &lt;${esc(email)}&gt; requested coffee.</p>
    <p><strong>when:</strong> ${esc(when)}<br>
       <strong>what about:</strong></p>
    <blockquote style="border-left:3px solid #888;padding-left:.8em;margin-left:0;color:#333">
      ${esc(topic).replace(/\n/g, "<br>")}
    </blockquote>
    <p>
      <a href="${approveUrl}" style="display:inline-block;padding:8px 14px;background:#0a0;color:#fff;text-decoration:none;border-radius:3px">approve &amp; send invite</a>
      &nbsp;&nbsp;
      <a href="${declineUrl}" style="display:inline-block;padding:8px 14px;background:#900;color:#fff;text-decoration:none;border-radius:3px">decline</a>
    </p>
    <p style="color:#888;font-size:12px">one-click. signed url; only you can use these.</p>
  `;
  return resendSend(env, {
    from:    `cal.aadhar.sh <noreply@aadhar.sh>`,
    to:      [env.HOST_EMAIL],
    subject: `☕ ${name} — ${shortWhen(start, env.HOST_TIMEZONE)}`,
    html,
    reply_to: email,   // hitting Reply goes to the requester directly
  });
}

export async function sendInvite(env, booking) {
  const { name, email, start, end, topic } = booking;
  const ics = buildICS(env, booking);
  const when = fmtRange(start, end, env.HOST_TIMEZONE);
  const html = `
    <p>hi ${esc(name.split(" ")[0] || name)} —</p>
    <p>confirmed for <strong>${esc(when)}</strong>.</p>
    <p>i'll send a calendar link or address closer to the day. meantime:
       the attached .ics file should add this to your calendar in one click.</p>
    <p>see you soon.<br>${esc(env.HOST_NAME)}</p>
  `;
  return resendSend(env, {
    from:    `${env.HOST_NAME} <${env.HOST_EMAIL}>`,
    to:      [email],
    cc:      [env.HOST_EMAIL],
    subject: `confirmed: ${env.EVENT_TITLE} — ${shortWhen(start, env.HOST_TIMEZONE)}`,
    html,
    attachments: [{
      filename:    "coffee.ics",
      content:     utf8ToBase64(ics),
      content_type: "text/calendar; method=REQUEST",
    }],
  });
}

export async function sendDecline(env, booking) {
  const { name, email } = booking;
  const html = `
    <p>hi ${esc(name.split(" ")[0] || name)} —</p>
    <p>thanks for reaching out about coffee. not going to be a fit
       right now, but i appreciate you writing. if context changes
       on either side, don't hesitate to reach out again.</p>
    <p>best,<br>${esc(env.HOST_NAME)}</p>
  `;
  return resendSend(env, {
    from:    `${env.HOST_NAME} <${env.HOST_EMAIL}>`,
    to:      [email],
    subject: `re: ${env.EVENT_TITLE}`,
    html,
  });
}

// exported: the root worker's webmention moderation mail reuses this exact
// transport (same key, same error posture) rather than opening a second one.
export async function resendSend(env, payload) {
  const r = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    console.error("resend error", r.status, body);
    throw new Error(`resend ${r.status}`);
  }
  return r.json();
}

// build a minimal RFC 5545 VEVENT, REQUEST method so it acts as an invite.
// recipient's mail client will offer "Add to Calendar" and (if they hit
// Accept) RSVP back to the host's address.
function buildICS(env, booking) {
  const { id, name, email, topic, start, end } = booking;
  const fmt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const uid = `${id}@cal.aadhar.sh`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//aadhar.sh//cal//EN",
    "METHOD:REQUEST",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${fmt(Date.now())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${escICS(env.EVENT_TITLE)}`,
    `DESCRIPTION:${escICS(`requested: ${topic}\n\nbooked via cal.aadhar.sh`)}`,
    `ORGANIZER;CN=${escICS(env.HOST_NAME)}:mailto:${env.HOST_EMAIL}`,
    `ATTENDEE;CN=${escICS(name)};RSVP=TRUE:mailto:${email}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  // RFC 5545 requires lines no longer than 75 octets, folded with CRLF + space.
  // for our short events this isn't usually triggered, but fold defensively.
  return lines.flatMap(foldLine).join("\r\n");
}
// fold to ≤75 OCTETS (not chars), and never split a code point — a topic with
// an emoji (☕) or accented name shouldn't be cut mid-character, which would
// corrupt it once the whole ICS is UTF-8 encoded for the attachment.
function foldLine(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return [line];
  const out = [];
  let cur = "", curBytes = 0, first = true;
  for (const ch of line) {                 // iterate by code point, not UTF-16 unit
    const chBytes = enc.encode(ch).length;
    const limit = first ? 75 : 74;          // continuation lines lead with a space (1 octet)
    if (curBytes + chBytes > limit) {
      out.push(first ? cur : " " + cur);
      first = false;
      cur = ch; curBytes = chBytes;
    } else {
      cur += ch; curBytes += chBytes;
    }
  }
  out.push(first ? cur : " " + cur);
  return out;
}
// base64 of the UTF-8 bytes. plain btoa() throws on any code point > 255, so a
// booking topic/name with an emoji or non-Latin char would otherwise make
// sendInvite throw — and since it runs in ctx.waitUntil, the confirmation email
// would silently never send.
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function escICS(s) {
  return String(s).replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
}

// ── formatting helpers ───────────────────────────────────────────────────
function fmtRange(start, end, tz) {
  const d = (ms) => new Date(ms).toLocaleString("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const t = (ms) => new Date(ms).toLocaleString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit",
  });
  // "Tuesday, May 14, 3:00 PM – 3:30 PM EDT"
  return `${d(start)} – ${t(end)}`;
}
function shortWhen(ms, tz) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: tz, month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
