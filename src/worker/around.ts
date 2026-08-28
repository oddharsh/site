import { BOT_NAME, BOT_UA, SIG_AGENT, signedFetch } from "./lib/botauth.ts";
import { cachedRender, deleteSWRKV } from "./lib/cache.ts";
import { crawlDocument, mapWithConcurrency, readResponseCapped } from "./lib/crawl.ts";
import { lunaPage } from "./lib/chrome.ts";
import { unsafeHtml } from "./lib/html.ts";
import { esc, extractMeta, jsonResponse } from "./lib/http.ts";
import { lensParseRobots, lensRobotsVerdict } from "./lib/robots.ts";
import { span } from "./lib/trace.ts";

// Obey robots.txt before crawling a neighbor. /bot promises AadharshBot reads and
// obeys robots.txt, and this cron is the one path that fetches third-party sites
// unprompted, so it is where the promise has to be kept. RFC 9309: an absent or
// 4xx robots.txt means allow-all; a 5xx or unreachable one means treat as
// disallowed (we skip THIS cycle and retry next cron, rather than crawl over a
// policy we could not read). Parsed robots is cached 12h per origin — ~20 origins,
// one write each, trivially within the KV budget.
async function robotsGate(env, url) {
  let origin, path;
  try { const u = new URL(url); origin = u.origin; path = u.pathname || "/"; } catch { return { ok: true }; }
  const key = `around:robots:${origin}`;
  let parsed = null;
  try { parsed = env.RN_KV ? await env.RN_KV.get(key, "json") : null; } catch {}
  if (!parsed) {
    try {
      const r = await signedFetch(origin + "/robots.txt", env, { signal: AbortSignal.timeout(3000) });
      if (r.status >= 500) return { ok: false, kind: "undetermined", reason: "robots.txt " + r.status };   // 5xx: don't cache, retry next cron
      const body = r.ok ? await readResponseCapped(r, 64 * 1024) : { text: "" };
      parsed = r.ok ? lensParseRobots(body.text) : { groups: [], sitemaps: [] };   // 4xx / absent → allow-all, cacheable
      if (env.RN_KV) { try { await env.RN_KV.put(key, JSON.stringify(parsed), { expirationTtl: 43200 }); } catch {} }
    } catch { return { ok: false, kind: "undetermined", reason: "robots.txt unreachable" }; }
  }
  const v = lensRobotsVerdict(parsed, BOT_NAME, path);
  return v.verdict === "block" ? { ok: false, kind: "disallow", rule: v.rule || "Disallow" } : { ok: true };
}

  // Signature-Agent value (RFC 8941 string)

// the neighborhood — crypto-VC homepages worth checking in on. just funds
// whose work i follow; the dashboard is mostly an excuse to point a branded
// crawler at something interesting.
//
// each url is the POST-REDIRECT one: whatever `curl -L` settles on, apex or
// www, is what goes here. a redirecting entry costs the cron an extra round
// trip every crawl and an extra robots.txt origin to resolve, for a response
// we already know is a 301. verify with:
//   curl -sIL -o /dev/null -w '%{num_redirects} %{url_effective}\n' <url>
// last swept 2026-07-30 (standardcrypto.vc -> www.standardvc.com, the
// "Standard Crypto" -> "Standard" rebrand; 1confirmation/thrivecap/ribbitcap
// apex -> www; sequoiacap www -> apex).
export const NEIGHBORS = [
  { name: "Paradigm",                url: "https://www.paradigm.xyz/" },
  { name: "a16z crypto",             url: "https://a16zcrypto.com/" },
  { name: "Polychain Capital",       url: "https://polychain.capital/" },
  { name: "Multicoin Capital",       url: "https://multicoin.capital/" },
  { name: "Variant Fund",            url: "https://variant.fund/" },
  { name: "Dragonfly",               url: "https://www.dragonfly.xyz/" },
  { name: "Electric Capital",        url: "https://www.electriccapital.com/" },
  { name: "1confirmation",           url: "https://www.1confirmation.com/" },
  { name: "Standard",                url: "https://www.standardvc.com/" },
  { name: "Union Square Ventures",   url: "https://www.usv.com/" },
  { name: "Archetype",               url: "https://www.archetype.fund/" },
  { name: "Pace Capital",            url: "https://pacecapital.com/" },
  { name: "Thrive Capital",          url: "https://www.thrivecap.com/" },
  { name: "Sequoia Capital",         url: "https://sequoiacap.com/" },
  { name: "Founders Fund",           url: "https://foundersfund.com/" },
  { name: "Hummingbird",             url: "https://www.hummingbird.vc/" },
  { name: "Benchmark",               url: "https://www.benchmark.com/" },
  { name: "Index Ventures",          url: "https://www.indexventures.com/" },
  { name: "Ribbit Capital",          url: "https://www.ribbitcap.com/" },
  { name: "Topology",                url: "https://www.topology.vc/" },
];

// ── /around ─────────────────────────────────────────────────────────
// what's going on in the crypto-VC neighborhood, as of the last CRON crawl.
// The request path only READS the snapshot: no visitor, crawler, or speculative
// prerender can make this site fetch 20 third-party homepages, which is what
// lets /around join the prerender set with every other page. The crawl runs on
// the schedule in wrangler.jsonc (cronAround, via index.js's scheduled handler).
export async function handleAround(request, env, ctx) {
  const url = new URL(request.url);
  // ?bust=SECRET is the owner's force-refresh (it re-crawls inside
  // readAroundReport), so it must skip the edge cache. Every other visit serves
  // the version-keyed caches.default copy and never touches KV; the TTL is the
  // response's own s-maxage=300 (renderAroundHtml). The crawl runs on cron.
  const isBust = env.RN_BUST_SECRET && url.searchParams.get("bust") === env.RN_BUST_SECRET;
  const render = async () => renderAroundHtml(await readAroundReport(request, env));
  return isBust ? render() : cachedRender(request, ctx, render, "/around", env);
}

export async function handleAroundJson(request, env, ctx) {
  const url = new URL(request.url);
  const isBust = env.RN_BUST_SECRET && url.searchParams.get("bust") === env.RN_BUST_SECRET;
  const render = async () => {
    const report = await readAroundReport(request, env);
    if (!report) {
      // 503 pending is never cached (cachedRender only stores 200) — a snapshot
      // that appears next cron won't be shadowed by a pinned "pending".
      return new Response(JSON.stringify({ pending: true, note: "no snapshot yet; the daily crawl hasn't run" }), {
        status: 503,
        // retry-after tracks the crawl cadence, which became daily on 2026-08-14.
        // Only reachable before the first successful crawl ever: after that a
        // snapshot exists and an all-error crawl deliberately will not clear it.
        headers: { "content-type": "application/json; charset=utf-8", "retry-after": "86400", "x-robots-tag": "noindex" },
      });
    }
    return new Response(JSON.stringify(report, null, 2), {
      headers: {
        "content-type":  "application/json; charset=utf-8",
        "cache-control": "public, max-age=60, s-maxage=300",
        "x-robots-tag":  "noindex",
      },
    });
  };
  return isBust ? render() : cachedRender(request, ctx, render, "/around/json", env);
}

const AROUND_KEY = "around:report";
const AROUND_HISTORY_TABLE = "around_crawl_history";

// D1's exec() SPLITS ITS INPUT ON NEWLINES and runs each line as a statement,
// so it can only ever take one-line statements. This used to hand it a
// multi-line CREATE TABLE plus two CREATE INDEXes as one string, which fails on
// the first line with `D1_EXEC_ERROR: Error in line 1: CREATE TABLE IF NOT
// EXISTS around_crawl_history (: incomplete input`. The table was therefore
// NEVER created in production, and persistAroundHistory's catch turned that
// into a returned reason nobody read: from 2026-08-18 until 2026-08-28 every
// daily crawl published its KV snapshot and wrote zero history rows, while
// /around/changes.json reported "change history starts with the next scheduled
// crawl" rather than "the table does not exist".
//
// Measured against a local D1 before the repair, with both controls: exec() of
// a SINGLE-LINE statement succeeds (`{count:1}`), and exec() of TWO single-line
// statements succeeds reporting `{count:2}`, which is the line-splitting shown
// directly rather than inferred from the failure.
//
// batch() rather than a prepare().run() loop (webmention.ts's ensureTable has
// one statement and so faces no choice): it is one round trip, it is atomic, so
// the table can never be visible without its indexes, and persistAroundHistory
// below already batches its inserts.
const AROUND_HISTORY_DDL = [
  `CREATE TABLE IF NOT EXISTS ${AROUND_HISTORY_TABLE} (
      target TEXT NOT NULL,
      name TEXT NOT NULL,
      observed_at INTEGER NOT NULL,
      status INTEGER,
      final_url TEXT,
      title TEXT,
      description TEXT,
      content_type TEXT,
      server TEXT,
      last_modified TEXT,
      body_hash TEXT,
      bytes_read INTEGER,
      truncated INTEGER NOT NULL DEFAULT 0,
      robots TEXT,
      skipped TEXT,
      error TEXT,
      PRIMARY KEY (target, observed_at)
    )`,
  `CREATE INDEX IF NOT EXISTS idx_around_crawl_history_time
      ON ${AROUND_HISTORY_TABLE} (observed_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_around_crawl_history_target_time
      ON ${AROUND_HISTORY_TABLE} (target, observed_at DESC)`,
];

async function ensureAroundHistoryTable(env) {
  if (!env.RESTORE_DB) return false;
  await env.RESTORE_DB.batch(AROUND_HISTORY_DDL.map((sql) => env.RESTORE_DB.prepare(sql)));
  return true;
}

// Persist only normalized observations and the digest of the bounded body
// sample. The raw third-party response never enters D1.
export async function persistAroundHistory(env, report) {
  if (!env.RESTORE_DB || !report || !Array.isArray(report.results)) return { ok: false, reason: "unconfigured" };
  try {
    await ensureAroundHistoryTable(env);
    const observedAt = Date.parse(report.crawledAt) || Date.now();
    const statements = report.results.map((row) => env.RESTORE_DB.prepare(
      `INSERT OR REPLACE INTO ${AROUND_HISTORY_TABLE}
       (target, name, observed_at, status, final_url, title, description, content_type,
        server, last_modified, body_hash, bytes_read, truncated, robots, skipped, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      row.url || "",
      row.name || "",
      observedAt,
      row.status ?? null,
      row.finalUrl || null,
      row.title || null,
      row.description || null,
      row.contentType || null,
      row.server || null,
      row.lastModified || null,
      row.bodyHash || null,
      row.bytesRead ?? null,
      row.truncated ? 1 : 0,
      row.robots || null,
      row.skipped || null,
      row.error || null,
    ));
    if (statements.length) await env.RESTORE_DB.batch(statements);
    // Keep the history explainable without letting a frequent cron grow D1
    // forever. The public reader still uses a small recent window.
    await env.RESTORE_DB.prepare(
      `DELETE FROM ${AROUND_HISTORY_TABLE} WHERE observed_at < ?`
    ).bind(Date.now() - 90 * 24 * 60 * 60 * 1000).run();
    return { ok: true, written: statements.length };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

const CHANGE_FIELDS = [
  ["status", "status"],
  ["final_url", "final_url"],
  ["title", "title"],
  ["description", "description"],
  ["content_type", "content_type"],
  ["robots", "robots"],
  ["skipped", "skipped"],
  ["error", "error"],
];

function changeSeverity(changes, current) {
  if (changes.some((change) => change.field === "status" || change.field === "error")) return "high";
  if (changes.some((change) => ["content", "title", "description", "final_url"].includes(change.field))) return "medium";
  if (changes.some((change) => ["robots", "skipped"].includes(change.field))) return "medium";
  return current?.truncated ? "medium" : "low";
}

export function diffAroundRows(current, previous) {
  if (!current || !previous) return [];
  const changes = [];
  for (const [field, key] of CHANGE_FIELDS) {
    const before = previous[key] ?? null;
    const after = current[key] ?? null;
    if (before !== after) changes.push({ field, before, after });
  }
  const liveCurrent = !current.error && current.status >= 200 && current.status < 400;
  const livePrevious = !previous.error && previous.status >= 200 && previous.status < 400;
  if (liveCurrent && livePrevious && current.body_hash && previous.body_hash && current.body_hash !== previous.body_hash) {
    changes.push({ field: "content", detail: "bounded response sample changed" });
  }
  return changes;
}
// requestedLimit takes whatever a query string hands over, which is why the
// body coerces with `Number(x) || 50`. The annotation says so; the default
// alone would have tsc infer number and reject its only caller.
export async function readAroundChanges(env, requestedLimit: string | number | null = 50) {
  const limit = Math.min(100, Math.max(1, Number(requestedLimit) || 50));
  if (!env.RESTORE_DB) {
    return { ok: true, available: false, changes: [], note: "change history is not configured on this deployment" };
  }
  let rows;
  try {
    // The latest 200 rows cover several complete 30-minute snapshots for the
    // current shortlist without making the public request scan the whole table.
    const result = await env.RESTORE_DB.prepare(
      `SELECT target, name, observed_at, status, final_url, title, description,
              content_type, body_hash, robots, skipped, error
         FROM ${AROUND_HISTORY_TABLE}
        ORDER BY observed_at DESC
        LIMIT 200`
    ).all();
    rows = result.results || [];
  } catch (e) {
    // Before the first cron run the lazy table does not exist yet. That is a
    // valid empty state, not a broken public endpoint.
    if (/no such table|does not exist/i.test(String(e?.message || e))) {
      return { ok: true, available: true, changes: [], note: "change history starts with the next scheduled crawl" };
    }
    throw e;
  }

  const byTarget = new Map();
  for (const row of rows) {
    const list = byTarget.getOrInsertComputed(row.target, () => []);
    if (list.length < 2) list.push(row);
  }
  const changes = [];
  let latestObservedAt = 0;
  for (const [target, list] of byTarget) {
    if (list[0]) latestObservedAt = Math.max(latestObservedAt, Number(list[0].observed_at) || 0);
    if (list.length < 2) continue;
    const current = list[0];
    const previous = list[1];
    const fields = diffAroundRows(current, previous);
    if (!fields.length) continue;
    changes.push({
      target,
      name: current.name,
      observedAt: new Date(current.observed_at).toISOString(),
      previousObservedAt: new Date(previous.observed_at).toISOString(),
      ageMs: Math.max(0, Date.now() - Number(current.observed_at || Date.now())),
      severity: changeSeverity(fields, current),
      changes: fields,
    });
  }
  changes.sort((a, b) => String(b.observedAt).localeCompare(String(a.observedAt)));
  return {
    ok: true,
    available: true,
    latestObservedAt: latestObservedAt ? new Date(latestObservedAt).toISOString() : null,
    targetCount: byTarget.size,
    changes: changes.slice(0, limit),
  };
}

export async function handleAroundChangesJson(request, env) {
  const url = new URL(request.url);
  try {
    const payload = await readAroundChanges(env, url.searchParams.get("limit"));
    return jsonResponse(payload, 200, {
      "cache-control": "public, max-age=60, s-maxage=300",
      "x-robots-tag": "noindex",
    });
  } catch (e) {
    return jsonResponse({ ok: false, available: false, changes: [], error: String(e?.message || e) }, 503, {
      "cache-control": "public, max-age=30, must-revalidate",
      "x-robots-tag": "noindex",
    });
  }
}

// cron entry: crawl the neighborhood and persist the snapshot. Runs on the DAILY
// outbound tick (41 5) alongside the webmention pass, not on a schedule of its
// own; see lib/cron.js for why the two share one, and wrangler.jsonc for why the
// crawl may never move back onto the request path.
//
// A crawl where EVERY neighbor errored stores nothing, so the last good snapshot
// keeps serving.
// (results.length is always NEIGHBORS.length — one row per neighbor, success or
// error — so the old length>0 guard never fired; check for a non-error row.)
export async function cronAround(env) {
  const report = await runAround(env);
  // the snapshot write is conditional: an all-error crawl deliberately does NOT
  // overwrite the last-good snapshot. Worth recording, because "the page still
  // shows last week" is then a fact about this branch rather than a mystery.
  const publishable = !!(report && Array.isArray(report.results) && report.results.some(r => !r.error) && env.RN_KV);
  if (publishable) {
    await span("around.publish", () => env.RN_KV.put(AROUND_KEY, JSON.stringify(report)));
  }
  // The result is READ rather than returned into the void. persistAroundHistory
  // catches everything so a history failure cannot cost the crawl, and for ten
  // days that catch was the whole reason a broken CREATE TABLE was invisible: it
  // handed back {ok:false, reason} and the only caller dropped it. A cron has no
  // response and no visitor to complain, so the span is the one place the answer
  // can land. `unconfigured` is a legitimate state (no RESTORE_DB, which is every
  // local dev run) and is reported as itself rather than as a failure.
  await span("around.persist_history", async (s) => {
    s.setAttribute("around.snapshot_published", publishable);
    const out = await persistAroundHistory(env, report);
    const unconfigured = !out.ok && out.reason === "unconfigured";
    s.setAttribute("around.outcome", out.ok ? "persisted" : unconfigured ? "unconfigured" : "persist_failed");
    if (out.ok) s.setAttribute("around.history_written", out.written);
    else if (!unconfigured) s.setAttribute("around.error", out.reason);
    return out;
  });
}

async function readAroundReport(request, env) {
  // ?bust=SECRET stays as the owner's force-refresh: the one request-path caller
  // still allowed to crawl, because it authenticates as the owner.
  const url = new URL(request.url);
  if (env.RN_BUST_SECRET && url.searchParams.get("bust") === env.RN_BUST_SECRET) {
    await deleteSWRKV(env, AROUND_KEY);   // this key is written directly above, never by swrKV
    const report = await runAround(env);
    if (report && report.results && report.results.some(r => !r.error) && env.RN_KV) {
      await env.RN_KV.put(AROUND_KEY, JSON.stringify(report));
    }
    return report;
  }
  // cacheTtl 1800: cronAround rewrites this key once a DAY, so half an hour is 2%
  // of the snapshot's own cadence and the page already says "as of the last cron
  // crawl". It has to exceed 300 to buy anything at all, because /around and
  // /around/json both sit behind cachedRender at s-maxage=300 and this read only
  // runs on an edge miss, so a shorter window would expire alongside the render it
  // was meant to skip ahead of. The owner's ?bust= still renders from its own fresh
  // crawl rather than from KV, so the person who ran it is never the one reading
  // stale; other colos catch up as their own cacheTtl lapses.
  try {
    const report = env.RN_KV ? await env.RN_KV.get(AROUND_KEY, { type: "json", cacheTtl: 1800 }) : null;
    return report && Array.isArray(report.results) ? report : null;
  } catch { return null; }
}

// Traced per neighbor, with a rollup on the parent. This is the job where
// tracing earns the most, because every degradation mode here is DESIGNED to be
// quiet: a disallowing robots.txt is a legitimate skipped row, and an
// unreachable one is deliberately recorded as an error precisely so it does NOT
// overwrite the last-good snapshot. Both are correct, and both mean a neighbor
// that has silently stopped being crawled looks identical to one that is fine
// until somebody reads the JSON row by row. The rollup (`around.crawled` /
// `.skipped` / `.errored`) makes "twenty neighbors, three of them dark for a
// month" a number on one span.
export async function runAround(env) {
  return span("around.crawl", (s) => runAroundInner(env, s), { "around.neighbors": NEIGHBORS.length });
}

async function runAroundInner(env, sCrawl) {
  // Four concurrent origins matches the census worker's bounded fan-out and
  // avoids turning one cron tick into a burst against twenty sites.
  const results = await mapWithConcurrency(NEIGHBORS, 4, async ({ name, url }) => span(
    "around.neighbor",
    async (s) => {
    s.setAttribute("around.name", name);
    s.setAttribute("around.host", (() => { try { return new URL(url).hostname; } catch { return undefined; } })());
    const t0 = Date.now();
    // honor robots.txt first. A disallow is a legitimate result (skipped row, no
    // error); an undetermined robots.txt is recorded as an error so a network-wide
    // outage can't overwrite the last-good snapshot with an all-skipped one.
    const gate = await span("around.robots_gate", () => robotsGate(env, url));
    if (gate.kind === "disallow") {
      s.setAttribute("around.outcome", "robots_disallow");
      s.setAttribute("around.robots_rule", gate.rule);
      return { name, url, skipped: "robots", robots: "disallow", robotsRule: gate.rule, elapsedMs: Date.now() - t0 };
    }
    if (gate.kind === "undetermined") {
      // the reason string ("robots.txt 503", "robots.txt unreachable") is the
      // whole diagnosis and it has been going into a JSON field nobody reads.
      s.setAttribute("around.outcome", "robots_undetermined");
      s.setAttribute("around.reason", gate.reason);
      return { name, url, robots: "undetermined", error: gate.reason + ", not crawled", elapsedMs: Date.now() - t0 };
    }
    try {
      // The kernel owns the deadline, stream cap, digest, and normalized signals.
      const crawl = await crawlDocument(url, env, { timeoutMs: 4000, maxBytes: 200 * 1024 });
      s.setAttribute("around.outcome", "crawled");
      s.setAttribute("http.response.status_code", crawl.status);
      s.setAttribute("around.bytes_read", crawl.bytesRead);
      s.setAttribute("around.truncated", crawl.truncated);
      return {
        name, url,
        finalUrl:      crawl.finalUrl,
        status:        crawl.status,
        title:         crawl.title,
        description:   crawl.description,
        ogImage:       extractMeta(crawl.text, "og:image") || "",
        server:        crawl.server,
        lastModified:  crawl.lastModified,
        contentType:   crawl.contentType,
        bodyHash:      crawl.bodyHash,
        bytesRead:     crawl.bytesRead,
        truncated:     crawl.truncated,
        robots:        "allow",
        elapsedMs:     crawl.elapsedMs,
      };
    } catch (e) {
      s.setAttribute("around.outcome", "error");
      s.setAttribute("around.error", String(e?.message || e));
      return { name, url, robots: "allow", error: String(e?.message || e), elapsedMs: Date.now() - t0 };
    }
    },
  ));
  // sort fastest → slowest; errors (no latency or huge values) fall to the
  // bottom so the table reads as a leaderboard.
  results.sort((a, b) => {
    const an = (a.error || a.skipped) ? Infinity : (a.elapsedMs ?? Infinity);
    const bn = (b.error || b.skipped) ? Infinity : (b.elapsedMs ?? Infinity);
    return an - bn;
  });
  // the rollup: the one line that turns twenty quiet rows into a health signal.
  sCrawl.setAttribute("around.crawled", results.filter((r) => !r.error && !r.skipped).length);
  sCrawl.setAttribute("around.skipped", results.filter((r) => r.skipped).length);
  sCrawl.setAttribute("around.errored", results.filter((r) => r.error).length);
  return {
    crawledBy: BOT_UA,
    crawledAt: new Date().toISOString(),
    signedWith: SIG_AGENT,
    count:     results.length,
    results,
  };
}

export function renderAroundHtml(report) {
  // failure honesty: no snapshot means a greyed, period-correct empty panel,
  // never a fabricated table. only ever visible before the first cron run
  // (or after an owner bust that failed to rebuild).
  if (!report) {
    return lunaPage({
      title: "aadhar.sh/around",
      path: "aadhar.sh/around",
      route: "/around",
      width: 820,
      description: "Snapshot of crypto VC homepages I keep tabs on, crawled by AadharshBot on a schedule.",
      robots: "noindex",
      css: `.pending { border: 1px solid oklch(61.14% 0.0611 253.60); background: oklch(96.72% 0 0);
        color: oklch(51.03% 0 0); padding: 18px 16px; margin: 16px 0; cursor: progress; }`,
      body: unsafeHtml(`
    <h1 style="font-family:'Trebuchet MS',Verdana,Geneva,sans-serif;color:oklch(41.92% 0.0962 250.51);font-size:18pt;margin:0 0 4px">Around the Neighborhood</h1>
    <div class="pending"><b>The neighborhood snapshot isn't built yet.</b><br>
    The crawl runs on a schedule, not on your visit; check back in a few minutes.</div>
    <footer style="text-align:center;font-size:9pt;margin-top:14px">&larr; <a href="/">aadhar.sh</a></footer>`),
      cache: "public, max-age=60",
      headers: { "x-robots-tag": "noindex" },
    });
  }

  const rows = report.results.map((r, i) => {
    const skipped = r.skipped === "robots";
    const ok = !r.error && !skipped && r.status >= 200 && r.status < 400;
    const status = r.error
      ? `<span class="bad">error</span>`
      : skipped
        ? `<span class="dim" title="robots.txt disallows AadharshBot on this path">robots</span>`
        : ok
          ? `<span class="ok">${r.status}</span>`
          : `<span class="warn">${r.status}</span>`;
    const titleCol = r.error
      ? esc(r.error)
      : skipped
        ? `<span class=dim>not crawled (${esc(r.robotsRule || "robots.txt")})</span>`
        : (esc(r.title) || "<span class=dim>—</span>");
    const desc = r.description ? `<div class="desc">${esc(r.description)}</div>` : "";
    return `
      <tr>
        <td class="firm">${esc(r.name)}<div class="host">${esc(new URL(r.url).host)}</div></td>
        <td class="status">${status}</td>
        <td class="title">${titleCol}${desc}</td>
        <td class="latency">${r.elapsedMs}ms</td>
        <td class="link"><a href="${esc(r.url)}" target="_blank" rel="noopener">↗</a></td>
      </tr>`;
  }).join("");

  return lunaPage({
    title: "aadhar.sh/around",
    path: "aadhar.sh/around",
      route: "/around",
    width: 820,
    description: "Snapshot of crypto VC homepages I keep tabs on, crawled live by AadharshBot.",
    robots: "noindex",
    css: `
  h1 {
    font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; color: oklch(41.92% 0.0962 250.51);
    font-size: 18pt; margin: 0 0 4px; font-weight: bold;
  }
  .lede { margin: 0 0 14px; color: oklch(38.67% 0 0); font-size: 10.5pt; }
  .lede code { font-family: "Courier New", Courier, monospace; background: oklch(96.72% 0 0); border: 1px solid oklch(88.22% 0 0); padding: 0 3px; font-size: 10pt; }
  table.scout {
    width: 100%; border-collapse: collapse; margin: 8px 0 12px;
    border: 1px solid oklch(61.14% 0.0611 253.60); border-top-color: oklch(47.12% 0.0555 253.58); border-left-color: oklch(47.12% 0.0555 253.58);
    background: oklch(100.00% 0 0); font-size: 10pt;
  }
  table.scout thead th {
    background: oklch(94.66% 0.0114 252.09); color: oklch(41.92% 0.0962 250.51); font-weight: bold;
    padding: 5px 8px; text-align: left;
    border-bottom: 1px solid oklch(61.14% 0.0611 253.60);
    font-family: "Trebuchet MS", Verdana, Geneva, sans-serif;
  }
  table.scout tbody td { padding: 6px 8px; border-bottom: 1px solid oklch(92.73% 0.0139 247.98); vertical-align: top; }
  table.scout tbody tr:nth-child(even) td { background: oklch(97.50% 0.0062 255.47); }
  table.scout .firm { font-weight: bold; color: oklch(41.92% 0.0962 250.51); width: 22%; }
  table.scout .host { font-family: "Courier New", Courier, monospace; color: oklch(62.68% 0 0); font-size: 9pt; font-weight: normal; }
  table.scout .status { font-family: "Courier New", Courier, monospace; width: 8%; text-align: center; }
  table.scout .ok   { color: oklch(49.32% 0.1678 142.50); font-weight: bold; }
  table.scout .warn { color: oklch(54.44% 0.1504 47.10); font-weight: bold; }
  table.scout .bad  { color: oklch(46.34% 0.1902 29.23); font-weight: bold; }
  table.scout .title { color: oklch(21.78% 0 0); }
  table.scout .desc { color: oklch(51.03% 0 0); font-size: 9.5pt; margin-top: 3px; }
  table.scout .latency { font-family: "Courier New", Courier, monospace; color: oklch(38.67% 0 0); width: 9%; text-align: right; }
  table.scout .link { width: 5%; text-align: center; }
  table.scout .link a { color: oklch(42.61% 0.2353 263.74); text-decoration: none; font-weight: bold; }
  table.scout .link a:hover { color: oklch(62.80% 0.2577 29.23); text-decoration: underline; }
  .meta {
    font-size: 9.5pt; color: oklch(51.03% 0 0);
    border: 1px solid oklch(61.14% 0.0611 253.60); background: oklch(98.81% 0.0263 99.90);
    padding: 6px 10px; margin: 12px 0;
  }
  .meta code { font-family: "Courier New", Courier, monospace; background: oklch(100.00% 0 0); border: 1px solid oklch(89.75% 0 0); padding: 0 3px; }
  footer { text-align: center; font-size: 9pt; color: oklch(44.95% 0 0); margin-top: 14px; padding-top: 10px; border-top: 1px solid oklch(86.67% 0.0294 259.59); }
  a { color: oklch(42.61% 0.2353 263.74); }
  .dim { color: oklch(62.68% 0 0); }
  hr { border: 0; border-top: 2px groove oklch(86.67% 0.0294 259.59); margin: 12px 0; height: 0; }
`,
    body: unsafeHtml(`
    <h1>Around the Neighborhood</h1>
    <p class="lede">
      A peek at what folks in crypto VC are up to. <code>${esc(BOT_UA)}</code>, the
      small branded crawler I run from this site, crawls each homepage on a
      schedule and lays the snapshot out as a tiny neighborhood window. I built
      this mostly to play with signed outbound requests per
      <a href="https://datatracker.ietf.org/wg/webbotauth/about/" target="_blank" rel="noopener">Web Bot Auth</a>;
      the shortlist is funds whose work I follow. Receiving sites can
      verify the signatures against
      <a href="/.well-known/http-message-signatures-directory">our JWKS</a>. Each
      request carries two: Ed25519, and a provisional post-quantum ML-DSA-44
      second label (<a href="/garage/pqc">why</a>).
    </p>
    <div class="meta">
      <strong>Last crawl:</strong> ${esc(report.crawledAt)} &middot;
      <strong>UA:</strong> <code>${esc(BOT_UA)}</code> &middot;
      <strong>Signature-Agent:</strong> <code>${esc(SIG_AGENT)}</code> &middot;
      <strong>Refreshed:</strong> every 30 min by cron (your visit triggers nothing)
    </div>
    <table class="scout">
      <thead>
        <tr><th>Firm</th><th>Status</th><th>Title / description</th><th>Latency</th><th>↗</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <hr>
    <p class="dim" style="font-size:9pt">
      Also available as JSON: <a href="/around/json">/around/json</a> &middot;
      Change Radar: <a href="/around/changes.json">/around/changes.json</a>.
      Bot methodology and ethics: <a href="/bot">/bot</a>.
    </p>
    <footer>
      &larr; <a href="/">aadhar.sh</a> &middot; crawled by <a href="/bot">${esc(BOT_NAME)}</a>
    </footer>
`),
    cache: "public, max-age=60, s-maxage=300",
    headers: { "x-robots-tag": "noindex" },
  });
}
