// HTML templates rendered by the Worker. Windows XP / Outlook Express
// visual theme — matches the resto-mod aesthetic of aadhar.sh. The CSS
// lives inline so the page renders without a cross-origin fetch, and so
// the worker is a single bundle.
//
// design vocab:
//   - .xp-window           outer panel, blue title bar + chrome buttons
//   - .xp-title-bar        title strip with glossy gel min/max/close controls
//   - .xp-body             inner workspace (white)
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

const STYLES = `
:root {
  /* core XP palette — hand-mirrors design/tokens/colors.css (keep in sync) */
  --xp-blue-1:   oklch(41.92% 0.0962 250.51); /* dark navy edge ≈ --blue-40   */
  --xp-blue-2:   oklch(51% 0.225 263);        /* mid ≈ --blue-65 (title core) */
  --xp-blue-3:   oklch(70% 0.15 258);         /* bright ≈ --blue-95 (grad top)*/
  --xp-blue-4:   oklch(66% 0.09 263);         /* pale ≈ --blue-inactive       */
  --xp-tan:      oklch(92.5% 0.018 95);       /* ButtonFace #ECE9D8 ≈ --face  */
  --xp-paper:    oklch(99% 0.005 95);   /* workspace bg */
  --xp-edge-dk:  oklch(46% 0.02 260);   /* sunken dark edge */
  --xp-edge-md:  oklch(70% 0.02 260);   /* mid bevel */
  --xp-edge-lt:  oklch(99% 0 0);        /* raised light edge */
  --xp-edge-sh:  oklch(56% 0.02 260);   /* button shadow */
  --xp-text:     oklch(18% 0 0);
  --xp-dim:      oklch(50% 0 0);
  --xp-link:     oklch(40% 0.20 260);
  --xp-link-hov: oklch(58% 0.25 30);
  --xp-row-alt:  oklch(96% 0.01 240);   /* alternating row tint */
  --xp-disabled: oklch(80% 0 0);
}

* { box-sizing: border-box; }

html {
  background: var(--xp-tan);
  color: var(--xp-text);
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

/* ── window chrome ──────────────────────────────────────────────────── */
.xp-window {
  max-width: 720px;
  margin: 0 auto;
  background: var(--xp-tan);
  border: 1px solid var(--xp-blue-1);
  /* outer raised bevel */
  box-shadow:
    inset  1px  1px 0 var(--xp-blue-3),
    inset -1px -1px 0 var(--xp-blue-1),
    2px 2px 0 oklch(0% 0 0 / 0.18);
  padding: 3px;
}
/* title bar — mirrors the aadhar.sh main-site convention: a single
   gradient strip with a tiny icon block + the page title on the left,
   and three glossy gel control buttons (min/max/close) on the right.
   the glyphs are CSS-drawn (no text, no Marlett dependency), matching
   the canonical .title-bar .controls .min/.max/.close site-wide. */
.xp-title-bar {
  /* the canonical site-wide 5-stop title gradient (≈ --grad-title) */
  background:
    linear-gradient(
      180deg,
      oklch(70% 0.15 258)  0%,
      oklch(60% 0.20 261)  8%,
      oklch(51% 0.225 263) 18%,
      oklch(50% 0.225 263) 86%,
      oklch(58% 0.18 260)  100%
    );
  color: oklch(100% 0 0);
  font-family: var(--font-caption);
  font-weight: bold;
  font-size: 11pt;
  padding: 4px 5px 4px 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  text-shadow: 1px 1px 0 oklch(20% 0.05 260 / 0.6);
  user-select: none;
}
.xp-title-bar .icon { /* tiny app icon */
  width: 14px; height: 14px;
  background: var(--xp-paper);
  border: 1px solid var(--xp-blue-1);
  display: inline-block;
  position: relative;
  flex: 0 0 14px;
}
.xp-title-bar .icon::before {
  content: "☕";
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 10px;
  filter: grayscale(0.2);
  text-shadow: none;
}
.xp-title-bar .title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.xp-controls {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
/* authentic Luna caption buttons — 21px glossy "gel" lozenges with a top
   specular highlight + CSS-drawn white glyphs, ported from the main site.
   sRGB hex traced from the Luna .msstyles bitmap, kept as hex on purpose.
   min/max are blue; CLOSE is RED at rest. */
.xp-controls .min,
.xp-controls .max,
.xp-controls .close {
  position: relative; box-sizing: border-box;
  width: 21px; height: 21px; padding: 0; margin: 0;
  display: inline-block; overflow: hidden; font-size: 0; color: transparent;
  border: 1px solid #6696eb; border-radius: 3px;
  text-decoration: none; cursor: pointer; text-shadow: none;
  background-color: #3e73f5;
  background-image: linear-gradient(180deg, #5f8cf7 0%, #3a71f5 22%, #3e73f5 55%, #2a70f2 82%, #1045be 100%);
  transition: filter 60ms ease-out;
}
/* "wet plastic" gloss band over the top ~45% (close uses ::after for its X stroke) */
.xp-controls .min::after,
.xp-controls .max::after {
  content: ""; position: absolute; left: 0; right: 0; top: 0; height: 45%;
  background: linear-gradient(180deg, rgba(255,255,255,.55) 0%, rgba(255,255,255,.12) 70%, rgba(255,255,255,0) 100%);
  pointer-events: none; border-radius: 2px 2px 5px 5px;
}
.xp-controls .min:hover, .xp-controls .min:focus-visible,
.xp-controls .max:hover, .xp-controls .max:focus-visible {
  border-color: #8fb4ff; background-color: #4fa4ff;
  background-image: linear-gradient(180deg, #689bff 0%, #468aff 22%, #4fa4ff 55%, #3990fc 82%, #1858c8 100%);
  outline: none;
}
/* CLOSE = red at rest */
.xp-controls .close {
  border-color: #d8401c; background-color: #e45f3e;
  background-image: linear-gradient(180deg, #e8795f 0%, #e45f40 30%, #e45d3d 52%, #e2552a 80%, #ae3110 100%);
}
.xp-controls .close:hover, .xp-controls .close:focus-visible {
  border-color: #ff7a66; background-color: #ff957c;
  background-image: linear-gradient(180deg, #ff8b7d 0%, #ff7463 26%, #ff957c 55%, #fd7e64 82%, #d34936 100%);
  box-shadow: 0 0 4px rgba(255,120,96,.7); outline: none;
}
.xp-controls .min:active,
.xp-controls .max:active,
.xp-controls .close:active { filter: brightness(.9); }
/* white glyphs drawn with pseudo-elements */
.xp-controls .min::before {
  content: ""; position: absolute; left: 5px; right: 5px; bottom: 5px; height: 2px;
  background: #fff; box-shadow: 0 1px 0 rgba(0,0,0,.35);
}
.xp-controls .max::before {
  content: ""; position: absolute; left: 5px; top: 5px; width: 11px; height: 9px;
  box-sizing: border-box; border: 1px solid #fff; border-top-width: 2px;
  filter: drop-shadow(0 1px 0 rgba(0,0,0,.35));
}
.xp-controls .close::before,
.xp-controls .close::after {
  content: ""; position: absolute; left: 50%; top: 50%;
  width: 13px; height: 2px; margin: -1px 0 0 -6.5px; background: #fff;
  box-shadow: 0 1px 0 rgba(0,0,0,.35);
}
.xp-controls .close::before { transform: rotate(45deg); }
.xp-controls .close::after  { transform: rotate(-45deg); }

/* ── workspace body ─────────────────────────────────────────────────── */
.xp-body {
  background: var(--xp-paper);
  /* sunken inner bevel */
  border-top:    1px solid var(--xp-edge-dk);
  border-left:   1px solid var(--xp-edge-dk);
  border-right:  1px solid var(--xp-edge-lt);
  border-bottom: 1px solid var(--xp-edge-lt);
  padding: 14px 18px 18px;
}

h1 {
  /* matches the aadhar.sh main-site h1 stack so the two pages feel
     like the same site visited at a different window. */
  font-family: var(--font-caption);
  font-size: 18pt;
  font-weight: bold;
  color: var(--xp-blue-1);
  margin: 4px 0 8px;
  letter-spacing: -0.01em;
}
.lead {
  font-family: var(--font-caption);
  font-size: 10.5pt;
  color: var(--xp-dim);
  margin: 0 0 12px;
}

a { color: var(--xp-link); text-decoration: underline; }
a:hover { color: var(--xp-link-hov); }

/* ── group boxes (Windows GroupBox controls) ────────────────────────── */
.xp-group {
  position: relative;
  border: 1px solid var(--xp-edge-md);
  border-radius: 0;
  padding: 14px 12px 12px;
  margin: 16px 0;
  background: var(--xp-paper);
  /* inner inset */
  box-shadow:
    inset 1px 1px 0 oklch(94% 0.01 260),
    inset -1px -1px 0 oklch(100% 0 0);
}
.xp-group > .legend {
  position: absolute;
  top: -8px; left: 10px;
  background: var(--xp-paper);
  padding: 0 6px;
  font-size: 10pt;
  font-weight: bold;
  color: var(--xp-blue-1);
}

/* ── slot listing ───────────────────────────────────────────────────── */
.xp-meta {
  color: var(--xp-dim);
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
  color: var(--xp-blue-1);
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
  color: var(--xp-text);
  background: linear-gradient(to bottom, oklch(99% 0 0) 0%, oklch(92% 0.005 240) 100%);
  border: 1px solid var(--xp-edge-sh);
  border-radius: 0;
  cursor: pointer;
  /* raised bevel */
  box-shadow:
    inset 1px 1px 0 var(--xp-edge-lt),
    inset -1px -1px 0 var(--xp-edge-md);
  font-variant-numeric: tabular-nums;
}
.slot-btn:hover,
button.xp-button:hover {
  background: linear-gradient(to bottom, oklch(99% 0.015 240) 0%, oklch(90% 0.03 240) 100%);
  border-color: var(--xp-blue-2);
}
.slot-btn:active,
button.xp-button:active {
  background: linear-gradient(to bottom, oklch(88% 0.01 240), oklch(95% 0.005 240));
  box-shadow:
    inset 1px 1px 0 var(--xp-edge-md),
    inset -1px -1px 0 var(--xp-edge-lt);
}
.slot-btn[aria-pressed="true"] {
  background: linear-gradient(to bottom, var(--xp-blue-3), var(--xp-blue-2));
  color: oklch(100% 0 0);
  border-color: var(--xp-blue-1);
  box-shadow:
    inset 1px 1px 0 var(--xp-blue-3),
    inset -1px -1px 0 var(--xp-blue-1);
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
  color: var(--xp-disabled);
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
  color: var(--xp-text);
}
form.book input[type="text"],
form.book input[type="email"],
form.book textarea {
  font-family: var(--font-ui);
  font-size: 10.5pt;
  padding: 3px 6px;
  background: oklch(100% 0 0);
  color: var(--xp-text);
  border: 1px solid var(--xp-edge-md);
  /* sunken (inset) — opposite of buttons */
  box-shadow:
    inset 1px 1px 0 oklch(70% 0.01 260),
    inset -1px -1px 0 oklch(100% 0 0);
  border-radius: 0;
  width: 100%;
}
form.book textarea { min-height: 5.5em; resize: vertical; }
form.book input:focus,
form.book textarea:focus {
  outline: none;
  border-color: var(--xp-blue-2);
  box-shadow:
    inset 1px 1px 0 oklch(70% 0.01 260),
    inset -1px -1px 0 oklch(100% 0 0),
    0 0 0 1px var(--xp-blue-3);
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
.banner::before { content: "ⓘ"; color: var(--xp-blue-2); font-weight: bold; flex: 0 0 auto; }
.banner.success { border-color: oklch(70% 0.13 145); background: oklch(95% 0.06 145); }
.banner.success::before { content: "✓"; color: oklch(50% 0.18 145); }
.banner.warn   { border-color: oklch(70% 0.13 50);  background: oklch(95% 0.06 80); }
.banner.warn::before   { content: "!"; color: oklch(55% 0.18 50);  }
.banner.error  { border-color: oklch(60% 0.20 25);  background: oklch(94% 0.04 25); }
.banner.error::before  { content: "✕"; color: oklch(50% 0.22 25);  }

.empty {
  color: var(--xp-dim);
  font-style: italic;
  margin: 14px 0;
}

/* ── status bar (footer chrome) ─────────────────────────────────────── */
.xp-statusbar {
  margin-top: 14px;
  font-size: 9pt;
  color: var(--xp-dim);
  border-top: 1px solid var(--xp-edge-md);
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
  .xp-body { padding: 10px 10px 12px; }
  form.book .row { grid-template-columns: 1fr; gap: 2px; }
  form.book label { font-size: 9.5pt; color: var(--xp-dim); text-transform: uppercase; letter-spacing: 0.04em; }
}
`;

function shell(title, body, env) {
  const base = env.BASE_PATH || "";
  const home = env.HOST_PUBLIC_URL || "https://aadhar.sh";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(env.HOST_NAME)}/coffee/${esc(title)}</title>
<meta name="description" content="let's grab coffee or a bagel with ${esc(env.HOST_NAME)} in NYC. requests are reviewed by hand.">
<meta name="theme-color" content="#0858a3">
<style>:root{--font-caption:"Trebuchet MS",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:"Courier New",Courier,monospace}${STYLES}</style>
</head>
<body>
<div class="xp-window">
  <div class="xp-title-bar">
    <span class="icon" aria-hidden="true"></span>
    <span class="title">${esc(env.HOST_NAME)}/coffee/${esc(title)}</span>
    <span class="xp-controls"
      ><span class="min" title="minimize" aria-hidden="true"></span
      ><span class="max" title="maximize" aria-hidden="true"></span
      ><a class="close" href="${esc(home)}" title="close" aria-label="close, up to ${esc(env.HOST_NAME)}"></a
    ></span>
  </div>
  <div class="xp-body">
    ${body}
    <div class="xp-statusbar">
      <span>← <a href="${esc(home)}">${esc(home.replace(/^https?:\/\//, ""))}</a></span>
      <span>page idea borrowed (with thanks) from <a href="https://jry.io/bagel" rel="external noopener">Jacob Young</a></span>
      <span>cloudflare workers · ${esc(env.HOST_TIMEZONE || "UTC").replace(/_/g, " ")}</span>
    </div>
  </div>
</div>
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
    <h1>Let&rsquo;s grab coffee or a bagel</h1>
    <p class="lead">if you&rsquo;re in NYC and working on something interesting, pick a slot below. i confirm by hand &mdash; nothing lands on your calendar until you see the confirmation email.</p>

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
