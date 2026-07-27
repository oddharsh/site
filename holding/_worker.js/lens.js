// lens.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { BOT_UA, botHeaders } from "./lib/botauth.js";
import { cachedRender } from "./lib/cache.js";
import { CANONICAL_HOST } from "./lib/const.js";
import { readResponseCapped } from "./lib/crawl.js";
import { lensParseRobots, lensPathMatch, lensRobotsVerdict } from "./lib/robots.js";
import { lunaPage } from "./lib/chrome.js";
import { escAttr, escHtml, jsonResponse } from "./lib/http.js";

// Per-IP crawl budgets, one place. These used to be inlined at each call site,
// which was fine until /mcp grew tools that call the same crawler: sharing the
// literal KV bucket is the whole point, because a second unmetered door (30 via
// /lens/fetch AND unlimited via JSON-RPC) is not a rate limit. Keys and ceilings
// are unchanged from the inlined versions, so live buckets carry over.
export const LENS_BUDGETS = {
  inspect: { key: "lens:rl",        max: 30 },
  shot:    { key: "lens:shotrl",    max: 8  },
  compare: { key: "lens:comparerl", max: 4  },
};

// Best-effort minute bucket. Returns true when the caller is already over.
// Fails OPEN when RN_KV is missing (dev), same as the code it replaces: this is
// abuse control, not authorization, and the SSRF guard is what enforces safety.
export async function overLensBudget(budget, request, env, ctx) {
  if (!env.RN_KV) return false;
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const bucket = `${budget.key}:${ip}:${Math.floor(Date.now() / 60000)}`;
  let n = 0;
  try { n = parseInt((await env.RN_KV.get(bucket)) || "0", 10) || 0; } catch {}
  if (n >= budget.max) return true;
  const write = env.RN_KV.put(bucket, String(n + 1), { expirationTtl: 120 }).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
  return false;
}

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
// (a real static file, cached like nav.js) so it can use normal JS without
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
    response.headers.set("x-content-type-options", "nosniff");
    response.headers.set("x-robots-tag", "noindex");
    return response;
  }
  // Keep a route-local shell key: the production runtime may not expose
  // CF_VERSION_METADATA, so a deploy can otherwise leave an older shell in
  // the edge cache while the separately served lens.js has already changed.
  return cachedRender(request, ctx, () => renderLensShell(), "/lens-shell-v4", env);
}

// One label per lens, shared by the SSR tabs, the SSR machine header, and the
// client (LENS_LABEL in lens.js must match). These are phrased as the question
// each lens answers, not practitioner nouns, so a first-time visitor can read
// the tab row as a menu of questions. Change here + in holding/lens.js together.
const LENS_TAB_LABELS = {
  readiness: "Agent-ready?",
  anatomy: "Raw response",
  structured: "What it claims",
  ai: "Model cost",
  terms: "Who's allowed",
  discovery: "Agent doors",
};

function lensState(url) {
  const validViews = ["both", "human", "machine", "browser", "delta"];
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
  if (status === 402) return "Payment Required";   // the x402 chip's whole point; a bare "client error" is the least useful label for the demo the page ships to showcase 402
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

function lensBrowserFragment(data) {
  if (!data || !data.ok) {
    return '<div class="lx-browser-intro"><b>Browser Run view.</b> Ask Cloudflare to open this URL in a real headless browser and return the rendered page, screenshot, Markdown, accessibility tree, and a clear WebMCP lab boundary.' +
      '<div class="lx-cap">This is opt-in: browser execution is slower and can run page JavaScript. Runtime WebMCP discovery is reported separately and requires the Chrome-beta lab.</div>' +
      '<button class="lx-browser-run" type="button" id="lx-browser-run">Run Browser Run snapshot</button></div>';
  }
  return '<div class="lx-browser-intro"><b>Browser Run snapshot ready.</b> The Browser pane is a rendered observation, separate from AadharshBot\'s HTTP fetch and the visitor\'s Human view.' +
    '<div class="lx-cap">Switch back to Browser and run again to refresh this snapshot.</div></div>';
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


async function inspectLensRequest(request, env, ctx) {
  const v = validateLensTarget(new URL(request.url).searchParams.get("url") || "");
  if (!v.ok) return { status: 400, payload: { ok: false, error: v.error } };

  // best-effort per-IP rate limit so the proxy can't be turned into a firehose.
  // Shared with /mcp's lens_inspect tool (same bucket, see LENS_BUDGETS).
  if (await overLensBudget(LENS_BUDGETS.inspect, request, env, ctx)) {
    return { status: 429, payload: { ok: false, error: "Slow down — 30 lookups a minute. Try again shortly." } };
  }

  try {
    return { status: 200, payload: await lensInspect(v.url, env) };
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "The site took too long to answer (8s timeout)." : (e && e.message) || String(e);
    return { status: 502, payload: { ok: false, error: msg } };
  }
}

// A dated, source-linked exhibit of where the machine web actually stands, so a
// cold visitor reads every per-URL verdict as a claim about the web, not one
// site's laziness. Hand-maintained; each fact carries a "checked" date and a
// source. Rendered as an XP dialog the client pops open on nav-in (once a
// session) and that the footer link reopens — it sits over the tool instead of
// pushing it below the fold. Update the dates when you refresh the numbers.
function lensStateOfWebPanel() {
  const facts = [
    {
      stat: "57.5%",
      claim: "Bots now make more of the web's requests than people do. Automated clients sent 57.5% of HTML requests on Cloudflare's network — the first time bots crossed half.",
      src: "Cloudflare Radar", href: "https://radar.cloudflare.com/",
    },
    {
      stat: "5.6% / ~0",
      claim: "Publishers signal, models mostly don't read. llms.txt is now published by 5.6% of the top 10k sites (up ~5× in a year), but one server-log study found 408 llms.txt hits across ~500M AI-bot visits, and Google says it ignores the file.",
      src: "HTTP Archive", href: "https://httparchive.org/",
    },
    {
      stat: "~10k servers",
      claim: "One protocol won the tool layer. MCP sits under the Linux Foundation with OpenAI, Google, Microsoft, and Amazon all shipping support, and roughly 10k public servers.",
      src: "Linux Foundation", href: "https://www.linuxfoundation.org/",
    },
    {
      stat: "the CLI is the new API",
      claim: "The action layer moved to the terminal. A Q1 2026 wave of agent-native CLIs (Stripe, Ramp, Google Workspace, Vercel) each crossed 20k GitHub stars in weeks — structured commands an agent runs, not HTTP well-knowns it discovers.",
      src: "OSS Insight", href: "https://ossinsight.io/",
    },
    {
      stat: "2 partners",
      claim: "Paying to crawl is still an experiment. A year after Cloudflare's pay-per-crawl launched, it has two named AI-side partners; unsigned crawlers get blocked, and default-blocking arrives for new domains on Sept 15, 2026.",
      src: "Cloudflare", href: "https://blog.cloudflare.com/introducing-pay-per-crawl/",
    },
    {
      stat: "$24M / 75M txns",
      claim: "Agent payments are many and tiny. x402 moved about $24M across ~75M transactions in the last 30 days — roughly $0.32 each, mostly sub-dollar micropayments.",
      src: "CoinDesk", href: "https://www.coindesk.com/",
    },
  ];
  const checked = "checked 2026-07";
  const cards = facts.map((f) =>
    '<div class="lx-sow-card"><div class="lx-sow-stat">' + escHtml(f.stat) + "</div>" +
    '<div class="lx-sow-claim">' + escHtml(f.claim) + "</div>" +
    '<div class="lx-sow-src"><a href="' + escAttr(f.href) + '" target="_blank" rel="noopener">' + escHtml(f.src) + "</a> &middot; " + checked + "</div></div>"
  ).join("");
  return '<dialog class="lx-sow-dialog" id="lx-sow-dialog" aria-labelledby="lx-sow-title">' +
    '<div class="lx-sow-tb"><span class="lx-sow-kicker" id="lx-sow-title">The state of the machine web</span>' +
    '<button class="lx-sow-x" type="button" id="lx-sow-close" title="Close" aria-label="Close"></button></div>' +
    '<div class="lx-sow-inner">' +
    '<div class="lx-sow-grid">' + cards + "</div>" +
    '<div class="lx-sow-foot">A page\'s second life as data is now the busier one. Whether a machine can actually <b>read</b>, <b>understand</b>, and <b>act</b> on a page — not just fetch it — is what the lenses here measure. Paste a URL to see one site\'s answer, or watch the movement over time in <a href="/lens/census">the weekly census</a> of 16 representative sites.</div>' +
    "</div></dialog>";
}

export function renderLensShell(initial, state, inputValue) {
  // defaults must match the client (lens.js) and lensState(), or a plain /lens
  // SSRs one tab and the deferred script silently flips to another on hydrate.
  state = state || { view: "both", lens: "readiness", counterfactuals: { markdown: false, semantic: false, contract: false, authority: false, receipt: false } };
  const seeded = initial && initial.ok;
  const value = inputValue || (seeded ? initial.finalUrl || initial.url : "");
  const humanHeader = seeded && !initial.framable
    ? 'Human view <span class="lx-mode">Reader</span> <span class="lx-mode-sub">server-rendered readable fallback</span>'
    : "Human view &middot; the live page";
  const machineHeader = state.view === "machine" ? "Machine view &middot; Briefing" : state.view === "delta" ? "Delta view &middot; What changes" : "Machine view &middot; " + (LENS_TAB_LABELS[state.lens] || state.lens);
  const browserHeader = "Browser Run &middot; Rendered";
  // Mode notes coach, they don't caption: each one asks for a prediction the
  // pane will then confirm or correct. Keep the strings byte-identical to
  // MODE_NOTE in holding/lens.js or the note visibly rewrites on hydrate.
  const modeNote = state.view === "human"
    ? "Human is the page as a person receives it. Every other view subtracts the person."
    : state.view === "machine"
      ? "Machine is an evidence-first briefing. Read claims first, then check each against its evidence."
      : state.view === "browser"
        ? "Browser Run renders after JavaScript beside HTTP. Disagreement reveals a JS dependency."
      : state.view === "delta"
        ? "Delta toggles hypothetical infrastructure. Predict, flip, check."
        : "Compare puts Human, HTTP Machine, and Browser Run side by side. Predict the machine pane; the miss is the lesson.";
  const initialScript = initial ? '<script type="application/json" id="lx-initial-data">' + lensScriptJson(initial) + "</script>" : "";
  return lunaPage({
    title: "The Other Web · aadhar.sh",
    path: "The Other Web",
    width: 980,
    description: "Paste any URL and see the human page, a transparent agent-readiness score, bot-specific access samples, raw HTML, structured data, machine terms, and the site's discovery surfaces side by side.",
    // The bare shell is the site's flagship machine-web page and should be
    // indexable — an agent reading llms.txt now finds /lens listed there. Only a
    // targeted ?url= scan gets x-robots-tag: noindex (handleLens sets it), since
    // that response spends the crawl budget and carries third-party data.
    robots: "index, follow",
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

/* example buttons. These are real <button>s, so they carry the same raised
   bevel as .lx-go above (light top-left, dark bottom-right, inverted on
   :active) rather than the flat 10px pill they used to be — which made them the
   only clickable thing on this page that didn't look pressable. Lighter weight
   than .lx-go on purpose: these are suggestions, that one is the action. */
.lx-chips { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin:7px 0 9px; }
.lx-chips-label { font-size:9pt; color:oklch(48% 0 0); }
.lx-chip { font-size:8.8pt; padding:2px 9px; color:oklch(20% 0 0); background:linear-gradient(180deg,#fdfdfd,#e6e6dd); border:1px solid; border-color:#fff oklch(45% 0 0) oklch(45% 0 0) #fff; border-radius:3px; }
.lx-chip:hover { background:linear-gradient(180deg,#fff,#efefe7); }
.lx-chip:active { border-color:oklch(45% 0 0) #fff #fff oklch(45% 0 0); }

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
/* the lens tabs only steer the machine pane, so they hide in the views that don't render it (human, browser) or ignore it (delta). shown for machine + compare. */
.lx-toolbar.is-human .lx-lenses, .lx-toolbar.is-browser .lx-lenses, .lx-toolbar.is-delta .lx-lenses { display:none; }

/* panes */
.lx-panes { display:flex; gap:8px; margin-top:8px; min-height:560px; }
.lx-panes.is-human .lx-pane-machine, .lx-panes.is-human .lx-pane-browser,
.lx-panes.is-machine .lx-pane-human, .lx-panes.is-machine .lx-pane-browser,
.lx-panes.is-browser .lx-pane-human, .lx-panes.is-browser .lx-pane-machine,
.lx-panes.is-delta .lx-pane-browser { display:none; }
.lx-pane { flex:1 1 0; min-width:0; display:flex; flex-direction:column; border:1px solid oklch(70% 0.03 250); border-radius:0 3px 3px 3px; background:#fff; }
.lx-pane-h { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:8.5pt; font-weight:bold; text-transform:uppercase; letter-spacing:.05em; color:#fff; background:linear-gradient(180deg, oklch(56% 0.12 252), oklch(45% 0.15 255)); padding:4px 8px; border-radius:0 2px 0 0; }
.lx-pane-human .lx-pane-h { background:linear-gradient(180deg, oklch(58% 0.06 150), oklch(46% 0.09 155)); }
.lx-pane-browser .lx-pane-h { background:linear-gradient(180deg, oklch(58% 0.10 205), oklch(45% 0.14 220)); }
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
.lx-browser-shot { width:100%; height:auto; display:block; border:1px solid oklch(82% 0.04 210); background:#fff; }
.lx-fallback-note { font-size:8.8pt; color:oklch(42% 0.11 60); background:oklch(96% 0.045 92); border:1px solid oklch(82% 0.09 80); border-radius:3px; padding:5px 9px; margin:0 0 10px; }
.lx-mode { font-family:"Courier New",monospace; font-size:7.6pt; font-weight:normal; text-transform:none; letter-spacing:0; color:oklch(38% 0.09 150); background:#fff; border-radius:7px; padding:1px 7px; vertical-align:middle; }
.lx-mode-sub { font-weight:normal; text-transform:none; letter-spacing:0; opacity:.85; font-size:8pt; }
.lx-browser-intro { padding:10px 9px; border:1px solid oklch(78% 0.06 210); background:linear-gradient(180deg,oklch(98% 0.015 210),oklch(94% 0.025 210)); color:oklch(31% 0.04 220); font-size:9pt; line-height:1.45; }
.lx-browser-intro b { color:oklch(34% 0.11 220); }
.lx-browser-run { margin-top:7px; border:1px solid oklch(52% 0.08 220); border-radius:3px; padding:3px 8px; background:linear-gradient(180deg,#fff,oklch(89% 0.025 210)); color:oklch(30% 0.08 220); font:8.4pt Tahoma,Verdana,sans-serif; cursor:pointer; }
.lx-browser-run:hover { background:oklch(91% 0.05 210); }

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
.lx-readiness-consume { margin-top:3px; font-size:8pt; color:oklch(46% 0.06 255); border-left:2px solid oklch(78% 0.06 255); padding-left:6px; }
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

/* the dollar-thesis verdict strip, above every scanned lens */
.lx-verdict { margin:0 0 11px; padding:8px 11px; border:1px solid oklch(74% 0.09 150); border-left:4px solid oklch(52% 0.14 150); border-radius:3px; background:linear-gradient(180deg,oklch(98% 0.02 150),oklch(96% 0.03 150)); color:oklch(30% 0.03 255); font-size:9.4pt; line-height:1.5; }
.lx-verdict b { color:oklch(34% 0.13 150); font-family:"Courier New",monospace; }

/* agent trace: an XP console of what an agent would do */
.lx-trace { font-family:"Courier New",Courier,monospace; font-size:8.7pt; line-height:1.5; background:oklch(22% 0.02 255); border-radius:3px; padding:9px 10px; color:oklch(90% 0.02 150); }
.lx-trace-line { display:grid; grid-template-columns:14px 1fr; gap:6px; padding:2px 0; align-items:start; }
.lx-trace-line + .lx-trace-line { border-top:1px solid oklch(30% 0.02 255); }
.lx-trace-g { text-align:center; font-weight:bold; }
.lx-trace-line.ok .lx-trace-g { color:oklch(78% 0.16 150); }
.lx-trace-line.warn .lx-trace-g { color:oklch(80% 0.15 85); }
.lx-trace-line.no .lx-trace-g { color:oklch(72% 0.17 27); }
.lx-trace-line.no span:last-child, .lx-trace-line.warn span:last-child { color:oklch(96% 0.01 150); }

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
.lx-cf-credit { margin-top:10px; font-size:8pt; color:oklch(55% 0 0); line-height:1.5; }
.lx-cf-credit a { color:oklch(42.61% 0.2353 263.74); }
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

/* state of the machine web — an XP dialog shown on nav-in, reopenable from the footer */
/* the shadow is luna.css's modal idiom verbatim (#axp-run): a hard 4px offset
   with NO blur, plus one tight ambient. XP dialogs really did drop a shadow,
   but it was cast, not diffused — the single 0 10px 40px this replaced read as
   a 2015 elevation surface. */
.lx-sow-dialog { padding:0; margin:auto; width:min(660px,calc(100vw - 26px)); max-height:min(88vh,700px); color:oklch(28% 0.02 255); background:oklch(96% 0.014 250); border:1px solid oklch(44% 0.09 258); border-radius:6px 6px 3px 3px; box-shadow:4px 4px 0 rgba(0,30,160,.35),2px 3px 12px -2px oklch(30% 0.12 263 / .55); overflow:hidden; display:flex; flex-direction:column; }
.lx-sow-dialog::backdrop { background:oklch(22% 0.04 258 / .38); }
.lx-sow-tb { display:flex; align-items:center; gap:8px; flex:0 0 auto; padding:4px 5px 5px 10px; background:linear-gradient(180deg, oklch(62% 0.16 256), oklch(45% 0.19 260)); }
.lx-sow-kicker { font:bold 10.5pt "Trebuchet MS",Verdana,sans-serif; color:#fff; text-shadow:0 1px 1px oklch(24% 0.1 260 / .6); }
.lx-sow-x { margin-left:auto; width:20px; height:20px; padding:0; overflow:hidden; font-size:0; cursor:pointer; position:relative; border:1px solid #d8401c; border-radius:3px; background-color:#e45f3e; background-image:linear-gradient(180deg,#e8795f,#e45d3d 55%,#ae3110); }
.lx-sow-x:hover, .lx-sow-x:focus-visible { filter:brightness(1.12); outline:none; box-shadow:0 0 4px oklch(70% 0.18 30 / .7); }
.lx-sow-x::before, .lx-sow-x::after { content:''; position:absolute; left:50%; top:50%; width:11px; height:2px; margin:-1px 0 0 -5.5px; background:#fff; }
.lx-sow-x::before { transform:rotate(45deg); } .lx-sow-x::after { transform:rotate(-45deg); }
.lx-sow-inner { padding:11px 13px 13px; overflow:auto; }
.lx-sow-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
.lx-sow-card { border:1px solid oklch(86% 0.02 250); border-radius:3px; background:#fff; padding:8px 10px; }
.lx-sow-stat { font:bold 12pt "Courier New",monospace; color:oklch(40% 0.14 255); margin:0 0 3px; line-height:1.1; }
.lx-sow-claim { font-size:8.6pt; line-height:1.42; color:oklch(30% 0.02 255); }
.lx-sow-src { margin-top:4px; font-size:7.8pt; color:oklch(55% 0 0); }
.lx-sow-src a { color:oklch(42.61% 0.2353 263.74); text-decoration:none; }
.lx-sow-foot { margin-top:10px; padding-top:8px; border-top:1px solid oklch(88% 0.02 250); font-size:8.8pt; line-height:1.45; color:oklch(38% 0.02 255); }
.lx-sow-foot b { color:oklch(33% 0.10 263); }
.lx-sow-open { font:inherit; color:oklch(42.61% 0.2353 263.74); background:none; border:none; padding:0; cursor:pointer; text-decoration:underline; }
@media (max-width:520px){ .lx-sow-grid{ grid-template-columns:1fr; } }

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
    <p class="lx-lede">Every page has a second life as data. Paste a URL to see what a person receives, what representative bots can retrieve, and which missing web surfaces limit them. The score is a map, not a verdict: every point stays tied to evidence. Scan a few sites and you start predicting the briefing before it loads; that mental model is the point, since you build differently once you carry it. Fetched server-side, honestly, as <a href="/bot">AadharshBot</a>.</p>

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

    <div class="lx-toolbar is-${state.view}" id="lx-toolbar">
      <div class="lx-view" role="radiogroup" aria-label="page mode">
        <button class="lx-seg${state.view === "both" ? " is-on" : ""}" data-view="both" role="radio" aria-checked="${state.view === "both" ? "true" : "false"}" type="button">Compare</button>
        <button class="lx-seg${state.view === "human" ? " is-on" : ""}" data-view="human" role="radio" aria-checked="${state.view === "human" ? "true" : "false"}" type="button">Human</button>
        <button class="lx-seg${state.view === "machine" ? " is-on" : ""}" data-view="machine" role="radio" aria-checked="${state.view === "machine" ? "true" : "false"}" type="button">Machine</button>
        <button class="lx-seg${state.view === "browser" ? " is-on" : ""}" data-view="browser" role="radio" aria-checked="${state.view === "browser" ? "true" : "false"}" type="button">Browser</button>
        <button class="lx-seg${state.view === "delta" ? " is-on" : ""}" data-view="delta" role="radio" aria-checked="${state.view === "delta" ? "true" : "false"}" type="button">Delta</button>
      </div>
      <div class="lx-lenses" role="tablist" aria-label="machine lens">
        <button class="lx-tab${state.lens === "readiness" ? " is-on" : ""}" data-lens="readiness" role="tab" aria-selected="${state.lens === "readiness" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">${LENS_TAB_LABELS.readiness}</button>
        <button class="lx-tab${state.lens === "anatomy" ? " is-on" : ""}" data-lens="anatomy" role="tab" aria-selected="${state.lens === "anatomy" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">${LENS_TAB_LABELS.anatomy}</button>
        <button class="lx-tab${state.lens === "structured" ? " is-on" : ""}" data-lens="structured" role="tab" aria-selected="${state.lens === "structured" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">${LENS_TAB_LABELS.structured}</button>
        <button class="lx-tab${state.lens === "ai" ? " is-on" : ""}" data-lens="ai" role="tab" aria-selected="${state.lens === "ai" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">${LENS_TAB_LABELS.ai}</button>
        <button class="lx-tab${state.lens === "terms" ? " is-on" : ""}" data-lens="terms" role="tab" aria-selected="${state.lens === "terms" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">${LENS_TAB_LABELS.terms}</button>
        <button class="lx-tab${state.lens === "discovery" ? " is-on" : ""}" data-lens="discovery" role="tab" aria-selected="${state.lens === "discovery" ? "true" : "false"}" aria-controls="lx-machine-body" type="button">${LENS_TAB_LABELS.discovery}</button>
      </div>
    </div>
    <div class="lx-mode-note" id="lx-mode-note">${modeNote}</div>

    <div class="lx-panes is-${state.view}" id="lx-panes">
      <section class="lx-pane lx-pane-human" id="lx-human">
        <div class="lx-pane-h" id="lx-human-h">${humanHeader}</div>
        <div class="lx-body" id="lx-human-body">${seeded ? lensHumanFragment(initial) : '<div class="lx-empty">Paste a URL above to compare the three surfaces.</div>'}</div>
      </section>
      <section class="lx-pane lx-pane-machine" id="lx-machine">
        <div class="lx-pane-h" id="lx-machine-h">${machineHeader}</div>
        <div class="lx-body" id="lx-machine-body">${seeded ? lensMachineFragment(initial, state) : '<div class="lx-empty">The markup, metadata, and machine directives land here.</div>'}</div>
      </section>
      <section class="lx-pane lx-pane-browser" id="lx-browser">
        <div class="lx-pane-h" id="lx-browser-h">${browserHeader}</div>
        <div class="lx-body" id="lx-browser-body">${lensBrowserFragment(null)}</div>
      </section>
    </div>

    <div class="lx-status" id="lx-status">${seeded || (initial && !initial.ok) ? lensStatusFragment(initial, state) : '<span>Idle. Nothing is fetched until you ask, and then just once, server-side, with no logging.</span>'}</div>
    <footer>&larr; <a href="/">aadhar.sh</a> &middot; a research toy about how machines read the web &middot; <button type="button" class="lx-sow-open" id="lx-sow-open">the state of the machine web</button> &middot; fetched by <a href="/bot">AadharshBot</a></footer>
    ${lensStateOfWebPanel()}
    ${initialScript}
`,
    // The shell is cached at the edge and browsers cache static scripts too, so a
    // fresh shell must not be able to pair with an older lens.js. This used to be a
    // hand-bumped ?v=N, which only worked as long as nobody forgot. build.mjs now
    // rewrites this src to /a/lens.<hash8>.js (same treatment as nav.js + luna.css),
    // so the URL names exact bytes and the pairing is enforced, not remembered. The
    // plain /lens.js below stays served, short-cached, for dev and any stale HTML.
    scripts: `<script src="/lens.js" defer></script>`,
    cache: "public, max-age=60, s-maxage=300",
    headers: {
      // No x-robots-tag here: the bare shell is meant to be indexed. handleLens
      // adds x-robots-tag: noindex for ?url= scans only.
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

// /lens/fetch?url=… → the stable machine-facing JSON contract.
export async function handleLensFetch(request, env, ctx) {
  const result = await inspectLensRequest(request, env, ctx);
  return jsonResponse(result.payload, result.status);
}


// /lens/shot?url=… → a faithful PNG of the page, rendered by Cloudflare
// Browser Run (real headless Chrome, server-side). The Human view uses this
// only when a site forbids live framing.
export async function handleLensShot(request, env, ctx) {
  const v = validateLensTarget(new URL(request.url).searchParams.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);
  if (!env.BROWSER || typeof env.BROWSER.quickAction !== "function") return jsonResponse({ ok: false, error: "Browser Run is not configured on this deployment." }, 503);

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

  const payload = {
    url: v.url,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    screenshotOptions: { fullPage: true, type: "png" },
    gotoOptions: { waitUntil: "networkidle0", timeout: 18000 },
    userAgent: BOT_UA,
  };
  let r;
  try {
    r = await env.BROWSER.quickAction("screenshot", payload);
  } catch (e) {
    return jsonResponse({ ok: false, error: "Browser Run request failed: " + ((e && e.message) || e) }, 502);
  }
  const ctype = r.headers.get("content-type") || "";
  if (!r.ok || !ctype.startsWith("image/")) {
    let detail = "";
    try { detail = (await r.text()).slice(0, 300); } catch (_e) {}
    return jsonResponse({ ok: false, error: "Browser Run returned " + r.status + ".", detail }, 502);
  }
  const buf = await r.arrayBuffer();
  if (env.RN_KV) ctx.waitUntil(env.RN_KV.put(cacheKey, buf, { expirationTtl: 3600 }));
  return new Response(buf, { headers: lensPngHeaders(false) });
}

// /lens/browser?url=… → opt-in rendered evidence for the third Lens pane.
// This deliberately stays separate from /lens/fetch: the normal scan is an
// identified HTTP observation, while this path executes page JavaScript in a
// Browser Run instance and returns a rendered snapshot plus browser structure.
export async function handleLensBrowser(request, env, ctx) {
  const v = validateLensTarget(new URL(request.url).searchParams.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);
  if (!env.BROWSER || typeof env.BROWSER.quickAction !== "function") return jsonResponse({ ok: false, error: "Browser Run is not configured on this deployment." }, 503);

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (env.RN_KV) {
    const bucket = `lens:browserrl:${ip}:${Math.floor(Date.now() / 60000)}`;
    const n = parseInt((await env.RN_KV.get(bucket)) || "0", 10);
    if (n >= 4) return jsonResponse({ ok: false, error: "Browser Run snapshots are rate-limited to 4/min. Hang on a moment." }, 429);
    ctx.waitUntil(env.RN_KV.put(bucket, String(n + 1), { expirationTtl: 120 }));
  }

  const cacheKey = "lens:browser:" + (await lensSha256Hex(v.url));
  if (env.RN_KV) {
    try {
      const hit = await env.RN_KV.get(cacheKey, "json");
      if (hit && hit.ok) return jsonResponse({ ...hit, cached: true });
    } catch (_e) { /* a corrupt cache entry is a miss, never a user-visible failure */ }
  }

  const started = Date.now();
  const payload = {
    url: v.url,
    formats: ["content", "screenshot", "markdown", "accessibilityTree"],
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    screenshotOptions: { fullPage: true, type: "png" },
    gotoOptions: { waitUntil: "networkidle0", timeout: 18000 },
    userAgent: BOT_UA,
  };

  let response;
  try {
    response = await env.BROWSER.quickAction("snapshot", payload);
  } catch (e) {
    return jsonResponse({ ok: false, error: "Browser Run request failed: " + ((e && e.message) || e) }, 502);
  }
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.text()).slice(0, 500); } catch (_e) {}
    return jsonResponse({ ok: false, error: "Browser Run returned " + response.status + ".", detail }, 502);
  }

  let envelope;
  try { envelope = await response.json(); }
  catch (e) { return jsonResponse({ ok: false, error: "Browser Run returned invalid JSON: " + ((e && e.message) || e) }, 502); }
  const result = envelope && envelope.result ? envelope.result : envelope || {};
  const meta = envelope && envelope.meta ? envelope.meta : {};
  const rawContent = String(result.content || "");
  const output = {
    ok: true,
    url: v.url,
    finalUrl: meta.url || v.url,
    status: meta.status == null ? null : meta.status,
    title: meta.title || "",
    content: rawContent.slice(0, 120000),
    contentTruncated: rawContent.length > 120000,
    markdown: String(result.markdown || "").slice(0, 60000),
    accessibilityTree: result.accessibilityTree || null,
    screenshot: result.screenshot ? "data:image/png;base64," + result.screenshot : null,
    // WebMCP discovery is currently a Chrome-beta lab capability, not a
    // production Browser Run binding capability. The local helper performs
    // the real runtime listing; this field keeps that boundary explicit.
    webmcp: { status: "lab-required", detail: "Runtime WebMCP listing requires the local Browser Run Chrome-beta lab. Use scripts/lens-webmcp.mjs." },
    fetchedBy: "Cloudflare Browser Run",
    elapsedMs: Date.now() - started,
  };
  if (env.RN_KV) ctx.waitUntil(env.RN_KV.put(cacheKey, JSON.stringify(output), { expirationTtl: 900 }));
  return jsonResponse({ ...output, cached: false });
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

function lensDoorCount(agent) {
  return ["mcp", "nlweb", "webmcp", "agentCard", "openapi", "apiCatalog"]
    .map((key) => agent?.[key])
    .filter((door) => door && (door.verdict === "yes" || door.verdict === "likely" || door.verdict === "maybe" || door.present || door.found)).length;
}

// Compact, stable Lens output for comparison and machine callers. Full scans
// remain available from /lens/fetch; these helpers deliberately exclude raw
// HTML, headers, and third-party response bodies.
export function lensObservationSummary(result) {
  const readiness = result?.readiness || {};
  const terms = result?.terms || {};
  const spectrum = terms.spectrum || {};
  const anatomy = result?.anatomy || {};
  const structured = result?.structured || {};
  const title = structured.title || result?.title || "";
  return {
    url: result?.url || "",
    finalUrl: result?.finalUrl || result?.url || "",
    redirected: !!result?.redirected,
    status: result?.status ?? null,
    contentType: result?.contentType || "",
    elapsedMs: result?.elapsedMs ?? null,
    truncated: !!result?.truncated,
    title: String(title).slice(0, 240),
    wordCount: anatomy.wordCount ?? 0,
    bytes: anatomy.rawBytes ?? null,
    readiness: readiness.overall ?? null,
    level: readiness.level ?? null,
    tier: spectrum.tier || "unknown",
    doors: lensDoorCount(result?.agent),
    surfaces: {
      llms: !!result?.discovery?.llmsTxt?.ok,
      markdown: !!result?.agent?.mdNegotiation?.supported,
      mcp: !!(result?.agent?.mcp && ["yes", "likely"].includes(result.agent.mcp.verdict)),
      agentCard: !!(result?.agent?.agentCard?.present || result?.agent?.agentCard?.found),
      apiCatalog: !!(result?.agent?.apiCatalog?.present || result?.agent?.apiCatalog?.found),
    },
  };
}

export function compareLensObservations(left, right) {
  const fields = [
    ["status", "status"], ["finalUrl", "final URL"], ["contentType", "content type"],
    ["title", "title"], ["wordCount", "word count"], ["bytes", "bytes"],
    ["readiness", "readiness"], ["level", "readiness level"], ["tier", "spectrum tier"],
    ["doors", "agent doors"],
  ];
  const changes = fields.filter(([key]) => left?.[key] !== right?.[key]).map(([key, label]) => ({
    field: key, label, before: left?.[key] ?? null, after: right?.[key] ?? null,
  }));
  for (const key of ["llms", "markdown", "mcp", "agentCard", "apiCatalog"]) {
    if (left?.surfaces?.[key] !== right?.surfaces?.[key]) changes.push({
      field: `surfaces.${key}`, label: `surface: ${key}`,
      before: !!left?.surfaces?.[key], after: !!right?.surfaces?.[key],
    });
  }
  return changes;
}

export async function compareLensTargets(leftUrl, rightUrl, env, opts = {}) {
  const [left, right] = await Promise.all([
    lensInspect(leftUrl, env, { skipBotViews: opts.skipBotViews !== false }),
    lensInspect(rightUrl, env, { skipBotViews: opts.skipBotViews !== false }),
  ]);
  const leftSummary = lensObservationSummary(left);
  const rightSummary = lensObservationSummary(right);
  return { left: leftSummary, right: rightSummary, changes: compareLensObservations(leftSummary, rightSummary) };
}

export async function handleLensCompare(request, env, ctx) {
  const url = new URL(request.url);
  const left = validateLensTarget(url.searchParams.get("left") || "");
  const right = validateLensTarget(url.searchParams.get("right") || "");
  if (!left.ok || !right.ok) return jsonResponse({ ok: false, error: left.ok ? `right: ${right.error}` : `left: ${left.error}` }, 400);
  // Shared with /mcp's lens_compare tool (same bucket, see LENS_BUDGETS).
  if (await overLensBudget(LENS_BUDGETS.compare, request, env, ctx)) {
    return jsonResponse({ ok: false, error: "Lens comparisons are rate-limited to 4/min." }, 429);
  }
  try {
    return jsonResponse({ ok: true, comparedAt: new Date().toISOString(), ...(await compareLensTargets(left.url, right.url, env)) });
  } catch (error) {
    return jsonResponse({ ok: false, error: "Lens comparison failed.", detail: String(error?.message || error).slice(0, 240) }, 502);
  }
}

// the orchestrator: fetch the target, parse it, then probe the origin's
// site-level files in parallel. returns the full lens envelope.
export async function lensInspect(targetUrl, env, opts) {
  opts = opts || {};
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
    // Scanning our OWN /lens route is a fan-out trap. SELF_FETCH dispatches each probe
    // back through route() into handleLens, and every one of those re-runs a COMPLETE
    // inspection of the inner ?url= target: the main fetch, plus markdown negotiation,
    // plus six bot identities = 8 full nested scans inside one invocation. SELF_FETCH
    // nulls itself one level down, so DEPTH was already bounded; this bounds the WIDTH.
    // Neither probe says anything meaningful about the lens itself anyway.
    const selfLens = (() => {
      try {
        const u = new URL(finalUrl);
        return u.hostname.toLowerCase() === CANONICAL_HOST && /^\/lens(\/|$)/.test(u.pathname);
      } catch { return false; }
    })();
    const [robots, sitemap, llms, llmsFull, aiTxt, secTxt, tdmrep, agentCard, openapi, aiPlugin, apiCatalog, mcp, nlweb, mdNego, webBotAuth, openidConfig, oauthServer, oauthResource, authMd, mcpServerCard, agentSkills, ucp, acp, ap2, agentsMd, dnsAid, botViews] = await Promise.all([
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
      isHtml && !selfLens ? lensProbeMdNego(finalUrl, env) : Promise.resolve(null),
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
      lensProbeAgentsMd(origin, env),
      lensProbeDnsAid(new URL(finalUrl).hostname),
      // bot-view sampling is 6 extra fetches per scan. The census (opts.skipBotViews)
      // only needs tier/score/doors, so it skips them to stay well under the
      // per-invocation subrequest budget when sweeping the whole roster.
      (selfLens || opts.skipBotViews) ? Promise.resolve([]) : lensProbeBotViews(finalUrl, env),
    ]);
    const feeds = (out.structured?.relLinks || []).filter((l) =>
      /alternate/.test(l.rel) && /(rss|atom|feed|\+xml|\+json)/i.test((l.type || "") + " " + (l.href || "")));
    out.discovery = {
      origin, robotsTxt: robots, sitemapXml: sitemap, llmsTxt: llms, llmsFullTxt: llmsFull,
      aiTxt, securityTxt: secTxt, feeds, dnsAid, agentsMd,
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

// honest, identified fetch — AadharshBot UA + a required Web Bot Auth
// signature for external targets, the same identity the rest of the site
// crawls under. Self-dispatch stays local and therefore has no wire signature.
// `accept` override: the md-negotiation and MCP probes speak different Accepts.
export async function lensFetch(targetUrl, env, signal, accept) {
  env = env || {};
  const baseHeaders = {
    "user-agent": BOT_UA,
    "accept": accept || "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    "accept-language": "en-US,en;q=0.9",
  };
  let isSelf = false;
  try {
    const u = new URL(targetUrl);
    isSelf = u.hostname.toLowerCase() === CANONICAL_HOST && !!(env.SELF_FETCH || env.ASSETS);
  } catch (_e) {}
  // Self-dispatch never leaves Cloudflare, so it does not need a wire
  // signature. Every external target still requires the real AadharshBot key.
  const headers = await botHeaders(targetUrl, env, { headers: baseHeaders, sign: !isSelf });
  // Fetching our own hostname over the network loops back through this same
  // worker, and Cloudflare kills the loop with a 522 — which is why the featured
  // "Try: aadhar.sh" example (and every self-probe: robots.txt, llms.txt, …) once
  // rendered the site as down. Dispatch through our own router instead
  // (SELF_FETCH, injected in index.js): it returns the REAL response an external
  // agent receives — worker enhancement, markdown negotiation, cache + security
  // headers, all of it — so a self-scan measures the live surface rather than a
  // reimplementation of it.
  //
  // ASSETS is the fallback only. It serves the PRE-enhancement static file, which
  // is right for /robots.txt but wrong for "/": the skeleton carries an empty photo
  // grid and zero alt text, so a self-scan through it under-reported this site's own
  // image accessibility as 0/12 while the live page ships 13 alt texts.
  try {
    const u = new URL(targetUrl);
    if (u.hostname.toLowerCase() === CANONICAL_HOST) {
      const selfReq = new Request(u.toString(), { method: "GET", headers });
      if (env.SELF_FETCH) return await env.SELF_FETCH(selfReq);
      if (env.ASSETS)     return await env.ASSETS.fetch(selfReq);
    }
  } catch (_e) { /* fall through to a normal fetch */ }
  return fetch(targetUrl, { method: "GET", headers, redirect: "follow", signal, cf: { cacheTtl: 0 } });
}

// read a response body but stop at `max` bytes so a giant page can't blow memory.
export async function lensReadCapped(res, max) {
  const result = await readResponseCapped(res, max);
  return { text: result.text, truncated: result.truncated };
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
  // same self-dispatch rule as lensFetch: route() gives the real response this
  // bot identity would actually receive (the worker's UA-conditional branches
  // included), where ASSETS would hand back the pre-enhancement skeleton and make
  // every bot look identical for the wrong reason.
  try {
    const u = new URL(targetUrl);
    if (u.hostname.toLowerCase() === CANONICAL_HOST) {
      const selfReq = new Request(u.toString(), { method: "GET", headers });
      if (env.SELF_FETCH) return await env.SELF_FETCH(selfReq);
      if (env.ASSETS)     return await env.ASSETS.fetch(selfReq);
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
      // res.url is "" for a same-origin response built inside the worker (SELF_FETCH /
      // ASSETS), so `res.url !== targetUrl` reported redirected:true for every bot on any
      // aadhar.sh scan. Fall back to targetUrl, matching lensInspect's `res.url || targetUrl`.
      redirected: (res.url || targetUrl) !== targetUrl,
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

// AGENTS.md / agents.md — the 2025 convention for telling an agent how to work
// with a codebase or service (the CLI wave's answer to "where's the contract").
// Case varies by host, so try the lowercase web form first, then the uppercase
// repo form. `present` requires a non-trivial body, not just a 200, so an SPA
// catch-all serving HTML for everything doesn't read as a real AGENTS.md.
export async function lensProbeAgentsMd(origin, env) {
  for (const name of ["/agents.md", "/AGENTS.md"]) {
    const p = await lensProbe(origin + name, env);
    const body = (p && p.body || "").trim();
    const looksMd = body.length > 40 && !/^\s*<(?:!doctype|html)/i.test(body);
    if (p && p.ok && looksMd) return { ok: true, present: true, variant: name, status: p.status, body, truncated: p.truncated };
    if (p && p.ok && !looksMd) return { ok: true, present: false, variant: name, status: p.status, note: "answered, but the body looks like a catch-all HTML page, not Markdown instructions" };
  }
  return { ok: false, present: false, note: "no /agents.md or /AGENTS.md found" };
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
// robots.txt parsing + RFC 9309 evaluation moved to lib/robots.js (a second caller,
// /around, now OBEYS these on the crawl). Imported above for local use here and
// re-exported so every lens caller and the public export surface stay identical.
export { lensParseRobots, lensPathMatch, lensRobotsVerdict };

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
// One predicate for "this probe never actually answered the question", shared by
// both JSON interpreters below so they cannot disagree. lensProbe only sets .error
// when the fetch THROWS; a reachable-but-broken origin returns { ok:false, status:503 }
// with no error, which is still not an answer. (429 stays a definitive negative here,
// matching the door tier; revisit if rate-limited probes need their own "unknown".)
function lensProbeUnanswered(probe) {
  return !probe || !!probe.error || !!(probe.status && probe.status >= 500);
}

function lensJsonDoor(probe, validate, label) {
  if (!probe || !probe.ok) {
    return { present: false, status: probe ? probe.status : null, unknown: lensProbeUnanswered(probe) };
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
  // same "did it answer?" rule as lensJsonDoor: a 5xx origin did NOT answer, so it is
  // unknown, not a definitive fail (this used to call a reachable-but-broken 503 a fail,
  // undercounting webBotAuth / the oauth checks that route through here).
  if (lensProbeUnanswered(probe)) return { status: "unknown", detail: probe && probe.status ? "HTTP " + probe.status + " — probe did not answer" : "probe did not answer" };
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
  // Gate the "AI bot rules" STATUS on actually-named agents. Keying it on
  // robotsRules (= "any User-agent group exists") passed a robots.txt carrying
  // nothing but `User-agent: *` on a check whose own fix copy says to declare
  // explicit GPTBot/ClaudeBot/CCBot rules — this site scored that unearned pass on
  // its own scan. The predicate already existed; it just lived in the detail string.
  const namedAiRules = !!(robotsRules && robotsParsed.groups.some((g) =>
    g.agents.some((a) => a !== "*" && /bot|crawler|extended|spider|anthropic|openai|claude/i.test(a))));
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
  // A probe that never ran cannot be a "fail". lensProbeMdNego sets `note` ONLY when
  // it produced no real answer ("probe failed", or "not probed (non-HTML target)");
  // a genuine negative carries contentType/status and no note. Keying on the exact
  // string "probe failed" let the not-probed case fall through to fail and then
  // assert "Accept: text/markdown stayed non-markdown" about a request never sent —
  // the same fabrication the agent-doors tier already refuses to make.
  const mdNego = (agent && agent.mdNegotiation) || null;
  items.markdownNegotiation = lensReadinessItem("markdownNegotiation", mdNego && mdNego.supported ? "pass" : mdNego && mdNego.note ? "unknown" : "fail", mdNego && mdNego.supported ? "same URL returned text/markdown" : mdNego && mdNego.note ? mdNego.note : "Accept: text/markdown stayed non-markdown");
  items.robotsTxtAiRules = lensReadinessItem("robotsTxtAiRules", robots && robots.ok ? (namedAiRules ? "pass" : "fail") : "unknown", namedAiRules ? "named AI bot rules found" : robotsRules ? "wildcard rules apply to crawlers, no AI crawler is named" : "robots policy could not be evaluated");
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
  // ship the label with each action: LENS_READINESS_META already owns it, so the
  // client should render it off the envelope rather than keep a second copy that
  // silently wins and drifts when a label is renamed here.
  const nextActions = Object.values(items).filter((item) => item.status === "fail" && item.countInScore).slice(0, 5).map((item) => ({ key: item.key, label: item.label }));
  return {
    overall, level: level.number, levelName: level.name,
    categories, checks: items, counted: counted.length, passed,
    scoringNote: "Passes divided by pass + fail + unknown; neutral emerging-commerce checks are shown but excluded.",
    nextActions, botViews: botViews || [],
  };
}
