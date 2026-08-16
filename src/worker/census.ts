// @ts-nocheck — declared in config/ts-migration.json, which may only SHRINK.
// This module carried type errors when the Worker moved from JavaScript to
// TypeScript on 2026-08-16. The code is unchanged and runs identically; what
// changed is that tsc stopped being lenient. In a .js file TypeScript treats
// every parameter as optional and infers loosely, so none of this was visible.
// Remove this line, fix what tsc then reports, and delete the entry from
// config/ts-migration.json. A contract test fails if the two disagree.
// census.js — the longitudinal chip census. Once a week (cron), Lens re-scans a
// fixed roster of representative sites and records each one's spectrum tier,
// agent-readiness score, and agent-door count into D1. /lens/census renders the
// trend over time. Nobody else publishes agent-readiness as a time series for
// named sites, so even a few months of this is original, citable evidence about
// where the web is going — the point the rest of /lens argues one URL at a time.
import { lunaPage } from "./lib/chrome.ts";
import { escHtml, escAttr, jsonResponse, timingSafeEqual } from "./lib/http.ts";
import { lensInspect } from "./lens.ts";
import { span } from "./lib/trace.ts";

// The roster: 16 sites chosen to span the open → agent-native spectrum a
// crypto-VC audience cares about. Agent-native infra, AI labs, publishers
// building walls, an indie hand-built site, and the bare baseline. `label` is the
// storage key + display name; `url` is exactly what gets scanned.
export const CENSUS_ROSTER = [
  { url: "https://aadhar.sh/", label: "aadhar.sh" },
  { url: "https://stripe.com/", label: "stripe.com" },
  { url: "https://www.shopify.com/", label: "shopify.com" },
  { url: "https://vercel.com/", label: "vercel.com" },
  { url: "https://www.cloudflare.com/", label: "cloudflare.com" },
  { url: "https://github.com/", label: "github.com" },
  { url: "https://www.anthropic.com/", label: "anthropic.com" },
  { url: "https://openai.com/", label: "openai.com" },
  { url: "https://www.perplexity.ai/", label: "perplexity.ai" },
  { url: "https://www.nytimes.com/", label: "nytimes.com" },
  { url: "https://www.wsj.com/", label: "wsj.com" },
  { url: "https://www.theverge.com/", label: "theverge.com" },
  { url: "https://www.reddit.com/", label: "reddit.com" },
  { url: "https://daringfireball.net/", label: "daringfireball.net" },
  { url: "https://en.wikipedia.org/wiki/Semantic_Web", label: "wikipedia.org" },
  { url: "https://example.com/", label: "example.com" },
];

async function ensureCensusTable(env) {
  // One row per (host, ymd): a same-day re-run upserts rather than duplicating,
  // so the series is one point per scan day. Kept separate from the deploy-log
  // `checkpoints` table that shares this D1 database.
  await env.RESTORE_DB.exec(
    "CREATE TABLE IF NOT EXISTS lens_census (ts INTEGER, ymd TEXT, host TEXT, url TEXT, tier TEXT, score INTEGER, level INTEGER, doors INTEGER, verdict TEXT, surfaces TEXT, PRIMARY KEY (host, ymd))"
  );
}

// Pull the metrics the census tracks out of a full lens envelope.
function censusMetrics(site, r, ts, ymd) {
  const terms = (r && r.terms) || {};
  const readiness = (r && r.readiness) || {};
  const ag = (r && r.agent) || {};
  const d = (r && r.discovery) || {};
  const doorList = [ag.mcp, ag.nlweb, ag.webmcp, ag.agentCard, ag.openapi, ag.apiCatalog];
  const doors = doorList.filter((x) => x && (x.verdict === "yes" || x.verdict === "likely" || x.verdict === "maybe" || x.present || x.found)).length;
  const surfaces = {
    llms: !!(d.llmsTxt && d.llmsTxt.ok),
    md: !!(ag.mdNegotiation && ag.mdNegotiation.supported),
    mcp: !!(ag.mcp && (ag.mcp.verdict === "yes" || ag.mcp.verdict === "likely")),
    agents: !!(d.agentsMd && d.agentsMd.present),
    jsonld: !!(r && r.structured && (r.structured.jsonld || []).length),
    webBotAuth: !!(d.webBotAuth && d.webBotAuth.ok),
  };
  return {
    ts, ymd, host: site.label, url: site.url,
    tier: (terms.spectrum && terms.spectrum.tier) || "unknown",
    score: readiness.overall == null ? null : readiness.overall,
    level: readiness.level == null ? null : readiness.level,
    doors,
    verdict: (ag.strategy && ag.strategy.verdict) || "unknown",
    surfaces: JSON.stringify(surfaces),
  };
}

// The weekly job. Scans the whole roster (bot-view sampling skipped to stay under
// the subrequest budget), in small concurrent batches, and upserts one row each.
// Best-effort per host: a single site that errors or times out doesn't sink the run.
// Traced because this is a TIME SERIES, and a time series with quietly missing
// rows is worse than no time series: the whole claim of /lens/census is that it
// is citable evidence about where the web is going. The per-host catch below is
// correct (one dead host must not abort the sweep) and it is also the exact
// mechanism by which a roster of 16 could quietly become a roster of 3. `written`
// is returned but the caller is `ctx.waitUntil`, so nothing has ever read it.
// Now the sweep records roster size against rows written, and each failed host
// names itself. The lensInspect spans nest underneath, so a host that failed
// because its own fetch timed out shows exactly that.
// opts.oneBatch: process a single 4-host slice and advance a KV cursor, for
// callers whose invocation cannot outlive the runtime's post-response grace.
// The Monday cron is now AWAITED by scheduled() and sweeps the whole roster in
// one pass; the owner's ?refresh= rides a fetch event's waitUntil, which gets
// roughly thirty seconds — a full sweep is four batches at up to ~15s each, and
// three straight weeks of refresh-seeded snapshots wrote exactly batch one. A
// chunked pass finishes safely inside the grace, and four passes cover the
// roster. Same-day passes upsert into one (host, ymd) snapshot, so a click-
// through refresh still yields a single census day.
const CENSUS_CURSOR_KEY = "lens:census:cursor";

export async function cronCensus(env, opts = {}) {
  return span("census.sweep", (s) => cronCensusInner(env, s, opts), { "census.roster": CENSUS_ROSTER.length });
}

async function cronCensusInner(env, sSweep, opts = {}) {
  if (!env.RESTORE_DB) {
    sSweep.setAttribute("census.outcome", "no_binding");
    return { ok: false, error: "no RESTORE_DB binding" };
  }
  await span("census.ensure_table", () => ensureCensusTable(env));
  const ts = Date.now();
  const ymd = new Date(ts).toISOString().slice(0, 10);
  let written = 0, failed = 0;
  const batchSize = 4;
  let start = 0;
  if (opts.oneBatch && env.RN_KV) {
    try { start = parseInt((await env.RN_KV.get(CENSUS_CURSOR_KEY)) || "0", 10) || 0; } catch (_e) {}
    if (start >= CENSUS_ROSTER.length) start = 0;
  }
  const stop = opts.oneBatch ? Math.min(start + batchSize, CENSUS_ROSTER.length) : CENSUS_ROSTER.length;
  for (let i = start; i < stop; i += batchSize) {
    const batch = CENSUS_ROSTER.slice(i, i + batchSize);
    await Promise.all(batch.map(async (site) => span("census.host", async (s) => {
      s.setAttribute("census.host", site.label || site.url);
      try {
        const r = await lensInspect(site.url, env, { skipBotViews: true });
        const m = censusMetrics(site, r, ts, ymd);
        await env.RESTORE_DB.prepare(
          "INSERT INTO lens_census (ts, ymd, host, url, tier, score, level, doors, verdict, surfaces) VALUES (?,?,?,?,?,?,?,?,?,?) " +
          "ON CONFLICT(host, ymd) DO UPDATE SET ts=excluded.ts, url=excluded.url, tier=excluded.tier, score=excluded.score, level=excluded.level, doors=excluded.doors, verdict=excluded.verdict, surfaces=excluded.surfaces"
        ).bind(m.ts, m.ymd, m.host, m.url, m.tier, m.score, m.level, m.doors, m.verdict, m.surfaces).run();
        written++;
        s.setAttribute("census.outcome", "written");
        s.setAttribute("census.tier", m.tier);
        s.setAttribute("census.score", m.score);
        s.setAttribute("census.doors", m.doors);
      } catch (e) { /* skip a failed host; the census is best-effort */
        failed++;
        s.setAttribute("census.outcome", "failed");
        s.setAttribute("census.error", (e && e.message) || String(e));
      }
    })));
  }
  let cursorNext = null;
  if (opts.oneBatch && env.RN_KV) {
    cursorNext = stop >= CENSUS_ROSTER.length ? 0 : stop;
    try { await env.RN_KV.put(CENSUS_CURSOR_KEY, String(cursorNext)); } catch (_e) {}
    sSweep.setAttribute("census.cursor_next", cursorNext);
  }
  sSweep.setAttribute("census.range", start + "-" + stop);
  sSweep.setAttribute("census.written", written);
  sSweep.setAttribute("census.failed", failed);
  sSweep.setAttribute("census.ymd", ymd);
  return { ok: true, written, ymd, range: [start, stop], cursorNext };
}

// Read every stored row, grouped per host into a time series with its first and
// latest snapshot. Small dataset (roster × weeks), so read it all and reduce here.
export async function fetchCensusGrouped(env) {
  if (!env.RESTORE_DB) return null;
  await ensureCensusTable(env);
  const { results } = await env.RESTORE_DB.prepare(
    "SELECT ts, ymd, host, url, tier, score, level, doors, verdict, surfaces FROM lens_census ORDER BY host, ts"
  ).all();
  const rows = results || [];
  if (!rows.length) return { hosts: [], snapshots: 0, firstYmd: null, lastYmd: null };
  const byHost = new Map();
  let firstYmd = null, lastYmd = null;
  const days = new Set();
  for (const row of rows) {
    days.add(row.ymd);
    if (!firstYmd || row.ymd < firstYmd) firstYmd = row.ymd;
    if (!lastYmd || row.ymd > lastYmd) lastYmd = row.ymd;
    byHost.getOrInsertComputed(row.host, () => []).push(row);
  }
  const order = CENSUS_ROSTER.map((s) => s.label);
  const hosts = [...byHost.entries()].map(([host, series]) => {
    series.sort((a, b) => a.ts - b.ts);
    const first = series[0], last = series[series.length - 1];
    return {
      host, url: last.url, first, last, series,
      scoreSeries: series.map((s) => (s.score == null ? 0 : s.score)),
      delta: (last.score != null && first.score != null) ? last.score - first.score : 0,
    };
  }).sort((a, b) => {
    // rank by latest score desc, unknown/null last, ties keep roster order
    const sa = a.last.score == null ? -1 : a.last.score;
    const sb = b.last.score == null ? -1 : b.last.score;
    if (sb !== sa) return sb - sa;
    return order.indexOf(a.host) - order.indexOf(b.host);
  });
  return { hosts, snapshots: days.size, firstYmd, lastYmd };
}

const SPARK = "▁▂▃▄▅▆▇█";
function sparkline(series) {
  if (!series || !series.length) return "";
  if (series.length === 1) return SPARK[Math.min(7, Math.round(series[0] / 100 * 7))];
  return series.map((v) => SPARK[Math.max(0, Math.min(7, Math.round((v || 0) / 100 * 7)))]).join("");
}

const TIER_KIND = { open: "ok", signaled: "", enforced: "warn", paid: "warn", unknown: "off" };

// The shared exhibit renderer: the full per-site trend table. Used by the
// standalone /lens/census page.
export function censusExhibitHtml(grouped) {
  if (!grouped || !grouped.hosts.length) {
    return '<div class="cx-empty">No snapshots recorded yet. The weekly census writes its first row on the next run; an owner can seed it immediately with the refresh key.</div>';
  }
  const rows = grouped.hosts.map((h) => {
    const last = h.last;
    const tier = last.tier || "unknown";
    const scoreTxt = last.score == null ? "—" : last.score;
    const arrow = h.delta > 0 ? '<span class="cx-up">▲' + h.delta + "</span>" : h.delta < 0 ? '<span class="cx-down">▼' + Math.abs(h.delta) + "</span>" : (h.series.length > 1 ? '<span class="cx-flat">•</span>' : "");
    let surf = {};
    try { surf = JSON.parse(last.surfaces || "{}"); } catch (_e) {}
    const chips = [
      surf.llms ? "llms.txt" : "", surf.md ? "markdown" : "", surf.mcp ? "MCP" : "",
      surf.agents ? "AGENTS.md" : "", surf.jsonld ? "JSON-LD" : "", surf.webBotAuth ? "WebBotAuth" : "",
    ].filter(Boolean).map((c) => '<span class="cx-surf">' + escHtml(c) + "</span>").join("");
    return '<tr>' +
      '<td class="cx-site"><a href="/lens?url=' + escAttr(encodeURIComponent(h.url)) + '">' + escHtml(h.host) + "</a></td>" +
      '<td><span class="lx-badge ' + (TIER_KIND[tier] || "off") + '">' + escHtml(tier) + "</span></td>" +
      '<td class="cx-num"><b>' + escHtml(scoreTxt) + "</b>" + (scoreTxt === "—" ? "" : "<span>/100</span>") + " " + arrow + "</td>" +
      '<td class="cx-num">' + (last.level == null ? "—" : "L" + last.level) + "</td>" +
      '<td class="cx-num">' + last.doors + "</td>" +
      '<td class="cx-spark" title="' + escAttr(h.scoreSeries.join(" → ")) + '">' + escHtml(sparkline(h.scoreSeries)) + "</td>" +
      '<td class="cx-surfs">' + (chips || '<span class="cx-none">none</span>') + "</td>" +
      "</tr>";
  }).join("");
  const span = grouped.firstYmd === grouped.lastYmd
    ? "one snapshot, " + escHtml(grouped.firstYmd)
    : grouped.snapshots + " snapshots, " + escHtml(grouped.firstYmd) + " → " + escHtml(grouped.lastYmd);
  return '<div class="cx-meta">' + grouped.hosts.length + " sites &middot; " + span + " &middot; re-scanned weekly, honestly, as AadharshBot</div>" +
    '<div class="cx-scroll"><table class="cx-table"><thead><tr>' +
    "<th>site</th><th>terms</th><th>readiness</th><th>level</th><th>doors</th><th>score trend</th><th>surfaces published</th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
    '<div class="cx-foot">Readiness is the same transparent rubric the <a href="/lens">Readiness lens</a> runs, minus bot-view sampling. Score trend is one mark per weekly snapshot. Machine-readable twin: <a href="/lens/census.json">/lens/census.json</a>.</div>';
}

export const CENSUS_CSS = `
.cx-meta { font-size:8.6pt; color:oklch(50% 0 0); font-style:italic; margin:0 0 8px; }
.cx-scroll { overflow-x:auto; }
.cx-table { width:100%; border-collapse:collapse; font-size:9pt; min-width:640px; }
.cx-table th { font:7.8pt Tahoma,Verdana,sans-serif; text-transform:uppercase; letter-spacing:.05em; color:oklch(50% 0 0); text-align:left; padding:3px 8px 5px 0; border-bottom:2px solid oklch(70% 0.05 250); }
.cx-table td { padding:5px 8px 5px 0; border-bottom:1px solid oklch(93% 0.01 250); vertical-align:middle; }
.cx-site a { font-family:"Courier New",monospace; color:oklch(40% 0.11 255); text-decoration:none; }
.cx-site a:hover { text-decoration:underline; }
.cx-num { font-family:"Courier New",monospace; white-space:nowrap; color:oklch(30% 0.04 255); }
.cx-num span { color:oklch(58% 0 0); font-size:7.6pt; }
.cx-up { color:oklch(45% 0.14 150); margin-left:3px; }
.cx-down { color:oklch(52% 0.19 27); margin-left:3px; }
.cx-flat { color:oklch(62% 0 0); margin-left:3px; }
.cx-spark { font-family:"Courier New",monospace; font-size:12pt; letter-spacing:1px; color:oklch(45% 0.12 255); }
.cx-surfs { line-height:1.7; }
.cx-surf { font-family:"Courier New",monospace; font-size:7.6pt; color:oklch(35% 0.06 150); background:oklch(95% 0.03 150); border:1px solid oklch(82% 0.05 150); border-radius:3px; padding:0 5px; margin:0 3px 2px 0; display:inline-block; }
.cx-none { color:oklch(60% 0 0); font-size:8pt; }
.cx-foot { margin-top:10px; padding-top:8px; border-top:1px solid oklch(88% 0.02 250); font-size:8.6pt; color:oklch(42% 0.02 255); line-height:1.5; }
.cx-foot a { color:oklch(42.61% 0.2353 263.74); }
.cx-empty { padding:22px 10px; text-align:center; color:oklch(52% 0 0); font-size:9.5pt; }
`;

// GET /lens/census — the standalone exhibit page (SSR, no-JS friendly, machines
// welcome). ?refresh=<CENSUS_KEY> triggers a scan now (owner-only), so the first
// snapshot doesn't have to wait for the Monday cron.
export async function handleCensus(request, env, ctx) {
  const url = new URL(request.url);
  const refresh = url.searchParams.get("refresh");
  let banner = "";
  if (refresh) {
    if (env.CENSUS_KEY && timingSafeEqual(refresh, env.CENSUS_KEY)) {
      // oneBatch: a fetch invocation's waitUntil gets ~30s past the response,
      // which a 16-host sweep blows through (that ceiling is why refresh-seeded
      // snapshots only ever held the first four hosts). Each pass sweeps one
      // batch and advances a cursor; the Monday cron sweeps everything at once.
      ctx.waitUntil(cronCensus(env, { oneBatch: true }));
      banner = '<div class="cx-banner ok">Census refresh triggered: one pass of 4 roster hosts (a browser-triggered pass stays under the runtime\'s post-response budget; the Monday cron sweeps all 16 at once). Reload in a minute, then trigger again to continue where the cursor left off.</div>';
    } else {
      banner = '<div class="cx-banner err">That refresh key did not match. The census only re-scans on the weekly cron or with the owner key.</div>';
    }
  }
  const grouped = await fetchCensusGrouped(env);
  return lunaPage({
    title: "The census · aadhar.sh",
    path: "The Other Web · census",
    route: "/lens/census",
    width: 900,
    description: "A weekly, longitudinal record of how agent-ready 16 representative websites are — spectrum tier, readiness score, and agent doors, tracked over time.",
    robots: "index, follow",
    css: CENSUS_CSS + `
.cx-banner { margin:0 0 12px; padding:7px 10px; border-radius:3px; font-size:9pt; }
.cx-banner.ok { border:1px solid oklch(74% 0.09 150); background:oklch(96% 0.03 150); color:oklch(34% 0.11 150); }
.cx-banner.err { border:1px solid oklch(74% 0.12 40); background:oklch(96% 0.04 60); color:oklch(44% 0.13 45); }
.lx-badge { font-family:"Courier New",monospace; font-size:7.6pt; color:#fff; background:oklch(52% 0.13 255); border-radius:8px; padding:1px 7px; }
.lx-badge.warn { background:oklch(60% 0.16 50); }
.lx-badge.ok { background:oklch(52% 0.13 150); }
.lx-badge.off { background:oklch(60% 0 0); }
h1 { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:13pt; color:oklch(41.92% 0.0962 250.51); margin:0 0 2px; }
.cx-lede { margin:0 0 12px; color:oklch(40% 0 0); font-size:10pt; line-height:1.5; }
.cx-lede a { color:oklch(42.61% 0.2353 263.74); }
footer { text-align:center; font-size:9pt; color:oklch(45% 0 0); margin-top:16px; padding-top:11px; border-top:1px solid oklch(86.67% 0.0294 259.59); }
footer a { color:oklch(42.61% 0.2353 263.74); }
`,
    body: `
    <h1>The census</h1>
    <p class="cx-lede">Every per-URL scan in <a href="/lens">The Other Web</a> is a sample of one. This is the population over time: 16 representative sites, re-scanned weekly, so you can watch the agentic web actually move. Nobody else publishes agent-readiness as a time series for named sites, which is exactly why it is worth keeping.</p>
    ${banner}
    ${censusExhibitHtml(grouped)}
    <footer>&larr; <a href="/lens">The Other Web</a> &middot; <a href="/">aadhar.sh</a> &middot; fetched by <a href="/bot">AadharshBot</a></footer>
`,
    cache: "public, max-age=300, s-maxage=900",
    headers: { "x-robots-tag": "index" },
  });
}

// GET /lens/census.json — the machine twin: the same grouped series as JSON.
export async function handleCensusJson(request, env) {
  const grouped = await fetchCensusGrouped(env);
  if (!grouped) return jsonResponse({ ok: false, error: "census storage is unavailable" }, 503);
  return jsonResponse({
    ok: true,
    roster: CENSUS_ROSTER.length,
    snapshots: grouped.snapshots,
    firstYmd: grouped.firstYmd,
    lastYmd: grouped.lastYmd,
    sites: grouped.hosts.map((h) => ({
      host: h.host, url: h.url,
      tier: h.last.tier, score: h.last.score, level: h.last.level,
      doors: h.last.doors, verdict: h.last.verdict,
      delta: h.delta,
      surfaces: (() => { try { return JSON.parse(h.last.surfaces || "{}"); } catch (_e) { return {}; } })(),
      series: h.series.map((s) => ({ ymd: s.ymd, score: s.score, tier: s.tier, doors: s.doors })),
    })),
  }, 200, { "cache-control": "public, max-age=300, s-maxage=900" });
}
