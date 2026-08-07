import { json, withRenderedHeaders } from "./http";

type JsonRecord = Record<string, unknown>;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function dateLabel(value: unknown): string {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.valueOf())
    ? "Undated"
    : date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

async function kvJson<T>(env: Env, key: string): Promise<T | null> {
  try { return await env.RN_KV.get<T>(key, "json"); }
  catch { return null; }
}

function readingHtml(payload: JsonRecord | null): string | null {
  const items = Array.isArray(payload?.items) ? payload.items as JsonRecord[] : [];
  if (!items.length) return null;
  const groups = new Map<string, JsonRecord[]>();
  for (const item of items) {
    const key = dateLabel(item.created).replace(/^\d+ /, "");
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups].map(([label, rows]) => `<section class="live-group"><h2>${escapeHtml(label)}</h2>${rows.map((item) => {
    const highlights = Array.isArray(item.highlights) ? item.highlights.slice(0, 3) : [];
    return `<article class="live-item"><h3><a href="${escapeHtml(item.link)}" rel="external noopener">${escapeHtml(item.title || item.link)}</a></h3><p class="live-meta">${escapeHtml(item.domain)} · ${escapeHtml(dateLabel(item.created))}${item.favorite ? " · Favorite" : ""}</p>${item.snippet ? `<p>${escapeHtml(item.snippet)}</p>` : ""}${highlights.map((highlight) => `<blockquote>${escapeHtml(highlight)}</blockquote>`).join("")}</article>`;
  }).join("")}</section>`).join("");
}

export async function readingResponse(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const html = readingHtml(await kvJson<JsonRecord>(env, "curius:links"));
  const transformed = html
    ? new HTMLRewriter().on("#reading-list", { element(element) { element.setInnerContent(html, { html: true }); } }).transform(response)
    : response;
  return withRenderedHeaders(transformed, request);
}

function aroundHtml(report: JsonRecord | null): string | null {
  const results = Array.isArray(report?.results) ? report.results as JsonRecord[] : [];
  if (!results.length) return null;
  return `<div class="status-grid">${results.map((row) => {
    const okay = !row.error && Number(row.status) >= 200 && Number(row.status) < 400;
    return `<article class="status-card"><h2><a href="${escapeHtml(row.finalUrl || row.url)}" rel="external noopener">${escapeHtml(row.name || row.url)}</a></h2><dl><dt>HTTP</dt><dd>${escapeHtml(row.status || "unavailable")}</dd><dt>State</dt><dd>${okay ? "reachable" : escapeHtml(row.skipped || row.error || "unavailable")}</dd>${row.title ? `<dt>Title</dt><dd>${escapeHtml(row.title)}</dd>` : ""}${row.robots ? `<dt>Robots</dt><dd>${escapeHtml(row.robots)}</dd>` : ""}</dl></article>`;
  }).join("")}</div>`;
}

export async function aroundResponse(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const html = aroundHtml(await kvJson<JsonRecord>(env, "around:report"));
  const transformed = html
    ? new HTMLRewriter().on("#around-report", { element(element) { element.setInnerContent(html, { html: true }); } }).transform(response)
    : response;
  return withRenderedHeaders(transformed, request);
}

export async function aroundJson(env: Env): Promise<Response> {
  const report = await kvJson<JsonRecord>(env, "around:report");
  return json(report ?? { pending: true, note: "no snapshot yet; the scheduled crawl has not run" }, {
    status: report ? 200 : 503,
    headers: { "cache-control": report ? "public, max-age=60, s-maxage=300" : "no-store", "x-robots-tag": "noindex" },
  });
}

export async function aroundChanges(env: Env, limitValue: string | null): Promise<Response> {
  const limit = Math.min(100, Math.max(1, Number(limitValue) || 50));
  try {
    const result = await env.RESTORE_DB.prepare(
      `SELECT target, name, observed_at, status, final_url, title, description, content_type, body_hash, robots, skipped, error
       FROM around_crawl_history ORDER BY observed_at DESC LIMIT 200`,
    ).all<JsonRecord>();
    const pairs = new Map<string, JsonRecord[]>();
    for (const row of result.results) {
      const key = String(row.target ?? "");
      const rows = pairs.get(key) ?? [];
      if (rows.length < 2) rows.push(row);
      pairs.set(key, rows);
    }
    const changes = [...pairs].flatMap(([target, rows]) => {
      if (rows.length < 2) return [];
      const fields = ["status", "final_url", "title", "description", "content_type", "body_hash", "robots", "skipped", "error"]
        .filter((field) => rows[0][field] !== rows[1][field])
        .map((field) => ({ field, before: rows[1][field] ?? null, after: rows[0][field] ?? null }));
      return fields.length ? [{ target, name: rows[0].name, observedAt: new Date(Number(rows[0].observed_at)).toISOString(), changes: fields }] : [];
    });
    return json({ ok: true, available: true, changes: changes.slice(0, limit) }, { headers: { "cache-control": "public, max-age=60, s-maxage=300", "x-robots-tag": "noindex" } });
  } catch (error) {
    if (/no such table|does not exist/i.test(String(error))) {
      return json({ ok: true, available: true, changes: [], note: "change history starts with the next scheduled crawl" });
    }
    return json({ ok: false, available: false, changes: [], error: "change history unavailable" }, { status: 503 });
  }
}

const crawlers = [
  ["oai-searchbot", "OAI-SearchBot", "OpenAI", "answers"], ["chatgpt-user", "ChatGPT-User", "OpenAI", "answers"],
  ["gptbot", "GPTBot", "OpenAI", "train"], ["claude-searchbot", "Claude-SearchBot", "Anthropic", "answers"],
  ["claude-user", "Claude-User", "Anthropic", "answers"], ["claudebot", "ClaudeBot", "Anthropic", "train"],
  ["perplexitybot", "PerplexityBot", "Perplexity", "answers"], ["ccbot", "CCBot", "Common Crawl", "train"],
  ["bytespider", "Bytespider", "ByteDance", "train"], ["amazonbot", "Amazonbot", "Amazon", "train"],
  ["meta-externalagent", "Meta-ExternalAgent", "Meta", "train"], ["applebot", "Applebot", "Apple", "search"],
  ["googlebot", "Googlebot", "Google", "search"], ["bingbot", "Bingbot", "Microsoft", "search"],
] as const;

export function countCrawler(env: Env, request: Request, response: Response, ctx: ExecutionContext): void {
  if (response.status >= 400) return;
  const ua = (request.headers.get("user-agent") ?? "").toLowerCase();
  const crawler = crawlers.find(([needle]) => ua.includes(needle));
  if (!crawler) return;
  const [, name, owner, kind] = crawler;
  ctx.waitUntil(Promise.resolve().then(() => env.BOT_LEDGER.writeDataPoint({ blobs: [name, owner, kind, new URL(request.url).pathname.slice(0, 96)], doubles: [1], indexes: [name] })).catch(() => undefined));
}

type Secrets = { ANALYTICS_READ_TOKEN?: string };

async function ledgerPayload(env: Env): Promise<JsonRecord> {
  const token = (env as Env & Secrets).ANALYTICS_READ_TOKEN;
  if (!token) return { ok: false, reason: "unconfigured", window_days: 30, rate_usd: 0.01, line_items: [], total_hits: 0, total_usd: 0 };
  const query = "SELECT blob1 AS bot, blob2 AS owner, blob3 AS kind, SUM(_sample_interval * double1) AS hits FROM aadhar_bot_ledger WHERE timestamp > NOW() - INTERVAL '30' DAY GROUP BY bot, owner, kind ORDER BY hits DESC FORMAT JSON";
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: query, signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { ok: false, reason: `analytics API ${response.status}`, window_days: 30, rate_usd: 0.01, line_items: [] };
    const body = await response.json<{ data?: JsonRecord[] }>();
    const items = (body.data ?? []).map((row) => ({ bot: row.bot, owner: row.owner, kind: row.kind, hits: Math.round(Number(row.hits) || 0), amount_usd: +(Math.round(Number(row.hits) || 0) * .01).toFixed(2) }));
    const totalHits = items.reduce((sum, row) => sum + row.hits, 0);
    return { ok: true, window_days: 30, rate_usd: .01, line_items: items, total_hits: totalHits, total_usd: +(totalHits * .01).toFixed(2), note: "worker-served requests only; identity is self-reported by User-Agent" };
  } catch { return { ok: false, reason: "analytics API unavailable", window_days: 30, rate_usd: .01, line_items: [] }; }
}

export async function ledgerJson(env: Env): Promise<Response> {
  return json(await ledgerPayload(env), { headers: { "cache-control": "public, max-age=60", "x-robots-tag": "noindex" } });
}

export async function ledgerResponse(request: Request, env: Env): Promise<Response> {
  const [response, payload] = await Promise.all([env.ASSETS.fetch(request), ledgerPayload(env)]);
  const rows = Array.isArray(payload.line_items) ? payload.line_items as JsonRecord[] : [];
  const html = payload.ok
    ? `<h2>Last 30 days</h2><table><thead><tr><th>Bot</th><th>Owner</th><th>Purpose</th><th>Requests</th><th>Posted amount</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${escapeHtml(row.bot)}</td><td>${escapeHtml(row.owner)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(row.hits)}</td><td>$${Number(row.amount_usd).toFixed(2)}</td></tr>`).join("")}</tbody><tfoot><tr><th colspan="3">Total</th><td>${escapeHtml(payload.total_hits)}</td><td>$${Number(payload.total_usd).toFixed(2)}</td></tr></tfoot></table>`
    : null;
  const transformed = html
    ? new HTMLRewriter().on("#ledger-data", { element(element) { element.setInnerContent(html, { html: true }); } }).transform(response)
    : response;
  return withRenderedHeaders(transformed, request);
}
