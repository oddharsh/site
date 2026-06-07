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
  const opt = { weekday: "short", month: "short", day: "numeric" };
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
  if (isNaN(d)) return "";
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
            (SELECT GROUP_CONCAT(COALESCE(uc.label, 'unnamed-' || substr(ec.user_key,1,4)), ', ')
               FROM event_contributions ec
               LEFT JOIN user_cookies uc ON uc.user_key = ec.user_key
              WHERE ec.event_id = e.id) AS contributors
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
    `SELECT a.id AS attendee_id, a.name, a.bio_short, a.times_seen, ea.is_host,
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
    `SELECT COALESCE(uc.label, 'unnamed-' || substr(ec.user_key,1,4)) AS label, uc.enabled AS enabled
       FROM event_contributions ec
       LEFT JOIN user_cookies uc ON uc.user_key = ec.user_key
      WHERE ec.event_id = ?
      ORDER BY ec.contributed_at DESC`
  ).all(id);
}
async function countContributors(d) {
  const r = await d.prepare(`SELECT COUNT(*) AS n FROM user_cookies WHERE enabled = 1`).get();
  return r ? Number(r.n) : 0;
}

// ── chrome: self-contained Luna window (ported from aadhar.sh xpChromeCss) ───
function shellCss() {
  return `
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;min-height:100%}
  body{background:linear-gradient(160deg,oklch(70% 0.11 240) 0%,oklch(78% 0.075 235) 45%,oklch(85% 0.045 235) 100%);background-attachment:fixed;font-family:var(--font-ui);font-size:12px;line-height:1.5;color:oklch(16% 0 0);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased;scrollbar-color:oklch(64% 0.13 255) oklch(90% 0.025 250)}
  a{color:oklch(42% 0.235 264);text-decoration:underline}
  a:hover{color:oklch(60% 0.25 29)}
  h1,h2,h3{font-family:var(--font-caption);margin:0}
  .wrap{max-width:980px;margin:22px auto;padding:0 12px 48px}
  .window{background:#fff;border:2px solid #0831d9;border-right-color:#001ea0;border-bottom-color:#001ea0;border-top-left-radius:8px;border-top-right-radius:8px;overflow:hidden;box-shadow:inset 1px 1px 0 #166aee,inset 2px 2px 0 #0855dd,inset -1px -1px 0 #00138c,inset -2px -2px 0 #003bda,6px 6px 24px -6px rgba(0,20,90,.5)}
  .titlebar{display:flex;align-items:center;gap:6px;padding:4px 6px 4px 8px;font:bold 10pt "Trebuchet MS",Verdana,sans-serif;color:#fff;text-shadow:1px 1px #0f1089;border-bottom:1px solid #00138c;background:linear-gradient(180deg,oklch(70% 0.15 258) 0%,oklch(60% 0.20 261) 8%,oklch(51% 0.225 263) 18%,oklch(50% 0.225 263) 86%,oklch(58% 0.18 260) 100%)}
  .titlebar .ico{width:18px;height:18px;flex:0 0 auto;background:oklch(69.58% 0.2043 43.49);border-radius:0;position:relative}
  .titlebar .ico::before{content:"";position:absolute;inset:3px 4px;background:oklch(87.82% 0.0877 66.27);clip-path:polygon(50% 0,100% 100%,0 100%)}
  .titlebar .t{flex:1}
  .titlebar .x{width:21px;height:21px;border-radius:0;position:relative;border:1px solid #d8401c;text-decoration:none;background:linear-gradient(180deg,#e8795f,#e45f40 30%,#e45d3d 52%,#e2552a 80%,#ae3110)}
  .titlebar .x::before,.titlebar .x::after{content:"";position:absolute;left:50%;top:50%;width:13px;height:2px;margin:-1px 0 0 -6.5px;background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.35)}
  .titlebar .x::before{transform:rotate(45deg)}.titlebar .x::after{transform:rotate(-45deg)}
  .body{display:flex;min-height:520px}
  /* under the shared OS-window model nav.js scrolls .window>.body; for this
     master-detail layout, scroll the main .content instead so the sidebar
     fills the full window height (no mid-scroll cutoff / "weird spot"). */
  .window>.body{overflow:hidden !important}
  .body>.content{overflow:auto;min-height:0}
  .pane{width:200px;flex:0 0 auto;border-right:2px solid #7a96c8;background:linear-gradient(180deg,oklch(90% 0.055 245),oklch(93% 0.038 245));padding:12px}
  .pane .brand{display:block;padding:2px 4px 10px;color:oklch(16% 0 0);text-decoration:none}
  .pane .brand b{font:600 16pt "Trebuchet MS",Verdana,sans-serif;display:block;line-height:1}
  .pane .brand span{font-size:10px;color:oklch(45% 0.01 250)}
  .pane-head{font:bold 8.5pt "Trebuchet MS",Verdana,sans-serif;color:#fff;padding:3px 10px;border-radius:3px 3px 0 0;text-shadow:0 1px 1px rgba(0,30,90,.5);background:linear-gradient(180deg,oklch(66% 0.16 255),oklch(54% 0.20 260))}
  .pane-body{border:1px solid #bcd0ec;border-top:0;background:rgba(255,255,255,.55);padding:4px;display:flex;flex-direction:column}
  .pane-body a{padding:3px 8px;border-radius:0;text-decoration:none;color:oklch(42% 0.235 264)}
  .pane-body a:hover{background:#2f6fde;color:#fff}
  .pane-body a.current{background:#3a6ea5;color:#fff;font-weight:bold}
  .pane .foot{margin-top:14px;padding-top:8px;border-top:1px solid #a8c0e0;font-size:10px;color:oklch(45% 0.01 250)}
  .content{flex:1;min-width:0;padding:22px 26px}
  h1.page{font-size:19pt;font-weight:bold;color:oklch(33% 0.10 255);margin:0 0 2px;letter-spacing:-.01em}
  .lede{color:oklch(40% 0.01 250);font-size:11px;margin:0 0 16px;max-width:62ch}
  hr.sep{border:0;border-top:1px solid oklch(85% 0.03 250);margin:14px 0}
  .grp{font:bold 8.5pt "Trebuchet MS";text-transform:uppercase;letter-spacing:.06em;color:oklch(45% 0.02 255);margin:18px 0 8px}
  /* event card — sunken-bevel list item */
  .ev{display:block;text-decoration:none;color:inherit;border:1px solid oklch(80% 0.035 250);border-top-color:oklch(70% 0.05 250);border-left-color:oklch(70% 0.05 250);background:#fff;padding:10px 12px;margin:0 0 7px;border-radius:0}
  .ev:hover{border-color:oklch(50% 0.18 263);background:oklch(98% 0.02 250)}
  .ev .nm{font-weight:bold;color:oklch(20% 0.02 255);font-size:13px}
  .ev .meta{color:oklch(45% 0.01 250);font-size:11px;margin-top:2px}
  .ev .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}
  .count{font-size:11px;color:oklch(42% 0.02 255)}
  .badge{display:inline-block;font:bold 9px Tahoma;padding:1px 6px;border:1px solid;border-radius:0;text-transform:uppercase;letter-spacing:.04em}
  .badge.via{background:oklch(96% 0.02 250);color:oklch(42% 0.03 255);border-color:oklch(80% 0.04 250);font-weight:normal;text-transform:none}
  .badge.past{background:oklch(95% 0 0);color:oklch(45% 0 0);border-color:oklch(78% 0 0)}
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
     the page stays compact; the button is the manual reveal. */
  .evdesc{white-space:pre-wrap;margin:0 0 16px;padding:10px 12px;background:oklch(98% 0.005 250);border:1px solid oklch(85% 0.015 250);border-radius:0;font-size:12px;color:oklch(28% 0.01 250);max-width:64ch}
  .att .who{min-width:0;flex:1}
  .att .who .n{font-weight:bold;color:oklch(20% 0.02 255)}
  .att .who .sub{font-size:11px;color:oklch(45% 0.01 250);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .att .soc{display:flex;gap:6px;flex:0 0 auto}
  .att .soc a{font-size:10px}
  .empty{text-align:center;color:oklch(50% 0.01 250);padding:34px 12px;border:1px dashed oklch(78% 0.04 250);border-radius:0;background:oklch(98% 0.01 250)}
  .xp-button{display:inline-block;min-width:73px;padding:4px 14px;font:8pt/1.3 Tahoma;color:#000;cursor:pointer;border:1px solid #8e9dad;border-radius:0;text-decoration:none;background:linear-gradient(180deg,#fff,#fdfdfd 45%,#f3f2ec 55%,#e9e7dc)}
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
  .chip{font:8.5pt Tahoma;padding:3px 11px;border:1px solid #8e9dad;border-radius:0;background:linear-gradient(180deg,#fff,#f3f2ec);color:#222;cursor:pointer}
  .chip.on{color:#fff;border-color:#2c4d7e;font-weight:bold;background:linear-gradient(180deg,#5b9bf0,#2f6fde 60%,#2a60cc)}
  .ev[hidden],.grp[hidden]{display:none}
  .empty-filter{display:none;color:oklch(50% 0.01 250);padding:24px 12px;border:1px dashed oklch(78% 0.04 250);border-radius:0;background:oklch(98% 0.01 250);text-align:center;font-size:11px}
  /* cursor-following cover tooltip — ported from the homepage photo/car-link tooltip.
     --x/--y are typed <length> so the translate() positions it with no JS rAF; clamp
     keeps it on-screen. only events with a cover_url get one. */
  @property --x { syntax:"<length>"; inherits:false; initial-value:0px }
  @property --y { syntax:"<length>"; inherits:false; initial-value:0px }
  #ev-tip{position:fixed;z-index:9999;top:0;left:0;display:none;pointer-events:none;
    transform:translate(clamp(4px,calc(var(--x) + 18px),calc(100vw - 100% - 8px)),clamp(4px,calc(var(--y) + 18px),calc(100vh - 100% - 8px)))}
  #ev-tip.on{display:block}
  /* show the WHOLE banner — fixed width, natural aspect (no crop): Luma covers
     often place text/faces near an edge that object-fit:cover would chop. height:
     auto follows the image; max-height caps a rare portrait cover, with contain
     letterboxing inside it (bg fills) rather than distorting. */
  #ev-tip img{display:block;width:300px;height:auto;max-height:340px;object-fit:contain;background:oklch(94% 0.005 240);border:3px solid #fff;outline:1px solid oklch(61% 0.061 253);outline-offset:-1px;box-shadow:2px 3px 12px -2px rgba(0,20,90,.55)}
  @media(max-width:640px){.body{flex-direction:column}.pane{width:auto;border-right:0;border-bottom:2px solid #7a96c8}}`;
}

function shell(title, currentPath, bodyHtml) {
  const nav = (href, label) => {
    const full = PREFIX + href;
    const cur = currentPath === full || (href !== "" && currentPath.startsWith(full));
    return `<a href="${full || PREFIX}"${cur ? ' class="current"' : ""}>${label}</a>`;
  };
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Serendipity</title>
<meta name="description" content="A public, shared database of events worth going to and who's going — fed by the collective, queryable by humans and agents.">
<style>:root{--font-caption:"Trebuchet MS",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:"Courier New",Courier,monospace}${shellCss()}</style></head><body>
<div class="wrap"><div class="window">
  <div class="titlebar"><span class="ico" aria-hidden="true"></span>
    <span class="t">Serendipity Collective — aadhar.sh</span>
    <a class="x" href="/" title="back to aadhar.sh" aria-label="back to aadhar.sh"></a>
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
</div></div>
  <script src="/nav.js" defer></script>
</body></html>`;
}

// ── pages ────────────────────────────────────────────────────────────────────
function eventCard(e, isPast) {
  const contributors = (e.contributors || "").split(", ").filter(Boolean);
  const counts = [];
  if (Number(e.host_count) > 0) counts.push(`${e.host_count} host${e.host_count == 1 ? "" : "s"}`);
  if (Number(e.attendee_count) > 0) counts.push(`${e.attendee_count} going`);
  const d = e.start_at ? new Date(e.start_at) : null;
  return `<a class="ev" href="${PREFIX}/event/${esc(e.id)}" data-start="${esc(e.start_at || "")}"${e._coverHref ? ` data-cover="${esc(e._coverHref)}"` : ""}>
    <div class="nm">${esc(e.name)}</div>
    <div class="meta">${d ? esc(fmtDateTime(e.start_at)) : "date TBD"}${isPast && d ? ` · ${esc(relativeTime(d))}` : ""}${e.location ? " · " + esc(e.location) : ""}</div>
    <div class="row">
      ${counts.length ? `<span class="count">${counts.join(" · ")}</span>` : `<span class="count" style="color:oklch(60% 0 0)">no guest list yet</span>`}
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
  if(tip&&!matchMedia('(hover: none)').matches){
    var cur=null,lastX=0,lastY=0,hideT=0;
    // dismissal is deferred by TIP_DISMISS_MS so hopping card→card across the gap
    // doesn't flash the cover off-then-on; a fresh pointerover cancels it, but if the
    // cursor rests in the gap the cover still clears after the delay (no tooltip in
    // dead space). mirrors the homepage tooltip's TIP_DISMISS_MS — separate deploy,
    // same setting (keep the two in sync).
    var TIP_DISMISS_MS=50;
    function cancelHide(){ clearTimeout(hideT); hideT=0; }
    function scheduleHide(){ clearTimeout(hideT); hideT=setTimeout(hide, TIP_DISMISS_MS); }
    function show(a){ cancelHide(); cur=a; var img=new Image(); img.loading='lazy'; img.decoding='async'; img.alt=''; img.src=a.getAttribute('data-cover'); tip.textContent=''; tip.appendChild(img); tip.classList.add('on'); }
    function hide(){ cur=null; tip.classList.remove('on'); tip.textContent=''; }
    document.addEventListener('pointerover',function(e){
      lastX=e.clientX; lastY=e.clientY;
      var a=e.target.closest&&e.target.closest('.ev[data-cover]');
      if(a){ cancelHide(); if(a!==cur)show(a); return; }
      if(cur)scheduleHide();   // only when a cover is open — no timer churn on plain mouse moves
    },{passive:true});
    document.addEventListener('pointermove',function(e){ lastX=e.clientX; lastY=e.clientY; if(!cur)return; tip.style.setProperty('--x',lastX+'px'); tip.style.setProperty('--y',lastY+'px'); },{passive:true});
    document.addEventListener('pointerout',function(e){ if(cur&&!e.relatedTarget)scheduleHide(); });
    // scroll re-evaluation (ported from the homepage tooltip): the tip is
    // position:fixed and the cursor stays put during scroll, but the CARD under
    // it shifts — browsers (Safari esp.) don't reliably fire pointer enter/leave
    // for that, so without this the cover stays stuck on a row no longer under
    // the pointer. each scroll tick (rAF-coalesced) we look up what's actually
    // under the cursor and re-target or hide. --x/--y stay correct (no cursor move).
    var sf=0;
    function reeval(){ sf=0; if(!cur)return; var u=document.elementFromPoint(lastX,lastY); var a=u&&u.closest&&u.closest('.ev[data-cover]'); if(!a){scheduleHide();return;} if(a!==cur)show(a); }
    document.addEventListener('scroll',function(){ if(!cur)return; if(!sf)sf=requestAnimationFrame(reeval); },{capture:true,passive:true});
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
    const upcoming = events.filter((e) => !e.start_at || new Date(e.start_at).getTime() >= now);
    const pastAll = events.filter((e) => e.start_at && new Date(e.start_at).getTime() < now)
                          .sort((a, b) => new Date(b.start_at) - new Date(a.start_at));
    const past = pastAll.slice(0, PAST_CAP);
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
      ${upcoming.length ? `<div class="grp" data-grp>Upcoming (${upcoming.length})</div>${upcoming.map((e) => eventCard(e, false)).join("")}` : ""}
      ${pastAll.length ? `<div class="grp" data-grp>Past ${pastAll.length > PAST_CAP ? `(${PAST_CAP} most recent of ${pastAll.length})` : `(${pastAll.length})`}</div>${past.map((e) => eventCard(e, true)).join("")}` : ""}
      <p class="empty-filter" id="ev-none">No events match — clear the search or pick a wider range.</p>
      <div id="ev-tip" aria-hidden="true"></div>
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

    <div class="grp">Add an event by link</div>
    <p class="note" style="margin:0 0 8px">Paste public Luma event links (<code>lu.ma/&hellip;</code> or <code>luma.com/&hellip;</code>) &mdash; one per line. No login needed; we pull each event&apos;s details into the pool. The full guest list fills in once someone going syncs their feed.</p>
    <form method="POST" action="${PREFIX}/add-event">
      <textarea class="xp-field" name="links" rows="3" placeholder="https://lu.ma/your-event&#10;https://luma.com/another-one" autocomplete="off" spellcheck="false"></textarea>
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
function parseCookies(raw) {
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
  const body = `<h1 class="page">For agents</h1>
    <p class="lede">Serendipity is built to be queried by agents, not just people. A read-only MCP (Model Context Protocol) endpoint is coming at <code>${PREFIX}/mcp</code> — point an MCP client at it and call tools like <code>list_events</code>, <code>get_event</code>, and <code>search_people</code> to ask "what events are good and who's going."</p>
    <div class="empty" style="text-align:left"><p class="note" style="margin:0">The MCP + JSON endpoints land in a later build phase. The data model and query layer that back them already exist.</p></div>`;
  return html(200, shell("For agents", path, body));
}

// ════════════════════════════════════════════════════════════════════════════
// Luma client + sync — ported 1:1 from the Next app's lib/{luma,luma-auth,sync}.
// Server-side fetch to Luma's internal API using a contributor's stored cookies.
// ════════════════════════════════════════════════════════════════════════════
const LUMA_API = "https://api2.luma.com";

function cookieHeaderFrom(cookiesJson) {
  try {
    const data = JSON.parse(cookiesJson);
    return (data.cookies || []).map((c) => `${c.name}=${c.value}`).join("; ");
  } catch { return null; }
}
function selfIdFrom(cookiesJson) {
  try {
    const auth = (JSON.parse(cookiesJson).cookies || []).find((c) => c.name === "luma.auth-session-key");
    if (!auth) return null;
    const dot = auth.value.indexOf(".");
    const uid = dot === -1 ? auth.value : auth.value.slice(0, dot);
    return uid.startsWith("usr-") ? uid : null;
  } catch { return null; }
}
async function lumaFetch(url, cookieHeader) {
  const res = await fetch(url, { headers: { "Content-Type": "application/json", Cookie: cookieHeader, "x-luma-web-url": "https://lu.ma" } });
  if (!res.ok) { const b = await res.text().catch(() => ""); throw new Error(`Luma ${res.status}: ${b.slice(0, 200)}`); }
  return res;
}
async function fetchMe(cookieHeader) {
  try {
    const data = await (await lumaFetch(`${LUMA_API}/user/get-self`, cookieHeader)).json();
    const u = data.user ?? data;
    return u.api_id ? { api_id: u.api_id, name: u.name ?? "" } : null;
  } catch { return null; }
}
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
async function fetchMyEvents(cookieHeader, selfId) {
  const all = [];
  for (const period of ["future", "past"]) {
    // page caps kept low: Cloudflare limits subrequests (fetch calls) per Worker
    // invocation. ~10 fetches total stays well under the cap; full backfill is a
    // cron/cursor job (future). Future events matter most, so it gets more pages.
    let cursor = null, page = 0, max = period === "past" ? 2 : 6;
    while (page < max) {
      page++;
      const p = new URLSearchParams({ pagination_limit: "50", period });
      if (cursor) p.set("pagination_cursor", cursor);
      const data = await (await lumaFetch(`${LUMA_API}/home/get-events?${p}`, cookieHeader)).json();
      all.push(...parseEvents(data, selfId));
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
  }
  return all;
}
async function fetchEventGuests(eventId, ticketKey, cookieHeader) {
  const all = []; let cursor = null;
  while (true) {
    const p = new URLSearchParams({ event_api_id: eventId, ticket_key: ticketKey, pagination_limit: "100" });
    if (cursor) p.set("pagination_cursor", cursor);
    const data = await (await lumaFetch(`${LUMA_API}/event/get-guest-list?${p}`, cookieHeader)).json();
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
async function fetchEventDescription(eventId, cookieHeader) {
  const p = new URLSearchParams({ event_api_id: eventId });
  let res;
  // deleted/private events 400/404 — lumaFetch throws; treat as "no description".
  try { res = await lumaFetch(`${LUMA_API}/event/get?${p}`, cookieHeader); }
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

// single-statement attendee upsert (batch-friendly — no read-then-write).
// preserves email/first_seen_at/times_seen on conflict; refreshes profile fields.
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
  const cookieHeader = cookieHeaderFrom(cookiesJson);
  if (!cookieHeader) return { error: "bad cookie json" };
  try {
    const selfId0 = selfIdFrom(cookiesJson);
    const [events, me] = await Promise.all([fetchMyEvents(cookieHeader, selfId0), fetchMe(cookieHeader)]);
    const selfId = me?.api_id ?? selfId0;
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
    return { synced: events.length, statements: S.length };
  } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
}

// add events to the pool from pasted Luma links (no cookies needed). caps at 8
// links/submission so 2 subrequests each (resolve + fetch) stays under the limit.
// records the event + its hosts + a contribution by this uid. Returns {added,names,failed}.
async function addEventsByLink(d, uid, raw) {
  const urls = (raw || "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8);
  const S = [], names = [], failed = [];
  for (const u of urls) {
    let r;
    try { r = await fetchEventByLink(u); } catch (e) { r = { error: String(e) }; }
    if (!r || r.error || !r.event) { failed.push(u.replace(/^https?:\/\//, "").slice(0, 32)); continue; }
    const e = r.event;
    // link-added events are user_status 'unknown' (the submitter isn't necessarily
    // going); a later cookie-sync by an attendee upgrades it + fills the guest list.
    S.push(d.stmt(UPSERT_EVENT, e.id, e.name, e.description, e.start_at, e.end_at, e.location, e.cover_url, e.url, e.geo_latitude, e.geo_longitude, null, "unknown"));
    S.push(d.stmt(`INSERT INTO event_contributions (event_id,user_key,contributed_at) VALUES (?,?,datetime('now')) ON CONFLICT(event_id,user_key) DO UPDATE SET contributed_at=datetime('now')`, e.id, uid));
    for (const h of e.hosts) {
      if (!h.id) continue;
      S.push(attendeeStmt(d, h));
      S.push(d.stmt(`INSERT INTO event_attendees (event_id,attendee_id,is_host) VALUES (?,?,1) ON CONFLICT(event_id,attendee_id) DO UPDATE SET is_host=1`, e.id, h.id));
    }
    names.push(e.name || e.id);
  }
  if (S.length) await d.batch(S);
  return { added: names.length, names, failed };
}

// POST /serendipity/add-event — public: add events to the pool by Luma link.
async function handleAddEvent(request, env, d, uid) {
  const back = (msg, toDash) => new Response(null, { status: 303, headers: { location: `${PREFIX}${toDash ? "" : "/contribute"}?msg=${encodeURIComponent(msg)}` } });
  let form;
  try { form = await request.formData(); } catch { return back("Couldn't read the form"); }
  const raw = (form.get("links") || "").toString();
  if (!raw.trim()) return back("Paste at least one Luma event link");
  let r;
  try { r = await addEventsByLink(d, uid, raw); } catch (e) { return back("Add failed: " + (e instanceof Error ? e.message : String(e))); }
  if (!r.added) return back("Couldn't resolve those — make sure they're public Luma event links");
  let msg = `Added ${r.added} event${r.added === 1 ? "" : "s"} to the pool` + (r.names[0] ? `: ${r.names.slice(0, 2).join(", ")}${r.names.length > 2 ? " …" : ""}` : "");
  if (r.failed.length) msg += ` · ${r.failed.length} couldn't be resolved`;
  return back(msg, true);
}

// sync one event's full guest list (batched writes). Returns {synced} or {error}.
async function syncGuests(d, eventId, cookiesJson) {
  const cookieHeader = cookieHeaderFrom(cookiesJson);
  if (!cookieHeader) return { error: "bad cookie json" };
  const ev = await d.prepare("SELECT ticket_key, user_status FROM events WHERE id = ?").get(eventId);
  if (!ev) return { error: "event not found" };
  if (ev.user_status !== "going") return { error: `status is ${ev.user_status}, not going` };
  if (!ev.ticket_key) return { error: "no ticket_key" };
  const selfId = selfIdFrom(cookiesJson);
  try {
    const guests = await fetchEventGuests(eventId, ev.ticket_key, cookieHeader);
    const S = [];
    for (const g of guests) {
      if (!g.id || g.id === selfId) continue;
      S.push(attendeeStmt(d, g));
      S.push(d.stmt(`INSERT INTO event_attendees (event_id,attendee_id) VALUES (?,?) ON CONFLICT(event_id,attendee_id) DO NOTHING`, eventId, g.id));
    }
    await d.batch(S);
    return { synced: guests.length };
  } catch (err) { const m = err instanceof Error ? err.message : String(err); return { error: m.includes("403") ? "GUEST_LIST_RESTRICTED" : m }; }
}

// throttled description backfill. the list-sync omits descriptions, and fetching
// detail for every event in one go would blow the per-invocation subrequest cap,
// so each call fills up to `limit` events (one Luma fetch each) and reports how
// many remain — re-run until remaining hits 0. Returns {scanned,filled,remaining}.
async function syncDescriptions(d, cookiesJson, limit) {
  const cookieHeader = cookieHeaderFrom(cookiesJson);
  if (!cookieHeader) return { error: "bad cookie json" };
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
      try { desc = await fetchEventDescription(row.id, cookieHeader); } catch { desc = null; }  // never let one event abort the batch
      // always stamp the attempt; set description only when we got text.
      S.push(d.stmt(`UPDATE events SET description = COALESCE(?, description), desc_synced_at = datetime('now') WHERE id = ?`, desc, row.id));
      if (desc) filled++;
    }
    if (S.length) await d.batch(S);
    const rem = await d.prepare(`SELECT COUNT(*) AS n FROM events WHERE description IS NULL AND desc_synced_at IS NULL`).get();
    return { scanned: todo.length, filled, remaining: rem?.n || 0 };
  } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
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
  const set = await d.prepare("SELECT cookies_json, label FROM user_cookies WHERE enabled = 1 LIMIT 1").get();
  if (!set) return new Response(JSON.stringify({ ok: false, error: "no enabled cookies" }), { status: 400, headers: { "content-type": "application/json" } });
  const r = await syncDescriptions(d, set.cookies_json, limit);
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
    if (eventId) out.push({ label: s.label, event: eventId, ...(await syncGuests(d, eventId, s.cookies_json)) });
    else out.push({ label: s.label, ...(await syncEvents(d, s.user_key, s.cookies_json)) });
  }
  return new Response(JSON.stringify({ ok: true, results: out }, null, 2), { headers: { "content-type": "application/json" } });
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

// secret-gated: POST /serendipity/enrich?key=SECRET&attendee=<id>  (single)
//                                         &event=<id>&limit=6      (bulk, un-enriched)
async function handleEnrich(request, env, d) {
  const url = new URL(request.url);
  if (!env.SYNC_SECRET || url.searchParams.get("key") !== env.SYNC_SECRET) return new Response("forbidden", { status: 403 });
  const key = env.EXA_API_KEY;
  if (!key) return new Response(JSON.stringify({ error: "EXA_API_KEY not set" }), { status: 400, headers: { "content-type": "application/json" } });
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
      ORDER BY a.times_seen DESC LIMIT ?`).all(eid, limit);
  } else return new Response(JSON.stringify({ error: "pass ?attendee= or ?event=" }), { status: 400, headers: { "content-type": "application/json" } });

  const out = [];
  for (const a of targets) out.push({ name: a.name, ...(await enrichViaExa(d, key, a, !!aid)) });
  return new Response(JSON.stringify({ ok: true, enriched: out }, null, 2), { headers: { "content-type": "application/json" } });
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

  if (setCookie) {
    const h = new Headers(res.headers);
    h.append("set-cookie", setCookie);
    res = new Response(res.body, { status: res.status, headers: h });
  }
  return res;
}

// ── standalone Worker entry (deployed on a aadhar.sh/serendipity/* route) ────
// Self-contained: own security headers, no dependency on the Pages _worker.js.
const SECURITY_HEADERS = {
  "content-security-policy":
    // img-src is `https:` (any host) because Luma lets organizers point covers
    // at arbitrary CDNs (lumacdn, unsplash, …); allow-listing hosts was whack-a-
    // mole and silently broke the odd external cover. Covers now route through the
    // same-origin /cover proxy anyway, so 'self' carries them — `https:` is the
    // belt-and-suspenders net for the proxy's full-size fallback redirect path.
    "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
};

export default {
  async fetch(request, env, ctx) {
    // canonical host: anything landing on the *.workers.dev subdomain gets
    // 301'd to the equivalent path on aadhar.sh (no duplicate public footprint).
    const u = new URL(request.url);
    if (u.hostname.endsWith(".workers.dev")) {
      return new Response(null, { status: 301, headers: { location: `https://aadhar.sh${u.pathname}${u.search}`, "cache-control": "public, max-age=3600" } });
    }
    const res = await handleSerendipity(request, env, ctx);
    if (res.status >= 300 && res.status < 400) return res;
    const ct = res.headers.get("content-type") || "";
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      // CSP only matters for HTML documents; skip it on JSON (MCP/api) responses
      if (k === "content-security-policy" && !ct.startsWith("text/html")) continue;
      if (!h.has(k)) h.set(k, v);
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  },
};
