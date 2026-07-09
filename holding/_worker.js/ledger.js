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
import { cachedRender } from "./lib/cache.js";
import { lunaPage } from "./lib/chrome.js";
import { esc, jsonResp } from "./lib/http.js";

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
export function countCrawlerHit(env, request, response, pathname) {
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
async function queryLedger(env) {
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

function priced(rows) {
  const items = rows.map((r) => ({ ...r, amountUsd: +(r.hits * RATE_USD).toFixed(2) }));
  const totalHits = items.reduce((n, r) => n + r.hits, 0);
  const totalUsd = +(totalHits * RATE_USD).toFixed(2);
  return { items, totalHits, totalUsd };
}

// ── /ledger.json — the machine twin ─────────────────────────────────
export async function handleLedgerJson(request, env) {
  const q = await queryLedger(env);
  if (!q.ok) return jsonResp({ ok: false, reason: q.reason, window_days: WINDOW_DAYS, rate_usd: RATE_USD }, q.reason === "unconfigured" ? 200 : 502);
  const { items, totalHits, totalUsd } = priced(q.rows);
  return jsonResp({
    ok: true, window_days: WINDOW_DAYS, rate_usd: RATE_USD,
    note: "worker-served requests only; UA-matched (self-reported identity); the rate is this site's posted price, not a market quote",
    line_items: items, total_hits: totalHits, total_usd: totalUsd,
  });
}

// ── /ledger — the invoice ───────────────────────────────────────────
export function handleLedger(request, env, ctx) {
  return cachedRender(request, ctx, () => renderLedger(env), "/ledger", env);
}

const KIND_LABEL = { search: "search indexing", train: "model training", answers: "AI answers (live retrieval)" };

async function renderLedger(env) {
  const q = await queryLedger(env);
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

  const css = `
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
    </div>

    <div class="lg-terms">
      <b>Terms &amp; honesty notes</b>
      <ul>
        <li>Only worker-served requests are countable — static files served straight from the edge never wake the worker, so the true crawl count is higher than this.</li>
        <li>Identity is self-reported: a row is a user-agent claim, not a verified signature. A bot that lies about its name bills to nobody.</li>
        <li>The rate is this site's posted price (the /llms-full.txt cent), not a market quote. Robots policy and Content Signals live in <a href="/robots.txt">robots.txt</a>: reading here is welcome — this invoice is the point being made, not a demand letter.</li>
        <li>Machine-readable twin at <a href="/ledger.json">/ledger.json</a>.</li>
      </ul>
    </div>
    <footer>&larr; <a href="/">aadhar.sh</a> &middot; counted by the worker, priced by the house &middot; crawled honestly? <a href="/bot">so do we</a></footer>
`;

  return lunaPage({
    title: "The Crawl Ledger · aadhar.sh",
    path: "The Crawl Ledger",
    width: 760,
    description: "An invoice for the AI crawlers that read aadhar.sh: every identified bot hit in the last 30 days, priced at one cent a page. Issued monthly, collected never.",
    robots: "index, nofollow",
    css,
    body,
    cache: "public, max-age=60, s-maxage=300",
  });
}
