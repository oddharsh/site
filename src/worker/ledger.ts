// ledger.js — /ledger, the AI crawl ledger ("accounts receivable"). Every
// month AI crawlers read this site; nobody pays. This page does the
// arithmetic anyway: every worker-served crawler hit, counted into Workers
// Analytics Engine and priced at the same one cent /llms-full.txt charges,
// rendered as an XP-era invoice that is issued monthly and collected never.
//
// Two halves:
//   COUNTING — matchCrawler() is called from index.js's fetch wrapper; a UA
//   match writes one data point (bot, owner, kind, path) to the BOT_LEDGER
//   Analytics Engine dataset. Free tier, non-blocking, guarded — no binding,
//   no counting. Only worker-owned routes are visible (edge-direct static
//   assets never wake the worker); the page says so honestly.
//   READING — Analytics Engine has no read binding, so /ledger queries the
//   SQL API over HTTPS with ANALYTICS_READ_TOKEN (Account Analytics : Read).
//   Absent token → the invoice renders with a "meter not readable yet" note.
//   COSTING — one line under the total, read from Cloudflare's Billable Usage
//   API with BILLING_READ_TOKEN (Billing : Read). It is the only figure on the
//   page that was ever actually paid, and it is account-level by necessity;
//   see queryBillableUsage() for why there is no per-bot cost column.
import type { Env, SiteRequest } from "./lib/env.ts";
import { cachedRender } from "./lib/cache.ts";
import { lunaPage } from "./lib/chrome.ts";
import { esc, jsonResp } from "./lib/http.ts";

const RATE_USD = 0.01;      // the site's posted price (the /llms-full.txt cent), not a market quote
const WINDOW_DAYS = 30;
const DATASET = "aadhar_bot_ledger";

// UA-substring → identity. Specific tokens before general ones. AadharshBot
// is deliberately absent: lens self-scans would have us billing ourselves.
const CRAWLERS = [
  ["oai-searchbot",      "OAI-SearchBot",      "OpenAI",       "answers"],
  ["chatgpt-user",       "ChatGPT-User",       "OpenAI",       "answers"],
  ["gptbot",             "GPTBot",             "OpenAI",       "train"],
  ["claude-searchbot",   "Claude-SearchBot",   "Anthropic",    "answers"],
  ["claude-user",        "Claude-User",        "Anthropic",    "answers"],
  ["claudebot",          "ClaudeBot",          "Anthropic",    "train"],
  ["perplexity-user",    "Perplexity-User",    "Perplexity",   "answers"],
  ["perplexitybot",      "PerplexityBot",      "Perplexity",   "answers"],
  ["ccbot",              "CCBot",              "Common Crawl", "train"],
  ["bytespider",         "Bytespider",         "ByteDance",    "train"],
  ["amazonbot",          "Amazonbot",          "Amazon",       "train"],
  ["meta-externalagent", "Meta-ExternalAgent", "Meta",         "train"],
  ["applebot",           "Applebot",           "Apple",        "search"],
  ["googlebot",          "Googlebot",          "Google",       "search"],
  ["bingbot",            "Bingbot",            "Microsoft",    "search"],
  ["duckduckbot",        "DuckDuckBot",        "DuckDuckGo",   "search"],
];

export function matchCrawler(ua) {
  const s = String(ua || "").toLowerCase();
  if (!s) return null;
  for (const [needle, name, owner, kind] of CRAWLERS) {
    if (s.includes(needle)) return { name, owner, kind };
  }
  return null;
}

// one data point per crawler hit; called from the dispatcher. never throws.
export function countCrawlerHit(env: Env, request, response, pathname) {
  try {
    if (!env.BOT_LEDGER || response.status >= 400) return;
    const hit = matchCrawler(request.headers.get("user-agent"));
    if (!hit) return;
    env.BOT_LEDGER.writeDataPoint({
      blobs: [hit.name, hit.owner, hit.kind, pathname.slice(0, 96)],
      doubles: [1],
      indexes: [hit.name],
    });
  } catch (_e) { /* the ledger is best-effort; never break a response over it */ }
}

// ── reading the meter ───────────────────────────────────────────────
//
// BOTH READS DECLARE THEIR RETURN UNION RATHER THAN LETTING IT BE INFERRED, and
// that is a correctness fix rather than documentation. An inferred union built
// from object literals of different shapes does NOT discriminate: TypeScript
// normalizes it to ONE object type carrying every field as optional, so `.ok`
// narrows nothing and each field reads as possibly-undefined. Measured on the
// pinned tsc in a six-line probe:
//
//   function f(x: boolean) {
//     if (x) return { ok: false, reason: "no" };
//     return { ok: true, services: ["a"], totalUsd: 1 };
//   }
//   const r = f(true);
//   if (r.ok) r.services.length;   // TS18048: 'r.services' is possibly 'undefined'
//
// The `if (cost.ok)` branch below reads four fields that only exist on the
// success arm, and every one of them was unchecked until these types existed.
// The reads happen to be safe, because the runtime shapes really are disjoint,
// so nothing here was broken; what was broken is that the compiler could not
// tell, which is the whole reason a `?` on a degrading secret means anything.
type LedgerRow = { bot: string; owner: string; kind: string; hits: number };
type LedgerRead =
  | { ok: false; reason: string }
  | { ok: true; rows: LedgerRow[] };

async function queryLedger(env: Env): Promise<LedgerRead> {
  if (!env.ANALYTICS_READ_TOKEN || !env.CF_ACCOUNT_ID) return { ok: false, reason: "unconfigured" };
  const sql =
    `SELECT blob1 AS bot, blob2 AS owner, blob3 AS kind, SUM(_sample_interval * double1) AS hits ` +
    `FROM ${DATASET} WHERE timestamp > NOW() - INTERVAL '${WINDOW_DAYS}' DAY ` +
    `GROUP BY bot, owner, kind ORDER BY hits DESC FORMAT JSON`;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try {
      r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
        method: "POST",
        headers: { authorization: "Bearer " + env.ANALYTICS_READ_TOKEN },
        body: sql,
        signal: ctrl.signal,
      });
    } finally { clearTimeout(to); }
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 200);
      // a dataset with zero writes ever doesn't exist yet — that's an empty
      // ledger, not an error.
      if (/no such table|does not exist|unknown table/i.test(detail)) return { ok: true, rows: [] };
      return { ok: false, reason: "SQL API " + r.status + ": " + detail };
    }
    const j = await r.json().catch(() => null);
    const rows = (j && j.data ? j.data : []).map((d) => ({
      bot: String(d.bot || "?"), owner: String(d.owner || "?"), kind: String(d.kind || "?"),
      hits: Math.round(Number(d.hits) || 0),
    })).filter((d) => d.hits > 0);
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

// ── the other column: what the account actually paid ────────────────
// Everything above this line is revenue that will never be collected, priced
// at a rate the house invented. Cloudflare's Billable Usage API is the one
// number on this page that changed hands, so the invoice gets a cost line and
// stops being one-sided.
//
// It is ACCOUNT-WIDE and product-wide, which is the whole reason it renders as
// a single line and not a per-bot column. Granularity is daily, per account /
// product / zone, so nothing here attributes a cent to a crawler; deriving a
// per-bot cost would mean modelling it from request counts and presenting a
// guess in the same table as a measurement. The page says what it has.
//
// Coverage is whatever Cloudflare bills through this feed (Workers, R2, D1,
// Workers AI, Vectorize, Images, Stream as of 2026-08). Analytics Engine,
// Browser Run, and KV are absent from that list, so the cost line is a
// floor rather than a total — `services` records which families actually
// answered, so the note can name them instead of implying completeness.
type BillableRead =
  | { ok: false; reason: string }
  | { ok: true; totalUsd: number; currency: string; services: string[]; from: string; to: string };

async function queryBillableUsage(env: Env): Promise<BillableRead> {
  if (!env.BILLING_READ_TOKEN || !env.CF_ACCOUNT_ID) return { ok: false, reason: "unconfigured" };
  const end = new Date();
  const start = new Date(end.getTime() - WINDOW_DAYS * 86400000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try {
      r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/billable-usage` +
        `?from=${ymd(start)}&to=${ymd(end)}`,
        { headers: { authorization: "Bearer " + env.BILLING_READ_TOKEN }, signal: ctrl.signal },
      );
    } finally { clearTimeout(to); }
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 200);
      return { ok: false, reason: "billing API " + r.status + ": " + detail };
    }
    const j = await r.json().catch(() => null);
    if (!j || j.success !== true || !Array.isArray(j.result)) return { ok: false, reason: "unexpected envelope" };
    // Sum ContractedCost, NEVER CumulatedContractedCost. The latter is a
    // running total carried on every row, so adding it up bills each charge
    // period once per row that follows it.
    let totalUsd = 0;
    let currency = "USD";
    const services = new Set<string>();
    for (const row of j.result) {
      const cost = Number(row && row.ContractedCost);
      if (!Number.isFinite(cost)) continue;
      totalUsd += cost;
      if (row.BillingCurrency) currency = String(row.BillingCurrency);
      if (row.ServiceFamilyName) services.add(String(row.ServiceFamilyName));
    }
    return {
      ok: true, totalUsd: +totalUsd.toFixed(2), currency,
      // An EXPLICIT code-unit comparator, which is exactly what a bare .sort()
      // does to strings. Spelling it out satisfies require-array-sort-compare
      // without changing the order: localeCompare would have been the reflexive
      // fix and would quietly re-order anything non-ASCII.
      services: [...services].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), from: ymd(start), to: ymd(end),
    };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e) };
  }
}

function priced(rows) {
  const items = rows.map((r) => ({ ...r, amountUsd: +(r.hits * RATE_USD).toFixed(2) }));
  const totalHits = items.reduce((n, r) => n + r.hits, 0);
  const totalUsd = +(totalHits * RATE_USD).toFixed(2);
  return { items, totalHits, totalUsd };
}

// ── /ledger.json — the machine twin ─────────────────────────────────
export async function handleLedgerJson(request: SiteRequest, env: Env) {
  const [q, cost] = await Promise.all([queryLedger(env), queryBillableUsage(env)]);
  const costBlock = cost.ok
    ? {
        available: true, total_usd: cost.totalUsd, currency: cost.currency,
        from: cost.from, to: cost.to, service_families: cost.services,
        note: "account-wide across every product Cloudflare bills through the Billable Usage API; daily granularity, so no part of this is attributable to any crawler",
      }
    : { available: false, reason: cost.reason };
  if (!q.ok) return jsonResp({ ok: false, reason: q.reason, window_days: WINDOW_DAYS, rate_usd: RATE_USD, cost: costBlock }, q.reason === "unconfigured" ? 200 : 502);
  const { items, totalHits, totalUsd } = priced(q.rows);
  return jsonResp({
    ok: true, window_days: WINDOW_DAYS, rate_usd: RATE_USD,
    note: "worker-served requests only; UA-matched (self-reported identity); the rate is this site's posted price, not a market quote",
    line_items: items, total_hits: totalHits, total_usd: totalUsd,
    cost: costBlock,
  });
}

// ── /ledger — the invoice ───────────────────────────────────────────
export function handleLedger(request: SiteRequest, env: Env, ctx: ExecutionContext) {
  return cachedRender(request, ctx, () => renderLedger(env), "/ledger", env);
}

const KIND_LABEL = { search: "search indexing", train: "model training", answers: "AI answers (live retrieval)" };

async function renderLedger(env: Env) {
  const [q, cost] = await Promise.all([queryLedger(env), queryBillableUsage(env)]);
  const { items, totalHits, totalUsd } = priced(q.ok ? q.rows : []);

  let tableRows;
  if (q.ok && items.length) {
    tableRows = items.map((r) => `
      <tr>
        <td class="mono">${esc(r.bot)}</td>
        <td>${esc(r.owner)}<br><span class="dim">${esc(KIND_LABEL[r.kind] || r.kind)}</span></td>
        <td class="num">${r.hits.toLocaleString("en-US")}</td>
        <td class="num">$${RATE_USD.toFixed(2)}</td>
        <td class="num">$${r.amountUsd.toFixed(2)}</td>
      </tr>`).join("");
  } else if (q.ok) {
    tableRows = `<tr><td colspan="5" class="empty">No identified AI-crawler visits landed on worker-served routes in the last ${WINDOW_DAYS} days. The meter is new; give it time.</td></tr>`;
  } else if (q.reason === "unconfigured") {
    tableRows = `<tr><td colspan="5" class="empty">The meter is counting, but this page can't read it back yet (Analytics Engine needs a read token). Line items will appear once the bookkeeper gets API access.</td></tr>`;
  } else {
    tableRows = `<tr><td colspan="5" class="empty">The bookkeeper is unreachable right now (${esc(q.reason)}). The meter keeps counting regardless.</td></tr>`;
  }

  // The counterweight to the total above: one account-level figure, never a
  // per-bot column, because the billing feed cannot attribute a cent to a
  // crawler and a modelled split would read as measured next to the real hits.
  let costLine;
  if (cost.ok) {
    const families = cost.services.length ? cost.services.join(", ") : "no billed products";
    costLine = `<div class="lg-cost">Cost of actually running this account, same ${WINDOW_DAYS} days: <b>$${cost.totalUsd.toFixed(2)}</b> ${esc(cost.currency)}
      <span class="lg-cost-sub">Cloudflare's billing feed, account-wide (${esc(families)}) — not the crawlers' share, which nobody can compute.</span></div>`;
  } else if (cost.reason === "unconfigured") {
    costLine = `<div class="lg-cost"><span class="lg-cost-sub">The cost side of this invoice is unreadable until the bookkeeper gets a Billing Read token. Only the imaginary column renders today.</span></div>`;
  } else {
    costLine = `<div class="lg-cost"><span class="lg-cost-sub">The cost side is unreachable right now (${esc(cost.reason)}).</span></div>`;
  }

  const css = `/*min*/
h1 { font-family:"Trebuchet MS",Verdana,Geneva,sans-serif; font-size:13pt; color:oklch(41.92% 0.0962 250.51); margin:0 0 2px; font-weight:bold; }
.lg-lede { margin:0 0 12px; color:oklch(40% 0 0); font-size:10pt; }
.lg-lede a { color:oklch(42.61% 0.2353 263.74); }

/* the invoice paper */
.lg-paper { position:relative; background:#fff; border:1px solid oklch(80% 0.01 250); box-shadow:2px 2px 0 oklch(88% 0.01 250); padding:18px 20px 16px; max-width:640px; margin:0 auto; }
.lg-head { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid oklch(30% 0.02 255); padding-bottom:8px; margin-bottom:10px; }
.lg-from b { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:11pt; color:oklch(28% 0.04 255); }
.lg-from div, .lg-invno div { font-size:8.6pt; color:oklch(45% 0 0); }
.lg-invno { text-align:right; }
.lg-invno b { font-family:"Courier New",monospace; font-size:11pt; color:oklch(28% 0.04 255); }
.lg-billto { font-size:9pt; color:oklch(35% 0 0); margin:0 0 10px; }
.lg-billto b { color:oklch(28% 0.04 255); }

table.lg { width:100%; border-collapse:collapse; font-size:9pt; }
table.lg th { text-align:left; font-size:7.8pt; text-transform:uppercase; letter-spacing:.05em; color:oklch(48% 0 0); font-weight:normal; border-bottom:1px solid oklch(70% 0 0); padding:3px 6px 3px 0; }
table.lg td { border-bottom:1px dashed oklch(88% 0 0); padding:5px 6px 5px 0; vertical-align:top; }
table.lg .mono { font-family:"Courier New",monospace; }
table.lg .num, table.lg th.num { text-align:right; font-family:"Courier New",monospace; white-space:nowrap; }
table.lg .dim { color:oklch(55% 0 0); font-size:8pt; }
table.lg .empty { color:oklch(50% 0 0); font-size:9pt; padding:14px 4px; text-align:center; }
.lg-total { display:flex; justify-content:flex-end; gap:24px; font-size:10pt; margin-top:8px; padding-top:6px; border-top:2px solid oklch(30% 0.02 255); }
.lg-total b { font-family:"Courier New",monospace; font-size:12pt; }
/* the cost line: the one figure on this invoice that changed hands */
.lg-cost { text-align:right; font-size:8.8pt; color:oklch(45% 0 0); margin-top:7px; padding-top:6px; border-top:1px dashed oklch(80% 0 0); }
.lg-cost b { font-family:"Courier New",monospace; font-size:10.5pt; color:oklch(28% 0.04 255); }
.lg-cost .lg-cost-sub { display:block; color:oklch(55% 0 0); font-size:8pt; margin-top:1px; }

/* the stamp */
.lg-stamp { position:absolute; top:96px; right:26px; transform:rotate(-12deg); font-family:"Courier New",monospace; font-weight:bold; font-size:19pt; color:oklch(55% 0.21 27 / .8); border:3px double oklch(55% 0.21 27 / .8); border-radius:4px; padding:2px 14px; letter-spacing:.12em; pointer-events:none; }

.lg-terms { font-size:8.6pt; color:oklch(45% 0 0); margin:12px auto 0; max-width:640px; }
.lg-terms b { color:oklch(35% 0 0); }
.lg-terms ul { margin:4px 0 0; padding-left:18px; }
.lg-terms li { margin:2px 0; }
footer { text-align:center; font-size:9pt; color:oklch(45% 0 0); margin-top:14px; padding-top:11px; border-top:1px solid oklch(86.67% 0.0294 259.59); }
footer a { color:oklch(42.61% 0.2353 263.74); }
@media (max-width:560px){ .lg-stamp{ font-size:14pt; top:110px; right:12px; } }
`;

  const body = `
    <h1>The Crawl Ledger</h1>
    <p class="lg-lede">AI crawlers read this site all month; nobody pays. Here's the arithmetic anyway — every identified crawler hit on a worker-served route, priced at the same one cent <a href="/llms-full.txt">/llms-full.txt</a> charges. The uncollected revenue of one small site on the open web, itemized. See any page's terms through <a href="/lens">the lens</a>.</p>

    <div class="lg-paper">
      <span class="lg-stamp">UNPAID</span>
      <div class="lg-head">
        <div class="lg-from"><b>aadhar.sh</b><div>sole proprietor of this content</div><div>payment accepted in USDC, x402, at /llms-full.txt</div></div>
        <div class="lg-invno"><b>INVOICE</b><div>period: trailing ${WINDOW_DAYS} days</div><div>issued monthly &middot; collected never</div></div>
      </div>
      <p class="lg-billto"><b>Bill to:</b> the operators below, per their own user-agent strings.</p>
      <table class="lg">
        <tr><th>crawler</th><th>operator</th><th class="num">pages</th><th class="num">rate</th><th class="num">amount</th></tr>
        ${tableRows}
      </table>
      <div class="lg-total"><span>Total due</span> <b>$${totalUsd.toFixed(2)}</b> <span class="dim" style="font-size:8.6pt; align-self:center;">(${totalHits.toLocaleString("en-US")} pages)</span></div>
      ${costLine}
    </div>

    <div class="lg-terms">
      <b>Terms &amp; honesty notes</b>
      <ul>
        <li>Only worker-served requests are countable — static files served straight from the edge never wake the worker, so the true crawl count is higher than this.</li>
        <li>Identity is self-reported: a row is a user-agent claim, not a verified signature. A bot that lies about its name bills to nobody.</li>
        <li>The rate is this site's posted price (the /llms-full.txt cent), not a market quote. Robots policy and Content Signals live in <a href="/robots.txt">robots.txt</a>: reading here is welcome — this invoice is the point being made, not a demand letter.</li>
        <li>The cost line is the only figure here that changed hands, and it is account-wide: every product on this Cloudflare account over the same window, not the crawlers' share. Billing lands daily and carries no per-request identity, so splitting it per bot would mean modelling a number and printing it next to measured ones. Coverage is whatever Cloudflare bills through that feed, which leaves out Analytics Engine, Browser Run, and KV — read it as a floor.</li>
        <li>Machine-readable twin at <a href="/ledger.json">/ledger.json</a>.</li>
      </ul>
    </div>
    <footer>&larr; <a href="/">aadhar.sh</a> &middot; counted by the worker, priced by the house &middot; crawled honestly? <a href="/bot">so do we</a></footer>
`;

  return lunaPage({
    title: "The Crawl Ledger · aadhar.sh",
    path: "The Crawl Ledger",
    route: "/ledger",
    width: 760,
    description: "An invoice for the AI crawlers that read aadhar.sh: every identified bot hit in the last 30 days, priced at one cent a page. Issued monthly, collected never.",
    robots: "index, nofollow",
    css,
    body,
    cache: "public, max-age=60, s-maxage=300",
  });
}
