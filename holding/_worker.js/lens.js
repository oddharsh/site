// lens.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { BOT_UA, SIG_AGENT, signRequestForWebBotAuth } from "./lib/botauth.js";
import { cachedRender } from "./lib/cache.js";
import { CANONICAL_HOST } from "./lib/const.js";
import { lunaPage } from "./lib/chrome.js";
import { acceptQ, escAttr, escHtml, jsonResponse } from "./lib/http.js";

// ── /lens — "the other web" -----------------------------------------------
// A URL goes in; what a MACHINE sees comes out, across five lenses: page
// anatomy (raw HTML, headers, headings, stripped text), structured/semantic
// data (JSON-LD, microdata, RDFa, microformats, OG/Twitter), the LLM/AI view
// (a markdown rendering + crawler directives), the TERMS the site sets for
// machines (per-bot robots verdicts, Content-Signal, price + enforcement,
// the open → signaled → enforced → paid spectrum), and site-level discovery
// files (robots.txt, sitemap.xml, llms.txt, feeds). The fetch is server-side
// (CORS blocks the browser), guarded against SSRF, capped in time + size, and
// made honestly as AadharshBot. Engine here; the /lens page (handleLens) is the UI.

// /lens — the SSR shell: IE6 address bar, a Human/Machine view toggle, the
// six lens tabs, two panes, seeded examples. The renderer lives in /lens.js
// (a real static file, SW-cached like nav.js) so it can use normal JS without
// fighting this template literal's ${} and backticks.
// the /lens shell is static when it has no target. A shareable ?url= request is
// intentionally inspected server-side and seeded with the same HTML floor as
// /lens/fetch, so no-JS visitors still get a useful result. The empty shell is
// keyed on the bare path and remains cacheable; targeted inspections are
// private because they spend the crawler budget and contain third-party data.
export async function handleLens(request, env, ctx) {
  const url = new URL(request.url);
  const target = url.searchParams.get("url");
  if (target) {
    const result = await inspectLensRequest(request, env, ctx);
    const response = renderLensShell(result.payload, lensState(url), target);
    response.headers.set("cache-control", "no-store, must-revalidate");
    response.headers.set("vary", "accept");
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("x-robots-tag", "noindex");
    return response;
  }
  // Keep a route-local shell key: the production runtime may not expose
  // CF_VERSION_METADATA, so a deploy can otherwise leave an older shell in
  // the edge cache while the separately served lens.js has already changed.
  return cachedRender(request, ctx, () => renderLensShell(), "/lens-shell-v3", env);
}

function wantsLensHtml(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  return acceptQ(accept, "text/html") > acceptQ(accept, "application/json");
}

function lensState(url) {
  const validViews = ["both", "human", "machine", "delta"];
  const validLenses = ["readiness", "anatomy", "structured", "ai", "terms", "discovery"];
  const view = validViews.includes(url.searchParams.get("view")) ? url.searchParams.get("view") : "both";
  const lens = validLenses.includes(url.searchParams.get("lens")) ? url.searchParams.get("lens") : "readiness";
  const counterfactuals = {};
  for (const key of (url.searchParams.get("cf") || "").split(",")) {
    if (["markdown", "semantic", "contract", "authority", "receipt"].includes(key)) counterfactuals[key] = true;
  }
  return { view, lens, counterfactuals };
}

function lensScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function lensHttpText(status) {
  if (status >= 200 && status < 300) return "OK";
  if (status >= 300 && status < 400) return "redirect";
  if (status === 404) return "Not Found";
  if (status >= 400 && status < 500) return "client error";
  if (status >= 500) return "server error";
  return "";
}

function lensReaderFragment(data, note) {
  if (!data || !data.ok) return '<div class="lx-empty">' + escHtml((data && data.error) || "No page to show.") + "</div>";
  const a = data.anatomy;
  let out = note ? '<div class="lx-fallback-note">' + escHtml(note) + "</div>" : "";
  if (!a) return out + '<div class="lx-empty">No readable text either.</div>';
  const title = data.structured && data.structured.title || "";
  if (title) out += '<div class="lx-h-title">' + escHtml(title) + "</div>";
  if (a.headings && a.headings.length) {
    out += '<div class="lx-h-outline"><b>Document outline</b><br>';
    for (const h of a.headings.slice(0, 60)) {
      out += '<div style="padding-left:' + ((h.level - 1) * 12) + 'px"><span style="color:#9aa">h' + h.level + "</span> " + escHtml(h.text) + "</div>";
    }
    out += "</div>";
  }
  return out + '<div class="lx-h-text">' + escHtml(a.text || "(no extractable text)") + "</div>";
}

function lensHumanFragment(data) {
  if (!data || !data.ok) return lensReaderFragment(data);
  if (data.framable) {
    return '<iframe class="lx-frame" src="' + escAttr(data.finalUrl) +
      '" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals"' +
      ' referrerpolicy="no-referrer-when-downgrade" loading="lazy"></iframe>';
  }
  return lensReaderFragment(data, "Embedding is blocked; JavaScript can request a server-side snapshot, so this is the readable fallback.");
}

function lensMachineFragment(data, state) {
  if (!data || !data.ok) return '<div class="lx-empty">' + escHtml((data && data.error) || "No evidence yet.") + "</div>";
  const a = data.anatomy || {};
  const s = data.structured || {};
  const d = data.discovery || {};
  const ag = data.agent || {};
  const rows = [
    ["url", data.finalUrl || data.url],
    ["title", s.title || "(untitled)"],
    ["response", data.status + " " + lensHttpText(data.status)],
    ["readiness", data.readiness && data.readiness.overall != null ? data.readiness.overall + "/100" : "unknown"],
    ["content-type", data.contentType || "(none)"],
    ["payload", (a.rawBytes || 0) + " B" + (data.truncated ? " (capped)" : "")],
    ["headings", a.headings ? a.headings.length : 0],
    ["fetched as", data.fetchedBy || "identified bot"],
  ].map(row => '<tr><td>' + escHtml(row[0]) + '</td><td>' + escHtml(row[1]) + "</td></tr>").join("");
  const doors = ag.strategy && ag.strategy.verdict || "unknown";
  const files = [
    d.robotsTxt && d.robotsTxt.ok ? "robots.txt" : "",
    d.sitemapXml && d.sitemapXml.ok ? "sitemap.xml" : "",
    d.llmsTxt && d.llmsTxt.ok ? "llms.txt" : "",
  ].filter(Boolean);
  return '<div class="lx-brief-lede"><b>Server-rendered machine summary.</b> JavaScript can enhance this into the full selected lens; this fragment is the no-script evidence floor.</div>' +
    '<div class="lx-sec"><div class="lx-sec-h">Observed document <span class="lx-badge ok">observed</span></div>' +
    '<div class="lx-cap">The minimum contract a machine can recover from this response.</div><table class="lx-kv">' + rows + "</table></div>" +
    '<div class="lx-sec"><div class="lx-sec-h">Available surfaces <span class="lx-badge">' + escHtml(doors) + "</span></div>" +
    '<div class="lx-cap">Evidence found during the server-side inspection.</div><div class="lx-tags">' +
    (files.length ? files.map(file => '<span class="lx-tag">' + escHtml(file) + "</span>").join("") : '<span class="lx-none">no discovery files found</span>') +
    "</div></div>" +
    '<div class="lx-sec"><div class="lx-sec-h">Selected state <span class="lx-badge">' + escHtml(state.lens) + "</span></div>" +
    '<div class="lx-cap">View: ' + escHtml(state.view) + ". The browser enhancement can open the complete lens without changing the URL.</div></div>";
}

function lensStatusFragment(data, state) {
  if (!data || !data.ok) return '<span class="err">Failed:</span> <span>' + escHtml((data && data.error) || "unknown error") + "</span>";
  return '<span><b>' + data.status + "</b> " + lensHttpText(data.status) + "</span>" +
    '<span>' + escHtml(state.view === "both" ? "Compare" : state.view.charAt(0).toUpperCase() + state.view.slice(1)) + "</span>" +
    '<span>' + escHtml(data.contentType || "?") + "</span>" +
    (data.anatomy ? '<span>' + data.anatomy.rawBytes + " B</span>" : "") +
    '<span>' + escHtml(String(data.elapsedMs || 0)) + " ms</span>" +
    (data.redirected ? '<span>&rarr; ' + escHtml(data.finalUrl) + "</span>" : "") +
    '<span style="margin-left:auto">fetched as ' + escHtml(data.fetchedBy || "identified bot") + "</span>";
}

function renderLensFragments(data, state) {
  return '<div id="lx-fragments" data-lens-fragments="1">' +
    '<div data-lens-part="human">' + lensHumanFragment(data) + "</div>" +
    '<div data-lens-part="machine">' + lensMachineFragment(data, state) + "</div>" +
    '<div data-lens-part="status">' + lensStatusFragment(data, state) + "</div>" +
    '<script type="application/json" id="lx-initial-data">' + lensScriptJson(data) + "</script></div>";
}

async function inspectLensRequest(request, env, ctx) {
  const v = validateLensTarget(new URL(request.url).searchParams.get("url") || "");
  if (!v.ok) return { status: 400, payload: { ok: false, error: v.error } };

  // best-effort per-IP rate limit so the proxy can't be turned into a firehose.
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (env.RN_KV) {
    const bucket = `lens:rl:${ip}:${Math.floor(Date.now() / 60000)}`;
    const n = parseInt((await env.RN_KV.get(bucket)) || "0", 10);
    if (n >= 30) return { status: 429, payload: { ok: false, error: "Slow down — 30 lookups a minute. Try again shortly." } };
    ctx.waitUntil(env.RN_KV.put(bucket, String(n + 1), { expirationTtl: 120 }));
  }

  try {
    return { status: 200, payload: await lensInspect(v.url, env) };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "The site took too long to answer (8s timeout)." : (e && e.message) || String(e);
    return { status: 502, payload: { ok: false, error: msg } };
  }
}

function renderLensShell(initial, state, inputValue) {
  state = state || { view: "both", lens: "anatomy", counterfactuals: {} };
  const seeded = initial && initial.ok;
  const value = inputValue || (seeded ? initial.finalUrl || initial.url : "");
  const humanHeader = seeded && !initial.framable
    ? 'Human view <span class="lx-mode">Reader</span> <span class="lx-mode-sub">server-rendered readable fallback</span>'
    : "Human view &middot; the live page";
  const machineHeader = state.view === "machine" ? "Machine view &middot; Briefing" : state.view === "delta" ? "Delta view &middot; What changes" : "Machine view &middot; " + state.lens.charAt(0).toUpperCase() + state.lens.slice(1);
  const modeNote = state.view === "human"
    ? "Human shows the page as a person receives it in a browser."
    : state.view === "machine"
      ? "Machine turns the scan into an evidence-first briefing, then keeps the selected lens below it."
      : state.view === "delta"
        ? "Delta keeps the page visible while you add hypothetical machine infrastructure to the route."
        : "Compare keeps the live page beside the selected evidence lens.";
  const initialScript = initial ? '<script type="application/json" id="lx-initial-data">' + lensScriptJson(initial) + "</script>" : "";
  return lunaPage({
    title: "The Other Web · aadhar.sh",
    path: "The Other Web",
    width: 980,
    description: "Paste any URL and see the human page, a transparent agent-readiness score, bot-specific access samples, raw HTML, structured data, machine terms, and the site's discovery surfaces side by side.",
    robots: "index, nofollow",
    css: `
h1 { font-family:"Trebuchet MS",Verdana,Geneva,sans-serif; font-size:13pt; color:oklch(41.92% 0.0962 250.51); margin:0 0 2px; font-weight:bold; }
.lx-lede { margin:0 0 10px; color:oklch(40% 0 0); font-size:10pt; }
.lx-lede a { color:oklch(42.61% 0.2353 263.74); }

/* IE6 address bar */
.lx-addr { display:flex; align-items:center; gap:6px; background:oklch(94.66% 0.0114 252.09); border:1px solid oklch(72% 0.03 250); border-radius:3px; padding:5px 6px; }
.lx-addr-label { font-size:9pt; color:oklch(45% 0 0); padding:0 2px; }
.lx-globe { width:15px; height:15px; flex:0 0 auto; border-radius:50%; background:radial-gradient(circle at 35% 30%, oklch(78% 0.13 230), oklch(48% 0.16 250)); box-shadow:inset 0 0 0 1px oklch(100% 0 0 / .4); }
.lx-url { flex:1 1 auto; min-width:0; font-family:"Courier New",Courier,monospace; font-size:10pt; padding:3px 6px; border:2px solid; border-color:oklch(55% 0 0) oklch(85% 0 0) oklch(85% 0 0) oklch(55% 0 0); background:#fff; color:oklch(25% 0.02 255); }
.lx-url:focus { outline:1px dotted oklch(42.61% 0.2353 263.74); }
.lx-go, .lx-seg, .lx-tab, .lx-chip { font-family:Tahoma,Verdana,sans-serif; cursor:pointer; }
.lx-go { font-size:9.5pt; font-weight:bold; padding:3px 14px; color:oklch(20% 0 0); background:linear-gradient(180deg,#fdfdfd,#dcdcd2); border:1px solid; border-color:#fff oklch(45% 0 0) oklch(45% 0 0) #fff; border-radius:3px; }
.lx-go:active { border-color:oklch(45% 0 0) #fff #fff oklch(45% 0 0); }

/* example chips */
.lx-chips { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin:7px 0 9px; }
.lx-chips-label { font-size:9pt; color:oklch(48% 0 0); }
.lx-chip { font-size:8.8pt; padding:2px 8px; color:oklch(35% 0.06 255); background:oklch(97% 0.006 250); border:1px solid oklch(74% 0.03 250); border-radius:10px; }
.lx-chip:hover { background:oklch(90% 0.04 250); }

/* toolbar: view toggle + lens tabs */
.lx-toolbar { display:flex; align-items:flex-end; justify-content:space-between; gap:10px; flex-wrap:wrap; border-bottom:2px solid oklch(58% 0.10 250); margin-top:2px; }
.lx-view { display:inline-flex; margin-bottom:5px; }
.lx-seg { font-size:9pt; padding:3px 11px; color:oklch(28% 0 0); background:linear-gradient(180deg,#fbfbfb,#e3e3da); border:1px solid oklch(55% 0 0); border-right-width:0; }
.lx-seg:first-child { border-radius:3px 0 0 3px; }
.lx-seg:last-child { border-right-width:1px; border-radius:0 3px 3px 0; }
.lx-seg.is-on { color:#fff; background:linear-gradient(180deg, oklch(58% 0.15 255), oklch(44% 0.18 257)); }
.lx-lenses { display:inline-flex; gap:2px; }
.lx-tab { font-size:9.2pt; padding:5px 12px 6px; color:oklch(35% 0.04 255); background:linear-gradient(180deg, oklch(96% 0.01 250), oklch(88% 0.02 250)); border:1px solid oklch(60% 0.05 250); border-bottom:none; border-radius:5px 5px 0 0; position:relative; top:1px; }
.lx-tab.is-on { color:oklch(33% 0.10 263); font-weight:bold; background:#fff; top:2px; padding-bottom:7px; }

/* panes */
.lx-panes { display:flex; gap:8px; margin-top:8px; min-height:560px; }
.lx-panes.is-human .lx-pane-machine, .lx-panes.is-machine .lx-pane-human { display:none; }
.lx-pane { flex:1 1 0; min-width:0; display:flex; flex-direction:column; border:1px solid oklch(70% 0.03 250); border-radius:0 3px 3px 3px; background:#fff; }
.lx-pane-h { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:8.5pt; font-weight:bold; text-transform:uppercase; letter-spacing:.05em; color:#fff; background:linear-gradient(180deg, oklch(56% 0.12 252), oklch(45% 0.15 255)); padding:4px 8px; border-radius:0 2px 0 0; }
.lx-pane-human .lx-pane-h { background:linear-gradient(180deg, oklch(58% 0.06 150), oklch(46% 0.09 155)); }
.lx-body { flex:1 1 auto; overflow:auto; padding:10px 11px; }
.lx-empty { color:oklch(55% 0 0); font-size:9.5pt; padding:18px 6px; text-align:center; }
.lx-spin { color:oklch(42.61% 0.2353 263.74); font-size:9.5pt; padding:18px 6px; text-align:center; }
.lx-idle-lens { max-width:620px; margin:22px auto; padding:16px 18px; border:1px solid oklch(78% 0.04 250); border-radius:4px; background:linear-gradient(180deg,#fff,oklch(97% 0.008 250)); color:oklch(31% 0.02 255); }
.lx-idle-kicker { color:oklch(46% 0.13 252); font:9pt Tahoma,Verdana,sans-serif; text-transform:uppercase; letter-spacing:.06em; }
.lx-idle-lens h3 { margin:4px 0 5px; color:oklch(33% 0.10 263); font: bold 13pt "Trebuchet MS",Verdana,sans-serif; }
.lx-idle-lens p { margin:0 0 11px; line-height:1.45; }
.lx-idle-lens ul { margin:0 0 13px 18px; padding:0; line-height:1.5; }
.lx-idle-cta { padding:7px 9px; border-left:3px solid oklch(58% 0.15 255); background:oklch(95% 0.025 250); color:oklch(43% 0 0); font-size:9pt; }
.lx-body.is-bleed { padding:0; }
.lx-frame { width:100%; height:100%; min-height:520px; border:0; display:block; background:#fff; }
.lx-shot { width:100%; height:auto; display:block; }
.lx-fallback-note { font-size:8.8pt; color:oklch(42% 0.11 60); background:oklch(96% 0.045 92); border:1px solid oklch(82% 0.09 80); border-radius:3px; padding:5px 9px; margin:0 0 10px; }
.lx-mode { font-family:"Courier New",monospace; font-size:7.6pt; font-weight:normal; text-transform:none; letter-spacing:0; color:oklch(38% 0.09 150); background:#fff; border-radius:7px; padding:1px 7px; vertical-align:middle; }
.lx-mode-sub { font-weight:normal; text-transform:none; letter-spacing:0; opacity:.85; font-size:8pt; }

/* rendered machine content */
.lx-h-title { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:13pt; font-weight:bold; color:oklch(30% 0.06 255); margin:0 0 8px; }
.lx-h-text { font-size:10pt; line-height:1.55; color:oklch(28% 0 0); white-space:pre-wrap; }
.lx-h-outline { margin:0 0 12px; padding:8px 10px; background:oklch(98% 0.01 250); border:1px solid oklch(90% 0.02 250); border-radius:3px; font-size:9pt; }
.lx-h-outline a { color:oklch(42.61% 0.2353 263.74); text-decoration:none; }
.lx-pre { font-family:"Courier New",Courier,monospace; font-size:8.6pt; line-height:1.45; white-space:pre-wrap; word-break:break-word; background:oklch(20% 0.02 255); color:oklch(92% 0.02 150); padding:9px 10px; border-radius:3px; overflow:auto; max-height:520px; }
.lx-pre-light { background:oklch(98.5% 0.008 250); color:oklch(25% 0.02 255); border:1px solid oklch(90% 0.02 250); }
.lx-sec { margin:0 0 15px; }
.lx-sec-h { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:10pt; font-weight:bold; color:oklch(33% 0.09 263); margin:0 0 2px; display:flex; align-items:center; gap:7px; }
.lx-badge { font-family:"Courier New",monospace; font-size:7.6pt; font-weight:normal; color:#fff; background:oklch(52% 0.13 255); border-radius:8px; padding:1px 7px; }
.lx-badge.warn { background:oklch(60% 0.16 50); }
.lx-badge.ok { background:oklch(52% 0.13 150); }
.lx-badge.off { background:oklch(60% 0 0); }
.lx-cap { font-size:8.4pt; color:oklch(50% 0 0); margin:0 0 6px; font-style:italic; }
.lx-kv { width:100%; border-collapse:collapse; font-size:8.8pt; }
.lx-kv td { border-bottom:1px solid oklch(93% 0.01 250); padding:3px 6px 3px 0; vertical-align:top; }
.lx-kv td:first-child { font-family:"Courier New",monospace; color:oklch(42% 0.08 255); white-space:nowrap; width:1%; padding-right:12px; }
.lx-kv td:last-child { color:oklch(28% 0 0); word-break:break-word; }
.lx-tags { display:flex; flex-wrap:wrap; gap:4px; margin:4px 0 0; }
.lx-tag { font-family:"Courier New",monospace; font-size:8.2pt; color:oklch(33% 0.06 255); background:oklch(95% 0.02 255); border:1px solid oklch(80% 0.03 255); border-radius:3px; padding:1px 6px; }
.lx-none { font-size:8.8pt; color:oklch(58% 0 0); padding:2px 0; }
.lx-ogcard { display:flex; gap:9px; border:1px solid oklch(85% 0.02 250); border-radius:4px; padding:8px; background:oklch(99% 0.004 250); }
.lx-ogcard img { width:96px; height:96px; object-fit:cover; border-radius:3px; flex:0 0 auto; background:oklch(92% 0 0); }
.lx-ogcard .t { font-weight:bold; font-size:9.6pt; color:oklch(28% 0.04 255); }
.lx-ogcard .d { font-size:8.8pt; color:oklch(45% 0 0); margin-top:3px; }
.lx-ogcard .u { font-family:"Courier New",monospace; font-size:8pt; color:oklch(50% 0.05 150); margin-top:4px; }

/* Terms lens: the open → signaled → enforced → paid spectrum + bot scoreboard */
.lx-spectrum { display:flex; border:1px solid oklch(70% 0.03 250); border-radius:3px; overflow:hidden; margin:2px 0 8px; }
.lx-spec { flex:1 1 0; text-align:center; padding:5px 4px 6px; background:oklch(97% 0.005 250); border-right:1px solid oklch(88% 0.01 250); }
.lx-spec:last-child { border-right:none; }
.lx-spec b { display:block; font-size:9.2pt; color:oklch(40% 0.02 255); }
.lx-spec span { font-size:7.8pt; color:oklch(55% 0 0); }
.lx-spec.is-here { background:linear-gradient(180deg, oklch(58% 0.15 255), oklch(44% 0.18 257)); }
.lx-spec.is-here b, .lx-spec.is-here span { color:#fff; }
.lx-why { margin:0 0 4px; padding-left:18px; font-size:8.8pt; color:oklch(35% 0 0); }
.lx-why li { margin:1px 0; }
.lx-bots { width:100%; border-collapse:collapse; font-size:8.8pt; }
.lx-bots td, .lx-bots th { border-bottom:1px solid oklch(93% 0.01 250); padding:3px 8px 3px 0; text-align:left; vertical-align:top; }
.lx-bots th { font-size:7.8pt; font-weight:normal; color:oklch(50% 0 0); text-transform:uppercase; letter-spacing:.05em; }
.lx-bots .ua { font-family:"Courier New",monospace; color:oklch(30% 0.05 255); white-space:nowrap; }
.lx-bots .rule { font-family:"Courier New",monospace; font-size:8.2pt; color:oklch(48% 0 0); word-break:break-all; }
.lx-bots .who { color:oklch(55% 0 0); font-size:8pt; }
.lx-readiness-hero { display:flex; align-items:center; gap:15px; padding:10px 12px; margin:0 0 9px; border:1px solid oklch(73% 0.06 250); border-radius:4px; background:linear-gradient(105deg,oklch(97% 0.025 250),#fff); }
.lx-readiness-number { font:bold 29pt "Trebuchet MS",Verdana,sans-serif; line-height:1; color:oklch(38% 0.14 255); white-space:nowrap; }
.lx-readiness-number span { font:normal 10pt Tahoma,Verdana,sans-serif; color:oklch(53% 0 0); margin-left:2px; }
.lx-readiness-kicker { font:8pt Tahoma,Verdana,sans-serif; color:oklch(50% 0 0); text-transform:uppercase; letter-spacing:.06em; }
.lx-readiness-level { display:flex; align-items:center; gap:6px; margin:2px 0 3px; font-size:10pt; color:oklch(30% 0.04 255); }
.lx-readiness-cats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:5px; margin:5px 0 12px; }
.lx-readiness-cat { border:1px solid oklch(82% 0.03 250); border-radius:3px; padding:6px 8px; background:#fff; }
.lx-readiness-cat > div { display:flex; justify-content:space-between; gap:7px; font-size:8.4pt; color:oklch(37% 0.04 255); }
.lx-readiness-cat > div span { font:8pt "Courier New",monospace; color:oklch(55% 0 0); white-space:nowrap; }
.lx-readiness-cat strong { display:block; margin-top:2px; font:bold 14pt "Courier New",monospace; color:oklch(43% 0.13 150); }
.lx-readiness-cat.is-skipped strong { color:oklch(58% 0 0); }
.lx-projection { margin:0 0 12px; padding:6px 8px; border-left:3px solid oklch(60% 0.15 50); background:oklch(97% 0.035 75); color:oklch(42% 0.06 50); font-size:8.7pt; }
.lx-projection span { color:oklch(52% 0 0); }
.lx-readiness-checks { display:grid; gap:5px; margin-top:7px; }
.lx-readiness-check { padding:6px 8px; border:1px solid oklch(88% 0.015 250); border-radius:3px; background:#fff; }
.lx-readiness-check-top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.lx-readiness-check-top b { font-size:9pt; color:oklch(32% 0.05 255); }
.lx-readiness-detail { margin-top:2px; font-size:8.4pt; color:oklch(52% 0 0); }
.lx-readiness-fix { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:5px; padding-top:5px; border-top:1px dotted oklch(85% 0.02 250); font-size:8.4pt; color:oklch(42% 0.07 50); }
.lx-copy-fix, .lx-copy-all { border:1px solid oklch(62% 0.05 250); border-radius:3px; padding:2px 7px; background:linear-gradient(180deg,#fff,oklch(91% 0.012 250)); color:oklch(34% 0.07 255); font:8pt Tahoma,Verdana,sans-serif; cursor:pointer; white-space:nowrap; }
.lx-copy-fix:hover, .lx-copy-all:hover { background:oklch(93% 0.04 250); }
.lx-copy-all { margin:0 0 7px; font-weight:bold; }
.lx-next-actions { display:grid; gap:4px; margin:0 0 9px; }
.lx-next-actions div { display:grid; grid-template-columns:145px 1fr; gap:8px; padding:4px 6px; background:oklch(98% 0.01 250); border-left:3px solid oklch(60% 0.15 50); font-size:8.4pt; }
.lx-next-actions b { color:oklch(34% 0.07 255); }
.lx-next-actions span { color:oklch(46% 0 0); }
.lx-bot-matrix { width:100%; border-collapse:collapse; font-size:8.4pt; }
.lx-bot-matrix td, .lx-bot-matrix th { border-bottom:1px solid oklch(93% 0.01 250); padding:4px 7px 4px 0; text-align:left; vertical-align:top; }
.lx-bot-matrix th { font-size:7.5pt; font-weight:normal; color:oklch(50% 0 0); text-transform:uppercase; letter-spacing:.04em; }
.lx-bot-matrix .ua { font-family:"Courier New",monospace; color:oklch(30% 0.05 255); white-space:nowrap; }
.lx-bot-matrix .rule { color:oklch(47% 0 0); }
.lx-badge.no { background:oklch(52% 0.17 27); }
.lx-kindrow td { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:8.6pt; font-weight:bold; color:oklch(38% 0.07 255); padding-top:9px; }
.lx-mult { font-family:"Courier New",monospace; font-size:7.8pt; color:oklch(38% 0.09 150); background:oklch(94% 0.04 150); border:1px solid oklch(80% 0.06 150); border-radius:8px; padding:1px 7px; white-space:nowrap; }
.lx-bots th.num, .lx-bots td.num { text-align:right; font-family:"Courier New",monospace; white-space:nowrap; padding-right:10px; }

/* Machine briefing + Delta lab */
.lx-mode-note { margin:7px 0 0; padding:5px 8px; border-left:3px solid oklch(55% 0.14 250); background:oklch(97% 0.012 250); color:oklch(42% 0.03 255); font-size:8.7pt; }
.lx-brief-lede { margin:0 0 10px; padding:7px 9px; border:1px solid oklch(82% 0.04 250); background:linear-gradient(180deg,oklch(98% 0.01 250),oklch(94% 0.018 250)); color:oklch(31% 0.04 255); font-size:9pt; line-height:1.45; }
.lx-brief-lede b { color:oklch(35% 0.13 250); }
.lx-focus { margin:0 0 12px; padding:7px 8px 1px; border:1px solid oklch(77% 0.07 250); background:linear-gradient(180deg,oklch(98% 0.018 250),oklch(94% 0.025 250)); box-shadow:inset 0 1px #fff; }
.lx-focus .lx-sec { margin-bottom:7px; }
.lx-focus .lx-sec-h { color:oklch(29% 0.12 250); }
.lx-focus .lx-kv td { border-bottom-color:oklch(88% 0.025 250); }
.lx-machine-block { border-top:1px solid oklch(86% 0.03 250); padding-top:9px; margin-top:11px; }
.lx-machine-block .lx-sec-h { color:oklch(30% 0.10 250); }
.lx-delta-intro { margin:0 0 10px; padding:7px 9px; border:1px solid oklch(82% 0.08 75); background:oklch(97% 0.035 85); color:oklch(39% 0.05 60); font-size:9pt; line-height:1.45; }
.lx-cf-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px; margin:5px 0 12px; }
.lx-cf-card { border:1px solid oklch(82% 0.03 250); border-radius:3px; padding:7px 8px; background:oklch(99% 0.003 250); }
.lx-cf-card.is-on { border-color:oklch(61% 0.13 150); background:oklch(97% 0.025 150); }
.lx-cf-card h4 { margin:0 0 3px; font-family:"Trebuchet MS",Verdana,sans-serif; font-size:9.1pt; color:oklch(32% 0.07 255); }
.lx-cf-card p { margin:0 0 6px; color:oklch(48% 0 0); font-size:8.3pt; line-height:1.35; }
.lx-cf-toggle { display:inline-flex; align-items:center; gap:5px; border:1px solid oklch(65% 0.03 250); border-radius:3px; padding:2px 6px; background:linear-gradient(180deg,#fff,oklch(91% 0.012 250)); color:oklch(34% 0.06 255); font-family:"Courier New",monospace; font-size:8pt; cursor:pointer; }
.lx-cf-toggle:hover { border-color:oklch(48% 0.12 250); }
.lx-cf-toggle[aria-pressed="true"] { color:#fff; border-color:oklch(43% 0.12 150); background:linear-gradient(180deg,oklch(59% 0.13 150),oklch(45% 0.15 150)); }
.lx-cf-dot { width:7px; height:7px; display:inline-block; border-radius:50%; background:oklch(60% 0 0); }
.lx-cf-toggle[aria-pressed="true"] .lx-cf-dot { background:oklch(88% 0.15 105); }
.lx-path { display:grid; gap:5px; margin-top:4px; }
.lx-stage { display:grid; grid-template-columns:88px 1fr; gap:7px; align-items:start; padding:5px 0; border-bottom:1px solid oklch(93% 0.01 250); font-size:8.6pt; }
.lx-stage:last-child { border-bottom:0; }
.lx-stage-name { font-family:"Courier New",monospace; color:oklch(39% 0.08 255); }
.lx-stage-copy { color:oklch(32% 0 0); }
.lx-stage-copy .lx-badge { margin-right:4px; }
.lx-proof { margin-top:8px; font-size:8.2pt; color:oklch(52% 0 0); }
.lx-proof b { color:oklch(38% 0.06 255); }
@media (max-width:560px){ .lx-cf-grid{ grid-template-columns:1fr; } .lx-stage{ grid-template-columns:74px 1fr; } .lx-readiness-cats{ grid-template-columns:1fr; } .lx-readiness-hero{ align-items:flex-start; } .lx-next-actions div{ grid-template-columns:1fr; gap:2px; } .lx-bot-matrix{ min-width:620px; } }

/* status bar */
.lx-status { margin-top:9px; border-top:1px solid oklch(86% 0.03 260); padding-top:6px; display:flex; flex-wrap:wrap; gap:5px 14px; font-size:8.6pt; color:oklch(45% 0 0); }
.lx-status b { color:oklch(30% 0.04 255); font-weight:bold; }
.lx-status .err { color:oklch(55% 0.2 27); font-weight:bold; }
footer { text-align:center; font-size:9pt; color:oklch(45% 0 0); margin-top:14px; padding-top:11px; border-top:1px solid oklch(86.67% 0.0294 259.59); }
footer a { color:oklch(42.61% 0.2353 263.74); }
@media (max-width:720px){ .lx-panes{ flex-direction:column; } .lx-panes.is-both .lx-pane{ min-height:280px; } }
`,
    body: `
    <h1>The Other Web</h1>
    <p class="lx-lede">Every page has a second life as data. Paste a URL to see what a person receives, what representative bots can retrieve, and which missing web surfaces limit them. The score is a map, not a verdict: every point stays tied to evidence. Fetched server-side, honestly, as <a href="/bot">AadharshBot</a>.</p>

    <form class="lx-addr" id="lx-form" action="/lens" method="get">
      <span class="lx-globe" aria-hidden="true"></span>
      <label class="lx-addr-label" for="lx-url">Address</label>
      <input id="lx-url" class="lx-url" type="text" name="url" value="${escAttr(value)}" inputmode="url" placeholder="https://example.com  —  paste any URL" autocomplete="off" spellcheck="false">
      <button class="lx-go" type="submit">Go</button>
    </form>
    <div class="lx-chips">
      <span class="lx-chips-label">Try:</span>
      <button class="lx-chip" data-url="https://aadhar.sh/">aadhar.sh</button>
      <button class="lx-chip" data-url="https://daringfireball.net/">a hand-built blog</button>
      <button class="lx-chip" data-url="https://stripe.com/">a modern marketing site</button>
      <button class="lx-chip" data-url="https://en.wikipedia.org/wiki/Semantic_Web">a Wikipedia article</button>
      <button class="lx-chip" data-url="https://www.nytimes.com/">a publisher with AI terms</button>
      <button class="lx-chip" data-url="https://aadhar.sh/llms-full.txt">a bot paywall (x402)</button>
      <button class="lx-chip" data-url="https://example.com/">the bare minimum</button>
    </div>

    <div class="lx-toolbar">
      <div class="lx-view" role="radiogroup" aria-label="page mode">
        <button class="lx-seg${state.view === "both" ? " is-on" : ""}" data-view="both" role="radio" aria-checked="${state.view === "both" ? "true" : "false"}" type="button">Compare</button>
        <button class="lx-seg${state.view === "human" ? " is-on" : ""}" data-view="human" role="radio" aria-checked="${state.view === "human" ? "true" : "false"}" type="button">Human</button>
        <button class="lx-seg${state.view === "machine" ? " is-on" : ""}" data-view="machine" role="radio" aria-checked="${state.view === "machine" ? "true" : "false"}" type="button">Machine</button>
        <button class="lx-seg${state.view === "delta" ? " is-on" : ""}" data-view="delta" role="radio" aria-checked="${state.view === "delta" ? "true" : "false"}" type="button">Delta</button>
      </div>
      <div class="lx-lenses" role="tablist" aria-label="machine lens">
        <button class="lx-tab${state.lens === "readiness" ? " is-on" : ""}" data-lens="readiness" role="tab" aria-selected="${state.lens === "readiness" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">Readiness</button>
        <button class="lx-tab${state.lens === "anatomy" ? " is-on" : ""}" data-lens="anatomy" role="tab" aria-selected="${state.lens === "anatomy" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">Anatomy</button>
        <button class="lx-tab${state.lens === "structured" ? " is-on" : ""}" data-lens="structured" role="tab" aria-selected="${state.lens === "structured" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">Structured</button>
        <button class="lx-tab${state.lens === "ai" ? " is-on" : ""}" data-lens="ai" role="tab" aria-selected="${state.lens === "ai" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">AI view</button>
        <button class="lx-tab${state.lens === "terms" ? " is-on" : ""}" data-lens="terms" role="tab" aria-selected="${state.lens === "terms" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">Terms</button>
        <button class="lx-tab${state.lens === "discovery" ? " is-on" : ""}" data-lens="discovery" role="tab" aria-selected="${state.lens === "discovery" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">Discovery</button>
      </div>
    </div>
    <div class="lx-mode-note" id="lx-mode-note">${modeNote}</div>

    <div class="lx-panes is-${state.view}" id="lx-panes">
      <section class="lx-pane lx-pane-human" id="lx-human">
        <div class="lx-pane-h" id="lx-human-h">${humanHeader}</div>
        <div class="lx-body" id="lx-human-body">${seeded ? lensHumanFragment(initial) : '<div class="lx-empty">Paste a URL above to see it through both eyes.</div>'}</div>
      </section>
      <section class="lx-pane lx-pane-machine" id="lx-machine">
        <div class="lx-pane-h" id="lx-machine-h">${machineHeader}</div>
        <div class="lx-body" id="lx-machine-body">${seeded ? lensMachineFragment(initial, state) : '<div class="lx-empty">The markup, metadata, and machine directives land here.</div>'}</div>
      </section>
    </div>

    <div class="lx-status" id="lx-status">${seeded || (initial && !initial.ok) ? lensStatusFragment(initial, state) : '<span>Idle. Nothing is fetched until you ask, and then just once, server-side, with no logging.</span>'}</div>
    <footer>&larr; <a href="/">aadhar.sh</a> &middot; a research toy about how machines read the web &middot; fetched by <a href="/bot">AadharshBot</a></footer>
    ${initialScript}
`,
    // The shell is cached at the edge and browsers cache static scripts too;
    // version the client URL so a fresh shell cannot pair with an older lens.js.
    scripts: `<script src="/lens.js?v=4" defer></script>`,
    cache: "public, max-age=60, s-maxage=300",
    headers: {
      "x-robots-tag": "noindex",
      // /lens embeds arbitrary sites in the Human view, so it needs a looser
      // policy than the site default (which has no frame-src → falls back to
      // default-src 'self' and blocks every cross-origin iframe). This relaxes
      // ONLY frame-src (any https origin, for the live iframe) and img-src
      // (blob: for the Browser Rendering screenshot, https: for OG-card art);
      // everything else stays locked down. withSecurityHeaders sees a CSP is
      // already present and leaves it alone. frame-ancestors 'none' keeps OTHER
      // sites from embedding /lens itself.
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; frame-src https:; child-src https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'",
    },
  });
}

// /lens/fetch?url=… → JSON by default, or an HTML fragment when explicitly
// requested by the browser enhancement. no-store either way.
export async function handleLensFetch(request, env, ctx) {
  const url = new URL(request.url);
  const result = await inspectLensRequest(request, env, ctx);
  if (wantsLensHtml(request)) {
    return new Response(renderLensFragments(result.payload, lensState(url)), {
      status: result.status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, must-revalidate",
        "vary": "accept",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex",
      },
    });
  }
  const response = jsonResponse(result.payload, result.status);
  response.headers.set("vary", "accept");
  return response;
}

// /lens/shot?url=… → a faithful PNG of the page, rendered by Cloudflare
// Browser Rendering (real headless Chrome, server-side). The Human view uses
// this only when a site forbids live framing. Needs CF_ACCOUNT_ID +
// BROWSER_RENDER_TOKEN in env; degrades to a clear 503 when unconfigured.
export async function handleLensShot(request, env, ctx) {
  const v = validateLensTarget(new URL(request.url).searchParams.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);
  if (!env.BROWSER_RENDER_TOKEN || !env.CF_ACCOUNT_ID) {
    const missing = [];
    if (!env.CF_ACCOUNT_ID) missing.push("CF_ACCOUNT_ID");
    if (!env.BROWSER_RENDER_TOKEN) missing.push("BROWSER_RENDER_TOKEN");
    return jsonResponse({ ok: false, missing, error: "Snapshot rendering isn't configured: this deployment can't see " + missing.join(" + ") + ". Check the exact variable name(s) (case-sensitive) and that they're set on the same environment this branch deploys to, then redeploy." }, 503);
  }

  // screenshots are the expensive path — tighter per-IP limit + a KV cache.
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (env.RN_KV) {
    const bucket = `lens:shotrl:${ip}:${Math.floor(Date.now() / 60000)}`;
    const n = parseInt((await env.RN_KV.get(bucket)) || "0", 10);
    if (n >= 8) return jsonResponse({ ok: false, error: "Snapshots are rate-limited to 8/min. Hang on a moment." }, 429);
    ctx.waitUntil(env.RN_KV.put(bucket, String(n + 1), { expirationTtl: 120 }));
  }

  const cacheKey = "lens:shot:" + (await lensSha256Hex(v.url));
  if (env.RN_KV) {
    const hit = await env.RN_KV.get(cacheKey, "arrayBuffer");
    if (hit) return new Response(hit, { headers: lensPngHeaders(true) });
  }

  const api = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/screenshot`;
  const payload = {
    url: v.url,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    screenshotOptions: { fullPage: true, type: "png" },
    gotoOptions: { waitUntil: "networkidle0", timeout: 18000 },
    userAgent: BOT_UA,
  };
  let r;
  try {
    r = await fetch(api, { method: "POST", headers: { authorization: "Bearer " + env.BROWSER_RENDER_TOKEN, "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch (e) {
    return jsonResponse({ ok: false, error: "Render request failed: " + ((e && e.message) || e) }, 502);
  }
  const ctype = r.headers.get("content-type") || "";
  if (!r.ok || !ctype.startsWith("image/")) {
    let detail = "";
    try { detail = (await r.text()).slice(0, 300); } catch (_e) {}
    return jsonResponse({ ok: false, error: "Browser Rendering returned " + r.status + ".", detail }, 502);
  }
  const buf = await r.arrayBuffer();
  if (env.RN_KV) ctx.waitUntil(env.RN_KV.put(cacheKey, buf, { expirationTtl: 3600 }));
  return new Response(buf, { headers: lensPngHeaders(false) });
}

export function lensPngHeaders(cached) {
  return { "content-type": "image/png", "cache-control": "public, max-age=3600", "x-robots-tag": "noindex", "x-lens-cache": cached ? "hit" : "miss" };
}

export async function lensSha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// X-Frame-Options / CSP frame-ancestors → can a browser embed this live?
export function lensFramable(headers) {
  const xfo = (headers["x-frame-options"] || "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin") || xfo.includes("allow-from")) {
    return { framable: false, reason: "X-Frame-Options: " + xfo.trim() };
  }
  const csp = headers["content-security-policy"] || "";
  const m = csp.match(/frame-ancestors([^;]*)/i);
  if (m) {
    const val = m[1].toLowerCase();
    if (/'none'/.test(val)) return { framable: false, reason: "CSP frame-ancestors 'none'" };
    if (!/\*/.test(val)) return { framable: false, reason: "CSP frame-ancestors restricts embedding" };
  }
  return { framable: true, reason: null };
}

// Only public http(s). Reject loopback / private / link-local / cloud-metadata
// literals + non-standard ports. (Workers can't egress to the internal network
// anyway, but blocking the obvious literals is cheap hygiene.)
export function validateLensTarget(raw) {
  const s0 = String(raw || "").trim();
  if (!s0) return { ok: false, error: "Type a URL to inspect." };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s0) && !/^https?:\/\//i.test(s0)) {
    return { ok: false, error: "Only http and https URLs." };
  }
  const s = /^https?:\/\//i.test(s0) ? s0 : "https://" + s0;
  let url;
  try { url = new URL(s); } catch { return { ok: false, error: "That doesn't parse as a URL." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Only http and https URLs." };
  if (url.port && url.port !== "80" && url.port !== "443") return { ok: false, error: "Only ports 80 and 443 are allowed." };
  if (lensHostBlocked(url.hostname.toLowerCase())) return { ok: false, error: "That host is on the no-fetch list (localhost / private / link-local)." };
  return { ok: true, url: url.toString() };
}

export function lensHostBlocked(host) {
  const h = host.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".onion")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;        // link-local incl. 169.254.169.254 metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                        // multicast / reserved
  }
  return false;
}

// the orchestrator: fetch the target, parse it, then probe the origin's
// site-level files in parallel. returns the full lens envelope.
export async function lensInspect(targetUrl, env) {
  const started = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  let res, body = "", truncated = false, ct = "", isTextual = false, isHtml = false;
  try {
    res = await lensFetch(targetUrl, env, ctrl.signal);
    ct = res.headers.get("content-type") || "";
    isTextual = ct === "" || /text|html|xml|json|javascript|\+xml|\+json/i.test(ct);
    isHtml = /html/i.test(ct);
    // read the body while the abort timer is still armed. clearing it before the
    // read (as this used to) left a slow-drip response unbounded in wall time.
    if (isTextual) { const r = await lensReadCapped(res, 2 * 1024 * 1024); body = r.text; truncated = r.truncated; }
  } finally { clearTimeout(to); }

  const finalUrl = res.url || targetUrl;
  const headers = {};
  for (const [k, val] of res.headers) headers[k] = val;

  const out = {
    ok: true, url: targetUrl, finalUrl, redirected: finalUrl !== targetUrl,
    status: res.status, contentType: ct, binary: !isTextual, truncated,
    elapsedMs: Date.now() - started, fetchedBy: BOT_UA, headers,
  };

  // can the browser embed this URL live in an <iframe>, or does the site
  // forbid framing (so the Human view must fall back to a screenshot)?
  var fr = lensFramable(headers);
  out.framable = fr.framable;
  out.frameReason = fr.reason;

  if (isHtml && body) {
    const attrs = await lensExtractAttrs(body);
    const jsonld = attrs.jsonld.map(lensParseJsonld);
    const fullText = lensText(body);
    out.anatomy = {
      rawHtml: body.length > 80000 ? body.slice(0, 80000) : body,
      rawBytes: body.length,
      headings: lensHeadings(body),
      text: fullText.slice(0, 24000),
      imgTotal: attrs.imgTotal, imgNoAlt: attrs.imgNoAlt,
    };
    out.anatomy.wordCount = out.anatomy.text ? out.anatomy.text.split(/\s+/).filter(Boolean).length : 0;
    out.structured = {
      title: (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].replace(/\s+/g, " ").trim(),
      meta: attrs.meta, og: attrs.og, twitter: attrs.twitter, jsonld,
      microdata: { itemtypes: [...attrs.microItemtypes], props: [...attrs.microProps] },
      rdfa: { typeof: [...attrs.rdfaTypeof], properties: [...attrs.rdfaProps] },
      microformats: [...attrs.mf],
      relLinks: attrs.relLinks.map((l) => ({ ...l, href: lensAbs(l.href, finalUrl) })),
    };
    out.ai = { markdown: lensMarkdown(body, finalUrl) };
    // context economics: the same page, priced per representation an agent
    // could ingest. Full (unsliced) lengths — the slices above are UI caps.
    out.cost = lensCost({ html: body.length, text: fullText.length, markdown: out.ai.markdown.length, headings: out.anatomy.headings });
  } else if (isTextual && body) {
    // non-HTML text (xml/json/txt/markdown): show it raw, no parsing.
    out.anatomy = { rawHtml: body.slice(0, 80000), rawBytes: body.length, text: lensText(body).slice(0, 24000), headings: [], imgTotal: 0, imgNoAlt: 0 };
    out.anatomy.wordCount = out.anatomy.text ? out.anatomy.text.split(/\s+/).filter(Boolean).length : 0;
    out.cost = lensCost({ raw: body.length });
  }

  // site-level discovery — probe the origin's well-known files + agent doors
  // in parallel.
  // re-validate the FINAL url before probing its origin: the input allowlist only
  // vetted the url the user typed, but redirect:"follow" could have landed us on a
  // private/link-local host. a blocked final host skips discovery entirely.
  const origin = (() => {
    try { const u = new URL(finalUrl); return lensHostBlocked(u.hostname.toLowerCase()) ? null : u.origin; }
    catch { return null; }
  })();
  if (origin) {
    const [robots, sitemap, llms, llmsFull, aiTxt, secTxt, tdmrep, agentCard, openapi, aiPlugin, apiCatalog, mcp, nlweb, mdNego, webBotAuth, openidConfig, oauthServer, oauthResource, authMd, mcpServerCard, agentSkills, ucp, acp, ap2, dnsAid, botViews] = await Promise.all([
      lensProbe(origin + "/robots.txt", env), lensProbe(origin + "/sitemap.xml", env),
      lensProbe(origin + "/llms.txt", env), lensProbe(origin + "/llms-full.txt", env),
      lensProbe(origin + "/ai.txt", env), lensProbe(origin + "/.well-known/security.txt", env),
      lensProbe(origin + "/.well-known/tdmrep.json", env),
      lensProbe(origin + "/.well-known/agent-card.json", env),
      lensProbe(origin + "/openapi.json", env),
      lensProbe(origin + "/.well-known/ai-plugin.json", env),
      lensProbe(origin + "/.well-known/api-catalog", env),
      lensProbeMcp(origin, env),
      lensProbeNlweb(origin, env),
      isHtml ? lensProbeMdNego(finalUrl, env) : Promise.resolve(null),
      lensProbe(origin + "/.well-known/http-message-signatures-directory", env),
      lensProbe(origin + "/.well-known/openid-configuration", env),
      lensProbe(origin + "/.well-known/oauth-authorization-server", env),
      lensProbe(origin + "/.well-known/oauth-protected-resource", env),
      lensProbe(origin + "/auth.md", env),
      lensProbe(origin + "/.well-known/mcp/server-card.json", env),
      lensProbe(origin + "/.well-known/agent-skills/index.json", env),
      lensProbe(origin + "/.well-known/ucp", env),
      lensProbe(origin + "/.well-known/acp.json", env),
      lensProbe(origin + "/.well-known/ap2", env),
      lensProbeDnsAid(new URL(finalUrl).hostname),
      lensProbeBotViews(finalUrl, env),
    ]);
    const feeds = (out.structured?.relLinks || []).filter((l) =>
      /alternate/.test(l.rel) && /(rss|atom|feed|\+xml|\+json)/i.test((l.type || "") + " " + (l.href || "")));
    out.discovery = {
      origin, robotsTxt: robots, sitemapXml: sitemap, llmsTxt: llms, llmsFullTxt: llmsFull,
      aiTxt, securityTxt: secTxt, feeds, dnsAid,
      webBotAuth, oauthDiscovery: { openidConfiguration: openidConfig, oauthAuthorizationServer: oauthServer },
      oauthProtectedResource: oauthResource, authMd, mcpServerCard, agentSkills,
      commerce: { ucp, acp, ap2 },
    };
    out.ai = out.ai || {};
    out.ai.llmsTxtPresent = llms.ok;
    out.ai.directives = {
      metaRobots: out.structured?.meta?.robots || null,
      xRobotsTag: headers["x-robots-tag"] || null,
      namesAiCrawlers: robots.ok ? /GPTBot|ClaudeBot|Claude-Web|Google-Extended|CCBot|PerplexityBot|anthropic-ai|OAI-SearchBot|Bytespider|Amazonbot/i.test(robots.body || "") : false,
    };
    out.terms = lensTerms({
      finalUrl, status: res.status, headers, body, robots, tdmrep,
      metaRobots: out.structured?.meta?.robots || null,
    });
    out.agent = lensAgentDoors({
      llmsTxt: llms, mdNego, mcp, nlweb, agentCard, openapi, aiPlugin, apiCatalog,
      webmcp: isHtml ? lensDetectWebmcp(body) : { found: false },
    });
    out.botViews = botViews;
    out.readiness = lensReadiness({
      finalUrl, status: res.status, headers, body, robots, sitemap, terms: out.terms,
      discovery: out.discovery, agent: out.agent, openapi, botViews,
    });
  }
  return out;
}

// honest, identified fetch — AadharshBot UA + (when the key is set) a Web Bot
// Auth signature, same identity the rest of the site crawls under.
// `accept` override: the md-negotiation and MCP probes speak different Accepts.
export async function lensFetch(targetUrl, env, signal, accept) {
  const headers = new Headers({
    "user-agent": BOT_UA,
    "accept": accept || "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    "accept-language": "en-US,en;q=0.9",
  });
  if (env.RN_SIGNING_KEY_JWK) {
    try {
      const sig = await signRequestForWebBotAuth(targetUrl, env);
      headers.set("Signature-Agent", `"${SIG_AGENT}"`);
      headers.set("Signature-Input", `sig1=${sig.params}`);
      headers.set("Signature", `sig1=:${sig.b64}:`);
    } catch (_e) { /* recipient just can't verify */ }
  }
  // Fetching our own hostname over the network loops back through this same
  // worker, and Cloudflare kills the loop with a 522 — which is why the featured
  // "Try: aadhar.sh" example (and every self-probe: robots.txt, llms.txt, …) used
  // to render the site as down. Serve our own paths straight from the ASSETS
  // binding instead: same bytes a crawler would get, no network hop, no loop.
  try {
    const u = new URL(targetUrl);
    if (env.ASSETS && u.hostname.toLowerCase() === CANONICAL_HOST) {
      // The public homepage negotiates text/markdown in the Worker before the
      // static asset layer. Reproduce that branch here so a self-scan measures
      // the same surface an external agent receives, not just /index.html.
      if (u.pathname === "/" && /text\/markdown/i.test(headers.get("accept") || "")) {
        const md = await env.ASSETS.fetch(new Request(new URL("/index.md", u).toString(), { method: "GET", headers }));
        if (md.ok) {
          const body = await md.text();
          return new Response(body, { status: 200, headers: { "content-type": "text/markdown; charset=utf-8", "x-markdown-tokens": String(Math.ceil(body.length / 4)), "vary": "accept" } });
        }
      }
      return env.ASSETS.fetch(new Request(u.toString(), { method: "GET", headers }));
    }
  } catch (_e) { /* fall through to a normal fetch */ }
  return fetch(targetUrl, { method: "GET", headers, redirect: "follow", signal, cf: { cacheTtl: 0 } });
}

// read a response body but stop at `max` bytes so a giant page can't blow memory.
export async function lensReadCapped(res, max) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) { const t = await res.text(); return { text: t.length > max ? t.slice(0, max) : t, truncated: t.length > max }; }
  const chunks = []; let total = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > max) { chunks.push(value.subarray(0, max - total)); truncated = true; try { await reader.cancel(); } catch (_e) {} break; }
    chunks.push(value); total += value.length;
  }
  let len = 0; for (const c of chunks) len += c.length;
  const merged = new Uint8Array(len); let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return { text: new TextDecoder("utf-8").decode(merged), truncated };
}

// DNS-AID is a DNS surface, not an HTTP file. Query the three discovery names
// the scanner recognizes through Cloudflare's DNS-over-HTTPS endpoint and keep
// the result deliberately small: Lens is showing whether a door exists, not
// pretending to be a full DNS debugger.
export async function lensProbeDnsAid(hostname) {
  const names = ["_index._agents.", "_a2a._agents.", "_mcp._agents."].map((prefix) => prefix + hostname);
  try {
    const rows = await Promise.all(names.map(async (name) => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 4500);
      try {
        const url = "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(name) + "&type=SVCB&do=1";
        const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: ctrl.signal, cf: { cacheTtl: 0 } });
        const body = await res.json();
        const answers = Array.isArray(body.Answer) ? body.Answer : [];
        return { name, status: res.status, dnssecValidated: body.AD === true, answers: answers.filter((a) => a.type === 64 || a.type === 65).length };
      } finally { clearTimeout(to); }
    }));
    const records = rows.filter((r) => r.answers > 0);
    return { ok: true, found: records.length > 0, dnssecValidated: records.some((r) => r.dnssecValidated), names, records: rows };
  } catch (e) {
    return { ok: false, found: false, names, error: (e && e.message) || String(e) };
  }
}

// These are representative request identities, not claims about the exact
// implementation each vendor uses. A bot view is a bounded GET observation;
// the policy verdict in Terms remains the source of truth for robots.txt.
const LENS_BOT_VIEWS = [
  { key: "GPTBot", label: "GPTBot", owner: "OpenAI", ua: "GPTBot/1.0" },
  { key: "ClaudeBot", label: "ClaudeBot", owner: "Anthropic", ua: "ClaudeBot/1.0" },
  { key: "CCBot", label: "CCBot", owner: "Common Crawl", ua: "CCBot/2.0" },
  { key: "Google-Extended", label: "Google-Extended", owner: "Google", ua: "Google-Extended" },
  { key: "PerplexityBot", label: "PerplexityBot", owner: "Perplexity", ua: "PerplexityBot/1.0" },
  { key: "ChatGPT-User", label: "ChatGPT-User", owner: "OpenAI", ua: "ChatGPT-User/1.0" },
];

export async function lensFetchAsBot(targetUrl, env, signal, userAgent) {
  const headers = new Headers({
    "user-agent": userAgent,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    "accept-language": "en-US,en;q=0.9",
  });
  try {
    const u = new URL(targetUrl);
    if (env.ASSETS && u.hostname.toLowerCase() === CANONICAL_HOST) {
      return env.ASSETS.fetch(new Request(u.toString(), { method: "GET", headers }));
    }
  } catch (_e) { /* fall through to a normal fetch */ }
  return fetch(targetUrl, { method: "GET", headers, redirect: "follow", signal, cf: { cacheTtl: 0 } });
}

export async function lensProbeBotView(targetUrl, env, profile) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 4500);
  try {
    const res = await lensFetchAsBot(targetUrl, env, ctrl.signal, profile.ua);
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim();
    const cap = await lensReadCapped(res, 2048);
    const challenge = res.headers.get("cf-mitigated") === "challenge" || /challenge-platform|<title>Just a moment/i.test(cap.text);
    return {
      key: profile.key, label: profile.label, owner: profile.owner, userAgent: profile.ua,
      status: res.status, contentType, sampleBytes: cap.text.length,
      blocked: challenge || [401, 403, 406, 429, 451].includes(res.status), challenge,
      redirected: res.url !== targetUrl,
    };
  } catch (e) {
    return { key: profile.key, label: profile.label, owner: profile.owner, userAgent: profile.ua, status: null, contentType: "", sampleBytes: 0, blocked: false, challenge: false, error: (e && e.message) || String(e) };
  } finally { clearTimeout(to); }
}

export function lensProbeBotViews(targetUrl, env) {
  return Promise.all(LENS_BOT_VIEWS.map((profile) => lensProbeBotView(targetUrl, env, profile)));
}

// small, forgiving probe for a single site-level file.
export async function lensProbe(url, env) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try { res = await lensFetch(url, env, ctrl.signal); } finally { clearTimeout(to); }
    if (!res.ok) { try { await res.body?.cancel(); } catch (_e) {} return { ok: false, status: res.status, url }; }
    const cap = await lensReadCapped(res, 256 * 1024);
    return { ok: true, status: res.status, url, contentType: res.headers.get("content-type") || "", body: cap.text, truncated: cap.truncated };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), url }; }
}

// HTMLRewriter pass for the attribute-driven extraction it's robust at:
// meta/OG/Twitter, JSON-LD script bodies, rel-links, img alt coverage,
// microdata, RDFa, and microformats class tokens.
export async function lensExtractAttrs(html) {
  const acc = {
    meta: {}, og: {}, twitter: {}, relLinks: [], jsonld: [],
    microItemtypes: new Set(), microProps: new Set(), mf: new Set(),
    rdfaTypeof: new Set(), rdfaProps: new Set(), imgTotal: 0, imgNoAlt: 0,
  };
  let jbuf = null;
  const MF = /^(h|p|u|dt|e)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const MF_CLASSIC = /^(vcard|hcard|hcalendar|hentry|hfeed|hreview|hrecipe|hatom|hresume|hproduct|adr|geo)$/;
  const rw = new HTMLRewriter()
    .on("meta", { element(el) {
      const name = (el.getAttribute("name") || "").toLowerCase();
      const prop = (el.getAttribute("property") || "").toLowerCase();
      const content = el.getAttribute("content") || "";
      if (prop.startsWith("og:")) acc.og[prop.slice(3)] = content;
      else if (/^(article|product|book|profile|video|music):/.test(prop)) acc.og[prop] = content;
      else if (name.startsWith("twitter:")) acc.twitter[name.slice(8)] = content;
      else if (name) acc.meta[name] = content;
      else if (prop) acc.meta[prop] = content;
    } })
    .on("script", {
      element(el) { jbuf = (el.getAttribute("type") || "").toLowerCase() === "application/ld+json" ? [] : null; },
      text(t) { if (jbuf) { jbuf.push(t.text); if (t.lastInTextNode) { acc.jsonld.push(jbuf.join("")); jbuf = null; } } },
    })
    .on("link", { element(el) {
      const rel = (el.getAttribute("rel") || "").toLowerCase();
      if (!rel || acc.relLinks.length >= 80) return;
      acc.relLinks.push({ rel, href: el.getAttribute("href") || "", type: el.getAttribute("type") || "", title: el.getAttribute("title") || "", hreflang: el.getAttribute("hreflang") || "" });
    } })
    .on("img", { element(el) { acc.imgTotal++; const alt = el.getAttribute("alt"); if (alt === null || alt.trim() === "") acc.imgNoAlt++; } })
    .on("[itemtype]", { element(el) { const v = el.getAttribute("itemtype"); if (v && acc.microItemtypes.size < 100) acc.microItemtypes.add(v); } })
    .on("[itemprop]", { element(el) { const v = el.getAttribute("itemprop"); if (v && acc.microProps.size < 200) v.split(/\s+/).forEach((x) => x && acc.microProps.add(x)); } })
    .on("[typeof]", { element(el) { const v = el.getAttribute("typeof"); if (v && acc.rdfaTypeof.size < 100) v.split(/\s+/).forEach((x) => x && acc.rdfaTypeof.add(x)); } })
    .on("[property]", { element(el) { const v = (el.getAttribute("property") || ""); if (acc.rdfaProps.size >= 200) return; v.split(/\s+/).forEach((x) => { if (x && !/^(og|twitter|article|product|book|profile|video|music):/.test(x)) acc.rdfaProps.add(x); }); } })
    .on("[class]", { element(el) { if (acc.mf.size >= 60) return; (el.getAttribute("class") || "").split(/\s+/).forEach((tok) => { if (MF.test(tok) || MF_CLASSIC.test(tok)) acc.mf.add(tok); }); } });
  await rw.transform(new Response(html)).arrayBuffer();
  return acc;
}

export function lensParseJsonld(raw) {
  const trimmed = String(raw || "").trim();
  try {
    const obj = JSON.parse(trimmed);
    const types = new Set();
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (o["@type"]) [].concat(o["@type"]).forEach((t) => types.add(String(t)));
      for (const k in o) walk(o[k]);
    })(obj);
    return { valid: true, types: [...types], json: JSON.stringify(obj, null, 2).slice(0, 12000) };
  } catch (e) { return { valid: false, error: (e && e.message) || "parse error", raw: trimmed.slice(0, 3000) }; }
}

export function lensHeadings(html) {
  const out = []; const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi; let m;
  while ((m = re.exec(html)) && out.length < 250) { const txt = lensStripInline(m[2]).trim(); if (txt) out.push({ level: +m[1], text: txt.slice(0, 300) }); }
  return out;
}

export function lensText(html) {
  let s = html;
  const b = s.match(/<body[^>]*>([\s\S]*)<\/body>/i); if (b) s = b[1];
  s = s.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  return lensDecode(s).replace(/\s+/g, " ").trim();
}

// best-effort, dependency-free HTML→Markdown — roughly what a basic LLM
// scraper ingests. High-fidelity Readability/Turndown is a deliberate v2.
export function lensMarkdown(html, baseUrl) {
  let s = html;
  const b = s.match(/<body[^>]*>([\s\S]*)<\/body>/i); if (b) s = b[1];
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|template|svg|head|nav|footer|aside)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, i) => "\n\n```\n" + lensDecode(i.replace(/<[^>]+>/g, "")).replace(/\n+$/g, "") + "\n```\n\n");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (m, i) => "`" + lensStripInline(i).trim() + "`");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, l, i) => "\n\n" + "#".repeat(+l) + " " + lensStripInline(i).trim() + "\n\n");
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, i) => "\n\n> " + lensStripInline(i).trim().replace(/\n+/g, "\n> ") + "\n\n");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, i) => "- " + lensStripInline(i).trim() + "\n");
  s = s.replace(/<img\b[^>]*>/gi, (m) => { const alt = lensTagAttr(m, "alt"); const src = lensAbs(lensTagAttr(m, "src"), baseUrl); return src ? `![${alt}](${src})` : ""; });
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (m, i) => { const href = lensAbs(lensTagAttr(m, "href"), baseUrl); const txt = lensStripInline(i).trim(); if (!txt) return ""; return href ? `[${txt}](${href})` : txt; });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, i) => "**" + lensStripInline(i).trim() + "**");
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, i) => "*" + lensStripInline(i).trim() + "*");
  s = s.replace(/<\/(p|div|section|article|header|main|ul|ol|table|tr|h[1-6])>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = lensDecode(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

export function lensStripInline(h) { return lensDecode(String(h).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " "); }

export function lensTagAttr(tag, name) { const m = String(tag).match(new RegExp(name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i")); return m ? (m[2] ?? m[3] ?? m[4] ?? "") : ""; }

export function lensAbs(href, base) { if (!href) return href; try { return new URL(href, base).toString(); } catch { return href; } }

export function lensDecode(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch { return m; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return m; } })
    .replace(/&amp;/g, "&");
}

// ── the Terms lens ----------------------------------------------------------
// What this site permits, resists, or charges — per bot, per path. Everything
// below is read from PUBLISHED policy (robots.txt, Content-Signal, TDMRep,
// noai directives) plus what happened to our own identified fetch. Lens never
// wears another bot's user-agent to test enforcement; same honesty rule as
// AadharshBot itself.

// The crawlers worth a scoreboard row: the household names of the agentic web,
// grouped by what they take (a search index / a training corpus / live
// answers). Verdicts are evaluated per-bot against the exact fetched path.
const LENS_BOTS = [
  { ua: "Googlebot",          owner: "Google",       kind: "search",  note: "the classic search index" },
  { ua: "Bingbot",            owner: "Microsoft",    kind: "search",  note: "Bing (and Copilot grounding)" },
  { ua: "GPTBot",             owner: "OpenAI",       kind: "train",   note: "training corpus" },
  { ua: "ClaudeBot",          owner: "Anthropic",    kind: "train",   note: "training corpus" },
  { ua: "Google-Extended",    owner: "Google",       kind: "train",   note: "the Gemini-training consent token" },
  { ua: "Applebot-Extended",  owner: "Apple",        kind: "train",   note: "Apple Intelligence consent token" },
  { ua: "Meta-ExternalAgent", owner: "Meta",         kind: "train",   note: "Llama training + Meta AI" },
  { ua: "CCBot",              owner: "Common Crawl", kind: "train",   note: "the open crawl most models started on" },
  { ua: "Bytespider",         owner: "ByteDance",    kind: "train",   note: "famously robots-indifferent" },
  { ua: "Amazonbot",          owner: "Amazon",       kind: "train",   note: "Alexa answers + training" },
  { ua: "OAI-SearchBot",      owner: "OpenAI",       kind: "answers", note: "the ChatGPT Search index" },
  { ua: "ChatGPT-User",       owner: "OpenAI",       kind: "answers", note: "live fetch for a user's chat" },
  { ua: "Claude-User",        owner: "Anthropic",    kind: "answers", note: "live fetch for a user's chat" },
  { ua: "PerplexityBot",      owner: "Perplexity",   kind: "answers", note: "answer-engine index" },
  { ua: "AadharshBot",        owner: "aadhar.sh",    kind: "answers", note: "the bot that fetched this page" },
];

// robots.txt → { groups: [{agents, rules, signal}], sitemaps }. Groups follow
// RFC 9309: consecutive User-agent lines share one group; Content-Signal
// (contentsignals.org) rides along as a group-level directive.
export function lensParseRobots(txt) {
  const groups = [], sitemaps = [];
  let cur = null, inAgents = false;
  for (const raw of String(txt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!inAgents) { cur = { agents: [], rules: [], signal: null }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      inAgents = true;
      continue;
    }
    inAgents = false;
    if (key === "sitemap") { sitemaps.push(val); continue; }
    if (!cur) continue;
    if (key === "allow" || key === "disallow") cur.rules.push({ allow: key === "allow", pattern: val });
    else if (key === "content-signal") cur.signal = val;
  }
  return { groups, sitemaps };
}

// RFC 9309 evaluation for one bot: the group with the longest user-agent token
// that prefixes the bot's product token wins ('*' only as fallback), then the
// longest matching path rule; Allow beats Disallow on a length tie.
export function lensRobotsVerdict(parsed, botUa, path) {
  const token = botUa.toLowerCase();
  let bestUa = null;
  for (const g of parsed.groups) for (const ua of g.agents) {
    if (ua !== "*" && token.startsWith(ua) && (bestUa === null || ua.length > bestUa.length)) bestUa = ua;
  }
  const matchedUa = bestUa ?? (parsed.groups.some((g) => g.agents.includes("*")) ? "*" : null);
  if (matchedUa === null) return { verdict: "allow", matchedUa: null, rule: null, signal: null };
  const chosen = parsed.groups.filter((g) => g.agents.includes(matchedUa));
  let best = null;
  for (const g of chosen) for (const r of g.rules) {
    if (!r.pattern || !lensPathMatch(r.pattern, path)) continue; // empty Disallow: = no rule at all
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
  }
  const signal = chosen.map((g) => g.signal).find(Boolean) || null;
  return {
    verdict: best && !best.allow ? "block" : "allow",
    matchedUa,
    rule: best ? (best.allow ? "Allow: " : "Disallow: ") + best.pattern : null,
    signal,
  };
}

// robots path patterns: '*' is a wildcard, a trailing '$' anchors the end.
export function lensPathMatch(pattern, path) {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const rx = "^" + body.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : "");
  try { return new RegExp(rx).test(path); } catch { return path.startsWith(body.split("*")[0]); }
}

// "search=yes,ai-input=yes,ai-train=no" → { search: "yes", ... }
export function lensParseContentSignal(raw) {
  const out = {};
  for (const part of String(raw || "").split(",")) {
    const kv = part.split("=");
    if (kv.length === 2 && kv[0].trim()) out[kv[0].trim().toLowerCase()] = kv[1].trim().toLowerCase();
  }
  return out;
}

// assemble the whole terms envelope: scoreboard + signals + price + enforcement
// + the open → signaled → enforced → paid spectrum.
export function lensTerms({ finalUrl, status, headers, body, robots, tdmrep, metaRobots }) {
  let path = "/";
  try { const u = new URL(finalUrl); path = u.pathname + u.search; } catch (_e) {}
  const t = { path, robotsPresent: !!(robots && robots.ok) };

  // "absent" (a clean 404) and "unreachable" (timeout / 403 / 5xx) are very
  // different claims — never report unknown terms as no terms.
  const robotsAbsent = !!(robots && !robots.ok && (robots.status === 404 || robots.status === 410));
  t.robotsUnknown = !t.robotsPresent && !robotsAbsent;
  t.robotsError = t.robotsUnknown ? ((robots && (robots.error || (robots.status ? "HTTP " + robots.status : null))) || "unreachable") : null;

  const parsed = t.robotsPresent ? lensParseRobots(robots.body || "") : { groups: [], sitemaps: [] };
  t.scoreboard = LENS_BOTS.map((b) => {
    if (t.robotsUnknown) return { ua: b.ua, owner: b.owner, kind: b.kind, note: b.note, verdict: "unknown", matchedUa: null, rule: null };
    const v = lensRobotsVerdict(parsed, b.ua, path);
    return { ua: b.ua, owner: b.owner, kind: b.kind, note: b.note, verdict: v.verdict, matchedUa: v.matchedUa, rule: v.rule };
  });
  t.signals = parsed.groups.filter((g) => g.signal).map((g) => ({ agents: g.agents, raw: g.signal, parsed: lensParseContentSignal(g.signal) }));

  // price signals on the fetched response: HTTP 402, Cloudflare pay-per-crawl
  // headers, an x402 payment envelope in the body.
  const crawlerHeaders = {};
  for (const k in headers) if (/^crawler-/i.test(k)) crawlerHeaders[k] = headers[k];
  t.paid = { http402: status === 402, crawlerHeaders, x402: null };
  if (status === 402 && body) {
    try { const j = JSON.parse(body); if (j && (j.x402Version != null || j.accepts)) t.paid.x402 = JSON.stringify(j, null, 2).slice(0, 6000); } catch (_e) {}
  }

  // enforcement: what actually happened to our identified, signed fetch.
  const challenged = headers["cf-mitigated"] === "challenge" || /_cf_chl_opt|challenge-platform|<title>Just a moment/i.test(String(body || "").slice(0, 6000));
  t.enforcement = { status, challenged, blocked: challenged || status === 401 || status === 403 || status === 451 };

  const xRobotsTag = headers["x-robots-tag"] || null;
  t.directives = { metaRobots: metaRobots || null, xRobotsTag, noai: /noai|noimageai/i.test((metaRobots || "") + " " + (xRobotsTag || "")) };
  t.tdmrep = tdmrep && tdmrep.ok ? { present: true, body: String(tdmrep.body || "").slice(0, 4000) } : { present: false };

  // the spectrum: strongest tier present wins; reasons list everything found.
  // Nuance: an all-yes Content-Signal (or naming bots only to allow them) is an
  // explicit GRANT — that keeps the site at "open", just deliberately so.
  const reasons = [];
  const named = t.scoreboard.filter((b) => b.matchedUa && b.matchedUa !== "*");
  const blocked = t.scoreboard.filter((b) => b.verdict === "block");
  const restrictiveSignals = t.signals.some((s) => Object.values(s.parsed).some((v) => v !== "yes"));
  if (t.paid.http402) reasons.push({ tier: "paid", why: "answered 402 Payment Required" + (t.paid.x402 ? " with an x402 payment envelope" : "") });
  if (Object.keys(crawlerHeaders).length) reasons.push({ tier: "paid", why: "advertises pay-per-crawl price headers (" + Object.keys(crawlerHeaders).join(", ") + ")" });
  if (t.enforcement.challenged) reasons.push({ tier: "enforced", why: "served a bot challenge to our identified fetch" });
  else if (t.enforcement.blocked) reasons.push({ tier: "enforced", why: "refused our identified fetch with HTTP " + status });
  if (blocked.length) reasons.push({ tier: "signaled", why: "robots.txt blocks " + blocked.length + " of " + t.scoreboard.length + " scoreboard crawlers for this path" });
  if (named.length && !blocked.length) reasons.push({ tier: "open", why: "robots.txt names " + named.length + " scoreboard crawler" + (named.length > 1 ? "s" : "") + " explicitly, all allowed" });
  if (t.signals.length) reasons.push(restrictiveSignals
    ? { tier: "signaled", why: "declares restrictive Content-Signal preferences in robots.txt" }
    : { tier: "open", why: "declares Content-Signal preferences, all yes — explicitly open, in writing" });
  if (t.directives.noai) reasons.push({ tier: "signaled", why: "sets a noai directive (meta robots / X-Robots-Tag)" });
  if (t.tdmrep.present) reasons.push({ tier: "signaled", why: "publishes a TDM Reservation Protocol manifest" });
  if (t.robotsUnknown) reasons.push({ tier: "open", why: "robots.txt could not be read (" + t.robotsError + ") — robots terms unknown, not absent" });
  const order = ["open", "signaled", "enforced", "paid"];
  t.spectrum = {
    tier: reasons.reduce((top, r) => (order.indexOf(r.tier) > order.indexOf(top) ? r.tier : top), "open"),
    reasons: reasons.length ? reasons.map((r) => r.why) : ["no machine terms found — any bot may read anything here, free"],
  };
  return t;
}

// ── context economics --------------------------------------------------------
// What reading this page costs a machine, per representation it could ingest.
// The semantic web asked publishers to structure content up front; LLMs won by
// brute-force reading the human HTML instead — this is that choice, priced.
//
// chars-per-token calibrated 2026-07 against o200k_base on real pages
// (stripe.com 584KB, wikipedia Semantic_Web, daringfireball, aadhar.sh;
// size-weighted): raw HTML ≈ 2.9 (minified script-heavy markup tokenizes
// brutally — stripe hit 2.5), stripped text ≈ 4.5, markdown ≈ 3.9.
// Estimates, and the UI labels them ≈.
const LENS_CPT = { html: 3.0, text: 4.5, markdown: 3.9 };
// reference input prices, USD per million tokens, last checked 2026-07.
const LENS_RATES = [
  { model: "Claude Sonnet 4.5", usdPerMtok: 3.0 },
  { model: "GPT-5", usdPerMtok: 1.25 },
  { model: "Claude Haiku 4.5", usdPerMtok: 1.0 },
];

export function lensCost({ html, text, markdown, headings, raw }) {
  const tiers = [];
  const add = (key, label, note, chars, cpt) => {
    if (chars > 0) tiers.push({ key, label, note, chars, tokens: Math.round(chars / cpt) });
  };
  add("html", "raw HTML", "what a naive scraper puts in context", html, LENS_CPT.html);
  add("text", "stripped text", "tags dropped, structure lost", text, LENS_CPT.text);
  add("markdown", "markdown", "the AI-view rendering below", markdown, LENS_CPT.markdown);
  if (headings && headings.length) {
    const outline = headings.map((h) => "#".repeat(h.level) + " " + h.text).join("\n");
    add("outline", "outline", "headings only — what an efficient agent asks for first", outline.length, LENS_CPT.markdown);
  }
  add("raw", "raw body", "served as-is — already machine-shaped", raw, LENS_CPT.text);
  return tiers.length ? { tokenizer: "o200k_base, calibrated estimate", checked: "2026-07", rates: LENS_RATES, tiers } : null;
}

// ── agent doors ---------------------------------------------------------------
// Does this site publish surfaces for agents, or must they brute-force the
// human page? The research question behind the whole machine-internet thread
// (publish-for-agents vs drive-the-human-web), probed live per site.

// /mcp — Streamable HTTP MCP servers answer a GET with SSE, a JSON-RPC error,
// 401 + WWW-Authenticate (OAuth-protected), or a POST-only 4xx in JSON. A SPA
// answering 200 text/html is a router fallback, not a server.
export async function lensProbeMcp(origin, env) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try { res = await lensFetch(origin + "/mcp", env, ctrl.signal, "application/json, text/event-stream"); }
    finally { clearTimeout(to); }
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    const www = res.headers.get("www-authenticate") || "";
    const head = (await lensReadCapped(res, 2048)).text;
    if (/^text\/event-stream$/i.test(ct)) return { verdict: "yes", detail: "SSE stream at /mcp" };
    if (/jsonrpc/i.test(head)) return { verdict: "yes", detail: "JSON-RPC answer at /mcp (HTTP " + res.status + ")" };
    if (res.status === 401 && www) return { verdict: "likely", detail: "401 + WWW-Authenticate at /mcp (OAuth-protected server)" };
    if ([400, 405, 406].includes(res.status) && /json/i.test(ct)) return { verdict: "maybe", detail: "HTTP " + res.status + " " + ct + " at /mcp (POST-only server?)" };
    return { verdict: "no", detail: res.status === 404 ? "no /mcp" : "HTTP " + res.status + (ct ? " " + ct : "") };
  } catch (_e) { return { verdict: "unknown", detail: "probe failed" }; }
}

// /ask — NLWeb's REST convention. A real instance answers JSON (usually an
// error asking for a query); we never send one, so nothing runs on their side.
export async function lensProbeNlweb(origin, env) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try { res = await lensFetch(origin + "/ask", env, ctrl.signal, "application/json"); }
    finally { clearTimeout(to); }
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    const head = (await lensReadCapped(res, 1024)).text.trim();
    if (res.status === 404 || /html/i.test(ct)) return { verdict: "no", detail: res.status === 404 ? "no /ask" : "HTML at /ask (a page, not an endpoint)" };
    if (/json/i.test(ct) || head.startsWith("{")) return { verdict: "maybe", detail: "JSON at /ask (HTTP " + res.status + ") — NLWeb-shaped" };
    return { verdict: "no", detail: "HTTP " + res.status + (ct ? " " + ct : "") };
  } catch (_e) { return { verdict: "unknown", detail: "probe failed" }; }
}

// Accept: text/markdown — Cloudflare-style content negotiation: the same URL,
// re-served for machines. Supported iff the content-type actually flips.
export async function lensProbeMdNego(pageUrl, env) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try { res = await lensFetch(pageUrl, env, ctrl.signal, "text/markdown"); }
    finally { clearTimeout(to); }
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    try { await res.body?.cancel(); } catch (_e) {}
    return { supported: /^text\/markdown$/i.test(ct), contentType: ct, status: res.status };
  } catch (_e) { return { supported: false, note: "probe failed" }; }
}

// WebMCP is a page-level JS API (navigator.modelContext), so the marker lives
// in the HTML we already fetched — no extra request.
export function lensDetectWebmcp(html) {
  const m = String(html || "").match(/navigator\.modelContext|modelContext\.(?:registerTool|provideContext)|window\.webmcp/i);
  return m ? { found: true, marker: m[0] } : { found: false };
}

// a well-known JSON probe only counts if the body parses AND has the right
// shape — SPAs answer 200 text/html for every path, and that must read as
// absent, not present. And a probe that never answered reads as UNKNOWN,
// not absent — same honesty rule as the robots.txt tier.
function lensJsonDoor(probe, validate, label) {
  if (!probe || !probe.ok) {
    const unknown = !probe || !!probe.error || (probe.status && probe.status >= 500);
    return { present: false, status: probe ? probe.status : null, unknown };
  }
  let j = null;
  try { j = JSON.parse(probe.body); } catch (_e) { return { present: false, note: "answered, but not JSON (SPA fallback?)" }; }
  if (!j || typeof j !== "object" || !validate(j)) return { present: false, note: "JSON, but not " + label + "-shaped" };
  return { present: true, json: j };
}

export function lensAgentDoors({ llmsTxt, mdNego, mcp, nlweb, webmcp, agentCard, openapi, aiPlugin, apiCatalog }) {
  const doors = {
    mcp: mcp || { verdict: "unknown" },
    nlweb: nlweb || { verdict: "unknown" },
    webmcp: webmcp || { found: false },
    agentCard: lensJsonDoor(agentCard, (j) => j.name && (j.url || j.skills || j.capabilities || j.protocolVersion), "agent-card"),
    openapi: lensJsonDoor(openapi, (j) => j.openapi || j.swagger, "OpenAPI"),
    aiPlugin: lensJsonDoor(aiPlugin, (j) => j.schema_version || j.name_for_model, "ai-plugin"),
    apiCatalog: lensJsonDoor(apiCatalog, (j) => j.linkset, "linkset"),
    mdNegotiation: mdNego || { supported: false, note: "not probed (non-HTML target)" },
    llmsTxt: {
      present: !!(llmsTxt && llmsTxt.ok),
      unknown: !!(llmsTxt && !llmsTxt.ok && llmsTxt.error),
    },
  };
  if (doors.agentCard.present) doors.agentCard.detail = String(doors.agentCard.json.name || "").slice(0, 80);
  if (doors.openapi.present) doors.openapi.detail = "OpenAPI " + String(doors.openapi.json.openapi || doors.openapi.json.swagger).slice(0, 20);
  if (doors.aiPlugin.present) doors.aiPlugin.detail = String(doors.aiPlugin.json.name_for_model || "manifest").slice(0, 80);
  if (doors.apiCatalog.present) doors.apiCatalog.detail = (doors.apiCatalog.json.linkset || []).length + " linkset entr" + ((doors.apiCatalog.json.linkset || []).length === 1 ? "y" : "ies");
  for (const k of ["agentCard", "openapi", "aiPlugin", "apiCatalog"]) delete doors[k].json;

  // the verdict: action surfaces beat readable ones beat nothing.
  const action = [];
  if (doors.mcp.verdict === "yes" || doors.mcp.verdict === "likely") action.push("an MCP endpoint");
  if (doors.nlweb.verdict === "maybe") action.push("an NLWeb-shaped /ask");
  if (doors.webmcp.found) action.push("in-page WebMCP tools");
  if (doors.agentCard.present) action.push("an A2A agent card");
  const readable = [];
  if (doors.llmsTxt.present) readable.push("llms.txt");
  if (doors.mdNegotiation.supported) readable.push("markdown negotiation");
  if (doors.apiCatalog.present) readable.push("an RFC 9264 API catalog");
  if (doors.openapi.present) readable.push("OpenAPI");
  if (doors.aiPlugin.present) readable.push("a legacy ai-plugin manifest");
  // probes that never answered can't vote — say so rather than undercount.
  const unknowns = [];
  if (doors.llmsTxt.unknown) unknowns.push("llms.txt");
  if (doors.mcp.verdict === "unknown") unknowns.push("/mcp");
  if (doors.nlweb.verdict === "unknown") unknowns.push("/ask");
  if (doors.mdNegotiation.note === "probe failed") unknowns.push("markdown negotiation");
  for (const [k, label] of [["agentCard", "agent card"], ["openapi", "OpenAPI"], ["aiPlugin", "ai-plugin"], ["apiCatalog", "api-catalog"]]) {
    if (doors[k].unknown) unknowns.push(label);
  }

  // a timed-out probe can hide an action/readable door too, not just flip a
  // human-only verdict — so hedge on every verdict where unknowns remain.
  const hedge = unknowns.length
    ? " (" + unknowns.length + " probe" + (unknowns.length > 1 ? "s" : "") + " never answered, so this may undercount: " + unknowns.join(", ") + ")"
    : "";
  let verdict, note;
  if (action.length) {
    verdict = "agent-native";
    note = "This site publishes action surfaces: " + action.join(", ") + (readable.length ? " — plus " + readable.join(", ") + "." : ".") + hedge;
  } else if (readable.length) {
    verdict = "agent-readable";
    note = "This site publishes for machine readers (" + readable.join(", ") + ") but exposes no action surface." + hedge;
  } else if (unknowns.length) {
    verdict = "human-only";
    note = "No agent door answered, but " + unknowns.length + " probe" + (unknowns.length > 1 ? "s" : "") + " (" + unknowns.join(", ") + ") never got a response — this verdict may undercount.";
  } else {
    verdict = "human-only";
    note = "No agent door found. An agent here must brute-force the human page — the AI view prices exactly that.";
  }
  doors.strategy = { verdict, note, action, readable, unknowns };
  return doors;
}

// ── agent readiness rubric -------------------------------------------------
// A local, evidence-backed implementation of the public IsItAgentReady rubric.
// The score is intentionally transparent: pass / (pass + fail + unknown),
// with neutral emerging-commerce checks excluded. A site can inspect exactly
// why a point moved instead of receiving an opaque vendor verdict.
const LENS_READINESS_META = {
  robotsTxt: { category: "discoverability", label: "robots.txt" }, sitemap: { category: "discoverability", label: "Sitemap" },
  linkHeaders: { category: "discoverability", label: "Link headers" }, dnsAid: { category: "discoverability", label: "DNS-AID" },
  markdownNegotiation: { category: "contentAccessibility", label: "Markdown negotiation" },
  robotsTxtAiRules: { category: "botAccessControl", label: "AI bot rules" }, contentSignals: { category: "botAccessControl", label: "Content Signals" },
  webBotAuth: { category: "botAccessControl", label: "Web Bot Auth" }, apiCatalog: { category: "discovery", label: "API Catalog" },
  oauthDiscovery: { category: "discovery", label: "OAuth discovery" }, oauthProtectedResource: { category: "discovery", label: "OAuth Protected Resource" },
  authMd: { category: "discovery", label: "Auth.md" }, mcpServerCard: { category: "discovery", label: "MCP Server Card" },
  a2aAgentCard: { category: "discovery", label: "A2A Agent Card", optional: true, countInScore: false },
  agentSkills: { category: "discovery", label: "Agent Skills" }, webMcp: { category: "discovery", label: "WebMCP" },
  x402: { category: "commerce", label: "x402", optional: true, countInScore: false }, mpp: { category: "commerce", label: "MPP", optional: true, countInScore: false },
  ucp: { category: "commerce", label: "UCP", optional: true, countInScore: false }, acp: { category: "commerce", label: "ACP", optional: true, countInScore: false },
  ap2: { category: "commerce", label: "AP2", optional: true, countInScore: false },
};

const LENS_READINESS_CATEGORIES = [
  { key: "discoverability", label: "Discoverability", countInScore: true },
  { key: "contentAccessibility", label: "Content Accessibility", countInScore: true },
  { key: "botAccessControl", label: "Bot Access Control", countInScore: true },
  { key: "discovery", label: "API, Auth, MCP & Skill Discovery", countInScore: true },
  { key: "commerce", label: "Commerce", countInScore: false },
];

function lensJsonShape(probe, validate) {
  if (!probe || probe.error) return { status: "unknown", detail: "probe did not answer" };
  if (!probe.ok) return { status: "fail", detail: "HTTP " + (probe.status || "error") };
  try {
    const json = JSON.parse(probe.body || "");
    return validate(json) ? { status: "pass", detail: "valid JSON shape" } : { status: "fail", detail: "JSON answered, but the expected fields were absent" };
  } catch (_e) { return { status: "fail", detail: "answered, but was not valid JSON" }; }
}

function lensReadinessItem(key, status, detail) {
  const meta = LENS_READINESS_META[key];
  return {
    key, category: meta.category, label: meta.label, status, detail,
    optional: !!meta.optional,
    countInScore: meta.countInScore !== false && !meta.optional,
  };
}

export function lensReadiness({ headers, robots, sitemap, terms, discovery, agent, openapi, botViews }) {
  const items = {};
  const robotsParsed = robots && robots.ok ? lensParseRobots(robots.body || "") : null;
  const robotsRules = robotsParsed && robotsParsed.groups.length > 0;
  const link = String((headers && headers.link) || "");
  const usefulLinks = (link.match(/rel\s*=\s*["']?(?:sitemap|alternate|service-doc|service-desc|api-catalog)/gi) || []).length;
  const botAuth = lensJsonShape(discovery && discovery.webBotAuth, (j) => Array.isArray(j.keys) && j.keys.length > 0);
  const oauthOpen = lensJsonShape(discovery && discovery.oauthDiscovery && discovery.oauthDiscovery.openidConfiguration, (j) => !!(j.issuer || j.authorization_endpoint || j.token_endpoint));
  const oauthServer = lensJsonShape(discovery && discovery.oauthDiscovery && discovery.oauthDiscovery.oauthAuthorizationServer, (j) => !!(j.issuer || j.token_endpoint || j.authorization_endpoint));
  const oauthResource = lensJsonShape(discovery && discovery.oauthProtectedResource, (j) => !!(j.resource || j.authorization_servers || j.scopes_supported));
  const mcpCard = lensJsonShape(discovery && discovery.mcpServerCard, (j) => !!(j.serverInfo || j.server || j.name || j.capabilities));
  const skills = lensJsonShape(discovery && discovery.agentSkills, (j) => Array.isArray(j.skills));
  const ucp = lensJsonShape(discovery && discovery.commerce && discovery.commerce.ucp, (j) => !!(j.protocol || j.version || j.services || j.capabilities));
  const acp = lensJsonShape(discovery && discovery.commerce && discovery.commerce.acp, (j) => !!(j.protocol || j.api_base_url || j.capabilities || j.services));
  const ap2 = lensJsonShape(discovery && discovery.commerce && discovery.commerce.ap2, (j) => !!(j.protocol || j.version || j.capabilities));

  items.robotsTxt = lensReadinessItem("robotsTxt", robots && robots.ok ? "pass" : robots && (robots.status === 404 || robots.status === 410) ? "fail" : "unknown", robots && robots.ok ? "valid response with " + robotsParsed.groups.length + " User-agent group(s)" : "robots.txt did not return a readable 200");
  items.sitemap = lensReadinessItem("sitemap", sitemap && sitemap.ok ? "pass" : sitemap && (sitemap.status === 404 || sitemap.status === 410) ? "fail" : "unknown", sitemap && sitemap.ok ? "sitemap answered with " + ((sitemap.body || "").match(/<url>|<sitemap>/gi) || []).length + " URL entries" : "sitemap.xml was not found or did not answer");
  items.linkHeaders = lensReadinessItem("linkHeaders", usefulLinks ? "pass" : "fail", usefulLinks ? usefulLinks + " agent-useful Link relation(s)" : "no agent-useful Link relations on the fetched response");
  items.dnsAid = lensReadinessItem("dnsAid", discovery && discovery.dnsAid && discovery.dnsAid.ok ? (discovery.dnsAid.found ? "pass" : "fail") : "unknown", discovery && discovery.dnsAid && discovery.dnsAid.found ? "DNS-AID record found" : "no DNS-AID record found at the checked discovery names");
  items.markdownNegotiation = lensReadinessItem("markdownNegotiation", agent && agent.mdNegotiation && agent.mdNegotiation.supported ? "pass" : agent && agent.mdNegotiation && agent.mdNegotiation.note === "probe failed" ? "unknown" : "fail", agent && agent.mdNegotiation && agent.mdNegotiation.supported ? "same URL returned text/markdown" : "Accept: text/markdown stayed non-markdown");
  items.robotsTxtAiRules = lensReadinessItem("robotsTxtAiRules", robots && robots.ok ? (robotsRules ? "pass" : "fail") : "unknown", robotsRules ? (robotsParsed.groups.some((g) => g.agents.some((a) => a !== "*" && /bot|crawler|extended|spider|anthropic|openai|claude/i.test(a))) ? "named AI bot rules found" : "wildcard rules apply to crawlers") : "robots policy could not be evaluated");
  items.contentSignals = lensReadinessItem("contentSignals", terms && terms.robotsUnknown ? "unknown" : terms && terms.signals && terms.signals.length ? "pass" : "fail", terms && terms.signals && terms.signals.length ? terms.signals.length + " Content-Signal directive(s)" : "no Content-Signal directive found");
  items.webBotAuth = lensReadinessItem("webBotAuth", botAuth.status, botAuth.detail);
  items.apiCatalog = lensReadinessItem("apiCatalog", agent && agent.apiCatalog && agent.apiCatalog.present ? "pass" : agent && agent.apiCatalog && agent.apiCatalog.unknown ? "unknown" : "fail", agent && agent.apiCatalog && agent.apiCatalog.present ? agent.apiCatalog.detail : "no valid API Catalog linkset");
  items.oauthDiscovery = lensReadinessItem("oauthDiscovery", oauthOpen.status === "pass" || oauthServer.status === "pass" ? "pass" : oauthOpen.status === "unknown" || oauthServer.status === "unknown" ? "unknown" : "fail", oauthOpen.status === "pass" || oauthServer.status === "pass" ? "OAuth or OIDC discovery metadata found" : "no valid OAuth/OIDC discovery document");
  items.oauthProtectedResource = lensReadinessItem("oauthProtectedResource", oauthResource.status, oauthResource.detail);
  items.authMd = lensReadinessItem("authMd", discovery && discovery.authMd && discovery.authMd.ok && String(discovery.authMd.body || "").trim() ? "pass" : discovery && discovery.authMd && discovery.authMd.error ? "unknown" : "fail", discovery && discovery.authMd && discovery.authMd.ok ? "auth.md answered" : "no auth.md registration guide");
  items.mcpServerCard = lensReadinessItem("mcpServerCard", mcpCard.status, mcpCard.detail);
  items.a2aAgentCard = lensReadinessItem("a2aAgentCard", agent && agent.agentCard && agent.agentCard.present ? "pass" : "fail", agent && agent.agentCard && agent.agentCard.present ? agent.agentCard.detail : "no valid A2A Agent Card");
  items.agentSkills = lensReadinessItem("agentSkills", skills.status, skills.detail);
  items.webMcp = lensReadinessItem("webMcp", agent && agent.webmcp && agent.webmcp.found ? "pass" : "fail", agent && agent.webmcp && agent.webmcp.found ? "modelContext marker found in page" : "no WebMCP marker found in the fetched HTML");
  items.x402 = lensReadinessItem("x402", terms && terms.paid && terms.paid.http402 ? "pass" : "neutral", terms && terms.paid && terms.paid.http402 ? "HTTP 402 payment requirement observed" : "not observed (optional; not scored)");
  const openapiText = openapi && openapi.ok ? String(openapi.body || "") : "";
  items.mpp = lensReadinessItem("mpp", /x-payment-info|mpp/i.test(openapiText) ? "pass" : "neutral", /x-payment-info|mpp/i.test(openapiText) ? "payment metadata found in OpenAPI" : "not observed (optional; not scored)");
  items.ucp = lensReadinessItem("ucp", ucp.status === "pass" ? "pass" : "neutral", ucp.status === "pass" ? "UCP-shaped discovery metadata found" : "not observed (optional; not scored)");
  items.acp = lensReadinessItem("acp", acp.status === "pass" ? "pass" : "neutral", acp.status === "pass" ? "ACP-shaped discovery metadata found" : "not observed (optional; not scored)");
  items.ap2 = lensReadinessItem("ap2", ap2.status === "pass" ? "pass" : "neutral", ap2.status === "pass" ? "AP2-shaped discovery metadata found" : "not observed (optional; not scored)");

  const categories = LENS_READINESS_CATEGORIES.map((category) => {
    const values = Object.values(items).filter((item) => item.category === category.key && item.countInScore && item.status !== "neutral");
    const passed = values.filter((item) => item.status === "pass").length;
    return { key: category.key, label: category.label, score: values.length ? Math.round((passed / values.length) * 100) : 0, passed, total: values.length, checkCount: Object.values(items).filter((item) => item.category === category.key).length, countInScore: category.countInScore };
  });
  const counted = Object.values(items).filter((item) => item.countInScore && item.status !== "neutral");
  const passed = counted.filter((item) => item.status === "pass").length;
  const overall = counted.length ? Math.round((passed / counted.length) * 100) : 0;
  const actionSurface = !!(agent && agent.strategy && agent.strategy.action && agent.strategy.action.length);
  const strongPublishing = items.markdownNegotiation.status === "pass" && items.contentSignals.status === "pass" && items.linkHeaders.status === "pass";
  const baseline = items.robotsTxt.status === "pass" || items.sitemap.status === "pass";
  const level = actionSurface ? { number: 5, name: "Agent-Native" } : strongPublishing ? { number: 3, name: "Agent-Readable" } : baseline ? { number: 1, name: "Basic Web Presence" } : { number: 0, name: "Not Ready" };
  const nextActions = Object.values(items).filter((item) => item.status === "fail" && item.countInScore).slice(0, 5).map((item) => ({ key: item.key }));
  return {
    overall, level: level.number, levelName: level.name,
    categories, checks: items, counted: counted.length, passed,
    scoringNote: "Passes divided by pass + fail + unknown; neutral emerging-commerce checks are shown but excluded.",
    nextActions, botViews: botViews || [],
  };
}
