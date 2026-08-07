import { botName } from "./bot.ts";
import { fetchPublicResource, inspectLens, validateLensTarget } from "./lens.ts";
import { json, withSiteHeaders } from "./http.ts";

type Row = Record<string, unknown>;

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function report(title: string, fields: [string, unknown][], extra = ""): string {
  return `<article class="tool-report"><h2>${escapeHtml(title)}</h2><dl>${fields.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>${extra}</article>`;
}

async function overBudget(env: Env, request: Request): Promise<boolean> {
  try { return !(await env.LENS_RL_INSPECT.limit({ key: request.headers.get("cf-connecting-ip") || "anonymous" })).success; }
  catch { return false; }
}

async function dictTool(raw: string, env: Env): Promise<string> {
  const fetched = await fetchPublicResource(raw, env, { accept: "*/*" }, 64 * 1024);
  const names = ["content-encoding", "available-dictionary", "dictionary-id", "use-as-dictionary", "vary", "cache-control", "etag"];
  return report("Dictionary negotiation", [["Final URL", fetched.finalUrl.href], ["HTTP", fetched.response.status], ["Signed as", fetched.signed ? botName : "local unsigned mode"], ...names.map((name) => [name, fetched.response.headers.get(name) || "not present"] as [string, string])]);
}

async function cacheTool(raw: string, env: Env): Promise<string> {
  const first = await fetchPublicResource(raw, env, { accept: "text/html,*/*;q=0.5" }, 64 * 1024);
  const validator = first.response.headers.get("etag") || first.response.headers.get("last-modified");
  let secondStatus: number | string = "not run";
  if (validator) {
    const headers = first.response.headers.has("etag") ? { "if-none-match": first.response.headers.get("etag")! } : { "if-modified-since": first.response.headers.get("last-modified")! };
    secondStatus = (await fetchPublicResource(first.finalUrl.href, env, headers, 4096)).response.status;
  }
  return report("Behavioral revalidation", [["Final URL", first.finalUrl.href], ["Initial status", first.response.status], ["Cache-Control", first.response.headers.get("cache-control") || "not present"], ["ETag", first.response.headers.get("etag") || "not present"], ["Last-Modified", first.response.headers.get("last-modified") || "not present"], ["Conditional status", secondStatus], ["Verdict", !validator ? "no validator to replay" : secondStatus === 304 ? "validator honored" : "validator returned a full response"]]);
}

function u32(bytes: Uint8Array, offset: number): number { return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0; }

function imageStructure(bytes: Uint8Array): Row {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2, scans = 0, width: number | null = null, height: number | null = null, progressive = false;
    while (offset + 3 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xda) scans++;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && offset + 8 < bytes.length) { progressive = marker === 0xc2; height = (bytes[offset + 5] << 8) | bytes[offset + 6]; width = (bytes[offset + 7] << 8) | bytes[offset + 8]; }
      if (marker === 0xd9 || marker === 0xda || marker === 0x00 || marker === 0xff) { offset += 2; continue; }
      const size = (bytes[offset + 2] << 8) | bytes[offset + 3]; offset += Math.max(2, size + 2);
    }
    return { format: "JPEG", width, height, progressive, scans: Math.max(scans, progressive ? 1 : 0) };
  }
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return { format: "PNG", width: u32(bytes, 16), height: u32(bytes, 20), interlaced: bytes[28] === 1 };
  const ascii = new TextDecoder("latin1").decode(bytes.slice(0, Math.min(bytes.length, 128 * 1024)));
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return { format: "WebP", subtype: ascii.slice(12, 16) };
  if (ascii.slice(4, 12).startsWith("ftyp") && /avif|avis/.test(ascii.slice(8, 32))) {
    const boxes = [...ascii.matchAll(/(?:^|.{4})(ftyp|meta|mdat|moov|iloc|iprp|iref)/gs)].slice(0, 30).map((match) => match[1]);
    return { format: "AVIF", boxes: [...new Set(boxes)] };
  }
  return { format: "unknown" };
}

async function encodeTool(raw: string, env: Env): Promise<string> {
  const fetched = await fetchPublicResource(raw, env, { accept: "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.2", range: "bytes=0-524287" }, 512 * 1024);
  const structure = imageStructure(fetched.body.raw);
  return report("Container structure", [["Final URL", fetched.finalUrl.href], ["HTTP", fetched.response.status], ["Content-Type", fetched.response.headers.get("content-type") || "unknown"], ["Bytes inspected", fetched.body.bytes], ...Object.entries(structure).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value] as [string, unknown])]);
}

function radarTool(raw: string): string {
  let samples: Row[];
  try { const value = JSON.parse(raw); samples = Array.isArray(value) ? value.slice(0, 1000) : []; }
  catch { throw new Error("Readings must be a JSON array."); }
  const values = samples.map((sample) => ({ frequency: Number(sample.frequency ?? sample.mhz), dbm: Number(sample.dbm ?? sample.rssi) })).filter(({ frequency, dbm }) => Number.isFinite(frequency) && Number.isFinite(dbm));
  if (!values.length) throw new Error("No readings contained numeric frequency and dBm fields.");
  const bands = new Map<string, number[]>();
  for (const sample of values) { const band = sample.frequency < 3000 ? "2.4 GHz" : sample.frequency < 5925 ? "5 GHz" : "6 GHz"; bands.set(band, [...(bands.get(band) ?? []), sample.dbm]); }
  return report("Signal report", [["Readings", values.length], ["Strongest", `${Math.max(...values.map(({ dbm }) => dbm))} dBm`], ["Weakest", `${Math.min(...values.map(({ dbm }) => dbm))} dBm`], ["Bands", [...bands.keys()].join(", ")]], `<pre>${escapeHtml([...bands].map(([band, readings]) => `${band.padEnd(8)} ${readings.length.toString().padStart(3)} samples  avg ${(readings.reduce((sum, value) => sum + value, 0) / readings.length).toFixed(1)} dBm`).join("\n"))}</pre>`);
}

async function fingerTool(env: Env): Promise<string> {
  const [index, updates] = await Promise.all([
    env.ASSETS.fetch("https://assets.invalid/search-index.json").then((response) => response.json<Row[]>()),
    env.ASSETS.fetch("https://assets.invalid/updates.json").then((response) => response.json<Row>()),
  ]);
  return report("aadharsh@aadhar.sh", [["Role", "investor and technologist"], ["Published routes", index.length], ["Current build", updates.build || "unrecorded"], ["Writing", "/writing"], ["Photos", "/photos"], ["Listening", "/rn"], ["Availability", "/coffee"], ["Machine index", "/llms.txt"]]);
}

async function agentReadyTool(request: Request, raw: string, env: Env): Promise<string> {
  const result = await inspectLens(request, env, raw);
  if (!result.payload.ok) throw new Error(result.payload.error || "Audit failed.");
  const readiness = result.payload.readiness as Row; const discovery = result.payload.discovery as Row;
  return report("Agent doors", [["Final URL", result.payload.finalUrl], ["Doors found", readiness.doors], ["Document title", readiness.title ? "present" : "absent"], ["llms.txt", (discovery["/llms.txt"] as Row)?.present ? "present" : "absent"], ["Agent card", (discovery["/.well-known/agent-card.json"] as Row)?.present ? "present" : "absent"], ["Machine inspection", `/lens/fetch?url=${encodeURIComponent(raw)}`]]);
}

export async function utilityPage(request: Request, env: Env, slug: string): Promise<Response> {
  const response = await env.ASSETS.fetch(request); const url = new URL(request.url); const parameter = slug === "radar" ? "samples" : slug === "finger" ? "q" : "url"; const raw = url.searchParams.get(parameter) ?? (slug === "finger" ? "aadharsh" : "");
  if (!raw) return withSiteHeaders(response, request);
  let html: string;
  try {
    if (["dict", "cache", "encode"].includes(slug)) {
      const validation = validateLensTarget(raw);
      if (validation.error || await overBudget(env, request)) throw new Error(validation.error || "Tool budget exceeded; retry in one minute.");
    }
    html = slug === "finger" ? await fingerTool(env) : slug === "radar" ? radarTool(raw) : slug === "dict" ? await dictTool(raw, env) : slug === "cache" ? await cacheTool(raw, env) : slug === "encode" ? await encodeTool(raw, env) : await agentReadyTool(request, raw, env);
  } catch (error) { html = `<article class="tool-report"><h2>Stopped</h2><p class="empty-state">${escapeHtml(error instanceof Error ? error.message : "The tool could not run.")}</p></article>`; }
  const transformed = new HTMLRewriter().on("#tool-input", { element(element) { if (slug === "radar") element.setInnerContent(raw); else element.setAttribute("value", raw); } }).on("#tool-output", { element(element) { element.setInnerContent(html, { html: true }); } }).transform(response);
  const secured = withSiteHeaders(transformed, request); secured.headers.set("cache-control", "no-store"); secured.headers.set("x-robots-tag", "noindex"); return secured;
}

function safeExternalUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

function safePath(value: unknown): string {
  try { return new URL(String(value)).pathname; }
  catch { return "/"; }
}

function calendarDay(value: unknown): string {
  const date = new Date(typeof value === "number" ? value : Number(value));
  return Number.isNaN(date.valueOf()) ? "unknown date" : date.toISOString().slice(0, 10);
}

export async function inboxPage(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request); let mentions: Row[] = [];
  try { mentions = (await env.SOCIAL_DB.prepare("SELECT id,source,target,kind,author,title,excerpt,approved_at FROM webmentions WHERE status='approved' ORDER BY approved_at DESC LIMIT 200").all<Row>()).results; } catch { /* empty state */ }
  if (!mentions.length) return withSiteHeaders(response, request);
  const html = `<ol>${mentions.flatMap((mention) => {
    const source = safeExternalUrl(mention.source);
    if (!source) return [];
    return [`<li id="${escapeHtml(mention.id)}"><h2><a href="${escapeHtml(source)}" rel="ugc external noopener">${escapeHtml(mention.title || mention.source)}</a></h2><p class="event-meta">${escapeHtml(mention.author || "someone")} ${escapeHtml(mention.kind || "mentioned")} ${escapeHtml(safePath(mention.target))} · ${calendarDay(mention.approved_at)}</p>${mention.excerpt ? `<p>${escapeHtml(mention.excerpt)}</p>` : ""}</li>`];
  }).join("")}</ol>`;
  const transformed = new HTMLRewriter().on("#mention-list", { element(element) { element.setInnerContent(html, { html: true }); } }).transform(response); const secured = withSiteHeaders(transformed, request); secured.headers.set("link", `<${new URL(request.url).origin}/webmention>; rel="webmention"`); return secured;
}

async function censusRows(env: Env): Promise<Row[]> {
  try { return (await env.RESTORE_DB.prepare("SELECT ts,ymd,host,url,tier,score,level,doors,verdict,surfaces FROM lens_census ORDER BY host,ts").all<Row>()).results; } catch { return []; }
}

function groupedCensus(rows: Row[]) {
  const groups = new Map<string, Row[]>(); for (const row of rows) groups.set(String(row.host), [...(groups.get(String(row.host)) ?? []), row]);
  return [...groups].map(([host, series]) => ({ host, url: series.at(-1)?.url, latest: series.at(-1)!, delta: Number(series.at(-1)?.score || 0) - Number(series[0]?.score || 0), series: series.map((row) => ({ ymd: row.ymd, score: row.score, tier: row.tier, doors: row.doors })) })).sort((a, b) => Number(b.latest.score ?? -1) - Number(a.latest.score ?? -1));
}

export async function censusJson(env: Env): Promise<Response> {
  const sites = groupedCensus(await censusRows(env)); return json({ ok: true, sites, snapshots: new Set(sites.flatMap((site) => site.series.map((row) => row.ymd))).size }, { headers: { "cache-control": "public, max-age=300", "x-robots-tag": "noindex" } });
}

export async function censusPage(request: Request, env: Env): Promise<Response> {
  const [response, rows] = await Promise.all([env.ASSETS.fetch(request), censusRows(env)]); const sites = groupedCensus(rows); if (!sites.length) return withSiteHeaders(response, request);
  const html = `<table><thead><tr><th>Site</th><th>Terms</th><th>Readiness</th><th>Level</th><th>Doors</th><th>Change</th></tr></thead><tbody>${sites.map((site) => `<tr><td><a href="/lens?url=${encodeURIComponent(String(site.url))}">${escapeHtml(site.host)}</a></td><td>${escapeHtml(site.latest.tier)}</td><td>${escapeHtml(site.latest.score ?? "—")}</td><td>${site.latest.level == null ? "—" : `L${escapeHtml(site.latest.level)}`}</td><td>${escapeHtml(site.latest.doors)}</td><td>${site.delta > 0 ? "+" : ""}${site.delta}</td></tr>`).join("")}</tbody></table>`;
  const transformed = new HTMLRewriter().on("#census", { element(element) { element.setInnerContent(html, { html: true }); } }).transform(response); return withSiteHeaders(transformed, request);
}
