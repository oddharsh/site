// updates.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { cachedRender } from "./lib/cache.ts";
import { lunaPage } from "./lib/chrome.ts";
import { esc } from "./lib/http.ts";
import checkpoints from "./checkpoints.json" with { type: "json" };

// ── /updates handler (Windows Update reskin) ────────────────────────
export async function handleWindowsUpdate(request, env, ctx) {
  // Version-keyed edge cache (caches.default): the changelog changes only on
  // deploy, and a deploy mints a fresh cache key, so the rendered shell serves
  // for up to s-maxage=300 without re-querying D1 on every visit.
  return cachedRender(request, ctx, () => readCheckpoints(env).then(renderWindowsUpdate), "/updates", env);
}

// The deploy log, read ONCE and handed to the three renderers that project it.
//
// D1 stays the single source of truth. This function is the only thing that talks to
// it, which is what keeps /updates, /updates.json and /restore from drifting apart —
// previously each ran its own SELECT with its own LIMIT and its own error handling.
//
// It also makes the three renderers PURE, so build.mjs can call them in Node against
// the committed projection (www/_worker.js/checkpoints.json, written by
// bump-version.sh) and emit updates.html + restore.html at deploy time. Those two
// pages are the only dynamic surfaces whose data changes ONLY at deploy — the
// checkpoint row is inserted moments before it — so baking them costs no freshness
// at all, unlike /reading or /around whose feeds move on their own.
export async function readCheckpoints(env) {
  // The BUNDLED projection, not a D1 read, and that is the point.
  //
  // /updates and /restore are precomputed from this file at build time. If this
  // function went to D1 at runtime, /updates.json would answer from a different
  // source than the two HTML pages render from, and the three could disagree the
  // moment a checkpoint landed without a deploy. CLAUDE.md calls out that /updates
  // and /restore reading one table "is what stops those two pages drifting apart";
  // reading one committed file is the same guarantee, made stronger — all three
  // surfaces now serve literally the same bytes rather than the same query.
  //
  // D1 remains the source of truth: bump-version.sh writes it and then derives this
  // file from it, and `pnpm run checkpoints:check` fails on any drift between them.
  // env is kept in the signature because the handlers pass it and a future caller
  // may want the live table; nothing here needs it today.
  return { points: checkpoints, state: checkpoints.length ? "ok" : "empty" };
}

export async function renderWindowsUpdate(cp) {
  // Single source of truth: the same D1 `checkpoints` table that backs /restore.
  // One row per logged deploy (scripts/bump-version.sh, which now derives the
  // next vnum from this table; the retired service worker used to carry it as
  // CACHE_VERSION). The newest row is the running build and the recent rows ARE
  // the changelog, so /updates and /restore cannot drift apart. Degrades
  // gracefully when RESTORE_DB is unbound, mirroring /restore.
  const state = cp.state;
  const pts = cp.points.slice(-18).reverse();          // newest first, same as the old DESC LIMIT 18
  let build = "aadhar.sh", log = [];
  if (pts.length) { build = pts[0].version; log = pts.map((p) => [p.slug, p.title]); }
  const rows = log.length
    ? log.map(([tag, desc]) =>
        `<li><span class="wu-tag">${esc(tag)}</span><span class="wu-desc">${esc(desc)}</span></li>`).join("\n      ")
    : `<li><span class="wu-desc">${esc(
        state === "unbound" ? "The update log lives in a Cloudflare D1 database (aadhar-restore) being connected to this page."
        : state === "error" ? "The update log did not answer just now; it is backed by Cloudflare D1 and this page stays read-only either way."
        : "No updates recorded yet."
      )}</span></li>`;
  return lunaPage({
    title: "Windows Update · aadhar.sh",
    path: "Windows Update",
    route: "/updates",
    width: 620,
    description: "What has shipped to this site lately, in a Windows Update reskin. Read-only.",
    robots: "noindex",
    css: `
h1{margin:0 0 4px}
.wu-ok{display:flex;align-items:center;gap:11px;border:1px solid #9cc97f;background:linear-gradient(180deg,#f0f8ea,#e2f1d6);border-radius:4px;padding:11px 13px;margin:0 0 13px}
.wu-ok .ck{width:34px;height:34px;flex:0 0 34px;border-radius:50%;background:linear-gradient(180deg,#62b043,#3c8f24);display:grid;place-items:center}
.wu-ok .ck svg{width:20px;height:20px}
.wu-ok b{font-family:var(--font-caption);font-size:11.5pt;color:#2c6a1e}
.wu-ok .sub{font-size:8.5pt;color:#5a7a4a}
.wu-ok .sub .mono{font-family:var(--font-mono)}
.wu-list{list-style:none;margin:6px 0 0;padding:0}
.wu-list li{display:flex;gap:9px;align-items:baseline;padding:6px 2px;border-bottom:1px solid #eef2f7;font-size:9.5pt;color:#33415c}
.wu-tag{flex:0 0 92px;font-family:var(--font-mono);font-size:8pt;color:#7a4eb0;background:#f3edfb;border:1px solid #e0d4f3;border-radius:3px;padding:1px 5px;text-align:center}
.wu-desc{flex:1}
.wu-foot{font-size:8.5pt;color:#6b7280;border-top:1px solid #e2e8f0;padding-top:8px;margin-top:11px}
`,
    body: `
    <h1>Windows Update</h1>
    <div class="wu-ok">
      <span class="ck"><svg viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg></span>
      <div><b>aadhar.sh is up to date.</b><div class="sub">running build <span class="mono">${esc(build)}</span>. updates install themselves at deploy time, so you never click "restart now."</div></div>
    </div>
    <h2>Recently installed</h2>
    <ul class="wu-list">
      ${rows}
    </ul>
    <p class="wu-foot">No reboot, no nagging. Each item is a real deploy from the site's checkpoint log; see how delivery works in <a href="/security">Security Center</a>, or roll the whole system back through every past build in <a href="/restore">System Restore</a>.</p>
`,
    cache: "public, max-age=0, s-maxage=300",
    closeHref: "/security",
    closeTitle: "back to Security Center",
    closeLabel: "back to Security Center",
    headers: {
      "x-robots-tag":    "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

// brief JSON for the Windows Update tray balloon: running build + recent changelog,
// read from the same D1 checkpoints log as /updates and /restore.
export async function handleUpdatesJson(request, env, ctx) {
  return cachedRender(request, ctx, () => readCheckpoints(env).then(renderUpdatesJson), "/updates.json", env);
}

export async function renderUpdatesJson(cp) {
  const pts = cp.points.slice(-8).reverse();           // newest first, same as the old DESC LIMIT 8
  let build = "aadhar.sh", items = [];
  if (pts.length) { build = pts[0].version; items = pts.map((p) => ({ slug: p.slug, title: p.title })); }
  return new Response(JSON.stringify({ build, items }), {
    headers: {
      "content-type":    "application/json; charset=utf-8",
      "cache-control":   "public, max-age=0, s-maxage=300",
      "x-robots-tag":    "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

// ── /restore handler (Windows System Restore reskin, backed by D1) ───
// Restore points live in the aadhar-restore D1 database, one row per logged
// deploy (bump-version.sh insert), seeded from this repo's git history. The
// scrubber previews the recorded state at any past point; it changes nothing.
// A real rollback is a destructive D1 Time Travel restore run from the CLI
// (7-day window on the free plan), never exposed to a visitor. env.RESTORE_DB
// is a dashboard binding; this page degrades gracefully when it is absent.
export async function handleSystemRestore(request, env, ctx) {
  return cachedRender(request, ctx, () => readCheckpoints(env).then(renderSystemRestore), "/restore", env);
}

export async function renderSystemRestore(cp) {
  const points = cp.points;
  const state = cp.state;
  // "You are here" tracks the newest checkpoint in D1, so it can't go stale on deploy
  // the way a hardcoded constant did. Backfill recent deploys into the log to keep it current.
  const newest = points.length ? points[points.length - 1] : null;
  const live = newest
    ? { version: newest.version, title: newest.title, ymd: newest.ymd }
    : { version: "aadhar.sh", title: "live build", ymd: "" };

  const liveBar =
    `<div class="sr-now"><span class="pin"></span><div><b>You are here.</b>` +
    `<div class="sub">current system: <span class="mono">${esc(live.version)}</span>` +
    ` &middot; ${esc(live.title)} &middot; shipped ${esc(live.ymd)}</div></div></div>`;

  let main;
  if (state === "ok") {
    const data = points.map(p => ({ v: p.vnum, d: p.ymd, ver: p.version, t: p.title }));
    main =
`    <p class="sr-lede">Windows kept a calendar of restore points so you could roll the system back to an earlier day. These are real: one point per deploy, logged in a Cloudflare D1 database and seeded from this site's own git history. Drag the scrubber to preview the system as it stood at any point. Nothing here changes anything.</p>
    <div class="sr-stage">
      <div class="sr-listwrap"><div class="sr-listhead">Restore points</div><div class="sr-list" id="srList"></div></div>
      <div class="sr-detail" id="srDetail"></div>
    </div>
    <div class="sr-scrub">
      <span class="sr-scrub-end">${esc(points[0].ymd)}</span>
      <input type="range" id="srRange" min="0" max="${points.length - 1}" value="${points.length - 1}" step="1" aria-label="restore point">
      <span class="sr-scrub-end">${esc(points[points.length - 1].ymd)}</span>
    </div>
    <p class="sr-foot">Restoring for real is a destructive <b>D1 Time Travel</b> operation: a point-in-time restore run from the CLI, with a 7-day window on the free plan. This page never fires it; it only reads the log. See what shipped at each point in <a href="/updates">Windows Update</a>.</p>
    <script>
var POINTS = ${JSON.stringify(data)};
(function(){
  var R = document.getElementById('srRange'), L = document.getElementById('srList'), D = document.getElementById('srDetail');
  if (!R || !L || !D) return;
  function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return c=='&'?'&amp;':c=='<'?'&lt;':'&gt;'; }); }
  function dfmt(d){ var x = new Date(d + 'T12:00:00'); try { return x.toLocaleDateString(undefined, {weekday:'long', year:'numeric', month:'long', day:'numeric'}); } catch(e){ return d; } }
  function mfmt(d){ var x = new Date(d + 'T12:00:00'); try { return x.toLocaleDateString(undefined, {year:'numeric', month:'long'}); } catch(e){ return d.slice(0,7); } }
  var html = '', lastM = '';
  for (var i = 0; i < POINTS.length; i++) {
    var m = mfmt(POINTS[i].d);
    if (m !== lastM) { html += '<div class="sr-mon">' + esc(m) + '</div>'; lastM = m; }
    html += '<button class="sr-pt" type="button" data-i="' + i + '"><span class="rv">v' + POINTS[i].v + '</span><span class="rt">' + esc(POINTS[i].t) + '</span><span class="rd">' + POINTS[i].d.slice(5) + '</span></button>';
  }
  L.innerHTML = html;
  function render(i){
    var p = POINTS[i], recent = '';
    for (var j = i; j >= 0 && j > i - 6; j--) recent += '<li><span class="rv">v' + POINTS[j].v + '</span>' + esc(POINTS[j].t) + '</li>';
    D.innerHTML = '<div class="sr-dt">Restore point</div><div class="sr-date">' + dfmt(p.d) + '</div>' +
      '<div class="sr-ver"><span class="mono">' + esc(p.ver) + '</span></div>' +
      '<div class="sr-meta">point ' + (i + 1) + ' of ' + POINTS.length + ' &middot; ' + esc(p.t) + '</div>' +
      '<div class="sr-changes-h">Installed up to this point</div><ul class="sr-changes">' + recent + '</ul>' +
      '<button class="sr-btn" type="button" id="srGo">Restore to this point</button>' +
      '<div class="sr-note" id="srNote" hidden>Preview only. A real rollback is a destructive D1 Time Travel restore run from the CLI, not something a visitor page should ever fire.</div>';
    var go = document.getElementById('srGo'), note = document.getElementById('srNote');
    if (go) go.onclick = function(){ if (note) note.hidden = !note.hidden; };
    var items = L.querySelectorAll('.sr-pt');
    for (var k = 0; k < items.length; k++) items[k].setAttribute('aria-current', k == i ? 'true' : 'false');
    if (items[i] && items[i].scrollIntoView) items[i].scrollIntoView({block:'nearest'});
  }
  L.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('.sr-pt') : null;
    if (!b) return; var i = +b.getAttribute('data-i'); R.value = i; render(i);
  });
  R.addEventListener('input', function(){ render(+R.value); });
  render(POINTS.length - 1);
})();
    </script>`;
  } else {
    const msg = state === "unbound"
      ? "The restore-point log lives in a Cloudflare D1 database (aadhar-restore) that's being connected to this page. Once the binding lands, the scrubber lights up with 48 real restore points."
      : state === "empty"
        ? "The restore-point database is connected but empty. It seeds from this site's git history on the next publish."
        : "The restore-point database didn't answer just now. It's backed by Cloudflare D1, and this page stays read-only either way.";
    main =
`    <p class="sr-lede">Windows kept a calendar of restore points so you could roll the system back to an earlier day.</p>
    <div class="sr-pending"><span class="sr-gear"></span><div><b>System Restore is finishing setup.</b><div class="sub">${esc(msg)}</div></div></div>
    <p class="sr-foot">Backed by <b>Cloudflare D1</b>, with a 7-day Time Travel window underneath for real recovery. See what's shipped in <a href="/updates">Windows Update</a>.</p>`;
  }

  return lunaPage({
    title: "System Restore · aadhar.sh",
    path: "System Restore",
    route: "/restore",
    width: 680,
    description: "Roll the site back through its real deploy history, in a Windows System Restore reskin backed by Cloudflare D1. Read-only.",
    robots: "noindex",
    css: `
h1{margin:0 0 4px}
.sr-lede{font-size:9.5pt;color:#4a5568;margin:0 0 12px;line-height:1.5}
.sr-now{display:flex;align-items:center;gap:11px;border:1px solid #9db8e0;background:linear-gradient(180deg,#eef5fe,#dceafe);border-radius:4px;padding:10px 13px;margin:0 0 13px}
.sr-now .pin{width:30px;height:30px;flex:0 0 30px;border-radius:50%;background:linear-gradient(180deg,#5b9bf0,#2f6fd0);box-shadow:inset 0 1px 0 rgba(255,255,255,.55);position:relative}
.sr-now .pin::after{content:"";position:absolute;inset:0;margin:auto;width:10px;height:10px;border-radius:50%;background:#fff}
.sr-now b{font-family:var(--font-caption);font-size:11pt;color:#1c3f78}
.sr-now .sub{font-size:8.5pt;color:#46618c}
.mono{font-family:var(--font-mono)}
.sr-stage{display:flex;gap:11px;align-items:stretch}
.sr-listwrap{flex:0 0 220px;border:1px solid #b7c0d0;border-radius:4px;overflow:hidden;display:flex;flex-direction:column;background:#fff}
.sr-listhead{padding:5px 10px;font-family:var(--font-caption);font-size:9pt;font-weight:bold;color:#fff;background:linear-gradient(180deg,#4f8bd8,#2f6fd0)}
.sr-list{overflow-y:auto;max-height:308px}
.sr-mon{position:sticky;top:0;background:#eef2f8;color:#5a6b85;font-size:8pt;font-weight:bold;padding:3px 10px;border-bottom:1px solid #dde5f0;text-transform:uppercase;letter-spacing:.04em}
.sr-pt{display:flex;align-items:baseline;gap:7px;width:100%;text-align:left;border:0;background:transparent;padding:5px 10px;font:inherit;font-size:8.5pt;color:#33415c;cursor:pointer;border-bottom:1px solid #f0f3f8}
.sr-pt:hover{background:#f3f7fd}
.sr-pt[aria-current=true]{background:#dceafe;box-shadow:inset 2px 0 0 #2f6fd0}
.sr-pt .rv{font-family:var(--font-mono);font-size:7.5pt;color:#7a4eb0;flex:0 0 auto}
.sr-pt .rt{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sr-pt .rd{font-family:var(--font-mono);font-size:7.5pt;color:#9aa6b8;flex:0 0 auto}
.sr-detail{flex:1;border:1px solid #b7c0d0;border-radius:4px;background:#fbfdff;padding:12px 14px;min-height:308px}
.sr-dt{font-size:8pt;color:#6b7280;text-transform:uppercase;letter-spacing:.05em}
.sr-date{font-family:var(--font-caption);font-size:13pt;color:#15243f;margin:1px 0 2px}
.sr-ver{margin:0 0 7px}.sr-ver .mono{font-size:9pt;color:#2f6fd0}
.sr-meta{font-size:8.5pt;color:#6b7280;margin:0 0 11px}
.sr-changes-h{font-size:8.5pt;font-weight:bold;color:#15243f;margin:0 0 4px}
.sr-changes{list-style:none;margin:0;padding:0}
.sr-changes li{font-size:9pt;color:#33415c;padding:3px 0;border-bottom:1px solid #eef2f7}
.sr-changes .rv{font-family:var(--font-mono);font-size:7.5pt;color:#7a4eb0;margin-right:6px}
.sr-btn{margin-top:11px;font:inherit;font-size:9pt;padding:4px 14px;cursor:pointer;border:1px solid #7c93b8;border-radius:3px;background:linear-gradient(180deg,#fdfefe,#dce6f4);box-shadow:inset 0 1px 0 #fff}
.sr-btn:hover{background:linear-gradient(180deg,#fff,#e8f0fb)}
.sr-note{margin-top:8px;font-size:8.5pt;color:#6b7280;background:#fffbe6;border:1px solid #f0e3a8;border-radius:3px;padding:6px 9px;line-height:1.5}
.sr-scrub{display:flex;align-items:center;gap:10px;margin:14px 0 4px}
.sr-scrub input[type=range]{flex:1;accent-color:#2f6fd0}
.sr-scrub-end{font-family:var(--font-mono);font-size:8pt;color:#9aa6b8;flex:0 0 auto}
.sr-foot{font-size:8.5pt;color:#6b7280;border-top:1px solid #e2e8f0;padding-top:8px;margin-top:12px;line-height:1.5}
.sr-foot b{color:#15243f}
.sr-pending{display:flex;align-items:center;gap:12px;border:1px solid #d8c98a;background:linear-gradient(180deg,#fffdf2,#fcf4d8);border-radius:4px;padding:13px 15px;margin:0 0 13px}
.sr-gear{width:24px;height:24px;flex:0 0 24px;border-radius:50%;border:3px solid #c9b25e;border-top-color:transparent;animation:srspin 1.1s linear infinite}
@keyframes srspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.sr-gear{animation:none}}
.sr-pending b{font-family:var(--font-caption);font-size:11pt;color:#7a5c12}
.sr-pending .sub{font-size:8.5pt;color:#8a7430}
@media (max-width:560px){.sr-stage{flex-direction:column}.sr-listwrap{flex:none}.sr-list{max-height:170px}}
`,
    body: `
    <h1>System Restore</h1>
    ${liveBar}
${main}
`,
    cache: "public, max-age=0, s-maxage=300",
    closeHref: "/updates",
    closeTitle: "back to Windows Update",
    closeLabel: "back to Windows Update",
    headers: {
      "x-robots-tag":    "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
