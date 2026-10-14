import { BOT_NAME, BOT_UA, SIG_AGENT, botRobotsPolicy, BotPolicyError } from "./lib/botauth.ts";
import { CHANGE_RADAR_LIMITS, clampParam } from "./lib/api-limits.ts";
import { cachedRender, deleteSWRKV, edgeKey, withWeakEtag } from "./lib/cache.ts";
import { crawlDocument, mapWithConcurrency } from "./lib/crawl.ts";
import { lunaPage } from "./lib/chrome.ts";
import { html, unsafeHtml } from "./lib/html.ts";
import { islandMount, islandPreload, islandResponse, islandScript } from "./lib/island.ts";
import { esc, extractMeta, jsonResponse, secretMatches } from "./lib/http.ts";
import { span } from "./lib/trace.ts";
import { AROUND_SNAPSHOT_URL } from "./routes.ts";

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

export async function handleAroundJson(request, env, ctx) {
  const url = new URL(request.url);
  const isBust = secretMatches(url.searchParams.get("bust"), env.RN_BUST_SECRET);
  const render = async () => {
    const report = await readAroundReport(request, env);
    if (!report) {
      return jsonResponse({ pending: true, note: "no snapshot yet; the daily crawl hasn't run" }, 503,
        { "retry-after": "86400", "x-robots-tag": "noindex" }, { pretty: false });
    }
    return jsonResponse(report, 200, {
      "cache-control": "public, max-age=60, s-maxage=300",
      "x-robots-tag":  "noindex",
    });
  };
  return isBust ? render() : cachedRender(request, ctx, render, "/around/json", env);
}

const AROUND_KEY = "around:report";
const AROUND_HISTORY_TABLE = "around_crawl_history";

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

export async function persistAroundHistory(env, report) {
  if (!env.RESTORE_DB || !report || !Array.isArray(report.results)) return { ok: false, reason: "unconfigured" };
  try {
    const db = env.RESTORE_DB;
    const observedAt = Date.parse(report.crawledAt) || Date.now();
    const inserts = report.results.map((row) => db.prepare(
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
    const retention = db.prepare(
      `DELETE FROM ${AROUND_HISTORY_TABLE} WHERE observed_at < ?`
    ).bind(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await db.batch([
      ...AROUND_HISTORY_DDL.map((sql) => db.prepare(sql)),
      ...inserts,
      retention,
    ]);
    return { ok: true, written: inserts.length };
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
export async function readAroundChanges(env, requestedLimit: string | number | null = CHANGE_RADAR_LIMITS.limitDefault) {
  const limit = clampParam(requestedLimit, CHANGE_RADAR_LIMITS.limitDefault, CHANGE_RADAR_LIMITS.limitMax);
  if (!env.RESTORE_DB) {
    return { ok: true, available: false, changes: [], note: "change history is not configured on this deployment" };
  }
  let rows;
  try {
    const result = await env.RESTORE_DB.prepare(
      `SELECT target, name, observed_at, status, final_url, title, description,
              content_type, body_hash, robots, skipped, error
         FROM ${AROUND_HISTORY_TABLE}
        ORDER BY observed_at DESC
        LIMIT 200`
    ).all();
    rows = result.results || [];
  } catch (e) {
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
    console.error("around/changes.json: history read failed", e);
    return jsonResponse({ ok: false, available: false, changes: [], error: "change history is temporarily unavailable" }, 503, {
      "cache-control": "public, max-age=30, must-revalidate",
      "x-robots-tag": "noindex",
    });
  }
}

export async function cronAround(env) {
  const report = await runAround(env);
  const publishable = !!(report && Array.isArray(report.results) && report.results.some(r => !r.error) && env.RN_KV);
  if (publishable) {
    await span("around.publish", () => env.RN_KV.put(AROUND_KEY, JSON.stringify(report)));
  }
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
  const url = new URL(request.url);
  if (secretMatches(url.searchParams.get("bust"), env.RN_BUST_SECRET)) {
    await deleteSWRKV(env, AROUND_KEY);
    const report = await runAround(env);
    if (report && report.results && report.results.some(r => !r.error) && env.RN_KV) {
      await env.RN_KV.put(AROUND_KEY, JSON.stringify(report));
    }
    return report;
  }
  try {
    const report = env.RN_KV ? await env.RN_KV.get(AROUND_KEY, { type: "json", cacheTtl: 1800 }) : null;
    return report && Array.isArray(report.results) ? report : null;
  } catch { return null; }
}

export async function runAround(env) {
  return span("around.crawl", (s) => runAroundInner(env, s), { "around.neighbors": NEIGHBORS.length });
}

async function runAroundInner(env, sCrawl) {
  const results = await mapWithConcurrency(NEIGHBORS, 4, async ({ name, url }) => span(
    "around.neighbor",
    async (s) => {
    s.setAttribute("around.name", name);
    s.setAttribute("around.host", (() => { try { return new URL(url).hostname; } catch { return undefined; } })());
    const t0 = Date.now();
    const gate = await span("around.robots_gate", () => botRobotsPolicy(url, env));
    if (!gate.ok && gate.kind === "disallow") {
      s.setAttribute("around.outcome", "robots_disallow");
      s.setAttribute("around.robots_rule", gate.rule);
      return { name, url, skipped: "robots", robots: "disallow", robotsRule: gate.rule, elapsedMs: Date.now() - t0 };
    }
    if (!gate.ok && gate.kind === "undetermined") {
      s.setAttribute("around.outcome", "robots_undetermined");
      s.setAttribute("around.reason", gate.reason);
      return { name, url, robots: "undetermined", error: gate.reason + ", not crawled", elapsedMs: Date.now() - t0 };
    }
    try {
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
      // Redirect destinations have their own robots policy too.
      if (e instanceof BotPolicyError) {
        const policy = e.policy;
        s.setAttribute("around.outcome", "robots_" + policy.kind);
        return policy.kind === "disallow"
          ? { name, url, skipped: "robots", robots: "disallow", robotsRule: policy.rule, elapsedMs: Date.now() - t0 }
          : { name, url, robots: "undetermined", error: e.message, elapsedMs: Date.now() - t0 };
      }
      s.setAttribute("around.outcome", "error");
      s.setAttribute("around.error", String(e?.message || e));
      return { name, url, robots: "allow", error: String(e?.message || e), elapsedMs: Date.now() - t0 };
    }
    },
  ));
  results.sort((a, b) => {
    const an = (a.error || a.skipped) ? Infinity : (a.elapsedMs ?? Infinity);
    const bn = (b.error || b.skipped) ? Infinity : (b.elapsedMs ?? Infinity);
    return an - bn;
  });
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

export const SNAPSHOT_URL = AROUND_SNAPSHOT_URL;

const PENDING_REPORT = { crawledAt: null, results: NEIGHBORS.map(() => null) };

const SNAPSHOT_CACHE = "public, max-age=60, s-maxage=300";

export function renderAroundSnapshot(report) {
  if (!report) {
    return unsafeHtml(`<div class="pending"><b>The neighborhood snapshot isn't built yet.</b><br>
    The crawl runs on a schedule, not on your visit; check back tomorrow.</div>`);
  }
  const pending = report.crawledAt === null;
  const dots = "…";

  const rows = report.results.map((r) => {
    if (pending) {
      return `
      <tr>
        <td class="firm">${dots}<div class="host">${dots}</div></td>
        <td class="status">${dots}</td>
        <td class="title">${dots}</td>
        <td class="latency">${dots}</td>
        <td class="link"></td>
      </tr>`;
    }
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

  return unsafeHtml(`<div class="meta">
      <strong>Last crawl:</strong> ${esc(report.crawledAt ?? dots)} &middot;
      <strong>UA:</strong> <code>${esc(BOT_UA)}</code> &middot;
      <strong>Signature-Agent:</strong> <code>${esc(SIG_AGENT)}</code> &middot;
      <strong>Refreshed:</strong> once a day by cron (your visit triggers nothing)
    </div>
    <table class="scout">
      <thead>
        <tr><th>Firm</th><th>Status</th><th>Title / description</th><th>Latency</th><th>↗</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`);
}

export async function refreshAroundSnapshot(request, env) {
  const url = new URL(request.url);
  if (!secretMatches(url.searchParams.get("bust"), env.RN_BUST_SECRET)) return null;
  const report = await readAroundReport(request, env);
  const fresh = islandResponse(renderAroundSnapshot(report), { "cache-control": report ? SNAPSHOT_CACHE : "public, max-age=60" });
  if (report) {
    try { await caches.default.put(edgeKey(url.origin, SNAPSHOT_URL, env), await withWeakEtag(fresh.clone())); } catch {}
  }
  return fresh;
}

export async function handleAroundSnapshot(request, env, ctx) {
  const busted = await refreshAroundSnapshot(request, env);
  if (busted) return busted;
  const render = async () => {
    const report = await readAroundReport(request, env);
    return islandResponse(renderAroundSnapshot(report), { "cache-control": report ? SNAPSHOT_CACHE : "public, max-age=60" });
  };
  return cachedRender(request, ctx, render, SNAPSHOT_URL, env);
}

export function renderAroundPage() {
  return lunaPage({
    title: "aadhar.sh/around",
    path: "aadhar.sh/around",
    route: "/around",
    width: 820,
    description: "Snapshot of crypto VC homepages I keep tabs on, crawled once a day by AadharshBot.",
    robots: "noindex",
    head: islandPreload(SNAPSHOT_URL),
    css: `/*min*/
  h1 { font-size: 18pt; }
  .lede { margin: 0 0 14px; color: var(--ink-soft); font-size: var(--text-body); }
  .lede code { font-family: var(--font-mono); background: oklch(96.72% 0 0); border: 1px solid var(--grey-88); padding: 0 3px; font-size: var(--text-ui); }
  table.scout {
    width: 100%; border-collapse: collapse; margin: 8px 0 12px;
    border: 1px solid var(--frame); border-top-color: var(--blue-45); border-left-color: var(--blue-45);
    background: oklch(100.00% 0 0); font-size: var(--text-ui);
  }
  table.scout thead th {
    background: var(--surface-desktop); color: var(--blue-40); font-weight: bold;
    padding: 5px 8px; text-align: left;
    border-bottom: 1px solid var(--frame);
    font-family: var(--font-caption);
  }
  table.scout tbody td { padding: 6px 8px; border-bottom: 1px solid var(--surface-desktop); vertical-align: top; }
  table.scout tbody tr:nth-child(even) td { background: var(--row-alt); }
  table.scout .firm { font-weight: bold; color: var(--blue-40); width: 22%; }
  table.scout .host { font-family: var(--font-mono); color: var(--ink-faint); font-size: var(--text-mono); font-weight: normal; }
  table.scout .status { font-family: var(--font-mono); width: 8%; text-align: center; }
  table.scout .ok   { color: oklch(49.32% 0.1678 142.50); font-weight: bold; }
  table.scout .warn { color: var(--warn); font-weight: bold; }
  table.scout .bad  { color: var(--danger-deep); font-weight: bold; }
  table.scout .title { color: var(--ink); }
  table.scout .desc { color: var(--ink-dim); font-size: var(--text-sm); margin-top: 3px; }
  table.scout .latency { font-family: var(--font-mono); color: var(--ink-soft); width: 9%; text-align: right; }
  table.scout .link { width: 5%; text-align: center; }
  table.scout .link a { color: var(--link); text-decoration: none; font-weight: bold; }
  table.scout .link a:hover { color: var(--link-hover); text-decoration: underline; }
  .meta {
    font-size: var(--text-sm); color: var(--ink-dim);
    border: 1px solid var(--frame); background: oklch(98.81% 0.0263 99.90);
    padding: 6px 10px; margin: 12px 0;
  }
  .meta code { font-family: var(--font-mono); background: oklch(100.00% 0 0); border: 1px solid var(--grey-88); padding: 0 3px; }
  footer { text-align: center; font-size: var(--text-xs); color: var(--ink-quiet); margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--rule); }
  a { color: var(--link); }
  .dim { color: var(--ink-faint); }
  hr { border: 0; border-top: 2px groove var(--rule); margin: 12px 0; height: 0; }
  .pending { border: 1px solid var(--frame); background: oklch(96.72% 0 0);
    color: var(--ink-dim); padding: 18px 16px; margin: 16px 0; cursor: progress; }
  /* the island's failure note, shown only if the snapshot request failed */
  .ar-fail { display: none; color: var(--ink-faint); font-size: var(--text-xs); margin: 0 0 12px; }
  #ar-snapshot[data-state="failed"] + .ar-fail { display: block; }
`,
    body: html`
    <h1>Around the Neighborhood</h1>
    <p class="lede">
      A peek at what folks in crypto VC are up to. <code>${BOT_UA}</code>, the
      small branded crawler I run from this site, crawls each homepage on a
      schedule and lays the snapshot out as a tiny neighborhood window. I built
      this mostly to play with signed outbound requests per
      <a href="https://datatracker.ietf.org/wg/webbotauth/about/" target="_blank" rel="noopener">Web Bot Auth</a>;
      the shortlist is funds whose work I follow. Receiving sites can
      verify the signatures against
      <a href="/.well-known/http-message-signatures-directory">our JWKS</a>. Each
      request carries two: Ed25519, and a post-quantum ML-DSA-44 second label
      (<a href="/garage/pqc">why</a>).
    </p>
    ${islandMount("ar-snapshot", SNAPSHOT_URL, renderAroundSnapshot(PENDING_REPORT), html`<p>The crawl arrives in a second request after the page loads, and that needs a script. Without one, <a href="${SNAPSHOT_URL}">${SNAPSHOT_URL}</a> shows it as plain HTML, and <a href="/around/json">/around/json</a> as JSON.</p>`)}
    <p class="ar-fail">The request for the snapshot failed, so the table stays empty rather than guessed. <a href="${SNAPSHOT_URL}">${SNAPSHOT_URL}</a> has it as plain HTML.</p>
    <hr>
    <p class="dim" style="font-size:var(--text-xs)">
      Also available as JSON: <a href="/around/json">/around/json</a> &middot;
      Change Radar: <a href="/around/changes.json">/around/changes.json</a>.
      Bot methodology and ethics: <a href="/bot">/bot</a>.
    </p>
    <footer>
      &larr; <a href="/">aadhar.sh</a> &middot; crawled by <a href="/bot">${BOT_NAME}</a>
    </footer>
`,
    scripts: islandScript(),
  });
}
