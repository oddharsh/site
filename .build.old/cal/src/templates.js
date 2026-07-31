// HTML templates rendered by the Worker. Windows XP / Outlook Express
// visual theme — matches the resto-mod aesthetic of aadhar.sh. The CSS
// page-specific rules live inline; shared Luna window chrome comes from the
// cacheable /luna.css stylesheet.
//
// design vocab:
//   - .xp-window           outer panel, blue title bar + chrome buttons
//   - .title-bar        title strip with glossy gel min/max/close controls
//   - .content             inner workspace (white)
//   - .xp-group            sunken group-box ("Available slots", "Your info")
//   - .xp-day-label        day header in the slot list
//   - .slot-btn            individual time slot (raised → pressed when picked)
//   - input / textarea     sunken 3D look (dark TL, light BR)
//   - button.xp-button     raised 3D look (light TL, dark BR), pressed on :active
//
// Templates take an optional `env.BASE_PATH` so they can be mounted under
// /coffee on aadhar.sh as well as bare at cal.aadhar.sh. Form action +
// inline JS endpoints are prefixed with whatever path the request came
// in on; the router sets env.BASE_PATH per-request.

// The desktop partial the rest of the site ships. cal is staged beside holding/
// in .build with the same relative layout as the source tree, so this one path
// resolves in both. Emitted only under /coffee (see `onShell` in shell()): on
// the bare cal.aadhar.sh fallback the shell's links would be cross-origin and
// /nav.js 404s, so that host stays a standalone window, as it always has.
import { DESKTOP_CHROME, DESKTOP_TOP } from "../../holding/_worker.js/lib/desktop.js";

const STYLES = `
* { box-sizing: border-box; }

html {
  background: var(--face);
  color: var(--ink);
  -webkit-font-smoothing: subpixel-antialiased;
}
body {
  /* match the main site (aadhar.sh): Verdana first for the chunkier,
     period-correct sub-pixel rendering. Tahoma is the XP UI font but
     reads too "modern" on macOS (which falls back to Arial). Verdana
     is web-installed everywhere and gives the bolder 2003 weight. */
  font-family: var(--font-ui);
  font-size: 11pt;
  line-height: 1.4;
  margin: 0;
  padding: 24px 12px 48px;
  min-height: 100vh;
}

.window {
  max-width: 720px;
}
/* The coffee icon is page-specific; Luna owns the title strip and controls. */
.title-bar .icon {
  width: 14px; height: 14px; margin-right: 6px;
  background: var(--paper);
  border: 1px solid var(--blue-40);
  display: inline-block;
  position: relative;
  flex: 0 0 14px;
}
.title-bar .icon::before {
  content: "☕";
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 10px;
  filter: grayscale(0.2);
  text-shadow: none;
}

.content {
  background: var(--paper);
  /* sunken inner bevel */
  border-top:    1px solid var(--darkshadow);
  border-left:   1px solid var(--darkshadow);
  border-right:  1px solid var(--highlight);
  border-bottom: 1px solid var(--highlight);
  padding: 14px 18px 18px;
}

h1 {
  /* matches the aadhar.sh main-site h1 stack so the two pages feel
     like the same site visited at a different window. */
  font-family: var(--font-caption);
  font-size: 18pt;
  font-weight: bold;
  color: var(--blue-40);
  margin: 4px 0 8px;
  letter-spacing: -0.01em;
  text-wrap: balance;   /* horizon: even heading line breaks, no JS */
}
.lead {
  font-size: 10.5pt;
  color: oklch(38.67% 0 0);
  margin: 0 0 12px;
  text-wrap: pretty;    /* horizon: avoids orphans/ragged last line */
}

a { color: var(--link); text-decoration: underline; }
a:visited { color: var(--link-visited); }
a:hover { color: var(--link-hover); }

/* ── group boxes (Windows GroupBox controls) ────────────────────────── */
.xp-group {
  position: relative;
  border: 1px solid var(--shadow);
  border-radius: 0;
  padding: 14px 12px 12px;
  margin: 16px 0;
  background: var(--paper);
  /* inner inset */
  box-shadow:
    inset 1px 1px 0 oklch(94% 0.01 260),
    inset -1px -1px 0 oklch(100% 0 0);
}
.xp-group > .legend {
  position: absolute;
  top: -8px; left: 10px;
  background: var(--paper);
  padding: 0 6px;
  font-size: 10pt;
  font-weight: bold;
  color: var(--blue-40);
}

/* ── slot listing ───────────────────────────────────────────────────── */
.xp-meta {
  color: var(--ink-dim);
  font-size: 9.5pt;
  margin: 0 0 8px;
}
.xp-day-label {
  /* Tahoma isn't installed on macOS by default, so the previous stack
     fell back to Helvetica/Arial and read "Snow Leopard system" rather
     than "Windows XP UI". Trebuchet MS *is* installed on Mac and is
     period-correct (it was the Microsoft Office / Control Panel display
     font in the XP era). Verdana fallback for systems missing it. */
  font-family: var(--font-caption);
  font-weight: bold;
  font-size: 10pt;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--blue-40);
  margin: 14px 0 4px;
  padding-bottom: 2px;
  border-bottom: 1px dotted oklch(80% 0.03 240);
}
.xp-day-label:first-child { margin-top: 0; }
.slots {
  list-style: none;
  padding: 0;
  margin: 0 0 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px 4px;
}
.slots li { margin: 0; }
/* raised XP button look */
.slot-btn,
button.xp-button {
  display: inline-block;
  padding: 3px 12px;
  min-width: 70px;
  font-family: var(--font-ui);
  font-size: 10pt;
  color: var(--ink);
  background: linear-gradient(to bottom, oklch(99% 0 0) 0%, oklch(92% 0.005 240) 100%);
  border: 1px solid var(--shadow);
  border-radius: 0;
  cursor: pointer;
  /* raised bevel */
  box-shadow:
    inset 1px 1px 0 var(--highlight),
    inset -1px -1px 0 var(--shadow);
  font-variant-numeric: tabular-nums;
}
.slot-btn:hover,
button.xp-button:hover {
  background: linear-gradient(to bottom, oklch(99% 0.015 240) 0%, oklch(90% 0.03 240) 100%);
  border-color: var(--blue-65);
}
.slot-btn:active,
button.xp-button:active {
  background: linear-gradient(to bottom, oklch(88% 0.01 240), oklch(95% 0.005 240));
  box-shadow:
    inset 1px 1px 0 var(--shadow),
    inset -1px -1px 0 var(--highlight);
}
.slot-btn[aria-pressed="true"] {
  background: linear-gradient(to bottom, var(--blue-95), var(--blue-65));
  color: oklch(100% 0 0);
  border-color: var(--blue-40);
  box-shadow:
    inset 1px 1px 0 var(--blue-95),
    inset -1px -1px 0 var(--blue-40);
  font-weight: bold;
  text-shadow: 1px 1px 0 oklch(20% 0.05 260 / 0.6);
}

/* primary submit — XP "default" button highlight */
button.xp-button.primary {
  font-weight: bold;
  background: linear-gradient(to bottom, oklch(95% 0.06 100) 0%, oklch(86% 0.08 95) 100%);
  border-color: oklch(50% 0.10 95);
}
button.xp-button.primary:disabled,
button.xp-button:disabled {
  color: var(--ink-faint);
  background: linear-gradient(to bottom, oklch(95% 0 0), oklch(88% 0 0));
  border-color: oklch(75% 0 0);
  cursor: not-allowed;
  text-shadow: none;
}

/* ── form ───────────────────────────────────────────────────────────── */
form.book {
  margin-top: 4px;
}
form.book .row {
  margin: 8px 0;
  display: grid;
  grid-template-columns: 110px 1fr;
  align-items: center;
  gap: 8px;
}
form.book .row.stacked {
  grid-template-columns: 1fr;
  gap: 4px;
}
form.book label {
  font-size: 10pt;
  color: var(--ink);
}
form.book input[type="text"],
form.book input[type="email"],
form.book textarea {
  font-family: var(--font-ui);
  font-size: 10.5pt;
  padding: 3px 6px;
  background: oklch(100% 0 0);
  color: var(--ink);
  border: 1px solid var(--shadow);
  /* sunken (inset) — opposite of buttons */
  box-shadow:
    inset 1px 1px 0 oklch(70% 0.01 260),
    inset -1px -1px 0 oklch(100% 0 0);
  border-radius: 0;
  width: 100%;
}
form.book textarea { min-height: 5.5em; max-height: 40vh; resize: vertical; field-sizing: content; }  /* horizon: auto-grows with input, no JS */
form.book input:focus,
form.book textarea:focus {
  outline: none;
  border-color: var(--blue-65);
  box-shadow:
    inset 1px 1px 0 oklch(70% 0.01 260),
    inset -1px -1px 0 oklch(100% 0 0),
    0 0 0 1px var(--blue-95);
}
form.book .honeypot {
  position: absolute; left: -9999px; visibility: hidden;
}
form.book .actions {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

/* ── status banners (Outlook Express info bar) ──────────────────────── */
.banner {
  border: 1px solid oklch(75% 0.10 95);
  background: oklch(96% 0.06 100);
  padding: 8px 10px;
  font-size: 10pt;
  margin: 12px 0;
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.banner::before { content: "ⓘ"; color: var(--blue-65); font-weight: bold; flex: 0 0 auto; }
.banner.success { border-color: oklch(70% 0.13 145); background: oklch(95% 0.06 145); }
.banner.success::before { content: "✓"; color: oklch(50% 0.18 145); }
.banner.warn   { border-color: oklch(70% 0.13 50);  background: oklch(95% 0.06 80); }
.banner.warn::before   { content: "!"; color: oklch(55% 0.18 50);  }
.banner.error  { border-color: oklch(60% 0.20 25);  background: oklch(94% 0.04 25); }
.banner.error::before  { content: "✕"; color: oklch(50% 0.22 25);  }

.empty {
  color: var(--ink-dim);
  font-style: italic;
  margin: 14px 0;
}

/* ── status bar (footer chrome) ─────────────────────────────────────── */
.xp-statusbar {
  margin-top: 14px;
  font-size: 9pt;
  color: var(--ink-dim);
  border-top: 1px solid var(--shadow);
  padding-top: 6px;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
}
.xp-statusbar > span:nth-child(2) {
  /* center span (credit) gets a soft middle position; wraps below on
     narrow viewports where flex-wrap kicks in. */
  flex: 0 1 auto;
  text-align: center;
}

/* tighter on phones */
@media (max-width: 540px) {
  body { padding: 8px 4px 32px; }
  .content { padding: 10px 10px 12px; }
  form.book .row { grid-template-columns: 1fr; gap: 2px; }
  form.book label { font-size: 9.5pt; color: var(--ink-dim); text-transform: uppercase; letter-spacing: 0.04em; }
}
`;

// OS-window geometry — emitted only under aadhar.sh/coffee, where /nav.js is
// same-origin and turns this into a real desktop window (Bliss wallpaper,
// taskbar, draggable + resizable) like the garage. Inlined so FIRST PAINT
// matches nav.js (no shell "pop" when the deferred desktop arrives).
// On the cal.aadhar.sh fallback /nav.js 404s, so this is skipped and the page
// stays a standalone centered window (degrades cleanly).
//
// The painted taskbar placeholder that used to sit here (a body::after strip
// gradient, hand-kept "in sync with nav.js") is GONE: the page now ships the
// real DESKTOP_CHROME, so there is nothing to stand in for and nothing left to
// keep in sync by hand.
const SHELL_GEOMETRY = `
html { height: 100dvh; overflow: hidden; }
body { min-height: 0; height: calc(100vh - 30px); height: calc(100dvh - 30px);
  overflow: hidden; display: flex; flex-direction: column; align-items: center; padding: 8px; }
.window { flex: 0 1 auto; min-height: 0; max-height: 100%; display: flex; flex-direction: column; }
.window > .title-bar { flex: 0 0 auto; }
.window > .content { flex: 1 1 auto; min-height: 0; overflow: auto; padding-right: 12px; }
/* client edge — generated by build.mjs from luna.css */
.window > .content { border: 6px solid #ece9d8; background-clip: padding-box; outline: 1px solid #7f9db9; outline-offset: -6px; }
`;

// the coffee section glyph — mirrors nav.js SECTION_ICONS.coffee + the taskbar
// app button, so the tab favicon is right on first paint (and on cal.aadhar.sh,
// where nav.js never loads to set it). hex colors %23-encoded for the data URI.
const COFFEE_FAVICON = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%237a5230'/><path d='M8 12 h13 v6 a6.5 6.5 0 0 1-13 0 Z' fill='%23fff'/><path d='M21 13 h3 a2.6 2.6 0 0 1 0 5.2 h-3' fill='none' stroke='%23fff' stroke-width='2.2'/><g stroke='%23fff' stroke-width='1.8' stroke-linecap='round'><path d='M11 5.5 v3'/><path d='M14.5 5 v3.5'/></g></svg>";

function shell(title, body, env) {
  const home = env.HOST_PUBLIC_URL || "https://aadhar.sh";
  // Under aadhar.sh/coffee, /nav.js is same-origin → join the desktop shell.
  // On the bare cal.aadhar.sh fallback it isn't, so stay a standalone window.
  const onShell = (env.BASE_PATH || "") === "/coffee";
  const fullTitle = `${env.HOST_NAME}/coffee/${title}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#2D78BD">
<link rel="preload" as="style" href="https://aadhar.sh/a/luna.12fe1428.css">
<link rel="stylesheet" href="https://aadhar.sh/a/luna.12fe1428.css">
<title>${esc(fullTitle)}</title>
<meta name="description" content="let's grab coffee or a bagel with ${esc(env.HOST_NAME)} in NYC. requests are reviewed by hand.">
<link rel="icon" type="image/svg+xml" href="${COFFEE_FAVICON}">
<style>:root{--font-caption:"Trebuchet MS",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:"Courier New",Courier,monospace}${STYLES}${onShell ? SHELL_GEOMETRY : ""}</style>
</head>
<body>${onShell ? DESKTOP_TOP : ""}
<div class="window">
  <div class="title-bar" aria-hidden="true">
    <span class="title-text"><span class="icon"></span>${esc(fullTitle)}</span>
    <span class="controls"
      ><span class="min" title="minimize"></span
      ><span class="max" title="maximize"></span
      ><a class="close" href="${esc(home)}" title="close" aria-label="close, up to ${esc(env.HOST_NAME)}"></a
    ></span>
  </div>
  <div class="content">
    ${body}
    <div class="xp-statusbar">
      <span>← <a href="${esc(home)}">${esc(home.replace(/^https?:\/\//, ""))}</a></span>
      <span>page idea borrowed (with thanks) from <a href="https://jry.io/bagel" rel="external noopener">Jacob Young</a></span>
      <span>cloudflare workers · ${esc(env.HOST_TIMEZONE || "UTC").replace(/_/g, " ")}</span>
    </div>
  </div>
</div>${onShell ? `${DESKTOP_CHROME}
<script src="/a/nav.f1317f11.js" defer></script>` : ""}
</body>
</html>`;
}

export function bookingPage(slots, env) {
  const base = env.BASE_PATH || "";

  // group slots by local day (long weekday + month/day)
  const groups = {};
  for (const s of slots) {
    const dayKey = new Date(s.start).toLocaleDateString("en-US", {
      timeZone: env.HOST_TIMEZONE, weekday: "long", month: "long", day: "numeric",
    });
    (groups[dayKey] = groups[dayKey] || []).push(s);
  }

  const slotMarkup = Object.keys(groups).length === 0
    ? `<p class="empty">no open slots in the next ${esc(env.MAX_LOOKAHEAD_DAYS)} days. try again next week, or write to <a href="mailto:${esc(env.HOST_EMAIL)}">${esc(env.HOST_EMAIL)}</a>.</p>`
    : Object.entries(groups).map(([day, list]) => `
        <div class="xp-day-label">${esc(day)}</div>
        <ul class="slots">
          ${list.map(s => {
            const t = new Date(s.start).toLocaleTimeString("en-US", {
              timeZone: env.HOST_TIMEZONE, hour: "numeric", minute: "2-digit",
            });
            return `<li><button class="slot-btn" type="button" data-start="${s.start}" data-end="${s.end}" aria-pressed="false">${esc(t)}</button></li>`;
          }).join("")}
        </ul>
      `).join("");

  const body = `
    <h1>Let's grab coffee or a bagel</h1>
    <p class="lead">if you're in NYC and working on something interesting, pick a slot below. i confirm every request by hand, so nothing lands on your calendar until you see the confirmation email.</p>

    <div class="xp-group">
      <span class="legend">Available slots</span>
      <p class="xp-meta">times shown in ${esc((env.HOST_TIMEZONE || "UTC").replace(/_/g, " "))}.</p>
      ${slotMarkup}
    </div>

    <form class="book" id="bookform" method="POST" action="${esc(base)}/book" novalidate>
      <div class="xp-group">
        <span class="legend">Your info</span>
        <input type="hidden" name="start" id="start" value="">

        <div class="row">
          <label for="name">Name</label>
          <input type="text" id="name" name="name" required maxlength="100" autocomplete="name">
        </div>
        <div class="row">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required maxlength="200" autocomplete="email">
        </div>
        <div class="row stacked">
          <label for="topic">What would you like to talk about?</label>
          <textarea id="topic" name="topic" required maxlength="1000"
                    placeholder="A sentence or two — specific beats generic."></textarea>
        </div>

        <input type="text" name="website" class="honeypot" tabindex="-1" autocomplete="off" aria-hidden="true">

        <div class="actions">
          <button type="submit" class="xp-button primary" id="submit" disabled>pick a slot first</button>
        </div>
      </div>
    </form>

    <script>
    (function () {
      const buttons    = document.querySelectorAll(".slot-btn");
      const startInput = document.getElementById("start");
      const submit     = document.getElementById("submit");
      const fmt = (ms) => new Date(parseInt(ms, 10)).toLocaleString("en-US", {
        timeZone: ${JSON.stringify(env.HOST_TIMEZONE || "UTC")},
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
      buttons.forEach(b => b.addEventListener("click", () => {
        buttons.forEach(x => x.setAttribute("aria-pressed", "false"));
        b.setAttribute("aria-pressed", "true");
        startInput.value = b.dataset.start;
        submit.disabled = false;
        submit.textContent = "request " + fmt(b.dataset.start);
      }));
    })();
    </script>
  `;

  return shell("Coffee or a bagel", body, env);
}

export function successPage(env) {
  const body = `
    <h1>Request sent</h1>
    <div class="banner success">
      <div>
        <strong>thanks for writing.</strong> you should hear back from
        <strong>${esc(env.HOST_NAME)}</strong> within a day or two — usually faster.
      </div>
    </div>
    <p>if approved, you'll get a calendar invite at the email you provided.
       if declined, you'll get a short note.</p>
    <div class="banner warn">
      <div>nothing's on your calendar yet. don't block the time until you see the confirmation email.</div>
    </div>
  `;
  return shell("Request sent", body, env);
}

export function confirmedPage(booking, env, already) {
  const when = new Date(booking.start).toLocaleString("en-US", {
    timeZone: env.HOST_TIMEZONE, weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  const title = already ? "Already confirmed" : "Confirmed";
  const body = `
    <h1>${title}</h1>
    <div class="xp-group">
      <span class="legend">Booking</span>
      <p><strong>${esc(booking.name)}</strong> &lt;${esc(booking.email)}&gt;<br>
         <strong>${esc(when)}</strong></p>
      <p class="xp-meta">topic: ${esc(booking.topic)}</p>
    </div>
    <div class="banner success">
      <div>${already ? "you've already approved this booking." : "invite sent to the requester. you've been cc'd."}</div>
    </div>
  `;
  return shell(title, body, env);
}

export function declinedPage(booking, env, already) {
  const title = already ? "Already declined" : "Declined";
  const body = `
    <h1>${title}</h1>
    <div class="xp-group">
      <span class="legend">Booking</span>
      <p><strong>${esc(booking.name)}</strong> &lt;${esc(booking.email)}&gt;</p>
    </div>
    <div class="banner">
      <div>${already ? "you've already declined this booking." : "polite decline sent. the slot is free again."}</div>
    </div>
  `;
  return shell(title, body, env);
}

export function errorPage(message, env) {
  const base = env.BASE_PATH || "";
  const body = `
    <h1>Error</h1>
    <div class="banner error"><div>${esc(message)}</div></div>
    <p><a href="${esc(base) || "/"}">← try again</a></p>
  `;
  return shell("Error", body, env);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
