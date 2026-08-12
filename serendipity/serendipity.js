// serendipity.js — "Serendipity, collective edition" rebuilt the aadhar.sh way:
// one self-contained Cloudflare-Worker module, server-rendered handwritten HTML
// with inline CSS, over Cloudflare D1 (env.SERENDIPITY_DB). Public read surface:
// "what events are good and who's going." Reached from _worker.js route() via:
//   if (path === "/serendipity" || path.startsWith("/serendipity/"))
//     return handleSerendipity(request, env, ctx);
//
// Self-contained on purpose (own Luna chrome, own helpers) so it lifts out into
// its own site later by flipping PREFIX to "".
//
// Phase 1: read-only HTML (dashboard, event detail, contribute/config page).
// Phase 2 adds cookie-paste + sync + enrich (form POST → 302). Phase 3 adds the
// /serendipity/mcp JSON-RPC tool surface over the same query layer below.

const PREFIX = "/serendipity";

// The desktop partial the rest of the site ships. serendipity is staged beside
// www/ in .build with the same relative layout as the source tree, so this
// one path resolves in both. Before this, /serendipity loaded /nav.js and let
// it CONSTRUCT the desktop after load: curl and JS-off visitors got no desktop
// at all, and everyone else got a shell pop. Now the markup is in the document
// and nav.js only wires behavior, same as every other page.
import { DESKTOP_CHROME, DESKTOP_TOP } from "../www/_worker.js/lib/desktop.js";
import { privateHostBlocked } from "../www/_worker.js/lib/crawl.js";
import { CACHE_EMPTY, CACHE_STATIC, mcpGate, mcpHttpStatus, mcpServer } from "../www/_worker.js/lib/mcp-protocol.js";
import { mcpTool } from "../www/_worker.js/lib/mcp-tools.js";
import { previewToolRefusal } from "../www/_worker.js/lib/preview.js";

// ── tiny helpers ────────────────────────────────────────────────────────────
const esc = (v) =>
  String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const html = (status, body) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

function banner(msg) {
  if (!msg) return "";
  const cls = /fail|error|missing|bad|invalid/i.test(msg) ? "err" : /synced|thanks|contributing|refreshed/i.test(msg) ? "ok" : "";
  return `<div class="banner ${cls}">${esc(msg)}</div>`;
}

// stable initials-avatar (no external images → CSP-clean + light). hue from name.
function avatar(name, size = 30) {
  const initials = (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase() || "?";
  let h = 0; for (const ch of (name || "")) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="ava" style="--ab:oklch(72% 0.13 ${h});width:${size}px;height:${size}px;font-size:${Math.round(size*0.4)}px" aria-hidden="true">${esc(initials)}</span>`;
}

function relativeTime(date) {
  // whole-days elapsed, via Temporal when the runtime ships it (enable_temporal
  // compat flag), else the plain epoch-ms delta. same output either way.
  let days;
  try {
    if (typeof Temporal !== "undefined" && date.toTemporalInstant) {
      days = Math.floor(Temporal.Now.instant().since(date.toTemporalInstant()).total({ unit: "hour" }) / 24);
    }
  } catch (e) {}
  if (days === undefined) days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 35) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function fmtDateTime(s) {
  if (!s) return "";
  /** @type {Intl.DateTimeFormatOptions} */
  const opt = { weekday: "short", month: "short", day: "numeric" };
  /** @type {Intl.DateTimeFormatOptions} */
  const topt = { hour: "numeric", minute: "2-digit" };
  // Temporal when available: a wall-clock string shows as recorded; an instant
  // shows in UTC (matching this Worker's clock). falls back to Date otherwise.
  try {
    if (typeof Temporal !== "undefined") {
      const z = s.replace(" ", "T");
      const pdt = /[zZ]|[+-]\d{2}:?\d{2}$/.test(z)
        ? Temporal.Instant.from(z).toZonedDateTimeISO("UTC").toPlainDateTime()
        : Temporal.PlainDateTime.from(z);
      return pdt.toLocaleString("en-US", opt) + " · " + pdt.toLocaleString("en-US", topt);
    }
  } catch (e) {}
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", opt) + " · " + d.toLocaleTimeString("en-US", topt);
}

// influence/seniority proxy — ported verbatim from the Next app's attendeeScore.
function attendeeScore(a) {
  let s = 0;
  const r = (a.role || "").toLowerCase();
  if (/\bfounder\b/.test(r)) s += 100;
  else if (/\b(ceo|cto|coo|cfo|cpo|cmo|cro|chief)\b/.test(r)) s += 90;
  else if (/\bpresident\b/.test(r)) s += 80;
  else if (/\b(vp|vice\s+president)\b/.test(r)) s += 70;
  else if (/\b(director|head)\b/.test(r)) s += 60;
  else if (/\b(manager|lead)\b/.test(r)) s += 40;
  else if (/\b(senior|staff|principal)\b/.test(r)) s += 30;
  else if (/\b(engineer|developer|designer|analyst)\b/.test(r)) s += 20;
  else if (/\b(intern|junior|student)\b/.test(r)) s += 5;
  else if (r.length) s += 15;
  if (a.twitter_handle) s += 15;
  if (a.linkedin_handle || a.linkedin_url) s += 5;
  if (a.website) s += 5;
  if (a.times_seen > 1) s += 20;
  if (a.enriched_at) s += 10;
  return s;
}

// ── identity: a long-lived per-browser uid cookie (Web Crypto, edge-native) ──
const UID_COOKIE = "serendipity-uid";
function readUid(request) {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)serendipity-uid=([0-9a-f]+)/);
  return m ? m[1] : null;
}
function mintUid() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function uidCookie(uid) {
  return `${UID_COOKIE}=${uid}; Path=${PREFIX}; HttpOnly; Secure; SameSite=Lax; Max-Age=63072000`;
}

// ── D1 access shim — keeps call sites as db.prepare(sql).all/get/run(...args) ─
const norm = (a) => a.map((v) => (v === undefined ? null : v));
function db(env) {
  const D = env.SERENDIPITY_DB;
  return {
    raw: D,
    // build a bound statement (for batching) without executing
    stmt: (sql, ...a) => D.prepare(sql).bind(...norm(a)),
    // run an array of bound statements in chunks (each chunk = ONE subrequest;
    // Cloudflare caps subrequests per invocation, so bulk writes MUST batch)
    async batch(stmts, size = 50) {
      for (let i = 0; i < stmts.length; i += size) await D.batch(stmts.slice(i, i + size));
    },
    prepare(sql) {
      const st = D.prepare(sql);
      return {
        get: (...a) => st.bind(...norm(a)).first(),
        all: (...a) => st.bind(...norm(a)).all().then((r) => r.results || []),
        run: (...a) => st.bind(...norm(a)).run(),
      };
    },
  };
}

// ── query layer — the SINGLE source of truth (HTML now; MCP + JSON reuse it) ─
async function queryEvents(d) {
  return d.prepare(
    `SELECT e.id, e.name, e.start_at, e.location, e.url, e.user_status, e.cover_url,
            SUM(CASE WHEN ea.is_host = 0 THEN 1 ELSE 0 END) AS attendee_count,
            SUM(CASE WHEN ea.is_host = 1 THEN 1 ELSE 0 END) AS host_count,
            (SELECT GROUP_CONCAT(label, char(31)) FROM (
               SELECT DISTINCT COALESCE(uc.label, 'unnamed-' || substr(ec.user_key,1,4)) AS label
                 FROM event_contributions ec
                 LEFT JOIN user_cookies uc ON uc.user_key = ec.user_key
                WHERE ec.event_id = e.id)) AS contributors
       FROM events e
       LEFT JOIN event_attendees ea ON ea.event_id = e.id
      GROUP BY e.id
      ORDER BY e.start_at ASC`
  ).all();
}
async function queryEvent(d, id) {
  return d.prepare(`SELECT id, name, description, start_at, end_at, location, url, ticket_key, user_status FROM events WHERE id = ?`).get(id);
}
async function queryEventAttendees(d, id) {
  return d.prepare(
    `SELECT a.id AS attendee_id, a.name, a.bio_short,
            (SELECT COUNT(*) FROM event_attendees seen WHERE seen.attendee_id = a.id) AS times_seen,
            ea.is_host,
            a.website, a.twitter_handle, a.linkedin_handle, a.instagram_handle,
            en.company, en.role, en.bio AS enriched_bio, en.location,
            en.linkedin_url, en.enriched_at
       FROM event_attendees ea
       JOIN attendees a ON a.id = ea.attendee_id
       LEFT JOIN enrichments en ON en.attendee_id = a.id
      WHERE ea.event_id = ?`
  ).all(id);
}
async function queryContributors(d, id) {
  return d.prepare(
    `SELECT label, MAX(enabled) AS enabled FROM (
       SELECT COALESCE(uc.label, 'unnamed-' || substr(ec.user_key,1,4)) AS label,
              COALESCE(uc.enabled, 0) AS enabled, ec.contributed_at
         FROM event_contributions ec
         LEFT JOIN user_cookies uc ON uc.user_key = ec.user_key
        WHERE ec.event_id = ?)
      GROUP BY label
      ORDER BY MAX(contributed_at) DESC`
  ).all(id);
}
async function countContributors(d) {
  const r = await d.prepare(`SELECT COUNT(*) AS n FROM user_cookies WHERE enabled = 1`).get();
  return r ? Number(r.n) : 0;
}

// ── page shell: shared Luna chrome plus serendipity-specific layout ─────────
function shellCss() {
  return `
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;min-height:100%}
  /* NO -webkit-font-smoothing: the rest of the site renders at the browser
     default (auto/subpixel) for period-correct heavier text. serendipity was the
     only page forcing antialiased, which thinned the SHARED nav.js taskbar/clock
     it inherits — a visibly lighter clock here. It also caused a weight-swap
     flash of the clock + tray sleeve on every nav into/out of this page, back
     when a View Transition pinned the old taskbar snapshot against the live new
     one; that transition is gone, the mismatch reason is not. Match the site. */
  body{font-family:var(--font-ui);font-size:12px;line-height:1.5;color:oklch(16% 0 0);font-variant-numeric:tabular-nums;text-wrap:pretty}
  a{color:oklch(42% 0.235 264);text-decoration:underline}
  a:hover{color:oklch(60% 0.25 29)}
  h1,h2,h3{font-family:var(--font-caption);margin:0}
  .wrap{max-width:980px;padding:22px 12px 48px}
  /* windows are resizable now, so stack the master-detail on WINDOW width, not
     just viewport. container query keys on .window; the @media below stays as the
     viewport / no-container-support fallback. */
  .window{container:serendipity-win / inline-size}
  .body{display:flex;min-height:520px}
  @container serendipity-win (max-width:560px){.body{flex-direction:column}.pane{width:auto;border-right:0;border-bottom:2px solid #7a96c8}}
  /* under the shared OS-window model nav.js scrolls .window>.body; for this
     master-detail layout, scroll the main .content instead so the sidebar
     fills the full window height (no mid-scroll cutoff / "weird spot"). */
  .window>.body{overflow:hidden !important}
  .body>.content{overflow:auto;min-height:0}
  .pane{width:200px;flex:0 0 auto;border-right:2px solid #7a96c8;background:linear-gradient(180deg,oklch(90% 0.055 245),oklch(93% 0.038 245));padding:12px}
  .pane .brand{display:block;padding:2px 4px 10px;color:oklch(16% 0 0);text-decoration:none}
  .pane .brand b{font:600 16pt var(--font-caption);display:block;line-height:1}
  .pane .brand span{font-size:10px;color:oklch(45% 0.01 250)}
  .pane-head{font:bold 8.5pt var(--font-caption);color:#fff;padding:3px 10px;border-radius:3px 3px 0 0;text-shadow:0 1px 1px rgba(0,30,90,.5);background:linear-gradient(180deg,oklch(66% 0.16 255),oklch(54% 0.20 260))}
  .pane-body{border:1px solid #bcd0ec;border-top:0;background:rgba(255,255,255,.55);padding:4px;display:flex;flex-direction:column}
  .pane-body a{padding:3px 8px;border-radius:0;text-decoration:none;color:oklch(42% 0.235 264)}
  .pane-body a:hover{background:#2f6fde;color:#fff}
  .pane-body a.current{background:#3a6ea5;color:#fff;font-weight:bold}
  .pane .foot{margin-top:14px;padding-top:8px;border-top:1px solid #a8c0e0;font-size:10px;color:oklch(45% 0.01 250)}
  .content{flex:1;min-width:0;padding:22px 26px}
  h1.page{font-size:19pt;font-weight:bold;color:oklch(33% 0.10 255);margin:0 0 2px;letter-spacing:-.01em}
  .lede{color:oklch(40% 0.01 250);font-size:11px;margin:0 0 16px;max-width:62ch}
  hr.sep{border:0;border-top:1px solid oklch(85% 0.03 250);margin:14px 0}
  .grp{font:bold 8.5pt var(--font-caption);text-transform:uppercase;letter-spacing:.06em;color:oklch(45% 0.02 255);margin:18px 0 8px}
  /* event card — sunken-bevel list item */
  .ev{display:block;text-decoration:none;color:inherit;border:1px solid oklch(80% 0.035 250);border-top-color:oklch(70% 0.05 250);border-left-color:oklch(70% 0.05 250);background:#fff;padding:10px 12px;margin:0 0 7px;border-radius:0;content-visibility:auto;contain-intrinsic-size:auto 66px}
  .ev:hover{border-color:oklch(50% 0.18 263);background:oklch(98% 0.02 250)}
  .ev .nm{font-weight:bold;color:oklch(20% 0.02 255);font-size:13px}
  .ev .meta{color:oklch(45% 0.01 250);font-size:11px;margin-top:2px}
  .ev .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
  .count{font-size:11px;color:oklch(42% 0.02 255)}
  .badge{display:inline-block;font:bold 9px var(--font-ui);padding:1px 6px;border:1px solid;border-radius:0;text-transform:uppercase;letter-spacing:.04em}
  .badge.via{background:oklch(96% 0.02 250);color:oklch(42% 0.03 255);border-color:oklch(80% 0.04 250);font-weight:normal;text-transform:none}
  .badge.past{background:oklch(95% 0 0);color:oklch(45% 0 0);border-color:oklch(78% 0 0)}
  .badge.browsed{background:oklch(95% 0.03 75);color:oklch(46% 0.08 60);border-color:oklch(83% 0.06 75);font-weight:normal;text-transform:none}
  .ev.disc{opacity:.5;background:oklch(98.5% 0 0)}
  .ev.disc:hover{opacity:1}
  /* attendee row */
  .alist{border:1px solid oklch(80% 0.035 250);border-radius:0;background:#fff}
  .att{display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid oklch(92% 0.02 250)}
  .att:first-child{border-top:0}
  .ava{display:inline-flex;align-items:center;justify-content:center;border-radius:0;background:var(--ab);color:#fff;font-weight:bold;flex:0 0 auto;text-shadow:0 1px 1px rgba(0,0,0,.3)}
  /* contrast-color() (Safari 26 + Firefox) auto-picks black/white per hue — fixes
     low-contrast white initials on light hues (yellow/green ~90-150). Chrome lacks
     it today, so it falls back to the #fff above. */
  @supports (color: contrast-color(red)){ .ava{ color:contrast-color(var(--ab)); text-shadow:none } }
  /* event description, collapsed-but-findable. hidden="until-found" keeps the text
     in the DOM (Ctrl-F + #:~:text= deep-links auto-reveal it on Chrome/Safari) while
     the page stays compact; the button is the manual reveal. The state leaves a
     generated box in layout, so strip its chrome until the browser removes hidden. */
  .evdesc{white-space:pre-wrap;margin:0 0 16px;padding:10px 12px;background:oklch(98% 0.005 250);border:1px solid oklch(85% 0.015 250);border-radius:0;font-size:12px;color:oklch(28% 0.01 250);max-width:64ch}
  .evdesc[hidden="until-found"]{margin:0;padding:0;border:0}
  .att .who{min-width:0;flex:1}
  .att .who .n{font-weight:bold;color:oklch(20% 0.02 255)}
  .att .who .sub{font-size:11px;color:oklch(45% 0.01 250);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .att .soc{display:flex;gap:6px;flex:0 0 auto}
  .att .soc a{font-size:10px}
  .empty{text-align:center;color:oklch(50% 0.01 250);padding:34px 12px;border:1px dashed oklch(78% 0.04 250);border-radius:0;background:oklch(98% 0.01 250)}
  .xp-button{display:inline-block;min-width:73px;padding:4px 14px;font:8pt/1.3 var(--font-ui);color:#000;cursor:pointer;border:1px solid #8e9dad;border-radius:0;text-decoration:none;background:linear-gradient(180deg,#fff,#fdfdfd 45%,#f3f2ec 55%,#e9e7dc)}
  .xp-button:hover{border-color:#e9994a;box-shadow:inset 0 0 0 1px #fdd78b,0 0 3px 1px rgba(255,199,60,.55)}
  .xp-button.primary{color:#fff;border-color:#2c4d7e;font-weight:bold;background:linear-gradient(180deg,#5b9bf0,#3f81e8 12%,#2f6fde 50%,#2a64d4 88%,#2a60cc)}
  .note{font-size:11px;color:oklch(42% 0.01 250)}
  code{font-family:var(--font-mono);font-size:11px;background:oklch(96% 0.01 250);border:1px solid oklch(88% 0.02 250);padding:0 3px;border-radius:0}
  ol.steps{margin:8px 0;padding-left:20px}ol.steps li{margin:4px 0}
  .xp-field{box-sizing:border-box;width:100%;font-family:var(--font-ui);font-size:11px;color:#181818;background:#fff;padding:5px 7px;border:1px solid #7f9db9;border-radius:0;box-shadow:inset 1px 1px 0 rgba(0,0,0,.18),inset -1px -1px 0 #fff;margin:0 0 8px}
  .xp-field:focus{outline:none;border-color:#316ac5;box-shadow:inset 1px 1px 0 rgba(0,0,0,.18),inset -1px -1px 0 #fff,0 0 0 1px #316ac5}
  /* field-sizing:content (Chrome + Safari 26) auto-grows the textarea as the cookie
     JSON is pasted, capped so a huge blob can't run off-screen; resize stays manual. */
  textarea.xp-field{font-family:var(--font-mono);resize:vertical;field-sizing:content;min-height:6lh;max-height:60vh}
  .banner{margin:0 0 14px;padding:8px 12px;border:1px solid oklch(62% 0.10 250);background:oklch(95% 0.04 250);border-radius:0;font-size:11px;color:oklch(32% 0.08 250)}
  .banner.ok{border-color:oklch(60% 0.12 145);background:oklch(95% 0.05 145);color:oklch(30% 0.10 145)}
  .banner.err{border-color:oklch(58% 0.16 28);background:oklch(96% 0.04 28);color:oklch(40% 0.16 28)}
  .connected{border:1px solid oklch(60% 0.12 145);background:oklch(96% 0.04 145);border-radius:0;padding:10px 12px;margin:0 0 14px;font-size:11px;color:oklch(28% 0.08 145)}
  /* browse toolbar — client-side search + date-filter chips over the rendered list */
  .toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 14px}
  .toolbar .search{flex:1;min-width:170px;margin:0}
  .chips{display:flex;gap:4px;flex-wrap:wrap}
  .chip{font:8.5pt var(--font-ui);padding:3px 11px;border:1px solid #8e9dad;border-radius:0;background:linear-gradient(180deg,#fff,#f3f2ec);color:#222;cursor:pointer}
  .chip.on{color:#fff;border-color:#2c4d7e;font-weight:bold;background:linear-gradient(180deg,#5b9bf0,#2f6fde 60%,#2a60cc)}
  .ev[hidden],.grp[hidden]{display:none}
  .empty-filter{display:none;color:oklch(50% 0.01 250);padding:24px 12px;border:1px dashed oklch(78% 0.04 250);border-radius:0;background:oklch(98% 0.01 250);text-align:center;font-size:11px}
  /* cursor-following cover tooltip, driven by the shared engine in /hoist.js.
     --x/--y are typed <length> so the translate() positions it with no JS rAF; clamp
     keeps it on-screen. only events with a cover_url get one. The engine owns
     WHEN it shows; this owns what it looks like. */
  @property --x { syntax:"<length>"; inherits:false; initial-value:0px }
  @property --y { syntax:"<length>"; inherits:false; initial-value:0px }
  /* the margin/padding/border/background/inset resets undo the UA popover
     defaults (which set inset:0 and a solid border box); without them the cover
     picks up a stray frame and an off-by-a-corner start position. */
  #ev-tip{position:fixed;z-index:9999;top:0;left:0;right:auto;bottom:auto;display:none;pointer-events:none;
    margin:0;padding:0;border:0;background:none;overflow:visible;width:auto;height:auto;
    transform:translate(clamp(4px,calc(var(--x) + 18px),calc(100vw - 100% - 8px)),clamp(4px,calc(var(--y) + 18px),calc(100vh - 100% - 8px)))}
  /* popover path: the top layer is what stops a cover from being clipped by the
     scrolling content pane. Engines without :popover-open keep the display:none
     above and the engine's inline display:block fallback drives them instead. */
  @supports selector(:popover-open){
    #ev-tip:popover-open{display:block}
    #ev-tip.anchored:popover-open{transition:opacity 120ms ease-out}
    @starting-style{ #ev-tip.anchored:popover-open{opacity:0} }
  }
  /* keyboard focus tethers instead of tracking (there is no cursor to follow) */
  #ev-tip.anchored{position-anchor:--ev-tip;position-area:bottom span-right;
    top:auto;left:auto;transform:none;margin:6px 0 0;
    position-try-fallbacks:flip-block,flip-inline}
  /* show the WHOLE banner — fixed width, natural aspect (no crop): Luma covers
     often place text/faces near an edge that object-fit:cover would chop. height:
     auto follows the image; max-height caps a rare portrait cover, with contain
     letterboxing inside it (bg fills) rather than distorting. */
  #ev-tip img{display:block;width:300px;height:auto;max-height:340px;object-fit:contain;background:oklch(94% 0.005 240);border:3px solid #fff;outline:1px solid oklch(61% 0.061 253);outline-offset:-1px;box-shadow:2px 3px 12px -2px rgba(0,20,90,.55)}
  @media(max-width:640px){.body{flex-direction:column}.pane{width:auto;border-right:0;border-bottom:2px solid #7a96c8}}
}`;
}

function shell(title, currentPath, bodyHtml) {
  const nav = (href, label) => {
    const full = PREFIX + href;
    const cur = currentPath === full || (href !== "" && currentPath.startsWith(full));
    return `<a href="${full || PREFIX}"${cur ? ' class="current"' : ""}>${label}</a>`;
  };
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#2D78BD">
<title>${currentPath === PREFIX ? "aadhar.sh/serendipity" : "aadhar.sh/serendipity/" + esc(title)}</title>
<meta name="description" content="A public, shared database of events worth going to and who's going — fed by the collective, queryable by humans and agents.">
<style>:root{--font-caption:"Trebuchet MS",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:"Courier New",Courier,monospace}${shellCss()}</style>
<link rel="preload" as="style" href="/luna.css"><link rel="stylesheet" href="/luna.css"></head><body>${DESKTOP_TOP}
<div class="wrap"><div class="window">
  <div class="title-bar"><span class="title-text"><span class="icon" aria-hidden="true"></span>aadhar.sh/serendipity</span>
    <span class="controls"><a class="close" href="/" title="back to aadhar.sh" aria-label="back to aadhar.sh"></a></span>
  </div>
  <div class="body">
    <nav class="pane">
      <a class="brand" href="${PREFIX}"><b>Serendipity</b><span>collective edition</span></a>
      <div class="pane-head">Places</div>
      <div class="pane-body">
        ${nav("", "Events")}
        ${nav("/contribute", "Contribute")}
        ${nav("/mcp-info", "For agents")}
      </div>
      <div class="foot">
        A public pool of events + who&apos;s going.<br>Search by <a href="https://exa.ai" rel="noopener">Exa</a>.<br>Built by <a href="https://x.com/oddhash" rel="noopener">@oddhash</a>.
      </div>
    </nav>
    <main class="content">${bodyHtml}</main>
  </div>
</div></div>${DESKTOP_CHROME}
  <script src="/nav.js" defer></script>
</body></html>`;
}

// ── pages ────────────────────────────────────────────────────────────────────
function eventCard(e, isPast) {
  // split on the GROUP_CONCAT delimiter (char 31 / unit separator), which can't
  // occur in a label — a plain ", " split shredded any label containing a comma.
  const contributors = (e.contributors || "").split("\x1f").filter(Boolean);
  // first-class = a contributor actually RSVP'd / hosts (user_status 'going');
  // everything else was synced from browsing a feed — demote it (dimmed + a
  // "browsed" badge) so the real events stand out.
  const going = e.user_status === "going";
  const counts = [];
  if (Number(e.host_count) > 0) counts.push(`${e.host_count} host${e.host_count == 1 ? "" : "s"}`);
  if (Number(e.attendee_count) > 0) counts.push(`${e.attendee_count} going`);
  const d = e.start_at ? new Date(e.start_at) : null;
  return `<a class="ev${going ? "" : " disc"}" data-tier="${going ? "going" : "browsed"}" href="${PREFIX}/event/${esc(e.id)}" data-start="${esc(e.start_at || "")}"${e._coverHref ? ` data-cover="${esc(e._coverHref)}"` : ""}>
    <div class="nm">${esc(e.name)}</div>
    <div class="meta">${d ? esc(fmtDateTime(e.start_at)) : "date TBD"}${isPast && d ? ` · ${esc(relativeTime(d))}` : ""}${e.location ? " · " + esc(e.location) : ""}</div>
    <div class="row">
      ${going ? "" : `<span class="badge browsed" title="synced from a browsed feed — not RSVP'd">browsed</span>`}
      ${counts.length ? `<span class="count">${counts.join(" · ")}</span>` : `<span class="count" style="color:oklch(60% 0 0)">${going ? "no guest list yet" : "not RSVP&rsquo;d"}</span>`}
      ${contributors.slice(0, 3).map((c) => `<span class="badge via">via ${esc(c)}</span>`).join("")}
      ${contributors.length > 3 ? `<span class="count">+${contributors.length - 3}</span>` : ""}
    </div>
  </a>`;
}

// client-side dashboard interactivity: live search, date-filter chips, and the
// cursor-following cover tooltip (homepage idiom). all over the rendered cards —
// no extra requests, works with the 60s edge-cached HTML.
const DASHBOARD_JS = `
(function(){
  var cards=[].slice.call(document.querySelectorAll('.ev'));
  var grps=[].slice.call(document.querySelectorAll('.grp[data-grp]'));
  var search=document.getElementById('ev-search'), chips=document.getElementById('ev-chips');
  var none=document.getElementById('ev-none'), tip=document.getElementById('ev-tip'), when='all';
  function isWeekend(s,now){ if(s<now||s>now+8*864e5)return false; var w=new Date(s).getDay(); return w===0||w===6; }
  function apply(){
    var q=((search&&search.value)||'').trim().toLowerCase(), now=Date.now(), wk=now+7*864e5, shown=0;
    cards.forEach(function(c){
      var okq=!q||c.textContent.toLowerCase().indexOf(q)!==-1;
      var s=c.dataset.start?new Date(c.dataset.start).getTime():NaN, okw=true;
      if(when==='week')okw=!isNaN(s)&&s>=now&&s<=wk;
      else if(when==='weekend')okw=!isNaN(s)&&isWeekend(s,now);
      var v=okq&&okw; c.hidden=!v; if(v)shown++;
    });
    grps.forEach(function(g){
      var any=false,n=g.nextElementSibling;
      while(n&&!(n.classList&&n.classList.contains('grp'))){ if(n.classList&&n.classList.contains('ev')&&!n.hidden){any=true;break;} n=n.nextElementSibling; }
      g.hidden=!any;
    });
    if(none)none.style.display=shown?'none':'block';
  }
  if(search)search.addEventListener('input',apply);
  if(chips)chips.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('.chip'); if(!b)return;
    when=b.getAttribute('data-when');
    [].forEach.call(chips.children,function(c){c.classList.toggle('on',c===b);});
    apply();
  });
  // the cover tooltip runs on the SHARED hover engine (/hoist.js) that the
  // homepage photo/track/artist tips use. This was a hand-ported copy whose own
  // comment asked the next editor to keep TIP_DISMISS_MS in sync with the
  // homepage by hand, and it had already drifted from the original on three
  // counts: no popover hoist (so it was clippable and got no fade), no keyboard
  // path, no will-change lifecycle. It gains all three here. Deferred import,
  // because a hover nicety must never sit in front of the event list rendering.
  if(tip&&!matchMedia('(hover: none)').matches){
    import('/hoist.js').then(function(m){
      m.createHoist({
        node: tip,
        anchorName: '--ev-tip',
        findTarget: function(el){ return (el&&el.closest&&el.closest('.ev[data-cover]'))||null; },
        contentFor: function(a){
          var u=a.getAttribute('data-cover');
          return u ? '<img decoding="async" alt="" src="'+u.replace(/"/g,'&quot;')+'">' : '';
        }
      });
    }).catch(function(){});   // no covers is a fine outcome; the list still works
  }
})();
`;

async function renderDashboard(d, path, msg, env) {
  const [events, contribCount] = await Promise.all([queryEvents(d), countContributors(d)]);
  let body;
  if (!events.length) {
    body = `<h1 class="page">Events</h1>
      <p class="lede">A public, collective database of events worth going to and who&apos;s showing up. Anyone can contribute their Luma feed into the shared pool.</p>
      <div class="empty">
        <p style="font-size:14px;margin:0 0 6px"><b>The pool is empty.</b></p>
        <p class="note">No one has contributed events yet. <a href="${PREFIX}/contribute">Contribute your Luma feed</a> to seed it.</p>
      </div>`;
  } else {
    const now = Date.now();
    const PAST_CAP = 30;  // past-event cards were ~88% of the payload, mostly unscrolled
    // stable: surface RSVP'd ('going') events first within each section, so the
    // real events lead and a past one isn't buried below the cap by the browsed pile.
    const goingFirst = (arr) => arr.slice().sort((a, b) => Number(b.user_status === "going") - Number(a.user_status === "going"));
    const upcoming = events.filter((e) => !e.start_at || new Date(e.start_at).getTime() >= now);
    const pastAll = events.filter((e) => e.start_at && new Date(e.start_at).getTime() < now)
                          .sort((a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime());
    const past = goingFirst(pastAll).slice(0, PAST_CAP);
    // sign the cover-proxy URL for every card we actually render (upcoming + the
    // capped past slice) — not all of pastAll. eventCard reads e._coverHref.
    await Promise.all(
      [...upcoming, ...past].filter((e) => e.cover_url).map(async (e) => { e._coverHref = await coverProxyUrl(e.cover_url, env); })
    );
    body = `<h1 class="page">Events</h1>
      <p class="lede">${events.length} event${events.length == 1 ? "" : "s"} in the pool, fed by ${contribCount} contributor${contribCount == 1 ? "" : "s"}. Click any event to see who&apos;s going.</p>
      <div class="toolbar">
        <input class="xp-field search" id="ev-search" type="search" placeholder="Search events, places, contributors…" autocomplete="off">
        <div class="chips" id="ev-chips">
          <button type="button" class="chip on" data-when="all">All</button>
          <button type="button" class="chip" data-when="week">This week</button>
          <button type="button" class="chip" data-when="weekend">This weekend</button>
        </div>
      </div>
      ${upcoming.length ? `<div class="grp" data-grp>Upcoming (${upcoming.length})</div>${goingFirst(upcoming).map((e) => eventCard(e, false)).join("")}` : ""}
      ${pastAll.length ? `<div class="grp" data-grp>Past ${pastAll.length > PAST_CAP ? `(${PAST_CAP} of ${pastAll.length})` : `(${pastAll.length})`}</div>${past.map((e) => eventCard(e, true)).join("")}` : ""}
      <p class="empty-filter" id="ev-none">No events match — clear the search or pick a wider range.</p>
      <div id="ev-tip" popover="manual" aria-hidden="true"></div>
      <script>${DASHBOARD_JS}</script>`;
  }
  return html(200, shell("Events", path, banner(msg) + body));
}

function attendeeRow(a) {
  const sub = [a.role, a.company].filter(Boolean).join(" · ") || a.bio_short || (a.location ? `📍 ${a.location}` : "");
  const soc = [];
  if (a.twitter_handle) soc.push(`<a href="https://x.com/${esc(a.twitter_handle.replace(/^@/, ""))}" rel="noopener external">𝕏</a>`);
  if (a.linkedin_url) soc.push(`<a href="${esc(a.linkedin_url)}" rel="noopener external">in</a>`);
  else if (a.linkedin_handle) soc.push(`<a href="https://linkedin.com/in/${esc(a.linkedin_handle)}" rel="noopener external">in</a>`);
  if (a.website) soc.push(`<a href="${esc(a.website)}" rel="noopener external">web</a>`);
  return `<div class="att">${avatar(a.name)}
    <div class="who"><div class="n">${esc(a.name)}${a.times_seen > 1 ? ` <span class="count" title="seen at ${a.times_seen} events">×${a.times_seen}</span>` : ""}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div>
    ${soc.length ? `<div class="soc">${soc.join("")}</div>` : ""}</div>`;
}

async function renderEvent(d, id, path) {
  // all three reads in parallel — one fewer serial D1 round-trip per view. the
  // attendee/contributor reads run even on a 404 (rare), worth it for the common case.
  const [ev, rows, contributors] = await Promise.all([queryEvent(d, id), queryEventAttendees(d, id), queryContributors(d, id)]);
  if (!ev) {
    return html(404, shell("Not found", path, `<h1 class="page">Event not found</h1><p class="lede">No event with that id is in the pool.</p><p><a class="xp-button" href="${PREFIX}">&larr; All events</a></p>`));
  }
  const hosts = rows.filter((a) => a.is_host);
  const guests = rows.filter((a) => !a.is_host).map((a) => ({ ...a, _s: attendeeScore(a) }))
                     .sort((a, b) => b._s - a._s || a.name.localeCompare(b.name));
  const d0 = ev.start_at ? new Date(ev.start_at) : null;
  const lumaUrl = ev.url || (ev.id ? `https://lu.ma/${esc(ev.id)}` : null);
  const body = `
    <p style="margin:0 0 10px"><a href="${PREFIX}">&larr; All events</a></p>
    <h1 class="page">${esc(ev.name)}</h1>
    <p class="lede">${d0 ? esc(fmtDateTime(ev.start_at)) : "date TBD"}${ev.location ? " · " + esc(ev.location) : ""}${lumaUrl ? ` · <a href="${esc(lumaUrl)}" rel="noopener external">View on Luma ↗</a>` : ""}</p>
    ${contributors.length ? `<div class="row" style="display:flex;gap:6px;flex-wrap:wrap;margin:-8px 0 14px"><span class="grp" style="margin:0">Contributed by</span>${contributors.map((c) => `<span class="badge via"${Number(c.enabled) === 0 ? ' style="text-decoration:line-through;opacity:.6"' : ""}>${esc(c.label)}</span>`).join("")}</div>` : ""}
    ${ev.description && ev.description.trim() ? `<button class="xp-button" type="button" style="margin:0 0 12px" onclick="var d=this.nextElementSibling;d.hidden=false;this.remove()">Show description &#9662;</button><div class="evdesc" hidden="until-found">${esc(ev.description.trim())}</div>` : ""}
    ${hosts.length ? `<div class="grp">${hosts.length === 1 ? "Host" : "Hosts"}</div><div class="alist">${hosts.map(attendeeRow).join("")}</div>` : ""}
    <div class="grp">Attendees${guests.length ? ` (${guests.length})` : ""}</div>
    ${guests.length ? `<div class="alist">${guests.map(attendeeRow).join("")}</div>`
      : `<div class="empty"><p class="note">No guest list loaded for this event yet.</p></div>`}`;
  return html(200, shell(ev.name, path, body));
}

async function renderContribute(d, path, uid, msg) {
  const n = await countContributors(d);
  const own = await d.prepare("SELECT label, enabled FROM user_cookies WHERE user_key = ?").get(uid);
  let cnt = 0;
  if (own) { const c = await d.prepare("SELECT count(*) AS n FROM event_contributions WHERE user_key = ?").get(uid); cnt = c ? Number(c.n) : 0; }
  const body = `<h1 class="page">Contribute</h1>
    <p class="lede">Serendipity pools events worth going to &mdash; and who&apos;s going &mdash; into one public view. Add an event by link, or connect your Luma feed to sync everything. ${n} active contributor${n == 1 ? "" : "s"} so far.</p>
    ${banner(msg)}
    ${own ? `<div class="connected">&#10003; You&apos;re contributing as <b>${esc(own.label || "unnamed")}</b> &mdash; ${cnt} event${cnt == 1 ? "" : "s"} from your feed are in the pool. Re-paste below to refresh your Luma session.</div>` : ""}

    <div class="grp">Add events by link</div>
    <p class="note" style="margin:0 0 8px">Paste public Luma links (<code>lu.ma/&hellip;</code> or <code>luma.com/&hellip;</code>) &mdash; one per line. No login needed. A single <b>event</b> comes in whole; a <b>calendar</b> (e.g. <code>luma.com/newinterfaces</code>) or a <b>discovery page</b> (<code>luma.com/crypto</code>, <code>/ai</code>, <code>/nyc</code>) expands into its events, up to ${LIST_CAP} per link. Added events show as &ldquo;browsed&rdquo; until someone going syncs their feed and fills the guest list.</p>
    <form method="POST" action="${PREFIX}/add-event">
      <textarea class="xp-field" name="links" rows="3" placeholder="https://lu.ma/your-event&#10;https://luma.com/crypto&#10;https://luma.com/newinterfaces" autocomplete="off" spellcheck="false"></textarea>
      <button class="xp-button" type="submit">Add to the pool</button>
    </form>

    <div class="grp">Sync your whole Luma feed</div>
    <p class="note" style="margin:0 0 8px">Connect once to keep <em>all</em> your events in sync &mdash; including the guest lists a single link can&apos;t see.</p>
    <ol class="steps note">
      <li>Install the <a href="https://cookie-editor.com/" rel="noopener external">Cookie-Editor</a> extension.</li>
      <li>Open <a href="https://lu.ma" rel="noopener external">lu.ma</a> and sign in.</li>
      <li>Click the Cookie-Editor icon &rarr; <code>Export</code> &rarr; <code>Export as JSON</code>.</li>
      <li>Paste it below and save &mdash; your events sync into the pool immediately.</li>
    </ol>
    <form method="POST" action="${PREFIX}/cookies">
      <input class="xp-field" name="label" maxlength="40" placeholder="Label (e.g. 'aadharsh/personal')" value="${esc(own?.label || "")}" autocomplete="off">
      <textarea class="xp-field" name="cookies" rows="5" placeholder='[{"name":"luma.auth-session-key","value":"usr-XXX.YYY"}, ...]' autocomplete="off" spellcheck="false"></textarea>
      <p class="note" style="margin:0 0 8px">Stored privately, used only to sync your Luma events into the shared pool. Must contain <code>luma.auth-session-key</code>.</p>
      <button class="xp-button primary" type="submit">${own ? "Refresh my events" : "Save &amp; sync"}</button>
    </form>`;
  return html(200, shell("Contribute", path, body));
}

// parse a Cookie-Editor JSON export (or a "name=value; ..." header) into our
// stored shape. Throws with a human message if no luma.auth-session-key.
// Exported for contract-tests.mjs, like MCP_TOOLS.
export function parseCookies(raw) {
  const t = (raw || "").trim();
  let cookies;
  if (t.startsWith("[")) {
    const arr = JSON.parse(t);
    cookies = arr.map((c) => ({
      name: c.name, value: c.value, domain: c.domain ?? ".lu.ma", path: c.path ?? "/",
      expires: c.expirationDate ?? -1, httpOnly: c.httpOnly ?? false, secure: c.secure ?? true,
      sameSite: c.sameSite === "lax" ? "Lax" : c.sameSite === "strict" ? "Strict" : c.sameSite === "none" ? "None" : "Lax",
    }));
  } else {
    const pairs = t.split(";").map((s) => s.trim()).filter(Boolean);
    if (!pairs.length) throw new Error("No cookies found in input");
    cookies = pairs.map((p) => { const eq = p.indexOf("="); return { name: eq === -1 ? p : p.slice(0, eq), value: eq === -1 ? "" : p.slice(eq + 1), domain: ".lu.ma", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" }; });
  }
  // Keep only Luma's own cookies. A whole-domain export drags in Cloudflare
  // edge cookies (__cf_bm is a 30-minute, IP-bound bot-management token, and
  // replaying a stale one from Worker egress IPs reads as a scraper) plus
  // Stripe/analytics noise. None of it authenticates anything, so it never
  // enters the jar. cookieJar() applies the same filter on load, which heals
  // rows pasted before this existed.
  cookies = cookies.filter((c) => c.name.startsWith("luma."));
  const auth = cookies.find((c) => c.name === "luma.auth-session-key");
  if (!auth) throw new Error("Missing luma.auth-session-key — sign in to lu.ma, then export your cookies again");
  const dot = auth.value.indexOf(".");
  const u = dot === -1 ? auth.value : auth.value.slice(0, dot);
  return { cookiesJson: JSON.stringify({ cookies, capturedAt: new Date().toISOString() }), lumaUserId: u.startsWith("usr-") ? u : null };
}

// POST /serendipity/cookies — public contribute: save this uid's cookies + sync.
async function handleCookies(request, env, d, uid) {
  const back = (msg, toDash) => new Response(null, { status: 303, headers: { location: `${PREFIX}${toDash ? "" : "/contribute"}?msg=${encodeURIComponent(msg)}` } });
  let form;
  try { form = await request.formData(); } catch { return back("Couldn't read the form"); }
  const label = (form.get("label") || "").toString().trim().slice(0, 40) || null;
  let parsed;
  try { parsed = parseCookies((form.get("cookies") || "").toString()); }
  catch (e) { return back(e instanceof Error ? e.message : "Invalid cookies"); }
  await d.prepare(`INSERT INTO user_cookies (user_key,cookies_json,luma_user_id,label,enabled,updated_at)
    VALUES (?,?,?,?,1,datetime('now'))
    ON CONFLICT(user_key) DO UPDATE SET cookies_json=excluded.cookies_json,luma_user_id=excluded.luma_user_id,label=COALESCE(?,user_cookies.label),updated_at=datetime('now')`)
    .run(uid, parsed.cookiesJson, parsed.lumaUserId, label, label);
  const r = await syncEvents(d, uid, parsed.cookiesJson);
  if (r.error) return back("Saved, but the Luma sync failed: " + r.error);
  return back(`Synced ${r.synced} events — thanks for contributing!`, true);
}

function renderMcpInfo(path) {
  const ep = `https://aadhar.sh${PREFIX}/mcp`;
  const tool = (n, args, desc) =>
    `<div class="att"><div class="who"><div class="n"><code>${n}</code>${args ? ` <span class="sub" style="display:inline">(${args})</span>` : ""}</div><div class="sub">${desc}</div></div></div>`;
  const body = `<h1 class="page">For agents</h1>
    <p class="lede">Serendipity is built to be queried by agents, not just people. A read-only MCP (Model Context Protocol) endpoint is live at <code>${ep}</code>. Point any MCP client at it (Streamable-HTTP transport, JSON-RPC over POST) and ask "what events are good, and who's going." Public data only: no auth, no writes, and never private contact details.</p>
    <div class="grp">Tools</div>
    <div class="alist">
      ${tool("list_events", "when, rsvp, q, limit", "Events in the pool with a head count + an RSVP tier. By default returns only events a contributor actually RSVP&apos;d to / hosts (the ones with rosters), plus a count of browsed-but-not-RSVP&apos;d events hidden; rsvp:&quot;all&quot; includes those (first-class first), rsvp:&quot;discovered&quot; returns only them.")}
      ${tool("get_event", "id", "One event in full: description, hosts, the guest list (who&apos;s going), contributors.")}
      ${tool("search_people", "q, limit", "Find people by name; returns role/company/socials and their events split into going_to and been_to.")}
      ${tool("list_contributors", "", "The people feeding the pool: a label, an id prefix, and how many events each fed in.")}
      ${tool("contributor_events", "contributor", "One contributor&apos;s whole footprint (by cookie id, id prefix, or label), split into going_to and been_to.")}
      ${tool("frequent_people", "when, limit", "Who shows up across the most events (who you&apos;re seeing a lot), with an event count.")}
      ${tool("co_attendees", "q, limit", "Who one person crosses paths with most, with the shared event names. Pass your own name for &quot;who am I seeing a lot&quot;.")}
      ${tool("connections", "min_shared, limit", "The tightest co-attendance pairs pool-wide (who&apos;s seeing who), with shared counts + event names.")}
      ${tool("shared_events", "a, b", "The events two named people both attended (did they cross paths, and where).")}
      ${tool("stats", "", "Pool overview: event counts, distinct people, active contributors.")}
    </div>
    <div class="grp">Connect</div>
    <p class="note" style="margin:0 0 8px">Add it to an MCP client config:</p>
    <pre class="code-block" style="font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;background:oklch(97% 0 0);border:1px solid oklch(82% 0.02 250);border-radius:3px;padding:10px;overflow:auto;margin:0 0 12px">{
  "mcpServers": {
    "serendipity": { "url": "${ep}" }
  }
}</pre>
    <p class="note">It exposes exactly what the dashboard shows: event details and who&apos;s going, with names, roles, companies, and public social links. The email and phone columns behind the pool never leave the database.</p>`;
  return html(200, shell("For agents", path, body));
}

// ════════════════════════════════════════════════════════════════════════════
// Luma client + sync — ported from the Next app's lib/{luma,luma-auth,sync},
// then hardened for the one condition the local app never met: running
// unattended for weeks on a stored session. Server-side fetch to Luma's
// internal API using a contributor's stored cookies.
// ════════════════════════════════════════════════════════════════════════════
const LUMA_API = "https://api2.luma.com";

function selfIdFrom(cookiesJson) {
  try {
    const auth = (JSON.parse(cookiesJson).cookies || []).find((c) => c.name === "luma.auth-session-key");
    if (!auth) return null;
    const dot = auth.value.indexOf(".");
    const uid = dot === -1 ? auth.value : auth.value.slice(0, dot);
    return uid.startsWith("usr-") ? uid : null;
  } catch { return null; }
}

// The stored jar is a snapshot of the contributor's browser session, and Luma
// treats sessions as LIVE: api2 responses re-issue luma.* cookies as they
// rotate or extend, so a client that keeps replaying the frozen snapshot
// eventually presents a key Luma no longer honours. That is how the deployed
// sync died where local dev (cookies pasted minutes earlier) never did.
// cookieJar() is one sync pass's live view of the session: header() renders
// the request Cookie, absorb() folds any rotated luma.* values back in and
// marks the jar dirty so the caller persists what Luma last issued.
//
// Only luma.* cookies are kept, on load and on absorb. A whole-domain browser
// export drags in Cloudflare edge cookies — __cf_bm is a 30-minute, IP-bound
// bot-management token, and replaying a stale one from datacenter egress IPs
// reads as a scraper — plus Stripe/analytics noise. None of it authenticates
// anything, so load strips it and marks the jar dirty, healing pre-existing
// rows the first time they sync.
export function cookieJar(cookiesJson) {  // exported for contract-tests.mjs
  let cookies;
  try { cookies = JSON.parse(cookiesJson).cookies || []; } catch { return null; }
  let dirty = cookies.some((c) => !c.name.startsWith("luma."));
  cookies = cookies.filter((c) => c.name.startsWith("luma."));
  return {
    header: () => cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    absorb(res) {
      for (const line of (res.headers.getSetCookie?.() || [])) {
        const semi = line.indexOf(";");
        const pair = (semi === -1 ? line : line.slice(0, semi)).trim();
        const eq = pair.indexOf("=");
        if (eq < 1) continue;
        const name = pair.slice(0, eq), value = pair.slice(eq + 1);
        if (!name.startsWith("luma.")) continue;  // api2 re-issues __cf_bm on every response; it must not enter the jar
        const attrs = semi === -1 ? "" : line.slice(semi + 1).toLowerCase();
        const at = cookies.findIndex((c) => c.name === name);
        if (!value || /max-age=(?:0|-\d+)(?:;|$)/.test(attrs)) {  // an explicit deletion: record reality
          if (at !== -1) { cookies.splice(at, 1); dirty = true; }
          continue;
        }
        // expires metadata is inert (header() never enforces it) but keeping it
        // current is free here and is what a health surface would want to read.
        let expires = -1;
        const ma = attrs.match(/max-age=(\d+)/);
        if (ma) expires = Math.floor(Date.now() / 1000) + Number(ma[1]);
        else {
          const ex = line.match(/expires=([^;]+)/i);
          const t = ex ? Date.parse(ex[1]) : NaN;
          if (!Number.isNaN(t)) expires = Math.floor(t / 1000);
        }
        if (at === -1) {
          cookies.push({ name, value, domain: ".luma.com", path: "/", expires,
            httpOnly: attrs.includes("httponly"), secure: attrs.includes("secure"), sameSite: "Lax" });
          dirty = true;
        } else if (cookies[at].value !== value) {
          cookies[at] = { ...cookies[at], value, expires };
          dirty = true;
        }
      }
    },
    get dirty() { return dirty; },
    json: () => JSON.stringify({ cookies, capturedAt: new Date().toISOString() }),
  };
}

// Write a rotated jar back so the NEXT sync sends what Luma last issued.
// Called on failure paths too: a rotation absorbed before the failure is
// still the freshest key we hold.
async function persistJar(d, userKey, jar) {
  if (!jar || !jar.dirty) return;
  await d.prepare(`UPDATE user_cookies SET cookies_json = ?, updated_at = datetime('now') WHERE user_key = ?`).run(jar.json(), userKey);
}

// auth is a cookieJar on the authenticated sync paths, or a plain Cookie
// header string ("" on the public, cookie-less endpoints). Jar responses are
// absorbed BEFORE the ok-check: a 4xx can still carry a rotation, and losing
// it because the call failed would strand the session one key behind.
async function lumaFetch(url, auth) {
  const jar = typeof auth === "string" ? null : auth;
  const res = await fetch(url, { headers: { "Content-Type": "application/json", Cookie: jar ? jar.header() : auth, "x-luma-web-url": "https://lu.ma" } });
  if (jar) jar.absorb(res);
  if (!res.ok) { const b = await res.text().catch(() => ""); throw new Error(`Luma ${res.status}: ${b.slice(0, 200)}`); }
  return res;
}
// fetchMe is gone: Luma removed /user/get-self (404 for every caller as of
// 2026-07-30, with multi-second stalls in the tail), and the auth cookie
// itself carries the usr- id — selfIdFrom() covers every use it had.
const toLumaUrl = (raw, id) => (!raw ? `https://lu.ma/${id}` : raw.startsWith("http") ? raw : `https://lu.ma/${raw}`);
function parseGuest(entryApiId, user) {
  return {
    id: entryApiId || user.api_id, name: user.name || null, email: user.email || null,
    avatar_url: user.avatar_url || null, bio_short: user.bio_short || null, website: user.website || null,
    twitter_handle: user.twitter_handle || null, linkedin_handle: user.linkedin_handle || null,
    instagram_handle: user.instagram_handle || null, tiktok_handle: user.tiktok_handle || null, youtube_handle: user.youtube_handle || null,
  };
}
function mapStatus(raw, ticketKey, role, isOwner) {
  if (isOwner) return "going";
  if (role) { const r = role.toLowerCase(); if (r.includes("host") || r === "owner" || r === "manager" || r === "organizer") return "going"; }
  if (!raw) return ticketKey ? "going" : "unknown";
  const s = raw.toLowerCase();
  if (s === "approved" || s === "going" || s === "attending") return "going";
  if (s === "invited") return "invited";
  if (s.includes("pending")) return "pending";
  if (s === "declined" || s === "rejected") return "declined";
  if (s === "waitlisted" || s === "waitlist") return "waitlisted";
  return ticketKey ? "going" : "unknown";
}
function parseEvents(data, selfId) {
  return ((data.entries || [])).map((entry) => {
    const event = entry.event || {}, cover = entry.cover_image || event.cover_image || {};
    const geo = event.geo_address_info || {}, gi = entry.guest_info || {};
    const id = entry.api_id || event.api_id;
    const ticketKey = gi.ticket_key || null;
    const approval = gi.approval_status || gi.calendar_status || null;
    const er = entry.role;
    const roleType = er && typeof er === "object" ? er.type : (typeof er === "string" ? er : null);
    const isManager = !!((er && typeof er === "object" && er.is_manager) || entry.host_info || entry.manager_info);
    const hosts = (entry.hosts || []);
    const isHost = isManager || roleType === "host" || (selfId != null && hosts.some((h) => h.api_id === selfId));
    const userStatus = mapStatus(approval, ticketKey, gi.role || gi.user_role || null, isHost);
    const preview = [];
    for (const g of (entry.guests || entry.attending_guests || entry.preview_guests || event.guests || [])) {
      const u = g.user || g, gid = g.api_id || u.api_id; if (gid) preview.push(parseGuest(gid, u));
    }
    const parsedHosts = [];
    for (const h of hosts) { if (h.api_id) parsedHosts.push(parseGuest(h.api_id, h)); }
    return {
      id, name: event.name || event.title || "", description: event.description || event.description_md || null,
      start_at: entry.start_at || event.start_at || null, end_at: entry.end_at || event.end_at || null,
      location: geo.full_address || event.location || null, cover_url: cover.url || event.cover_url || null,
      url: toLumaUrl(event.url, id), geo_latitude: event.geo_latitude || null, geo_longitude: event.geo_longitude || null,
      ticket_key: ticketKey, user_status: userStatus, preview_guests: preview, hosts: parsedHosts,
    };
  });
}
export const SERENDIPITY_SYNC_LIMITS = Object.freeze({ futurePages: 6, pastPages: 4, pastGuestEvents: 4 });

async function fetchMyEvents(auth, selfId) {
  const all = [];
  for (const period of ["future", "past"]) {
    // page caps kept low: Cloudflare limits subrequests (fetch calls) per Worker
    // invocation. Ten fetches total stays well under the cap. Four past pages
    // restores the depth the original app used; the two-page Worker port silently
    // dropped the older half of an active contributor's history.
    let cursor = null, page = 0;
    const max = period === "past" ? SERENDIPITY_SYNC_LIMITS.pastPages : SERENDIPITY_SYNC_LIMITS.futurePages;
    while (page < max) {
      page++;
      const p = new URLSearchParams({ pagination_limit: "50", period });
      if (cursor) p.set("pagination_cursor", cursor);
      const data = await (await lumaFetch(`${LUMA_API}/home/get-events?${p}`, auth)).json();
      all.push(...parseEvents(data, selfId));
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
  }
  return all;
}
async function fetchEventGuests(eventId, ticketKey, auth) {
  const all = []; let cursor = null;
  while (true) {
    // ticket_key ONLY when we have a real one. Sending ticket_key=null (the
    // literal, which URLSearchParams produces from a null value) makes Luma
    // 403 "you don't have access to see the guest list". Omitting it lets
    // access ride the auth session: a host sees their own event's list, and a
    // guest sees any event whose list is public to guests. (Verified against
    // api2.luma.com: same 7 guests with the key or with it omitted.)
    const p = new URLSearchParams({ event_api_id: eventId, pagination_limit: "100" });
    if (ticketKey) p.set("ticket_key", ticketKey);
    if (cursor) p.set("pagination_cursor", cursor);
    const data = await (await lumaFetch(`${LUMA_API}/event/get-guest-list?${p}`, auth)).json();
    for (const e of (data.entries || [])) all.push(parseGuest(e.api_id, e.user || {}));
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return all;
}
// Luma stores the description as a ProseMirror JSON doc (top-level
// `description_mirror`), not markdown. Walk it to plain text: text nodes
// concatenate, hard breaks → \n, block nodes (paragraph/heading/list item)
// → trailing \n\n so paragraphs survive.
function pmToText(node) {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text || "";
  if (/hard.?break|hardBreak/.test(node.type || "")) return "\n";
  let s = (node.content || []).map(pmToText).join("");
  if (/paragraph|heading|listItem|list_item|blockquote|codeBlock|code_block/.test(node.type || "")) s += "\n\n";
  return s;
}

// fetch ONE event's full detail for its description (the list endpoint omits it).
// returns plain-text description, or null. one subrequest per call.
async function fetchEventDescription(eventId, auth) {
  const p = new URLSearchParams({ event_api_id: eventId });
  let res;
  // deleted/private events 400/404 — lumaFetch throws; treat as "no description".
  try { res = await lumaFetch(`${LUMA_API}/event/get?${p}`, auth); }
  catch { return null; }
  const data = await res.json();
  const e = data.event || {};
  let txt = data.description_md || data.description || e.description_md || e.description || "";
  if (!txt && data.description_mirror) txt = pmToText(data.description_mirror);
  txt = String(txt || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return txt || null;
}

// resolve a pasted Luma link/slug/id to an evt- id. direct match if the input
// already contains one (e.g. .../event/evt-XXX or a raw id); otherwise pull the
// slug and scrape the public event page (lu.ma 301s to luma.com), which carries
// the evt- id in its markup. one subrequest only when scraping is needed.
async function resolveLumaEventId(input) {
  const s = (input || "").trim();
  if (!s) return null;
  const direct = s.match(/evt-[A-Za-z0-9]{6,}/);
  if (direct) return direct[0];
  let slug = s;
  const um = s.match(/(?:lu\.ma|luma\.com)\/([A-Za-z0-9][A-Za-z0-9._-]*)/i);
  if (um) slug = um[1];
  slug = slug.replace(/[?#].*$/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  try {
    const r = await fetch(`https://luma.com/${encodeURIComponent(slug)}`, {
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)" }, redirect: "follow",
    });
    if (!r.ok) return null;
    const m = (await r.text()).match(/evt-[A-Za-z0-9]{6,}/);
    return m ? m[0] : null;
  } catch { return null; }
}

// fetch one public event by link → our event shape (no cookies; /event/get is
// public). brings event details + hosts; the full guest list still needs a
// contributor going to that event (it requires auth + a ticket_key).
async function fetchEventByLink(input) {
  const id = await resolveLumaEventId(input);
  if (!id) return { error: "no Luma event found at that link" };
  let res;
  try { res = await lumaFetch(`${LUMA_API}/event/get?event_api_id=${id}`, ""); }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  const data = await res.json();
  const e = data.event || {};
  if (!e.api_id) return { error: "event not found" };
  const geo = e.geo_address_info || {};
  let desc = data.description_md || e.description_md || "";
  if (!desc && data.description_mirror) desc = pmToText(data.description_mirror);
  desc = String(desc || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() || null;
  const hosts = (data.hosts || []).map((h) => parseGuest(h.api_id, h)).filter((g) => g.id);
  return { event: {
    id: e.api_id, name: e.name || "", description: desc,
    start_at: e.start_at || null, end_at: e.end_at || null,
    location: geo.full_address || geo.address || null,
    cover_url: e.cover_url || (e.cover_image && e.cover_image.url) || null,
    url: e.url ? toLumaUrl(e.url, e.api_id) : `https://lu.ma/${e.api_id}`,
    geo_latitude: (e.coordinate && e.coordinate.latitude) || null,
    geo_longitude: (e.coordinate && e.coordinate.longitude) || null,
    hosts,
  } };
}

// ── calendar / discovery expansion ──────────────────────────────────────────
// A pasted Luma URL can name a whole CALENDAR (lu.ma/<slug> → cal-XXX) or a
// discovery CATEGORY / PLACE page (luma.com/crypto, luma.com/nyc). Both expand
// to many events. We classify by the page's __NEXT_DATA__ `kind` (one
// authoritative marker in initialData) and route to the matching list endpoint,
// hard-capped so a 493-event category can't flood the pool. Expanded events land
// as user_status 'unknown' — the same "in the pool, nobody's confirmed going"
// tier link-adds use (rendered "browsed / not RSVP'd", sorted below real RSVPs).
const LIST_CAP = 30;   // most events pulled from ONE calendar/category/place URL
const POOL_CAP = 60;   // most events pulled across a whole submission
// whole-globe viewport: /discover/get-paginated-events is map-region driven, so
// a world box asks for every event in the category/place, ranked by Luma.
const DISCOVER_BOX = "north=85&south=-85&east=179&west=-179";

// classify a pasted Luma URL with ONE page fetch. Returns {kind,id,slug} where
// kind is 'event'|'calendar'|'category'|'place' (id is the evt-/cal- id; slug
// drives discovery), or null when it isn't a recognizable Luma surface. lu.ma
// 301s to luma.com, whose HTML carries the __NEXT_DATA__ we read.
async function resolveLumaSource(input) {
  const s = (input || "").trim();
  if (!s) return null;
  const evt = s.match(/evt-[A-Za-z0-9]{6,}/);
  if (evt) return { kind: "event", id: evt[0], slug: null };
  let slug = s;
  const um = s.match(/(?:lu\.ma|luma\.com)\/([A-Za-z0-9][A-Za-z0-9._-]*)/i);
  if (um) slug = um[1];
  slug = slug.replace(/[?#].*$/, "");
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  let text;
  try {
    const r = await fetch(`https://luma.com/${encodeURIComponent(slug)}`, {
      headers: { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)" }, redirect: "follow",
    });
    if (!r.ok) return null;
    text = await r.text();
  } catch { return null; }
  // pageProps.initialData.kind is emitted once and names the page type. Places
  // use the hyphenated "discover-place"; categories are "category".
  const km = text.match(/"kind":"(event|calendar|category|discover-place)"/);
  const kind = km ? km[1] : null;
  if (kind === "calendar") {
    const m = text.match(/"kind":"calendar"[\s\S]{0,240}?"api_id":"(cal-[A-Za-z0-9]+)"/);
    return m ? { kind, id: m[1], slug } : null;
  }
  if (kind === "category" || kind === "discover-place") return { kind, id: null, slug };
  // event page (or an older cache with no kind marker): pull the evt- id.
  const m = text.match(/evt-[A-Za-z0-9]{6,}/);
  return m ? { kind: "event", id: m[0], slug } : null;
}

// paginate a public user calendar's events via /calendar/get-items — no auth.
// Entry shape == parseEvents' input, so hosts + featured guests carry through.
// Upcoming events lead; once they run out we backfill with past ones up to `cap`,
// so a plain calendar link still lands events even for a past-only series (e.g.
// newinterfaces, whose run is over) instead of returning empty. Stops at `cap`
// (subrequest budget).
async function fetchCalendarEvents(calId, cap) {
  const all = [];
  for (const period of ["future", "past"]) {
    if (all.length >= cap) break;
    let cursor = null;
    while (all.length < cap) {
      const p = new URLSearchParams({ calendar_api_id: calId, period, pagination_limit: "50" });
      if (cursor) p.set("pagination_cursor", cursor);
      let data;
      try { data = await (await lumaFetch(`${LUMA_API}/calendar/get-items?${p}`, "")).json(); }
      catch { break; }  // rate-limit / transient error: keep whatever we have
      all.push(...parseEvents(data, null));
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
  }
  return all.slice(0, cap);
}

// paginate a discovery category/place's events globally via
// /discover/get-paginated-events?slug=…&<worldbox>. Same entry shape as the
// calendar feed. Discovery is upcoming-oriented; drop anything already past so
// the pool isn't seeded with stale events.
async function fetchDiscoverEvents(slug, cap) {
  const cutoff = Date.now() - 12 * 3600 * 1000;
  const all = []; let cursor = null, pages = 0;
  while (all.length < cap && pages < 3) {
    pages++;
    const p = new URLSearchParams({ slug, pagination_limit: "50" });
    if (cursor) p.set("pagination_cursor", cursor);
    let data;
    try { data = await (await lumaFetch(`${LUMA_API}/discover/get-paginated-events?${p}&${DISCOVER_BOX}`, "")).json(); }
    catch { break; }
    for (const e of parseEvents(data, null)) {
      if (!e.start_at || Date.parse(e.start_at) >= cutoff) all.push(e);
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return all.slice(0, cap);
}

// single-statement attendee upsert (batch-friendly — no read-then-write).
// preserves private email + first_seen_at on conflict and refreshes public
// profile fields. The legacy times_seen column is preserved too, but public
// reads derive the count from event_attendees so it cannot drift.
const UPSERT_ATTENDEE = `INSERT INTO attendees (id,name,email,avatar_url,bio_short,website,twitter_handle,linkedin_handle,instagram_handle,tiktok_handle,youtube_handle,first_seen_at,times_seen)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now'),1)
 ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar_url=excluded.avatar_url,bio_short=excluded.bio_short,website=excluded.website,
   twitter_handle=excluded.twitter_handle,linkedin_handle=excluded.linkedin_handle,instagram_handle=excluded.instagram_handle,
   tiktok_handle=excluded.tiktok_handle,youtube_handle=excluded.youtube_handle`;
const attendeeStmt = (d, g) => d.stmt(UPSERT_ATTENDEE, g.id, g.name || "Unknown", g.email, g.avatar_url, g.bio_short, g.website, g.twitter_handle, g.linkedin_handle, g.instagram_handle, g.tiktok_handle, g.youtube_handle);
const UPSERT_EVENT = `INSERT INTO events (id,name,description,start_at,end_at,location,cover_url,url,geo_latitude,geo_longitude,ticket_key,user_status,synced_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
 ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=COALESCE(excluded.description,events.description),start_at=excluded.start_at,end_at=excluded.end_at,
   location=excluded.location,cover_url=excluded.cover_url,url=excluded.url,geo_latitude=excluded.geo_latitude,geo_longitude=excluded.geo_longitude,
   ticket_key=COALESCE(events.ticket_key,excluded.ticket_key),
   user_status=CASE WHEN events.user_status='going' OR excluded.user_status='going' THEN 'going'
     WHEN events.user_status='invited' OR excluded.user_status='invited' THEN 'invited'
     WHEN events.user_status='pending' OR excluded.user_status='pending' THEN 'pending'
     WHEN events.user_status='waitlisted' OR excluded.user_status='waitlisted' THEN 'waitlisted' ELSE excluded.user_status END,
   synced_at=datetime('now')`;

// sync one contributor's events into the pool. All writes are collected then
// run via d.batch() (one subrequest per 50 statements) to stay under the
// Cloudflare per-invocation subrequest cap. Returns {synced} or {error}.
async function syncEvents(d, userKey, cookiesJson) {
  const jar = cookieJar(cookiesJson);
  if (!jar || !jar.header()) return { error: "bad cookie json" };
  try {
    const selfId = selfIdFrom(cookiesJson);
    const events = await fetchMyEvents(jar, selfId);
    const S = [];
    if (selfId) {
      S.push(d.stmt(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`, `luma_user_id_${userKey}`, selfId));
      S.push(d.stmt(`INSERT INTO contributors (luma_user_id,first_seen_at,last_seen_at) VALUES (?,datetime('now'),datetime('now')) ON CONFLICT(luma_user_id) DO UPDATE SET last_seen_at=datetime('now')`, selfId));
    }
    for (const e of events) {
      S.push(d.stmt(UPSERT_EVENT, e.id, e.name, e.description, e.start_at, e.end_at, e.location, e.cover_url, e.url, e.geo_latitude, e.geo_longitude, e.ticket_key, e.user_status));
      S.push(d.stmt(`INSERT INTO event_contributions (event_id,user_key,contributed_at) VALUES (?,?,datetime('now')) ON CONFLICT(event_id,user_key) DO UPDATE SET contributed_at=datetime('now')`, e.id, userKey));
      for (const h of e.hosts) { if (!h.id || h.id === selfId) continue; S.push(attendeeStmt(d, h)); S.push(d.stmt(`INSERT INTO event_attendees (event_id,attendee_id,is_host) VALUES (?,?,1) ON CONFLICT(event_id,attendee_id) DO UPDATE SET is_host=1`, e.id, h.id)); }
      for (const g of e.preview_guests) { if (!g.id || g.id === selfId) continue; S.push(attendeeStmt(d, g)); S.push(d.stmt(`INSERT INTO event_attendees (event_id,attendee_id) VALUES (?,?) ON CONFLICT(event_id,attendee_id) DO NOTHING`, e.id, g.id)); }
    }
    await d.batch(S);
    await persistJar(d, userKey, jar);
    return { synced: events.length, statements: S.length };
  } catch (err) {
    await persistJar(d, userKey, jar).catch(() => {});
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// add events to the pool from pasted Luma links (no cookies needed). Each URL is
// classified: a single event pulls that event; a calendar / discovery category /
// place URL expands into its events, capped (LIST_CAP per URL, POOL_CAP total) so
// a 493-event category can't flood the pool. caps at 8 URLs/submission to stay
// under the per-invocation subrequest limit. records each event + its hosts +
// featured guests + a contribution by this uid. Returns {added,names,sources,failed}.
async function addEventsByLink(d, uid, raw) {
  const urls = (raw || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const S = [], names = [], sources = [], failed = [];
  let total = 0;
  for (const u of urls) {
    if (total >= POOL_CAP) break;
    let src;
    try { src = await resolveLumaSource(u); } catch { src = null; }
    if (!src) { failed.push(u.replace(/^https?:\/\//, "").slice(0, 32)); continue; }
    const room = POOL_CAP - total;
    let events = [];
    try {
      // pass the resolved evt- id (not the URL) so fetchEventByLink skips a re-scrape.
      if (src.kind === "event") { const r = await fetchEventByLink(src.id); if (r && r.event) events = [r.event]; }
      else if (src.kind === "calendar") events = await fetchCalendarEvents(src.id, Math.min(LIST_CAP, room));
      else events = await fetchDiscoverEvents(src.slug, Math.min(LIST_CAP, room));  // category | place
    } catch { events = []; }
    if (!events.length) { failed.push((src.slug || u.replace(/^https?:\/\//, "")).slice(0, 32)); continue; }
    for (const e of events) {
      // pooled-by-link events are user_status 'unknown' (the submitter isn't
      // necessarily going); a later cookie-sync by an attendee upgrades it + fills
      // the guest list. Descriptions backfill via /sync-descriptions.
      S.push(d.stmt(UPSERT_EVENT, e.id, e.name, e.description || null, e.start_at, e.end_at, e.location, e.cover_url, e.url, e.geo_latitude, e.geo_longitude, null, "unknown"));
      S.push(d.stmt(`INSERT INTO event_contributions (event_id,user_key,contributed_at) VALUES (?,?,datetime('now')) ON CONFLICT(event_id,user_key) DO UPDATE SET contributed_at=datetime('now')`, e.id, uid));
      for (const h of (e.hosts || [])) {
        if (!h.id) continue;
        S.push(attendeeStmt(d, h));
        S.push(d.stmt(`INSERT INTO event_attendees (event_id,attendee_id,is_host) VALUES (?,?,1) ON CONFLICT(event_id,attendee_id) DO UPDATE SET is_host=1`, e.id, h.id));
      }
      for (const g of (e.preview_guests || [])) {
        if (!g.id) continue;
        S.push(attendeeStmt(d, g));
        S.push(d.stmt(`INSERT INTO event_attendees (event_id,attendee_id) VALUES (?,?) ON CONFLICT(event_id,attendee_id) DO NOTHING`, e.id, g.id));
      }
    }
    total += events.length;
    if (src.kind === "event") names.push(events[0].name || events[0].id);
    else sources.push(`${src.slug} (${events.length})`);
  }
  if (S.length) await d.batch(S);
  return { added: total, names, sources, failed };
}

// POST /serendipity/add-event — public: add events to the pool by Luma link.
async function handleAddEvent(request, env, d, uid) {
  const back = (msg, toDash) => new Response(null, { status: 303, headers: { location: `${PREFIX}${toDash ? "" : "/contribute"}?msg=${encodeURIComponent(msg)}` } });
  let form;
  try { form = await request.formData(); } catch { return back("Couldn't read the form"); }
  const raw = (form.get("links") || "").toString();
  if (!raw.trim()) return back("Paste at least one Luma event, calendar, or discovery-page link");
  let r;
  try { r = await addEventsByLink(d, uid, raw); } catch (e) { return back("Add failed: " + (e instanceof Error ? e.message : String(e))); }
  if (!r.added) return back("Couldn't resolve those — make sure they're public Luma event, calendar, or discovery-page links");
  let msg = `Added ${r.added} event${r.added === 1 ? "" : "s"} to the pool`;
  const bits = [...r.names.slice(0, 2), ...r.sources.slice(0, 2)];
  if (bits.length) msg += `: ${bits.join(", ")}${(r.names.length + r.sources.length) > bits.length ? " …" : ""}`;
  if (r.failed.length) msg += ` · ${r.failed.length} couldn't be resolved`;
  return back(msg, true);
}

const GUEST_SYNC_KEY = "serendipity_guest_sync_";

// The roster endpoint is authoritative. Work out which old non-host links must
// disappear after the fresh list has been inserted; otherwise cancellations stay
// on the public page forever. Exported because the destructive half of a roster
// replacement deserves a deterministic contract test.
export function staleGuestIds(existingIds, nextGuests, selfId = null) {
  const current = new Set(nextGuests.map((g) => g && g.id).filter((id) => id && id !== selfId));
  return existingIds.filter((id) => id && !current.has(id));
}

async function markGuestSync(d, eventId, value) {
  return d.prepare(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=datetime('now')`
  ).run(GUEST_SYNC_KEY + eventId, value);
}

// sync one event's full guest list (batched writes). Returns {synced} or {error}.
async function syncGuests(d, eventId, userKey, cookiesJson) {
  const jar = cookieJar(cookiesJson);
  if (!jar || !jar.header()) return { error: "bad cookie json" };
  const ev = await d.prepare("SELECT ticket_key, user_status FROM events WHERE id = ?").get(eventId);
  if (!ev) return { error: "event not found" };
  if (ev.user_status !== "going") return { error: `status is ${ev.user_status}, not going` };
  // no ticket_key gate: events you HOST/manage (and link-added ones) have no
  // ticket_key of your own, but the list still loads over the auth session.
  // fetchEventGuests omits a missing key rather than sending null (which 403s).
  const selfId = selfIdFrom(cookiesJson);
  try {
    const guests = await fetchEventGuests(eventId, ev.ticket_key, jar);
    const S = [];
    for (const g of guests) {
      if (!g.id || g.id === selfId) continue;
      S.push(attendeeStmt(d, g));
      S.push(d.stmt(`INSERT INTO event_attendees (event_id,attendee_id) VALUES (?,?) ON CONFLICT(event_id,attendee_id) DO NOTHING`, eventId, g.id));
    }
    await d.batch(S);
    // Insert first, then remove links absent from the authoritative response.
    // A failure can leave stale rows behind, but it can never erase a valid row
    // before its replacement was safely written.
    const existing = await d.prepare(
      "SELECT attendee_id FROM event_attendees WHERE event_id = ? AND is_host = 0"
    ).all(eventId);
    const stale = staleGuestIds(existing.map((r) => r.attendee_id), guests, selfId);
    await d.batch(stale.map((id) => d.stmt(
      "DELETE FROM event_attendees WHERE event_id = ? AND attendee_id = ? AND is_host = 0", eventId, id
    )));
    await markGuestSync(d, eventId, `ok:${guests.length}`);
    await persistJar(d, userKey, jar);
    return { synced: guests.length, removed: stale.length };
  } catch (err) {
    await persistJar(d, userKey, jar).catch(() => {});
    const m = err instanceof Error ? err.message : String(err);
    const error = m.includes("403") ? "GUEST_LIST_RESTRICTED" : m;
    await markGuestSync(d, eventId, `error:${error.slice(0, 180)}`).catch(() => {});
    return { error };
  }
}

// throttled description backfill. the list-sync omits descriptions, and fetching
// detail for every event in one go would blow the per-invocation subrequest cap,
// so each call fills up to `limit` events (one Luma fetch each) and reports how
// many remain — re-run until remaining hits 0. Returns {scanned,filled,remaining}.
async function syncDescriptions(d, userKey, cookiesJson, limit) {
  const jar = cookieJar(cookiesJson);
  if (!jar || !jar.header()) return { error: "bad cookie json" };
  try {
    // only events we haven't attempted yet (desc_synced_at marks the attempt, so
    // events with no description / deleted events don't get re-scanned forever).
    // newest/soonest first — those are the events people are deciding on now.
    const todo = await d.prepare(
      `SELECT id FROM events WHERE description IS NULL AND desc_synced_at IS NULL ORDER BY start_at DESC LIMIT ?`
    ).all(limit);
    let filled = 0;
    const S = [];
    for (const row of todo) {
      let desc = null;
      try { desc = await fetchEventDescription(row.id, jar); } catch { desc = null; }  // never let one event abort the batch
      // always stamp the attempt; set description only when we got text.
      S.push(d.stmt(`UPDATE events SET description = COALESCE(?, description), desc_synced_at = datetime('now') WHERE id = ?`, desc, row.id));
      if (desc) filled++;
    }
    if (S.length) await d.batch(S);
    await persistJar(d, userKey, jar);
    const rem = await d.prepare(`SELECT COUNT(*) AS n FROM events WHERE description IS NULL AND desc_synced_at IS NULL`).get();
    return { scanned: todo.length, filled, remaining: rem?.n || 0 };
  } catch (err) {
    await persistJar(d, userKey, jar).catch(() => {});
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// secret-gated: POST /serendipity/sync-descriptions?key=SECRET[&n=30]
// fills up to n (default 30, max 45) missing descriptions per call.
async function handleSyncDescriptions(request, env, d) {
  const url = new URL(request.url);
  if (!env.SYNC_SECRET || url.searchParams.get("key") !== env.SYNC_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const limit = Math.min(45, Math.max(1, parseInt(url.searchParams.get("n") || "30", 10) || 30));
  // any enabled cookie can read public event detail; use the first available.
  const set = await d.prepare("SELECT user_key, cookies_json, label FROM user_cookies WHERE enabled = 1 LIMIT 1").get();
  if (!set) return new Response(JSON.stringify({ ok: false, error: "no enabled cookies" }), { status: 400, headers: { "content-type": "application/json" } });
  const r = await syncDescriptions(d, set.user_key, set.cookies_json, limit);
  return new Response(JSON.stringify({ ok: !r.error, via: set.label, ...r }, null, 2), { headers: { "content-type": "application/json" } });
}

// secret-gated trigger: POST /serendipity/sync?key=SECRET[&event=<id>]
async function handleSync(request, env, d) {
  const url = new URL(request.url);
  if (!env.SYNC_SECRET || url.searchParams.get("key") !== env.SYNC_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const sets = await d.prepare("SELECT user_key, cookies_json, label FROM user_cookies WHERE enabled = 1").all();
  const eventId = url.searchParams.get("event");
  const out = [];
  for (const s of sets) {
    if (eventId) out.push({ label: s.label, event: eventId, ...(await syncGuests(d, eventId, s.user_key, s.cookies_json)) });
    else out.push({ label: s.label, ...(await syncEvents(d, s.user_key, s.cookies_json)) });
  }
  return new Response(JSON.stringify({ ok: true, results: out }, null, 2), { headers: { "content-type": "application/json" } });
}

// ── cron: the recurring tick that keeps the pool honest ─────────────────────
// Deployed serendipity had NO recurring sync. The pool refreshed only when
// someone re-pasted cookies, so production data froze at the last paste
// (measured 2026-07-30: last sync 07-11, 8 future events left, 0 "going")
// while the stored session idled toward Luma's few-weeks expiry. Local dev
// never showed this because a fresh paste was always minutes old. This tick
// (23 */6 * * *, wired in index.js scheduled()) does what an active local
// user did by hand: re-sync every enabled feed, refill guest lists for the
// next upcoming events, backfill a few descriptions. It is also what keeps
// the stored session warm, and every request routes through cookieJar, so a
// rotation Luma issues mid-run lands back in D1 instead of on the floor.
//
// Budgeted in SUBREQUESTS (Luma fetches and D1 calls both count): the feed
// pass is ≤10 fetches plus chunked D1 batches per contributor, the upcoming
// sweep ≤4 events, the historical backfill ≤4 events, and descriptions ≤10
// fetches. The caps keep growth bounded. Failures stay per-arm: one restricted
// guest list is timestamped and the sweep advances instead of starving behind
// the same unreadable event forever.
const CRON_UPCOMING_GUEST_EVENTS = 4;
const CRON_PAST_GUEST_EVENTS = SERENDIPITY_SYNC_LIMITS.pastGuestEvents;
const CRON_DESC_LIMIT = 10;
export async function cronSerendipity(env) {
  const d = db(env);
  const sets = await d.prepare("SELECT user_key, cookies_json, label FROM user_cookies WHERE enabled = 1").all();
  if (!sets.length) { console.log(JSON.stringify({ cron: "serendipity", skipped: "no enabled cookie sets" })); return; }
  const out = { events: [], guests: [], descriptions: null };
  for (const s of sets) out.events.push({ label: s.label, ...(await syncEvents(d, s.user_key, s.cookies_json)) });
  // Re-read the sets before the guest pass: if syncEvents absorbed a rotation,
  // the pass after it must send what Luma just issued, never the old snapshot.
  const fresh = await d.prepare("SELECT user_key, cookies_json, label FROM user_cookies WHERE enabled = 1").all();
  if (!fresh.length) return;
  // datetime() normalizes the mixed start_at formats in this table (ISO-with-T
  // from Luma, space-separated from SQLite) — a bare string compare would sort
  // "…T16:00" after "… 21:00" and let same-day past events shadow real ones.
  const soon = await d.prepare(
    `SELECT id FROM events WHERE user_status = 'going' AND start_at IS NOT NULL AND datetime(start_at) >= datetime('now') ORDER BY datetime(start_at) ASC LIMIT ?`
  ).all(CRON_UPCOMING_GUEST_EVENTS);
  // Completed past rosters are immutable. Unattempted ones lead; restricted or
  // transient failures fall to the back and are retried oldest-attempt first
  // only after the sweep has made progress through the rest of the history.
  const past = await d.prepare(
    `SELECT e.id FROM events e
       LEFT JOIN settings gs ON gs.key = ? || e.id
      WHERE e.user_status = 'going' AND e.start_at IS NOT NULL
        AND datetime(e.start_at) < datetime('now')
        AND (gs.value IS NULL OR gs.value NOT LIKE 'ok:%')
      ORDER BY (gs.updated_at IS NULL) DESC, datetime(gs.updated_at) ASC, datetime(e.start_at) DESC
      LIMIT ?`
  ).all(GUEST_SYNC_KEY, CRON_PAST_GUEST_EVENTS);
  for (const ev of [...soon, ...past]) {
    // first set that can read this list wins; with one contributor that is one
    // try, and a restricted list falls through to the next set rather than dying.
    /** @type {{error?: string, synced?: number}} */
    let r = { error: "no readable cookie set" };
    for (const s of fresh) { r = await syncGuests(d, ev.id, s.user_key, s.cookies_json); if (!r.error) break; }
    out.guests.push({ event: ev.id, ...r });
  }
  out.descriptions = await syncDescriptions(d, fresh[0].user_key, fresh[0].cookies_json, CRON_DESC_LIMIT);
  console.log(JSON.stringify({ cron: "serendipity", ...out }));
}

// ════════════════════════════════════════════════════════════════════════════
// Exa enrichment — ported from lib/enrich.ts (Exa path only). Web-grounded,
// cited, never fabricates. name (+ any signal) → {company, role, location, bio,
// linkedin_url, work_history}. Stealth companies get a second neural drill.
// ════════════════════════════════════════════════════════════════════════════
const EXA = "https://api.exa.ai";
const SUMMARY_PROMPT = `Two parts. Output them in this exact order:

PART 1 — Bio (2-3 plain English sentences describing who this person is professionally, what they're working on now, and what they're known for. No bullet points, no key-value pairs, no markdown).

PART 2 — Then below, in this exact format on separate lines (use "unknown" when missing):
ROLE: <current job title>
COMPANY: <current company>
LOCATION: <city, region, country>
PAST: <up to 3 past roles, formatted as "Title at Company", comma-separated>`;
const STEALTH_PROMPT = `This person is reportedly building a stealth startup. Return EXACTLY these lines (use "unknown" if unsupported):
Domain: <one of: crypto, AI, biotech, devtools, consumer, fintech, climate, robotics, defense, hardware, social, other>
Thesis: <one short phrase — what problem or wedge, max 12 words>
Signal: <one direct quote from the text, max 25 words>`;
const GARBAGE = new Set(["in","at","of","on","the","a","an","is","and","linkedin","linkedin profile","linkedin.com","see profile","profile","n/a","none","unknown","tbd"]);
const cleanVal = (raw) => {
  if (!raw) return null;
  const s = raw.replace(/^[\s\-•*]+/, "").replace(/^["']|["']$/g, "").trim();
  if (!s || s.length < 3 || /^(unknown|n\/?a|none)$/i.test(s) || GARBAGE.has(s.toLowerCase())) return null;
  return s;
};
function parseStructured(text) {
  if (!text) return { role: null, company: null, location: null, bio: null, work_history: [] };
  const KV = new RegExp(`^\\s*(?:ROLE|COMPANY|LOCATION|PAST|BIO)\\s*:`, "im");
  const m = KV.exec(text);
  const proseEnd = m ? m.index : text.length;
  let bio = text.slice(0, proseEnd)
    .replace(/^\s*PART\s*1\b[\s:.—\-]*(?:Bio\b[\s:.—\-]*)?/i, "")  // drop "PART 1 [— Bio:]" lead-in
    .replace(/\bPART\s*2\b[\s:.—\-]*$/i, "")                              // drop trailing "PART 2"
    .replace(/^\s*(?:Bio|Summary)\s*:\s*/im, "")
    .replace(/\s+/g, " ").trim() || null;
  const kv = m ? text.slice(proseEnd) : "";
  const line = (k) => { const lm = kv.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, "im")); return cleanVal(lm?.[1]); };
  const role = line("ROLE"), company = line("COMPANY"), location = line("LOCATION"), past = line("PAST");
  const work = [];
  if (role || company) work.push({ title: role, company_name: company, current: true });
  if (past) for (const c of past.split(/\s*,\s*/).slice(0, 3)) { const [t, co] = c.split(/\s+at\s+/i).map(cleanVal); if (t || co) work.push({ title: t ?? null, company_name: co ?? null }); }
  return { role, company, location, bio, work_history: work };
}
function parseStealth(text) {
  if (!text) return { domain: null, thesis: null, signal: null };
  const line = (k) => { const m = text.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, "im")); if (!m) return null; const v = m[1].replace(/^["']|["']$/g, "").trim(); return (!v || /^unknown$/i.test(v) || /^n\/?a$/i.test(v)) ? null : v; };
  return { domain: line("Domain"), thesis: line("Thesis"), signal: line("Signal") };
}
const isStealth = (c) => !!c && (/\bstealth\b/i.test(c) || /^(undisclosed|confidential|tbd)$/i.test(c.trim()));
async function exaPost(key, path, body) {
  const res = await fetch(`${EXA}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Exa ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}
const pickLinkedIn = (results) => results?.find((r) => r.url?.includes("linkedin.com/in/")) ?? null;
async function drillStealth(key, attendee, knownLinkedIn) {
  const seed = knownLinkedIn ? `${attendee.name} (${knownLinkedIn})` : attendee.name;
  const q = `${seed}${attendee.bio_short ? " " + attendee.bio_short : ""} building stealth startup — what are they working on, recent posts, tweets, interviews`;
  try {
    const data = await exaPost(key, "/search", { query: q, type: "neural", numResults: 5, startPublishedDate: new Date(Date.now() - 365 * 864e5).toISOString(), contents: { text: { maxCharacters: 3000 }, summary: { query: STEALTH_PROMPT } } });
    const ranked = (data.results ?? []).map((r) => ({ r, p: parseStealth(r.summary) })).filter(({ p }) => p.domain || p.thesis || p.signal)
      .sort((a, b) => ((b.p.domain ? 1 : 0) + (b.p.thesis ? 2 : 0) + (b.p.signal ? 2 : 0)) - ((a.p.domain ? 1 : 0) + (a.p.thesis ? 2 : 0) + (a.p.signal ? 2 : 0)));
    const top = ranked[0];
    return top ? { ...top.p, sources: ranked.slice(0, 3).map((x) => x.r.url).filter(Boolean) } : null;
  } catch { return null; }
}
// enrich one attendee via Exa, store into enrichments. Returns {outcome, profile?}.
async function enrichViaExa(d, key, attendee, force) {
  if (!key) return { outcome: "not_found", error: "EXA_NOT_CONFIGURED" };
  if (!force) {
    const ex = await d.prepare("SELECT source FROM enrichments WHERE attendee_id = ?").get(attendee.id);
    if (ex && ex.source === "exa") return { outcome: "already_enriched" };
  }
  let linkedinUrl = null;
  if (attendee.linkedin_handle) linkedinUrl = attendee.linkedin_handle.startsWith("http") ? attendee.linkedin_handle : `https://www.linkedin.com${attendee.linkedin_handle.startsWith("/") ? "" : "/in/"}${attendee.linkedin_handle}`;
  const query = `${attendee.name}${attendee.bio_short ? " " + attendee.bio_short : ""}`;
  let text = null, summary = null;
  try {
    if (linkedinUrl) {
      const data = await exaPost(key, "/contents", { urls: [linkedinUrl], text: { maxCharacters: 4000 }, summary: { query: SUMMARY_PROMPT } });
      const hit = data.results?.[0]; text = hit?.text ?? null; summary = hit?.summary ?? null;
    } else {
      const data = await exaPost(key, "/search", { query, type: "neural", numResults: 3, category: "linkedin profile", contents: { text: { maxCharacters: 4000 }, summary: { query: SUMMARY_PROMPT } } });
      const hit = pickLinkedIn(data.results); if (hit) { linkedinUrl = hit.url; text = hit.text ?? null; summary = hit.summary ?? null; }
    }
  } catch (err) { return { outcome: "not_found", error: err instanceof Error ? err.message : String(err) }; }

  const p = parseStructured(summary ?? text);
  const freeform = (summary ?? text ?? "").replace(/\s+/g, " ").trim();
  let company = p.company, bio = p.bio ?? (freeform ? freeform.slice(0, 600) : null);
  let stealth = null;
  if (isStealth(company)) {
    stealth = await drillStealth(key, attendee, linkedinUrl);
    if (stealth && (stealth.domain || stealth.thesis)) {
      const flavor = [stealth.domain, stealth.thesis].filter(Boolean).join(" · ");
      company = company ? `${company} (${flavor})` : `Stealth (${flavor})`;
      bio = `[stealth signal] ${flavor}${stealth.signal ? ` — "${stealth.signal}"` : ""}${p.bio ? " · " + p.bio : ""}`;
    }
  }
  const found = !!(linkedinUrl || p.role || company || bio);
  await d.prepare(`INSERT INTO enrichments (attendee_id,linkedin_url,company,role,bio,location,work_history,education,emails,phone_numbers,source,raw_json,enriched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(attendee_id) DO UPDATE SET linkedin_url=excluded.linkedin_url,company=excluded.company,role=excluded.role,bio=excluded.bio,
      location=excluded.location,work_history=excluded.work_history,source=excluded.source,raw_json=excluded.raw_json,enriched_at=datetime('now')`)
    .run(attendee.id, linkedinUrl, company, p.role, bio, p.location, JSON.stringify(p.work_history), "[]", "[]", "[]", "exa", JSON.stringify({ summary, stealth }).slice(0, 4000));
  return { outcome: found ? "success" : "not_found", profile: { company, role: p.role, location: p.location, linkedin_url: linkedinUrl, bio } };
}

// ── Parallel (parallel.ai) enrichment — the optional second provider ────────
// Synchronous Search API: POST /v1beta/search → ranked web excerpts. Unlike Exa
// (whose summary feature returns a structured ROLE/COMPANY block we parse), this
// returns raw excerpts, so role/company are best-effort regex'd out of a "<Title>
// at <Company>" pattern. Good enough to A/B against Exa; if Parallel wins the
// eval, the structured upgrade is its Task API (server-side output schema).
async function parallelSearch(key, objective, queries) {
  const r = await fetch("https://api.parallel.ai/v1beta/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "parallel-beta": "search-extract-2025-10-10" },
    body: JSON.stringify({ objective, search_queries: queries, max_results: 5, max_chars_per_result: 1500 }),
  });
  if (!r.ok) throw new Error(`Parallel ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return r.json();
}
function guessRoleCompany(text) {
  if (!text) return { role: null, company: null };
  const m = text.match(/\b([A-Z][A-Za-z0-9/&+. -]{2,40}?(?:Engineer|Developer|Founder|Co-?founder|CEO|CTO|COO|CFO|CPO|President|VP|Director|Head|Manager|Lead|Designer|Researcher|Scientist|Partner|Investor|Analyst|Officer))\s+(?:at|@|,|\bof\b)\s+([A-Z][A-Za-z0-9/&+.' -]{1,40})/);
  return m ? { role: m[1].trim(), company: m[2].trim() } : { role: null, company: null };
}
async function enrichViaParallel(d, key, attendee, force) {
  if (!key) return { outcome: "not_found", error: "PARALLEL_NOT_CONFIGURED" };
  if (!force) {
    const ex = await d.prepare("SELECT source FROM enrichments WHERE attendee_id = ?").get(attendee.id);
    if (ex && ex.source === "parallel") return { outcome: "already_enriched" };
  }
  const objective = `Identify the professional profile of ${attendee.name}${attendee.bio_short ? " (" + attendee.bio_short + ")" : ""}: current job title/role, current company or organization, and city/location. Prefer LinkedIn, company pages, and recent reputable sources.`;
  const queries = [`${attendee.name} LinkedIn`, `${attendee.name} ${attendee.bio_short || "role company"}`.trim(), `${attendee.name} founder OR engineer OR investor`];
  let results;
  try { results = (await parallelSearch(key, objective, queries)).results || []; }
  catch (err) { return { outcome: "not_found", error: err instanceof Error ? err.message : String(err) }; }

  const linkedinUrl = (results.find((r) => /linkedin\.com\/in\//i.test(r.url || "")) || {}).url || null;
  const context = results.flatMap((r) => r.excerpts || []).join(" ").replace(/\s+/g, " ").trim();
  const g = guessRoleCompany(context);
  const bio = context ? context.slice(0, 600) : null;
  const found = !!(linkedinUrl || g.role || g.company || bio);
  await d.prepare(`INSERT INTO enrichments (attendee_id,linkedin_url,company,role,bio,location,work_history,education,emails,phone_numbers,source,raw_json,enriched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(attendee_id) DO UPDATE SET linkedin_url=excluded.linkedin_url,company=excluded.company,role=excluded.role,bio=excluded.bio,
      location=excluded.location,work_history=excluded.work_history,source=excluded.source,raw_json=excluded.raw_json,enriched_at=datetime('now')`)
    .run(attendee.id, linkedinUrl, g.company, g.role, bio, null, "[]", "[]", "[]", "[]", "parallel", JSON.stringify({ objective, results: results.slice(0, 3) }).slice(0, 4000));
  return { outcome: found ? "success" : "not_found", profile: { company: g.company, role: g.role, location: null, linkedin_url: linkedinUrl, bio } };
}

// secret-gated: POST /serendipity/enrich?key=SECRET&attendee=<id>  (single)
//                                         &event=<id>&limit=6      (bulk, un-enriched)
// provider=exa (default) | parallel — both optional; only the one whose API key
// is set will run. No agentcash / payment layer: each provider is a direct key.
const ENRICH_PROVIDERS = {
  exa:      { keyEnv: "EXA_API_KEY",      fn: enrichViaExa },
  parallel: { keyEnv: "PARALLEL_API_KEY", fn: enrichViaParallel },
};
async function handleEnrich(request, env, d) {
  const url = new URL(request.url);
  if (!env.SYNC_SECRET || url.searchParams.get("key") !== env.SYNC_SECRET) return new Response("forbidden", { status: 403 });
  const jerr = (msg, code) => new Response(JSON.stringify({ error: msg }), { status: code, headers: { "content-type": "application/json" } });
  const provider = (url.searchParams.get("provider") || "exa").toLowerCase();
  const P = ENRICH_PROVIDERS[provider];
  if (!P) return jerr(`unknown provider "${provider}" (use exa | parallel)`, 400);
  const key = env[P.keyEnv];
  if (!key) return jerr(`${P.keyEnv} not set — add it with: wrangler secret put ${P.keyEnv}`, 400);
  const COLS = "id, name, linkedin_handle, email, bio_short";
  let targets;
  const aid = url.searchParams.get("attendee"), eid = url.searchParams.get("event");
  if (aid) targets = await d.prepare(`SELECT ${COLS} FROM attendees WHERE id = ?`).all(aid);
  else if (eid) {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "6", 10) || 6, 10);
    targets = await d.prepare(`SELECT a.id, a.name, a.linkedin_handle, a.email, a.bio_short
       FROM event_attendees ea JOIN attendees a ON a.id = ea.attendee_id
       LEFT JOIN enrichments en ON en.attendee_id = a.id
      WHERE ea.event_id = ? AND ea.is_host = 0 AND en.attendee_id IS NULL
      ORDER BY (SELECT COUNT(*) FROM event_attendees seen WHERE seen.attendee_id = a.id) DESC LIMIT ?`).all(eid, limit);
  } else return jerr("pass ?attendee= or ?event=", 400);

  const out = [];
  for (const a of targets) out.push({ name: a.name, ...(await P.fn(d, key, a, !!aid)) });
  return new Response(JSON.stringify({ ok: true, provider, enriched: out }, null, 2), { headers: { "content-type": "application/json" } });
}

// ── cover-proxy request signing ─────────────────────────────────────────────
// The /cover proxy fetches a caller-supplied URL and edge-caches it (s-maxage 7d).
// Left open that's an SSRF-shaped vector: any third party could point ?u= at an
// arbitrary host that returns image/* (incl. internal/metadata endpoints) and have
// aadhar.sh fetch + cache it. We deliberately do NOT allowlist hosts — covers come
// from arbitrary CDNs (lumacdn, unsplash, organizer-chosen), and allowlisting was
// whack-a-mole that silently broke external covers. Instead the worker HMAC-signs
// every cover URL it emits and only honours requests carrying a valid signature for
// their exact ?u= value. Any external CDN still works; an attacker can't forge the
// MAC, so attacker-chosen URLs are rejected. Secret reuses SYNC_SECRET (override
// with a dedicated COVER_SECRET). If neither is set the proxy degrades to open —
// that's an unconfigured deploy only, not anything an attacker can induce.
const _enc = new TextEncoder();
function _b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function coverSecret(env) { return (env && (env.COVER_SECRET || env.SYNC_SECRET)) || null; }
function coverKey(secret) {
  return crypto.subtle.importKey("raw", _enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signCoverUrl(rawUrl, secret) {
  return _b64url(await crypto.subtle.sign("HMAC", await coverKey(secret), _enc.encode(rawUrl)));
}
async function verifyCoverUrl(rawUrl, sig, secret) {
  if (!sig) return false;
  let bytes;
  try { bytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)); }
  catch { return false; }
  return crypto.subtle.verify("HMAC", await coverKey(secret), bytes, _enc.encode(rawUrl));
}
// Same-origin, signed cover-proxy URL for a raw cover_url ("" when there's none).
async function coverProxyUrl(rawUrl, env) {
  if (!rawUrl) return "";
  const base = `${PREFIX}/cover?u=${encodeURIComponent(rawUrl)}`;
  const secret = coverSecret(env);
  return secret ? `${base}&s=${await signCoverUrl(rawUrl, secret)}` : base;
}

// ── router ────────────────────────────────────────────────────────────────────
// GET /serendipity/cover?u=<encoded image url>[&s=<hmac>] — same-origin cover proxy.
// Resizes via Cloudflare Image Transformations (cf.image) so the hover tooltip
// pulls a ~520px thumbnail instead of the multi-MB original (covers ran up to
// 6.4 MB). Two wins: covers become same-origin (any organizer-chosen host loads
// without widening CSP), and the bytes shrink. If Transformations aren't enabled
// on the zone, cf.image is silently ignored and the original is streamed through
// — still same-origin, just full-size, so nothing breaks before the toggle flips.
// The &s= signature (see above) gates which URLs are honoured — verified before the
// cache lookup so a forged/unsigned URL can neither be served from nor written to
// the shared edge cache.
async function handleCover(request, env, ctx) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("u");
  if (!raw) return new Response("missing u", { status: 400 });
  let target;
  try { target = new URL(raw); } catch { return new Response("bad u", { status: 400 }); }
  if (target.protocol !== "https:") return new Response("https only", { status: 400 });
  if (target.port && target.port !== "443") return new Response("https only", { status: 400 });
  // SSRF guard, before any fetch and independent of the signature below.
  // the cover fetch degrades to an unsigned plain fetch when Transformations are
  // off, so a signature check alone is not the gate; the host floor runs regardless.
  if (privateHostBlocked(target.hostname.toLowerCase())) return new Response("blocked host", { status: 400 });
  const secret = coverSecret(env);
  if (secret && !(await verifyCoverUrl(raw, url.searchParams.get("s"), secret))) {
    return new Response("bad or missing signature", { status: 403 });
  }

  const hit = await caches.default.match(request);
  if (hit) return hit;

  const ua = { "user-agent": "AadharshBot/1.0 (+https://aadhar.sh/bot)" };
  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: ua,
      // format:'webp' (not 'auto') so every client gets one format — keeps the
      // shared edge cache key correct without a Vary:Accept dance. webp is
      // supported everywhere the site targets (Safari 16+, all evergreen).
      cf: { image: { width: 520, quality: 72, fit: "scale-down", format: "webp" } },
    });
    if (!upstream.ok) throw new Error("upstream " + upstream.status);
  } catch {
    // Transformations off / transform error → plain fetch, original bytes.
    try { upstream = await fetch(target.toString(), { headers: ua }); }
    catch { return new Response("upstream fetch failed", { status: 502 }); }
  }
  const ct = upstream.headers.get("content-type") || "";
  if (!upstream.ok || !ct.startsWith("image/")) return new Response("not an image", { status: 415 });

  const h = new Headers();
  h.set("content-type", ct);
  h.set("cache-control", "public, max-age=86400, s-maxage=604800");
  h.set("x-content-type-options", "nosniff");
  const out = new Response(upstream.body, { status: 200, headers: h });
  ctx.waitUntil(caches.default.put(request, out.clone()));
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// MCP — read-only Model Context Protocol surface at /serendipity/mcp.
// Streamable-HTTP transport (JSON-RPC 2.0 over POST), stateless + dependency-
// free — the same hand-rolled style as the rest of this Worker. It reuses the
// query layer above and exposes ONLY the public read surface the dashboard
// renders. The email / phone_numbers / raw_json columns on attendees+enrichments
// never cross this boundary. No auth, no writes — the same data, for agents.
// ════════════════════════════════════════════════════════════════════════════

// DUAL-ERA as of 2026-07-28, on the same terms as the site server at /mcp: a
// request carrying modern `_meta` is served statelessly under the new revision,
// an `initialize` request selects legacy semantics. The wire rules live in
// www/_worker.js/lib/mcp-protocol.js and are SHARED with /mcp, deliberately
// — two MCP servers on one origin speaking different dialects is a bug waiting
// to be reported by a client author rather than by us.
export const SERENDIPITY_MCP_SERVER_INFO = { name: "serendipity", title: "Serendipity", version: "2.0.0" };
export const SERENDIPITY_MCP_CAPABILITIES = { tools: {} };
export const SERENDIPITY_MCP_INSTRUCTIONS = "Read-only access to the Serendipity event pool: community-curated events and who's going. Start with stats or list_events, drill in with get_event, find people with search_people. Public data only.";

const MCP = mcpServer({
  serverInfo: SERENDIPITY_MCP_SERVER_INFO,
  capabilities: SERENDIPITY_MCP_CAPABILITIES,
  instructions: SERENDIPITY_MCP_INSTRUCTIONS,
});

// public-safe projection of an attendee row — mirrors what attendeeRow renders.
// NO email / phone / raw_json: those columns aren't even SELECT'd by the query
// layer, and this mapper is the second guardrail.
function mcpAttendee(a) {
  const socials = {};
  if (a.twitter_handle) socials.x = "https://x.com/" + String(a.twitter_handle).replace(/^@/, "");
  if (a.linkedin_url) socials.linkedin = a.linkedin_url;
  else if (a.linkedin_handle) socials.linkedin = "https://linkedin.com/in/" + a.linkedin_handle;
  if (a.instagram_handle) socials.instagram = "https://www.instagram.com/" + String(a.instagram_handle).replace(/^@/, "");
  if (a.website) socials.website = a.website;
  const o = {
    name: a.name,
    role: a.role || null,
    company: a.company || null,
    location: a.location || null,
    bio: a.bio_short || null,
    times_seen: a.times_seen != null ? Number(a.times_seen) : null,
  };
  if (a.is_host != null) o.is_host = !!Number(a.is_host);
  if (Object.keys(socials).length) o.socials = socials;
  return o;
}

function mcpEventSummary(e) {
  return {
    id: e.id,
    name: e.name,
    start_at: e.start_at || null,
    location: e.location || null,
    url: e.url || (e.id ? "https://lu.ma/" + e.id : null),
    going: Number(e.attendee_count || 0),
    hosts: Number(e.host_count || 0),
    // RSVP tier: "going" means a contributor actually RSVP'd / is hosting — the
    // first-class events. "invited"/"pending"/"waitlisted"/unknown are synced from
    // browsing a Luma feed without RSVPing — no roster, second-class.
    attending: e.user_status === "going",
    rsvp: e.user_status || "unknown",
    contributors: e.contributors || null,
  };
}

// people search: one query for the matches, one IN(...) query for their events
// (two D1 subrequests total, no N+1).
async function mcpSearchPeople(d, q, limit) {
  const term = "%" + String(q).replace(/[\\%_]/g, "\\$&") + "%";
  const people = await d.prepare(
    `SELECT a.id, a.name, a.bio_short,
            (SELECT COUNT(*) FROM event_attendees seen WHERE seen.attendee_id = a.id) AS times_seen,
            a.website,
            a.twitter_handle, a.linkedin_handle, a.instagram_handle,
            en.company, en.role, en.location, en.linkedin_url
       FROM attendees a LEFT JOIN enrichments en ON en.attendee_id = a.id
      WHERE a.name LIKE ? ESCAPE '\\'
      ORDER BY times_seen DESC, a.name ASC
      LIMIT ?`
  ).all(term, limit);
  if (!people.length) return [];
  const ids = people.map((p) => p.id);
  const ph = ids.map(() => "?").join(",");
  const memberships = await d.prepare(
    `SELECT ea.attendee_id, e.id AS event_id, e.name AS event_name, e.start_at, ea.is_host
       FROM event_attendees ea JOIN events e ON e.id = ea.event_id
      WHERE ea.attendee_id IN (${ph})
      ORDER BY e.start_at DESC`
  ).all(...ids);
  const byPerson = new Map();
  for (const m of memberships) {
    if (!byPerson.has(m.attendee_id)) byPerson.set(m.attendee_id, []);
    byPerson.get(m.attendee_id).push({ id: m.event_id, name: m.event_name, start_at: m.start_at || null, is_host: !!Number(m.is_host) });
  }
  const now = Date.now();
  return people.map((p) => {
    const o = mcpAttendee(p);
    const evs = byPerson.get(p.id) || [];
    // split each person's events into what they're going to (upcoming) vs have
    // been to (past), so a caller can read both their trajectory and their reach.
    o.going_to = evs.filter((e) => !e.start_at || new Date(e.start_at).getTime() >= now)
                    .sort((a, b) => new Date(a.start_at || 0).getTime() - new Date(b.start_at || 0).getTime());
    o.been_to = evs.filter((e) => e.start_at && new Date(e.start_at).getTime() < now);  // already DESC
    return o;
  });
}

// resolve a contributor (by their cookie id / user_key, a user_key prefix, or
// their label) and return every event they fed into the pool, split into
// upcoming (going to) and past (been to). the contributor->events mapping is
// already public on the dashboard ("Contributed by <label>" per event); this
// just lets you pivot on it. only an 8-char key prefix is ever echoed back.
async function mcpContributorEvents(d, contributor) {
  const key = String(contributor || "").trim();
  if (!key) return null;
  const c = await d.prepare(
    `SELECT user_key, label, luma_user_id, enabled FROM user_cookies
      WHERE user_key = ?1 OR label = ?1 OR user_key LIKE ?2 ESCAPE '\\' LIMIT 1`
  ).get(key, key.replace(/[\\%_]/g, "\\$&") + "%");
  if (!c) return null;
  const rows = await d.prepare(
    `SELECT e.id, e.name, e.start_at, e.location, e.url,
            (SELECT COUNT(*) FROM event_attendees ea WHERE ea.event_id = e.id AND ea.is_host = 0) AS attendee_count,
            (SELECT COUNT(*) FROM event_attendees ea WHERE ea.event_id = e.id AND ea.is_host = 1) AS host_count
       FROM event_contributions ec JOIN events e ON e.id = ec.event_id
      WHERE ec.user_key = ? ORDER BY e.start_at`
  ).all(c.user_key);
  const now = Date.now();
  const summaries = rows.map(mcpEventSummary);
  return {
    contributor: { label: c.label || null, id_prefix: String(c.user_key).slice(0, 8),
                   luma_user_id: c.luma_user_id || null, enabled: Number(c.enabled) === 1 },
    total: rows.length,
    going_to: summaries.filter((e) => !e.start_at || new Date(e.start_at).getTime() >= now),
    been_to: summaries.filter((e) => e.start_at && new Date(e.start_at).getTime() < now)
                      .sort((a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime()),
  };
}

async function mcpListContributors(d) {
  const rows = await d.prepare(
    `SELECT uc.label, uc.enabled, uc.luma_user_id, substr(uc.user_key, 1, 8) AS id_prefix,
            (SELECT COUNT(*) FROM event_contributions ec WHERE ec.user_key = uc.user_key) AS events
       FROM user_cookies uc ORDER BY events DESC, uc.updated_at DESC`
  ).all();
  return rows.map((r) => ({ label: r.label || null, id_prefix: r.id_prefix, luma_user_id: r.luma_user_id || null,
                            enabled: Number(r.enabled) === 1, events: Number(r.events) }));
}

// ── social graph: frequency + co-attendance ──────────────────────────────────
// all read-only, public surface only (same projection as search_people; the
// who-overlaps-with-whom is already implicit in the public guest lists, this
// just computes it). co-attendance counts hosts and guests alike: being at the
// same event is the edge.
const PUB_COLS = `a.id, a.name, a.bio_short,
            (SELECT COUNT(*) FROM event_attendees seen WHERE seen.attendee_id = a.id) AS times_seen,
            a.website,
            a.twitter_handle, a.linkedin_handle, a.instagram_handle,
            en.company, en.role, en.location, en.linkedin_url`;

// best-match attendee for a name (most-seen wins ties).
async function mcpResolvePerson(d, q) {
  const term = "%" + String(q || "").replace(/[\\%_]/g, "\\$&") + "%";
  return d.prepare(
    `SELECT ${PUB_COLS} FROM attendees a LEFT JOIN enrichments en ON en.attendee_id = a.id
      WHERE a.name LIKE ? ESCAPE '\\' ORDER BY times_seen DESC, a.name ASC LIMIT 1`
  ).get(term);
}

// who shows up across the most events (who you're seeing a lot); optional slice.
async function mcpFrequentPeople(d, when, limit) {
  let filter = "", binds = [];
  if (when === "upcoming" || when === "past") {
    const nowIso = new Date().toISOString();
    filter = when === "upcoming"
      ? `AND (e.start_at IS NULL OR e.start_at >= ?)`
      : `AND (e.start_at IS NOT NULL AND e.start_at < ?)`;
    binds.push(nowIso);
  }
  binds.push(limit);
  const rows = await d.prepare(
    `SELECT ${PUB_COLS}, COUNT(DISTINCT ea.event_id) AS events
       FROM attendees a
       JOIN event_attendees ea ON ea.attendee_id = a.id
       JOIN events e ON e.id = ea.event_id
       LEFT JOIN enrichments en ON en.attendee_id = a.id
      WHERE 1=1 ${filter}
      GROUP BY a.id ORDER BY events DESC, a.name ASC LIMIT ?`
  ).all(...binds);
  return rows.map((r) => { const o = mcpAttendee(r); o.events = Number(r.events); return o; });
}

// one person's strongest co-attendees + the events they share.
async function mcpCoAttendees(d, q, limit) {
  const person = await mcpResolvePerson(d, q);
  if (!person) return null;
  const rows = await d.prepare(
    `SELECT ${PUB_COLS}, COUNT(*) AS shared, GROUP_CONCAT(e.name, '|||') AS shared_names
       FROM event_attendees ea
       JOIN attendees a ON a.id = ea.attendee_id
       JOIN events e ON e.id = ea.event_id
       LEFT JOIN enrichments en ON en.attendee_id = a.id
      WHERE ea.event_id IN (SELECT event_id FROM event_attendees WHERE attendee_id = ?1)
        AND ea.attendee_id != ?1
      GROUP BY a.id ORDER BY shared DESC, times_seen DESC, a.name ASC LIMIT ?2`
  ).all(person.id, limit);
  const tot = await d.prepare(`SELECT COUNT(DISTINCT event_id) AS n FROM event_attendees WHERE attendee_id = ?`).get(person.id);
  return {
    person: mcpAttendee(person),
    events_attended: tot ? Number(tot.n) : 0,
    co_attendees: rows.map((r) => { const o = mcpAttendee(r); o.shared = Number(r.shared);
      o.shared_events = (r.shared_names || "").split("|||").filter(Boolean); return o; }),
  };
}

// the tightest co-attendance pairs pool-wide (who's seeing who).
async function mcpConnections(d, minShared, limit) {
  const rows = await d.prepare(
    `SELECT a1.attendee_id AS id1, a2.attendee_id AS id2,
            COUNT(*) AS shared, GROUP_CONCAT(e.name, '|||') AS shared_names
       FROM event_attendees a1
       JOIN event_attendees a2 ON a1.event_id = a2.event_id AND a1.attendee_id < a2.attendee_id
       JOIN events e ON e.id = a1.event_id
      GROUP BY a1.attendee_id, a2.attendee_id
     HAVING shared >= ?1 ORDER BY shared DESC LIMIT ?2`
  ).all(minShared, limit);
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap((r) => [r.id1, r.id2]))];
  const ph = ids.map(() => "?").join(",");
  const people = await d.prepare(
    `SELECT a.id, a.name, en.company, en.role FROM attendees a LEFT JOIN enrichments en ON en.attendee_id = a.id WHERE a.id IN (${ph})`
  ).all(...ids);
  const byId = new Map(people.map((p) => [p.id, { name: p.name, role: p.role || null, company: p.company || null }]));
  return rows.map((r) => ({
    a: byId.get(r.id1) || { name: "?" },
    b: byId.get(r.id2) || { name: "?" },
    shared: Number(r.shared),
    shared_events: (r.shared_names || "").split("|||").filter(Boolean),
  }));
}

// the events two named people both attended (did they cross paths, and where).
async function mcpSharedEvents(d, qa, qb) {
  const a = await mcpResolvePerson(d, qa);
  const b = await mcpResolvePerson(d, qb);
  if (!a) return { _missing: qa };
  if (!b) return { _missing: qb };
  const rows = await d.prepare(
    `SELECT e.id, e.name, e.start_at, e.location, e.url,
            (SELECT COUNT(*) FROM event_attendees x WHERE x.event_id = e.id AND x.is_host = 0) AS attendee_count,
            (SELECT COUNT(*) FROM event_attendees x WHERE x.event_id = e.id AND x.is_host = 1) AS host_count
       FROM events e
      WHERE e.id IN (SELECT event_id FROM event_attendees WHERE attendee_id = ?1)
        AND e.id IN (SELECT event_id FROM event_attendees WHERE attendee_id = ?2)
      ORDER BY e.start_at DESC`
  ).all(a.id, b.id);
  return { a: mcpAttendee(a), b: mcpAttendee(b), shared_count: rows.length, shared_events: rows.map(mcpEventSummary) };
}

const MCP_TOOL_DEFINITIONS = [
  {
    name: "list_events",
    description: "List events in the Serendipity pool, each with a head count of who's going and an RSVP tier. The pool mixes events a contributor actually RSVP'd to or hosts (rsvp:\"going\" — first-class, the ones with real rosters) with events synced from just browsing a Luma feed (rsvp:\"invited\"/\"pending\"/etc — no roster, second-class). By default only the going (RSVP'd) events are returned, with a discovered_hidden count noting how many browsed events were omitted; pass rsvp:\"all\" to include them (first-class first) or rsvp:\"discovered\" for only the browsed ones. Each event carries attending (bool) + rsvp (raw status). Defaults to upcoming, soonest first.",
    inputSchema: {
      type: "object",
      properties: {
        when: { type: "string", enum: ["upcoming", "past", "all"], description: "which time slice to return (default \"upcoming\")" },
        rsvp: { type: "string", enum: ["going", "all", "discovered"], description: "RSVP tier: \"going\" = only events a contributor RSVP'd to / hosts (default); \"all\" = include browsed-but-not-RSVP'd events, first-class first; \"discovered\" = only the browsed ones" },
        q: { type: "string", description: "optional case-insensitive filter on event name, location, or contributor" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "max events to return (default 50)" },
      },
    },
  },
  {
    name: "get_event",
    description: "Full detail for one event by id: description, time, location, Luma link, hosts, the guest list (who's going, with role/company/socials when known), and which contributors added it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "the event id, as returned by list_events" } },
      required: ["id"],
    },
  },
  {
    name: "search_people",
    description: "Search people across all events by name. Returns who they are (role/company/socials when known), how many events they've turned up at, and their events split into going_to (upcoming) and been_to (past), so you see both trajectory and reach.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "a name or partial name to search for" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "max people to return (default 25)" },
      },
      required: ["q"],
    },
  },
  {
    name: "list_contributors",
    description: "List the contributors feeding the pool (the people who synced a Luma feed): their label, an 8-char id prefix, and how many events each has fed in. Use the label or id prefix with contributor_events.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "contributor_events",
    description: "Given a contributor (their cookie id / user_key, an id prefix, or their label), return every event they fed into the pool, split into going_to (upcoming) and been_to (past). This is one contributor's whole event footprint.",
    inputSchema: {
      type: "object",
      properties: { contributor: { type: "string", description: "a contributor's cookie id (user_key), an id prefix from list_contributors, or their label" } },
      required: ["contributor"],
    },
  },
  {
    name: "frequent_people",
    description: "The people who show up across the most events in the pool (who you're seeing a lot), each with an event count. Optionally restrict the count to upcoming or past.",
    inputSchema: {
      type: "object",
      properties: {
        when: { type: "string", enum: ["upcoming", "past", "all"], description: "restrict the count to a slice (default all)" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "max people (default 25)" },
      },
    },
  },
  {
    name: "co_attendees",
    description: "Given a person by name, who they cross paths with most: the people most often at the same events, with a shared-event count and the names of those shared events. Pass your own name to answer \"who am I seeing a lot\".",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "a name or partial name" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "max co-attendees (default 25)" },
      },
      required: ["q"],
    },
  },
  {
    name: "connections",
    description: "The tightest co-attendance pairs in the whole pool (who's seeing who): pairs of people who keep turning up at the same events, with the shared count and the shared event names. The relationship graph's strongest edges.",
    inputSchema: {
      type: "object",
      properties: {
        min_shared: { type: "integer", minimum: 1, description: "only pairs sharing at least this many events (default 2)" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "max pairs (default 25)" },
      },
    },
  },
  {
    name: "shared_events",
    description: "Given two people by name, the events they both attended (did these two cross paths, and where).",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "first person's name" },
        b: { type: "string", description: "second person's name" },
      },
      required: ["a", "b"],
    },
  },
  {
    name: "stats",
    description: "Overview of the pool: upcoming/past event counts, distinct people seen, and active contributors.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const MCP_TOOLS = MCP_TOOL_DEFINITIONS.map((tool) => mcpTool(tool));

// run a tool. returns a plain object on success, or { _error } for a tool-level
// error (bad args / not found) the caller surfaces as an MCP isError result.
async function mcpCallTool(d, name, args) {
  args = args || {};
  if (name === "list_events") {
    const when = ["upcoming", "past", "all"].includes(args.when) ? args.when : "upcoming";
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 50, 1), 200);
    const q = args.q != null && String(args.q).trim() ? String(args.q).toLowerCase() : null;
    // rsvp tier: the pool mixes events a contributor actually RSVP'd to / hosts
    // ("going" — first-class, the ones with rosters) with events synced from just
    // browsing a Luma feed ("invited"/"pending"/etc — no roster, second-class).
    // default to the real ones; "all" includes the discovered pile (first-class
    // first), "discovered" returns only the not-RSVP'd ones.
    const rsvp = ["going", "all", "discovered"].includes(args.rsvp) ? args.rsvp : "going";
    const now = Date.now();
    let rows = await queryEvents(d);
    if (when === "upcoming") rows = rows.filter((e) => !e.start_at || new Date(e.start_at).getTime() >= now);
    else if (when === "past") rows = rows.filter((e) => e.start_at && new Date(e.start_at).getTime() < now)
                                         .sort((a, b) => new Date(b.start_at).getTime() - new Date(a.start_at).getTime());
    if (q) rows = rows.filter((e) => [e.name, e.location, e.contributors].some((v) => v && String(v).toLowerCase().includes(q)));
    const matched = rows.length;                                            // after when + q, before rsvp tier
    const goingCount = rows.filter((e) => e.user_status === "going").length;
    if (rsvp === "going") rows = rows.filter((e) => e.user_status === "going");
    else if (rsvp === "discovered") rows = rows.filter((e) => e.user_status !== "going");
    else rows = rows.slice().sort((a, b) => Number(b.user_status === "going") - Number(a.user_status === "going")); // stable: first-class first, date order kept within tier
    const total = rows.length;
    const events = rows.slice(0, limit).map(mcpEventSummary);
    const out = { when, rsvp, total, returned: events.length, events };
    if (rsvp === "going") out.discovered_hidden = matched - goingCount;      // transparency: not-RSVP'd events omitted from this view
    return out;
  }
  if (name === "get_event") {
    const id = String(args.id || "").trim();
    if (!id) return { _error: "id is required" };
    const [ev, rows, contributors] = await Promise.all([queryEvent(d, id), queryEventAttendees(d, id), queryContributors(d, id)]);
    if (!ev) return { _error: "no event with id \"" + id + "\" is in the pool" };
    const hosts = rows.filter((a) => a.is_host).map(mcpAttendee);
    const guests = rows.filter((a) => !a.is_host).map((a) => ({ ...a, _s: attendeeScore(a) }))
                       .sort((a, b) => b._s - a._s || a.name.localeCompare(b.name)).map(mcpAttendee);
    return {
      event: {
        id: ev.id, name: ev.name, description: ev.description || null,
        start_at: ev.start_at || null, end_at: ev.end_at || null,
        location: ev.location || null, url: ev.url || (ev.id ? "https://lu.ma/" + ev.id : null),
        status: ev.user_status || null,
      },
      hosts, going: guests.length, attendees: guests,
      contributors: contributors.map((c) => c.label),
    };
  }
  if (name === "search_people") {
    const q = String(args.q || "").trim();
    if (!q) return { _error: "q is required" };
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 100);
    const people = await mcpSearchPeople(d, q, limit);
    return { query: q, returned: people.length, people };
  }
  if (name === "list_contributors") {
    return { contributors: await mcpListContributors(d) };
  }
  if (name === "contributor_events") {
    const c = String(args.contributor || "").trim();
    if (!c) return { _error: "contributor is required (a cookie id / user_key, an id prefix, or a label)" };
    const out = await mcpContributorEvents(d, c);
    if (!out) return { _error: "no contributor matching \"" + c + "\" (try list_contributors)" };
    return out;
  }
  if (name === "frequent_people") {
    const when = ["upcoming", "past", "all"].includes(args.when) ? args.when : "all";
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 100);
    const people = await mcpFrequentPeople(d, when, limit);
    return { when, returned: people.length, people };
  }
  if (name === "co_attendees") {
    const q = String(args.q || "").trim();
    if (!q) return { _error: "q is required (a person's name)" };
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 100);
    const out = await mcpCoAttendees(d, q, limit);
    if (!out) return { _error: "no person matching \"" + q + "\" (try search_people)" };
    return out;
  }
  if (name === "connections") {
    const minShared = Math.max(parseInt(args.min_shared, 10) || 2, 1);
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 100);
    return { min_shared: minShared, pairs: await mcpConnections(d, minShared, limit) };
  }
  if (name === "shared_events") {
    const a = String(args.a || "").trim(), b = String(args.b || "").trim();
    if (!a || !b) return { _error: "both a and b (person names) are required" };
    const out = await mcpSharedEvents(d, a, b);
    if (out._missing) return { _error: "no person matching \"" + out._missing + "\"" };
    return out;
  }
  if (name === "stats") {
    const [events, contributors, attRow] = await Promise.all([
      queryEvents(d), countContributors(d), d.prepare("SELECT COUNT(*) AS n FROM attendees").get(),
    ]);
    const now = Date.now();
    const upcoming = events.filter((e) => !e.start_at || new Date(e.start_at).getTime() >= now).length;
    return { events_total: events.length, events_upcoming: upcoming, events_past: events.length - upcoming,
             people: attRow ? Number(attRow.n) : 0, contributors };
  }
  return { _unknown: true };
}

// The one Serendipity tool the SITE's /mcp also offers, as `find_events`.
//
// Two MCP servers on one origin is right for agents that read the agent card and
// pick a door, and wrong for anything that only ever knocks on one. WebMCP is the
// second kind: Cloudflare's bridge reads a single endpoint (`/mcp` by default) and
// registers whatever it finds, so a tool living only at /serendipity/mcp is
// invisible to every agent browsing the page. This wrapper is how the site server
// borrows exactly one tool without a second implementation of it — `mcpCallTool`
// is the same function /serendipity/mcp dispatches into, so the two cannot answer
// differently, and the schema stays declared once at each door.
//
// Deliberately ONE tool rather than a general proxy. get_event and search_people
// are drill-downs that only make sense once you are inside the pool, and a bridge
// that hoisted all four would put four near-duplicate names in front of a model
// that already has seven.
export async function serendipityFindEvents(env, args) {
  if (!env?.SERENDIPITY_DB) return { _error: "the event pool is not bound on this deployment" };
  return mcpCallTool(db(env), "list_events", args || {});
}

// exported for contract-tests.mjs: the protocol-level methods (server/discover,
// initialize, the list surfaces, the version + header gate) touch no database,
// so they are drivable with a null `d`. Same reason shouldUseWorkersCache was
// pulled into lib/cache.js — a dispatcher-private function is a function no
// test can reach, and the bug that taught us that shipped through a green CI.
export async function handleMcp(request, env, d) {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, authorization",
    "access-control-max-age": "86400",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const respond = (obj, status = 200) => new Response(obj === null ? null : JSON.stringify(obj), {
    status, headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
  if (request.method !== "POST") {
    // stateless server: no server-initiated SSE stream, POST JSON-RPC only.
    return respond({ error: "Use POST with JSON-RPC 2.0. Docs: " + PREFIX + "/mcp-info" }, 405);
  }
  const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } });

  let payload;
  try { payload = await request.json(); }
  catch { return respond(rpcErr(null, -32700, "Parse error")); }

  const handleOne = async (msg) => {
    const hasId = msg && typeof msg === "object" && "id" in msg;
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return hasId ? rpcErr(msg.id, -32600, "Invalid Request") : null;
    }
    const id = msg.id, m = msg.method;
    try {
      // Version first, then the routing headers — the same gate /mcp applies.
      const refused = mcpGate(msg, request, id, hasId);
      if (refused !== null) return refused;

      // MUST be implemented as of 2026-07-28.
      if (m === "server/discover") return MCP.discover(id);
      // Kept for pre-2026 clients, which have no fall-forward mechanism.
      if (m === "initialize") return MCP.initialize(id, msg.params && msg.params.protocolVersion);
      if (m === "ping") return { jsonrpc: "2.0", id, result: {} };
      // MCP_TOOLS is a literal array nothing sorts or filters, so tools/list is
      // deterministic, which 2026-07-28 asks for so clients can cache it.
      if (m === "tools/list") return MCP.result(id, { tools: MCP_TOOLS }, CACHE_STATIC);
      // This server exposes no resources (capabilities says so). The empty
      // lists are answered anyway rather than 404'd, because a client that asks
      // deserves "none" instead of an error it has to special-case.
      if (m === "resources/list") return MCP.result(id, { resources: [] }, CACHE_EMPTY);
      if (m === "resources/templates/list") return MCP.result(id, { resourceTemplates: [] }, CACHE_EMPTY);
      if (m === "prompts/list") return MCP.result(id, { prompts: [] }, CACHE_EMPTY);
      if (m.startsWith("notifications/")) return null;  // client notification — ack only
      if (m === "tools/call") {
        const name = msg.params && msg.params.name;
        // Every tool on this server reads today, so this refuses nothing yet.
        // It is here so that the day one of them writes, the preview guard is
        // already in place rather than remembered — the site server learned that
        // lesson the expensive way (lib/preview.js).
        const refusedOnPreview = previewToolRefusal(request, MCP_TOOLS, name);
        if (refusedOnPreview) return MCP.result(id, { content: [{ type: "text", text: refusedOnPreview }], isError: true });
        const out = await mcpCallTool(d, name, (msg.params && msg.params.arguments) || {});
        if (out && out._unknown) return rpcErr(id, -32602, "Unknown tool: " + name);
        // A failed tool is a RESULT with isError, never a JSON-RPC error: the
        // call succeeded and the model is meant to read the text.
        if (out && out._error) return MCP.result(id, { content: [{ type: "text", text: out._error }], isError: true });
        return MCP.result(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out });
      }
      return hasId ? rpcErr(id, -32601, "Method not found: " + m) : null;
    } catch (e) {
      return hasId ? rpcErr(id, -32603, "Internal error: " + (e && e.message ? e.message : String(e))) : null;
    }
  };

  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map(handleOne))).filter((x) => x !== null);
    return out.length ? respond(out) : respond(null, 202);
  }
  const one = await handleOne(payload);
  // 400 on a malformed modern request, per 2026-07-28; 200 otherwise. Same rule
  // /mcp applies, from the same function.
  return one === null ? respond(null, 202) : respond(one, mcpHttpStatus(payload));
}

export async function handleSerendipity(request, env, ctx) {
  const url = new URL(request.url);
  let path = url.pathname.replace(/\/+$/, "") || PREFIX;

  // stable per-browser uid (keys a contributor's cookie set); mint if absent
  let uid = readUid(request), setCookie = null;
  if (!uid) { uid = mintUid(); setCookie = uidCookie(uid); }

  if (!env.SERENDIPITY_DB) {
    return html(500, shell("Setup", path, `<h1 class="page">Database not bound</h1><p class="lede">The <code>SERENDIPITY_DB</code> D1 binding isn&apos;t attached to this deployment yet.</p>`));
  }
  const d = db(env);

  // MCP — stateless JSON-RPC, read-only, no uid cookie. early-return like /cover
  // so the response stays cookie-free (and CORS-clean for cross-origin clients).
  if (path === `${PREFIX}/mcp`) return handleMcp(request, env, d);

  const msg = url.searchParams.get("msg");
  const dashKey = new Request(`${url.origin}${PREFIX}`);  // shared public-dashboard cache key

  // any mutation (sync / enrich / contribute) invalidates the cached dashboard
  if (request.method === "POST" &&
      (path === `${PREFIX}/sync` || path === `${PREFIX}/sync-descriptions` ||
       path === `${PREFIX}/enrich` || path === `${PREFIX}/cookies` || path === `${PREFIX}/add-event`)) {
    ctx.waitUntil(caches.default.delete(dashKey));
  }

  // secret-gated triggers (admin/cron): pull from cookies + Exa-enrich attendees
  if (request.method === "POST" && path === `${PREFIX}/sync`) return handleSync(request, env, d);
  if (request.method === "POST" && path === `${PREFIX}/sync-descriptions`) return handleSyncDescriptions(request, env, d);
  if (request.method === "POST" && path === `${PREFIX}/enrich`) return handleEnrich(request, env, d);

  // same-origin cover proxy (resizes via cf.image) — early return, no uid cookie
  // so the response stays cacheable at the edge.
  if ((request.method === "GET" || request.method === "HEAD") && path === `${PREFIX}/cover`) return handleCover(request, env, ctx);

  let res;
  try {
  if (request.method === "POST" && path === `${PREFIX}/cookies`) res = await handleCookies(request, env, d, uid);
  else if (request.method === "POST" && path === `${PREFIX}/add-event`) res = await handleAddEvent(request, env, d, uid);
  else if (path === PREFIX) {
    // public pool — data changes only on sync/contribute (which bust above).
    // cache the rendered HTML at the edge for 60s so repeat + agent hits skip
    // the D1 GROUP BY. skip when a flash msg is present (just-acted view).
    if (request.method === "GET" && !msg) {
      let hit = await caches.default.match(dashKey);
      if (!hit) {
        const rendered = await renderDashboard(d, path, msg, env);
        const h = new Headers(rendered.headers);
        h.set("cache-control", "public, max-age=60, s-maxage=60");
        h.delete("set-cookie");  // never store a per-visitor uid cookie in a shared cache
        hit = new Response(rendered.body, { status: rendered.status, headers: h });
        ctx.waitUntil(caches.default.put(dashKey, hit.clone()));
      }
      res = hit;
    } else {
      res = await renderDashboard(d, path, msg, env);
    }
  }
  else if (path === `${PREFIX}/contribute`) res = await renderContribute(d, path, uid, msg);
  else if (path === `${PREFIX}/mcp-info`) res = renderMcpInfo(path);
  else if (path.startsWith(`${PREFIX}/event/`)) res = await renderEvent(d, decodeURIComponent(path.slice(`${PREFIX}/event/`.length)), path);
  else res = html(404, shell("Not found", path, `<h1 class="page">404</h1><p class="lede">No such page. <a href="${PREFIX}">Back to events</a>.</p>`));
  } catch (e) {
    // a bound-but-unmigrated / erroring D1 would otherwise throw a bare, unstyled
    // 500 — degrade to the same shell()-styled error the missing-binding case uses.
    res = html(500, shell("Error", path, `<h1 class="page">Something broke</h1><p class="lede">The event pool hit a database error. Try again in a moment.</p>`));
  }

  if (setCookie) {
    const h = new Headers(res.headers);
    h.append("set-cookie", setCookie);
    res = new Response(res.body, { status: res.status, headers: h });
  }
  return res;
}

// ── embedded site module ─────────────────────────────────────────────────────
// The root aadhar-sh Worker dispatches /serendipity/* here. These headers stay
// local because this surface permits arbitrary HTTPS cover-image hosts while
// the homepage CSP deliberately remains narrower.
export const SERENDIPITY_SECURITY_HEADERS = {
  "content-security-policy":
    // img-src is `https:` (any host) because Luma lets organizers point covers
    // at arbitrary CDNs (lumacdn, unsplash, …); allow-listing hosts was whack-a-
    // mole and silently broke the odd external cover. Covers now route through the
    // same-origin /cover proxy anyway, so 'self' carries them — `https:` is the
    // belt-and-suspenders net for the proxy's full-size fallback redirect path.
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  // parity with the _headers set: this is a first-class page of the site
  // (the shared XP shell runs here too), so deny the same unused browser APIs.
  // tokens must be ones a shipping browser still recognizes, or they're inert
  // and log a console error: `browsing-topics` went the way of `interest-cohort`
  // when Chrome removed the Topics API feature (dropped here 2026-07).
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), midi=(), accelerometer=(), gyroscope=(), magnetometer=(), screen-wake-lock=(), hid=(), idle-detection=()",
};

export function withSerendipitySecurityHeaders(response) {
  if (response.status >= 300 && response.status < 400) return response;
  const contentType = response.headers.get("content-type") || "";
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SERENDIPITY_SECURITY_HEADERS)) {
    // CSP only matters for HTML documents; JSON endpoints inherit the root
    // Worker defaults when the outer dispatcher applies its common headers.
    if (key === "content-security-policy" && !contentType.startsWith("text/html")) continue;
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
