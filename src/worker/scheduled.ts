import targets from "../contracts/crawlers.json";
import { refreshCoffeeCalendar } from "./coffee.ts";
import { fetchPublicResource, inspectLens } from "./lens.ts";
import { refreshNowPlaying } from "./rn.ts";

type Row = Record<string, unknown>;

function textContent(html: string): string {
  return html.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function field(html: string, expression: RegExp): string | null {
  return html.match(expression)?.[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500) || null;
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function observe(env: Env, target: { name: string; url: string }): Promise<Row> {
  const observedAt = Date.now();
  try {
    const fetched = await fetchPublicResource(target.url, env, { accept: "text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5" }, 256 * 1024);
    const readable = textContent(fetched.body.text).slice(0, 50000);
    return { target: target.url, name: target.name, observed_at: observedAt, status: fetched.response.status, final_url: fetched.finalUrl.href, title: field(fetched.body.text, /<title\b[^>]*>([\s\S]*?)<\/title>/i), description: field(fetched.body.text, /<meta\b(?=[^>]*\b(?:name|property)=["'](?:description|og:description)["'])[^>]*\bcontent=["']([^"']*)["'][^>]*>/i), content_type: fetched.response.headers.get("content-type"), body_hash: await digest(readable), robots: "allowed", skipped: fetched.body.truncated ? "body capped at 256 KiB" : null, error: null };
  } catch (error) { return { target: target.url, name: target.name, observed_at: observedAt, status: null, final_url: null, title: null, description: null, content_type: null, body_hash: null, robots: "refused or unavailable", skipped: null, error: error instanceof Error ? error.message.slice(0, 500) : "crawl failed" }; }
}

async function ensureAroundSchema(env: Env): Promise<void> {
  await env.RESTORE_DB.prepare(`CREATE TABLE IF NOT EXISTS around_crawl_history (target TEXT NOT NULL, name TEXT NOT NULL, observed_at INTEGER NOT NULL, status INTEGER, final_url TEXT, title TEXT, description TEXT, content_type TEXT, body_hash TEXT, robots TEXT, skipped TEXT, error TEXT, PRIMARY KEY(target,observed_at))`).run();
  await env.RESTORE_DB.prepare("CREATE INDEX IF NOT EXISTS around_crawl_history_observed ON around_crawl_history(observed_at DESC)").run();
}

async function mapConcurrent<T, U>(items: readonly T[], width: number, work: (item: T) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(items.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (cursor < items.length) { const index = cursor++; output[index] = await work(items[index]); }
  }));
  return output;
}

export async function refreshNeighborhood(env: Env): Promise<void> {
  const results = await mapConcurrent(targets.neighborhood, 4, (target) => observe(env, target));
  await ensureAroundSchema(env);
  await env.RESTORE_DB.batch(results.map((row) => env.RESTORE_DB.prepare("INSERT OR REPLACE INTO around_crawl_history(target,name,observed_at,status,final_url,title,description,content_type,body_hash,robots,skipped,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").bind(row.target, row.name, row.observed_at, row.status, row.final_url, row.title, row.description, row.content_type, row.body_hash, row.robots, row.skipped, row.error)));
  await env.RN_KV.put("around:report", JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), count: results.length, results }));
}

async function ensureCensusSchema(env: Env): Promise<void> {
  await env.RESTORE_DB.prepare(`CREATE TABLE IF NOT EXISTS lens_census (ts INTEGER NOT NULL, ymd TEXT NOT NULL, host TEXT NOT NULL, url TEXT NOT NULL, tier TEXT, score INTEGER, level INTEGER, doors INTEGER, verdict TEXT, surfaces TEXT, PRIMARY KEY(ymd,host))`).run();
  await env.RESTORE_DB.prepare("CREATE INDEX IF NOT EXISTS lens_census_host_ts ON lens_census(host,ts)").run();
}

export async function refreshCensus(env: Env): Promise<void> {
  const ts = Date.now(); const ymd = new Date(ts).toISOString().slice(0, 10);
  const rows = await Promise.all(targets.census.map(async (url) => {
    const request = new Request(`https://aadhar.sh/lens/fetch?url=${encodeURIComponent(url)}`, { headers: { "cf-connecting-ip": `census:${new URL(url).hostname}` } });
    const result = await inspectLens(request, env, url); const payload = result.payload; const readiness = payload.readiness as Row | undefined; const discovery = payload.discovery as Row | undefined;
    // `doors` is the measurement this lens actually takes: how many public
    // machine-readable entrances the origin answers on. The composite score and
    // level the old lens reported have no successor here, so they are recorded
    // as NULL rather than as a 0 that would read like a real reading and would
    // pin every delta in the series to zero. Historical rows keep their values.
    return { ts, ymd, host: new URL(url).hostname.replace(/^www\./, ""), url, tier: result.status === 200 ? "public" : "unavailable", score: null, level: null, doors: Number(readiness?.doors) || 0, verdict: payload.ok ? "readable" : String(payload.error || "unavailable").slice(0, 500), surfaces: JSON.stringify(discovery ?? {}) };
  }));
  await ensureCensusSchema(env);
  await env.RESTORE_DB.batch(rows.map((row) => env.RESTORE_DB.prepare("INSERT OR REPLACE INTO lens_census(ts,ymd,host,url,tier,score,level,doors,verdict,surfaces) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(row.ts, row.ymd, row.host, row.url, row.tier, row.score, row.level, row.doors, row.verdict, row.surfaces)));
}

export async function runScheduled(cron: string, env: Env): Promise<void> {
  if (cron === "*/30 * * * *") return refreshNowPlaying(env).then(() => undefined);
  if (cron === "7,37 * * * *") return refreshCoffeeCalendar(env).then(() => undefined);
  if (cron === "23 */6 * * *") return refreshNeighborhood(env);
  if (cron === "17 8 * * 1") return refreshCensus(env);
  throw new Error(`Unknown cron: ${cron}`);
}
