import { botHeaders, botName } from "./bot.ts";
import { json, withSiteHeaders } from "./http.ts";

type JsonRecord = Record<string, unknown>;
type Inspection = JsonRecord & { ok: boolean; error?: string; finalUrl?: string; status?: number };

const parseCap = 256 * 1024;
const redirectCap = 4;

function escapeHtml(value: unknown): string {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function privateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && [0, 2, 168].includes(b))
    || (a === 198 && [18, 19, 51].includes(b))
    || (a === 203 && b === 0);
}

function privateIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false;
  if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host) || host.startsWith("ff")) return true;
  const mapped = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? privateIpv4(mapped[1]) : false;
}

export function validateLensTarget(raw: string | null): { target?: URL; error?: string } {
  if (!raw) return { error: "A URL is required." };
  let target: URL;
  try { target = new URL(raw); }
  catch { return { error: "That is not a valid URL." }; }
  if (!["http:", "https:"].includes(target.protocol)) return { error: "Only public HTTP and HTTPS URLs are accepted." };
  if (target.username || target.password) return { error: "URLs containing credentials are refused." };
  if (target.port && !["80", "443"].includes(target.port)) return { error: "Only standard web ports are accepted." };
  const host = target.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal" || privateIpv4(host) || privateIpv6(host)) {
    return { error: "Private, local, and reserved network targets are refused." };
  }
  target.hash = "";
  return { target };
}

async function readCapped(response: Response, cap = parseCap): Promise<{ text: string; raw: Uint8Array; bytes: number; truncated: boolean }> {
  if (!response.body) return { text: "", raw: new Uint8Array(), bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > cap) {
      chunks.push(value.slice(0, cap - bytes));
      bytes = cap;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(joined), raw: joined, bytes, truncated };
}

function robotsRules(source: string): { agents: string[]; allow: string[]; disallow: string[] }[] {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let group: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  let directivesStarted = false;
  for (const original of source.split(/\r?\n/)) {
    const line = original.replace(/\s*#.*$/, "").trim();
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const field = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (field === "user-agent") {
      if (!group || directivesStarted) { group = { agents: [], allow: [], disallow: [] }; groups.push(group); directivesStarted = false; }
      group.agents.push(value.toLowerCase());
    } else if (group && (field === "allow" || field === "disallow")) {
      group[field].push(value);
      directivesStarted = true;
    }
  }
  return groups;
}

function robotsVerdict(source: string, pathname: string): { allowed: boolean; rule: string | null } {
  const groups = robotsRules(source);
  const specific = groups.filter(({ agents }) => agents.some((agent) => agent === botName.toLowerCase()));
  const relevant = specific.length ? specific : groups.filter(({ agents }) => agents.includes("*"));
  const matches = relevant.flatMap((group) => [
    ...group.allow.filter(Boolean).map((rule) => ({ allowed: true, rule })),
    ...group.disallow.filter(Boolean).map((rule) => ({ allowed: false, rule })),
  ]).filter(({ rule }) => pathname.startsWith(rule)).sort((a, b) => b.rule.length - a.rule.length || Number(b.allowed) - Number(a.allowed));
  return matches[0] ?? { allowed: true, rule: null };
}

async function robotsGate(target: URL, env: Env): Promise<{ allowed: boolean; state: string; rule?: string | null; signed?: boolean }> {
  const robots = new URL("/robots.txt", target.origin);
  try {
    const identity = await botHeaders(robots, env, { accept: "text/plain" });
    const response = await fetch(robots, { headers: identity.headers, redirect: "manual", signal: AbortSignal.timeout(3500), cf: { cacheTtl: 3600 } });
    if (response.status === 404 || response.status === 410) return { allowed: true, state: "absent", signed: identity.signed };
    if (!response.ok) return { allowed: false, state: `unavailable (${response.status})`, signed: identity.signed };
    const body = await readCapped(response, 64 * 1024);
    const verdict = robotsVerdict(body.text, target.pathname || "/");
    return { allowed: verdict.allowed, state: verdict.allowed ? "allowed" : "blocked", rule: verdict.rule, signed: identity.signed };
  } catch { return { allowed: false, state: "unavailable" }; }
}

async function fetchTarget(initial: URL, env: Env, initialHeaders?: HeadersInit, cap = parseCap): Promise<{ response: Response; finalUrl: URL; body: { text: string; raw: Uint8Array; bytes: number; truncated: boolean }; signed: boolean }> {
  let target = initial;
  let signed = false;
  for (let redirects = 0; redirects <= redirectCap; redirects++) {
    const validation = validateLensTarget(target.href);
    if (!validation.target) throw new Error(validation.error);
    const identity = await botHeaders(target, env, initialHeaders);
    signed ||= identity.signed;
    const response = await fetch(target, { headers: identity.headers, redirect: "manual", signal: AbortSignal.timeout(6000), cf: { cacheTtl: 0 } });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      if (redirects === redirectCap) throw new Error("Too many redirects.");
      target = new URL(response.headers.get("location")!, target);
      continue;
    }
    return { response, finalUrl: target, body: await readCapped(response, cap), signed };
  }
  throw new Error("Too many redirects.");
}

export async function fetchPublicResource(raw: string, env: Env, headers?: HeadersInit, cap = parseCap) {
  const validation = validateLensTarget(raw);
  if (!validation.target) throw new Error(validation.error);
  const robots = await robotsGate(validation.target, env);
  if (!robots.allowed) throw new Error(`AadharshBot refused this URL because robots.txt is ${robots.state}.`);
  return fetchTarget(validation.target, env, headers, cap);
}

function decodeText(value: string): string {
  return value.replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function textContent(html: string): string {
  return decodeText(html.replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 20000);
}

function firstMatch(html: string, expression: RegExp): string {
  return decodeText(html.match(expression)?.[1]?.replace(/<[^>]+>/g, " ").trim() ?? "").slice(0, 500);
}

function metaContent(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = html.match(new RegExp(`<meta\\b(?=[^>]*(?:name|property)=["']${escaped}["'])[^>]*>`, "i"))?.[0] ?? "";
  return decodeText(tag.match(/\bcontent=["']([^"']*)["']/i)?.[1] ?? "").slice(0, 500);
}

async function discovery(origin: string, env: Env): Promise<JsonRecord> {
  const paths = ["/robots.txt", "/sitemap.xml", "/llms.txt", "/.well-known/agent-card.json"];
  const rows = await Promise.all(paths.map(async (path) => {
    try {
      const target = new URL(path, origin);
      const identity = await botHeaders(target, env);
      const response = await fetch(target, { headers: identity.headers, redirect: "manual", signal: AbortSignal.timeout(3000), cf: { cacheTtl: 300 } });
      const body = await readCapped(response, 64 * 1024);
      return [path, { status: response.status, present: response.ok, contentType: response.headers.get("content-type"), bytesRead: body.bytes }];
    } catch { return [path, { status: null, present: false }]; }
  }));
  return Object.fromEntries(rows);
}

async function limited(binding: RateLimit, request: Request, shared?: string): Promise<boolean> {
  try {
    return !(await binding.limit({ key: shared || request.headers.get("cf-connecting-ip") || "anonymous" })).success;
  } catch { return false; }
}

export async function inspectLens(request: Request, env: Env, raw = new URL(request.url).searchParams.get("url")): Promise<{ status: number; payload: Inspection }> {
  const validation = validateLensTarget(raw);
  if (!validation.target) return { status: 400, payload: { ok: false, error: validation.error! } };
  if (await limited(env.LENS_RL_INSPECT, request)) return { status: 429, payload: { ok: false, error: "Inspection budget exceeded; retry in one minute." } };
  const gate = await robotsGate(validation.target, env);
  if (!gate.allowed) return { status: 403, payload: { ok: false, error: `AadharshBot refused this URL because robots.txt is ${gate.state}.`, robots: gate } };
  try {
    const fetched = await fetchTarget(validation.target, env);
    const html = fetched.body.text;
    const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].slice(0, 60).map((match) => ({ level: Number(match[1]), text: textContent(match[2]).slice(0, 240) }));
    const title = firstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const description = metaContent(html, "description") || metaContent(html, "og:description");
    const jsonLd = (html.match(/<script\b[^>]*type=["']application\/ld\+json["']/gi) ?? []).length;
    const doors = await discovery(fetched.finalUrl.origin, env);
    const doorCount = Object.values(doors).filter((door) => (door as JsonRecord).present).length;
    const responseHeaders = Object.fromEntries(["content-type", "content-language", "cache-control", "etag", "last-modified", "link", "content-signal", "x-robots-tag", "available-dictionary", "dictionary-id", "use-as-dictionary", "content-encoding", "vary"].flatMap((name) => {
      const value = fetched.response.headers.get(name);
      return value ? [[name, value]] : [];
    }));
    return { status: 200, payload: {
      ok: true, url: validation.target.href, finalUrl: fetched.finalUrl.href, status: fetched.response.status,
      fetchedBy: botName, signed: fetched.signed, robots: gate, headers: responseHeaders,
      anatomy: { title, description, headings, text: textContent(html), bytesRead: fetched.body.bytes, truncated: fetched.body.truncated, links: (html.match(/<a\b[^>]*href=/gi) ?? []).length, images: (html.match(/<img\b/gi) ?? []).length },
      structured: { jsonLd, openGraph: { title: metaContent(html, "og:title"), description: metaContent(html, "og:description"), image: metaContent(html, "og:image") } },
      discovery: doors,
      readiness: { score: Math.min(100, 20 + Math.min(30, headings.length * 5) + (title ? 10 : 0) + (description ? 10 : 0) + jsonLd * 5 + doorCount * 5), doors: doorCount },
    } };
  } catch (error) { return { status: 502, payload: { ok: false, error: error instanceof Error ? error.message : "Inspection failed." } }; }
}

function inspectionHtml(payload: Inspection): string {
  if (!payload.ok) return `<h2>Inspection stopped</h2><p class="empty-state">${escapeHtml(payload.error)}</p>`;
  const anatomy = payload.anatomy as JsonRecord;
  const structured = payload.structured as JsonRecord;
  const readiness = payload.readiness as JsonRecord;
  const headings = Array.isArray(anatomy.headings) ? anatomy.headings as JsonRecord[] : [];
  const doors = Object.entries(payload.discovery as JsonRecord);
  return `<h2>${escapeHtml(anatomy.title || payload.finalUrl)}</h2><p><a href="${escapeHtml(payload.finalUrl)}" rel="external noopener">${escapeHtml(payload.finalUrl)}</a></p><div class="lens-summary"><article><h3>Raw response</h3><dl><dt>Status</dt><dd>${escapeHtml(payload.status)}</dd><dt>Bytes parsed</dt><dd>${escapeHtml(anatomy.bytesRead)}${anatomy.truncated ? " (capped)" : ""}</dd><dt>Headings</dt><dd>${headings.length}</dd><dt>Links</dt><dd>${escapeHtml(anatomy.links)}</dd></dl></article><article><h3>Agent-ready?</h3><dl><dt>Score</dt><dd>${escapeHtml(readiness.score)} / 100</dd><dt>Discovery doors</dt><dd>${escapeHtml(readiness.doors)}</dd><dt>Signed fetch</dt><dd>${payload.signed ? "yes" : "not configured here"}</dd><dt>Robots</dt><dd>${escapeHtml((payload.robots as JsonRecord).state)}</dd></dl></article></div><h3>Agent doors</h3><ul class="lens-doors">${doors.map(([path, value]) => `<li>${escapeHtml(path)}: ${(value as JsonRecord).present ? "present" : "absent"}</li>`).join("")}</ul>${headings.length ? `<section class="lens-outline"><h3>Document outline</h3><ol>${headings.map((heading) => `<li>h${escapeHtml(heading.level)} · ${escapeHtml(heading.text)}</li>`).join("")}</ol></section>` : ""}<h3>Readable text</h3><pre class="lens-text">${escapeHtml(anatomy.text)}</pre><p><a href="/lens/fetch?url=${encodeURIComponent(String(payload.url))}">Open this inspection as JSON</a></p>`;
}

export async function lensPage(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) return withSiteHeaders(response, request);
  const result = await inspectLens(request, env, raw);
  const transformed = new HTMLRewriter()
    .on("#lens-url", { element(element) { element.setAttribute("value", raw.slice(0, 2048)); } })
    .on("#lens-results", { element(element) { element.setInnerContent(inspectionHtml(result.payload), { html: true }); } })
    .transform(response);
  const secured = withSiteHeaders(transformed, request);
  secured.headers.set("cache-control", "no-store");
  secured.headers.set("x-robots-tag", "noindex");
  return secured;
}

export async function lensFetch(request: Request, env: Env): Promise<Response> {
  const result = await inspectLens(request, env);
  return json(result.payload, { status: result.status, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

async function browserGate(request: Request, env: Env): Promise<{ target?: URL; refusal?: Response }> {
  const validation = validateLensTarget(new URL(request.url).searchParams.get("url"));
  if (!validation.target) return { refusal: json({ ok: false, error: validation.error }, { status: 400 }) };
  if (await limited(env.LENS_RL_BROWSER, request) || await limited(env.LENS_RL_BROWSER_ALL, request, "browser-run")) return { refusal: json({ ok: false, error: "Browser Run budget exceeded." }, { status: 429 }) };
  const robots = await robotsGate(validation.target, env);
  if (!robots.allowed) return { refusal: json({ ok: false, error: `AadharshBot refused this URL because robots.txt is ${robots.state}.` }, { status: 403 }) };
  return { target: validation.target };
}

export async function lensBrowser(request: Request, env: Env): Promise<Response> {
  const gate = await browserGate(request, env);
  if (gate.refusal) return gate.refusal;
  try {
    const response = await env.BROWSER.quickAction("content", { url: gate.target!.href, userAgent: "AadharshBot/2.0 (+https://aadhar.sh/bot)", gotoOptions: { timeout: 15000, waitUntil: "domcontentloaded" }, actionTimeout: 15000, cacheTTL: 0 });
    const headers = new Headers(response.headers); headers.set("cache-control", "no-store"); headers.set("x-robots-tag", "noindex");
    return new Response(response.body, { status: response.status, headers });
  } catch { return json({ ok: false, error: "Browser Run is unavailable." }, { status: 503 }); }
}

export async function lensShot(request: Request, env: Env): Promise<Response> {
  const gate = await browserGate(request, env);
  if (gate.refusal) return gate.refusal;
  try {
    const response = await env.BROWSER.quickAction("screenshot", { url: gate.target!.href, userAgent: "AadharshBot/2.0 (+https://aadhar.sh/bot)", viewport: { width: 1280, height: 800 }, screenshotOptions: { type: "webp", fullPage: false }, gotoOptions: { timeout: 15000, waitUntil: "domcontentloaded" }, actionTimeout: 15000, cacheTTL: 0 });
    const headers = new Headers(response.headers); headers.set("cache-control", "no-store"); headers.set("x-robots-tag", "noindex");
    return new Response(response.body, { status: response.status, headers });
  } catch { return json({ ok: false, error: "Browser Run is unavailable." }, { status: 503 }); }
}

export async function lensCompare(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const left = validateLensTarget(url.searchParams.get("left"));
  const right = validateLensTarget(url.searchParams.get("right"));
  if (!left.target || !right.target) return json({ ok: false, error: left.error || right.error }, { status: 400 });
  if (await limited(env.LENS_RL_COMPARE, request)) return json({ ok: false, error: "Comparison budget exceeded." }, { status: 429 });
  const [a, b] = await Promise.all([inspectLens(request, env, left.target.href), inspectLens(request, env, right.target.href)]);
  return json({ ok: a.payload.ok && b.payload.ok, left: a.payload, right: b.payload }, { status: Math.max(a.status, b.status) >= 400 ? Math.max(a.status, b.status) : 200, headers: { "cache-control": "no-store", "x-robots-tag": "noindex" } });
}
