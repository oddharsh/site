// What the Worker does with a 404, and the counter that says whether it helped.
//
// Measured over three days of zone analytics before this existed (2026-09-28 to
// 2026-10-01, 34,272 requests, 3,237 of them 404): almost every miss had a
// deterministic answer, and none of the answers needed a model.
//
//   57%  a superseded /a/<name>.<hash8> URL (one crawler asked 1,737 times for
//        a sprite two releases old)
//   22%  vulnerability probes (.env, wp-, credentials.json), which stay 404
//    5%  agent discovery guesses (/.well-known/mcp, /AGENTS.md, ai-plugin.json)
//    2%  share cards asked for as .png, which have been .jpg since the cards
//        were re-rendered
//    1%  /<tool>.md, where a terminal tool answers at /<tool>.txt
//   <1%  superseded /i/ photo tiles, from the 2026-09-26 re-encode
//
// So the order here is a redirect when one URL is unambiguously meant, and
// otherwise a 404 that says where the real pages are. Every 404 carries Link
// headers to the sitemap, llms.txt and the ARD manifest, and a GENERIC 404 (the
// asset layer's empty one, or the clamp's "not found") gains a body listing the
// closest pages the sitemap knows, grouped by section. An agent that guessed
// /garage/resampe learns /garage/resample and /garage in the same response.
// That body is plain text by default, and Markdown or JSON when Accept asks for
// one, by the same rule the pages negotiate with. The JSON shape is the one
// /openapi.json declares as Error, so a client of the API reads a miss the way
// it reads any other failure.
//
// The sitemap is the authority for both halves. It is the list this site
// already publishes of what is real, build.ts's invariants hold it to the
// surface registry, and its paths carry the site's structure (/garage/*, /lwe/*,
// /writing/*), which is what "closest" is measured within.
//
// Every redirect is a 301 with a one-day cache. One day rather than a year
// because the target of a stale hash moves on the next release, and a cached
// chain is cheap to re-resolve but wrong to pin. Nothing here is aliased to a
// resource this site does not serve: ai-plugin.json and the rest stay 404,
// because answering them would advertise a capability that is not here. /openapi.json is a real file
// since 2026-10-13 (it describes the keyless JSON endpoints), so the usual
// guesses at an OpenAPI path now point at it.
//
// Node-safe (gotcha 16): the contract suite imports it outside workerd.

import { HASHED_ASSETS } from "./shell-assets.ts";
import { AGENT_SURFACES } from "./site-manifest.ts";
import { getThumbHashes } from "../photos.ts";
import { matchCrawler } from "../ledger.ts";
import { namesHtml, wantsJson, wantsMarkdown } from "./http.ts";

export const MISS_LINKS = [
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
  '</llms.txt>; rel="alternate"; type="text/plain"; title="llms.txt summary"',
  '</.well-known/ard.json>; rel="ard"; type="application/json"',
].join(", ");

// Discovery guesses with an honest answer. Each target is a document this site
// serves in the format the guess implies.
// /.well-known/mcp, /.well-known/mcp.json and /mcp.json are MCP server-card
// probes, and the site's card is /.well-known/mcp/server-card.json.
// /.well-known/ai-catalog.json is ARD's predecessor path for ard.json.
// AGENTS.md is guidance for agents written in Markdown, and /llms.txt is this site's. The OpenAPI guesses are the
// JSON spellings only: a YAML path would be answered in a format it did not ask for.
// The developer-guide guesses (/docs, /api-docs and the like) go to /developers,
// the page that is that guide.
export const DISCOVERY_ALIASES: Readonly<Record<string, string>> = {
  "/docs": "/developers",
  "/docs/api": "/developers",
  "/api-docs": "/developers",
  "/api/docs": "/developers",
  "/developer": "/developers",
  "/swagger.json": "/openapi.json",
  "/api/openapi.json": "/openapi.json",
  "/.well-known/openapi.json": "/openapi.json",
  "/.well-known/mcp": "/.well-known/mcp/server-card.json",
  "/.well-known/mcp.json": "/.well-known/mcp/server-card.json",
  "/.well-known/ai-catalog.json": "/.well-known/ard.json",
  "/mcp.json": "/.well-known/mcp/server-card.json",
  "/agents.md": "/llms.txt",
  "/AGENTS.md": "/llms.txt",
};

// A path shaped like an API call. Its miss answers JSON unless the caller names
// HTML, because whatever asked for /v1/users or /data.json is going to parse
// the body, and a client that sends no Accept (or */*) still gets something it
// can read. A browser names text/html and keeps the plain-text page.
export const API_CALL_PATH = /\.json$|^\/api(?:\/|$)|^\/v\d+(?:\/|$)/i;

// The terminal tools answer a text frame at /<tool>.txt, and agents guess .md.
// Derived from the registry, so a new tool is covered by being registered.
const TEXT_TOOLS = new Set(AGENT_SURFACES.filter((s) => s.mimeType === "text/plain").map((s) => s.path));

const PROBE = /\.(?:php\d?|env|git|ya?ml|cgi|sql|bak|zip|tar|gz|ini|cfg|conf|pem|key|asp|aspx|jsp)\b|\/wp-|\/\.(?:aws|ssh|docker|config|s3cfg|zshrc|bash|anthropic)|%25|\/etc\/|credentials|composer\.json|appsettings|phpinfo|cgi-bin/i;

export function missBucket(path: string): string {
  if (path.startsWith("/a/")) return "stale-asset";
  if (path.startsWith("/i/")) return "stale-photo";
  if (path.startsWith("/og/")) return "share-card";
  if (PROBE.test(path)) return "probe";
  if (DISCOVERY_ALIASES[path] || /^\/\.well-known\/|^\/(?:agents?|mcp|openapi|ai-plugin|llms)\b/i.test(path)) return "discovery";
  if (path.endsWith(".md")) return "md-guess";
  return "page";
}

export function callerClass(ua: string | null): string {
  const s = String(ua || "");
  if (!s) return "empty";
  if (matchCrawler(s)) return "ai-crawler";
  if (/curl|wget|python|go-http|node|undici|axios|okhttp|java\/|httpx|aiohttp|scrapy|headless|puppeteer|playwright|bun\/|deno|reqwest/i.test(s)) return "http-tool";
  if (/bot|crawl|spider|scan|fetch|monitor|preview|validator|feed/i.test(s)) return "other-bot";
  if (/mozilla/i.test(s)) return "browser";
  return "other";
}

// The sitemap, read once per isolate.
type AssetsEnv = { ASSETS?: { fetch: (r: Request | string) => Promise<Response> } };
let _sitemap: string[] | undefined;

/** The sitemap's paths. Empty when it cannot be read, which degrades every
 *  suggestion to the bare Link headers rather than failing the response. */
export async function sitemapPaths(env: AssetsEnv): Promise<string[]> {
  if (_sitemap) return _sitemap;
  try {
    const r = await env.ASSETS?.fetch("https://assets.local/sitemap.xml");
    const xml = r?.ok ? await r.text() : "";
    _sitemap = [...xml.matchAll(/<loc>\s*https?:\/\/[^/<]+([^<\s]*)\s*<\/loc>/g)].map((m) => m[1] || "/");
  } catch { _sitemap = []; }
  return _sitemap;
}

/** Test seam, never called by the Worker (gotcha 28). */
export function _resetSitemap() { _sitemap = undefined; }

/** The sitemap page a careless spelling meant: case, a trailing slash, `.html`,
 *  `/index`. These are the easy ones, and they need no guess. */
export function canonicalPage(path: string, pages: readonly string[]): string | null {
  const norm = (p: string) => (p.toLowerCase().replace(/\/index(?:\.html?)?$/, "").replace(/\.html?$/, "").replace(/\/+$/, "") || "/");
  const want = norm(path);
  const hit = pages.find((p) => norm(p) === want);
  return hit && hit !== path ? hit : null;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

function likeness(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max ? 1 - editDistance(a.toLowerCase(), b.toLowerCase()) / max : 1;
}

/** The sitemap pages closest to a missing path, and the section they share.
 *  "Closest" is measured within the path's own section when the sitemap has
 *  one (a miss under /garage/ is compared with /garage's pages), and across the
 *  whole sitemap otherwise. A floor keeps an unrelated page from being offered
 *  as a near miss. */
export function nearestPages(path: string, pages: readonly string[], limit = 3): { section: string | null, pages: string[] } {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  const top = parts.length > 1 ? `/${parts[0]}` : null;
  const section = top && pages.includes(top) ? top : null;
  const pool = section ? pages.filter((p) => p.startsWith(`${section}/`)) : pages.filter((p) => p !== "/");
  const leaf = parts.at(-1) || "";
  const scored = pool
    .map((p) => ({ p, score: section ? likeness(leaf, p.slice(section.length + 1)) : likeness(path, p) }))
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.p.localeCompare(b.p));
  return { section, pages: scored.slice(0, limit).map((s) => s.p) };
}

export async function resolveMiss(url: URL, env: AssetsEnv): Promise<{ location: string, rule: string } | null> {
  const path = url.pathname;

  const asset = /^\/a\/(.+)\.([0-9a-f]{8})\.([a-z0-9]+)$/.exec(path);
  if (asset) {
    const current = HASHED_ASSETS[`${asset[1]}.${asset[3]}`];
    return current && current !== path ? { location: current, rule: "stale-asset" } : null;
  }

  const tile = /^\/i\/(.+?)(-400|-200)?\.([0-9a-f]{8})\.(avif|jpg)$/.exec(path);
  if (tile) {
    const [, stem, tier, , ext] = tile;
    const key = ext === "jpg" ? "j" : tier === "-400" ? "s" : tier === "-200" ? "x" : "a";
    const h = (await getThumbHashes(env))?.[stem]?.[key];
    const current = h ? `/i/${stem}${tier || ""}.${h}.${ext}` : null;
    return current && current !== path ? { location: current, rule: "stale-photo" } : null;
  }

  const card = /^\/og\/([a-z0-9-]+)\.png$/.exec(path);
  if (card) {
    const jpg = `/og/${card[1]}.jpg`;
    const r = await env.ASSETS?.fetch(new Request(`${url.origin}${jpg}`, { method: "HEAD" })).catch(() => null);
    return r?.ok ? { location: jpg, rule: "share-card" } : null;
  }

  const tool = /^(\/[a-z-]+)\.md$/.exec(path);
  if (tool && TEXT_TOOLS.has(tool[1])) return { location: `${tool[1]}.txt`, rule: "tool-text" };

  if (DISCOVERY_ALIASES[path]) return { location: DISCOVERY_ALIASES[path], rule: "discovery-alias" };

  if (PROBE.test(path)) return null;
  const page = canonicalPage(path, await sitemapPaths(env));
  return page ? { location: page, rule: "canonical-page" } : null;
}

export function missBody(path: string, near: { section: string | null, pages: string[] }): string {
  const lines = [`404 Not Found: ${path}`, ""];
  if (near.pages.length) {
    lines.push(near.section ? `Closest pages in ${near.section}:` : "Closest pages:", ...near.pages.map((p) => `  ${p}`));
    if (near.section) lines.push(`Section index: ${near.section}`);
    lines.push("");
  }
  lines.push(
    "Every page on this site is listed in /sitemap.xml, summarized for agents in",
    "/llms.txt, and its agent resources are described in /.well-known/ard.json.",
  );
  return `${lines.join("\n")}\n`;
}

/** The same answer for a caller that asked for `text/markdown`: the pages as
 *  absolute links, so an agent can follow them without resolving anything. */
export function missMarkdown(origin: string, path: string, near: { section: string | null, pages: string[] }): string {
  const link = (p: string) => `[${p}](${origin}${p})`;
  const lines = ["# 404 Not Found", "", `\`${path}\` is not a page on ${new URL(origin).host}.`, ""];
  if (near.pages.length) {
    lines.push(near.section ? `## Closest pages in ${near.section}` : "## Closest pages", "", ...near.pages.map((p) => `- ${link(p)}`));
    if (near.section) lines.push("", `Section index: ${link(near.section)}`);
    lines.push("");
  }
  lines.push(
    "## Where the pages are",
    "",
    `- ${link("/sitemap.xml")}: every page on this site`,
    `- ${link("/llms.txt")}: the same map, summarized for agents`,
    `- ${link("/.well-known/ard.json")}: the agent resources this site serves`,
  );
  return `${lines.join("\n")}\n`;
}

/** The same answer as the Error object /openapi.json declares: the site's
 *  existing `{ ok: false, error }` shape, plus a machine code and a hint. */
export function missJson(origin: string, path: string, near: { section: string | null, pages: string[] }) {
  const body: Record<string, unknown> = {
    ok: false,
    error: `${path} is not a page or endpoint on ${new URL(origin).host}.`,
    code: "not_found",
    status: 404,
    hint: near.pages.length
      ? `Did you mean ${near.pages[0]}? Every page is listed in /sitemap.xml, and every JSON endpoint in /openapi.json.`
      : "Every page is listed in /sitemap.xml, and every JSON endpoint in /openapi.json.",
  };
  if (near.pages.length) body.suggestions = near.pages.map((p) => `${origin}${p}`);
  body.docs = `${origin}/developers`;
  return body;
}

export type MissOutcome = { response: Response, bucket: string, outcome: string };

/** Turn a 404 into a redirect where one URL is meant, and otherwise into a 404
 *  that says where the pages are. Never throws: a failure here returns the
 *  original 404 with the Link headers, which is what it would have been. */
export async function recoverNotFound(request: Request, env: AssetsEnv, response: Response): Promise<MissOutcome> {
  const url = new URL(request.url);
  const bucket = missBucket(url.pathname);
  try {
    const hit = await resolveMiss(url, env);
    if (hit) {
      return {
        bucket,
        outcome: `redirect:${hit.rule}`,
        response: new Response(null, {
          status: 301,
          headers: { location: `${url.origin}${hit.location}${url.search}`, "cache-control": "public, max-age=86400" },
        }),
      };
    }
    // Only a GENERIC 404 is rewritten: the asset layer's empty one, and the
    // clamp's "not found" (lib/assets.ts serveAssetWith404Clamp). A handler that
    // wrote its own body (a JSON error, a route's own page) knows better than
    // this does what to say.
    const body = request.method === "HEAD" ? "" : await response.clone().text();
    if (/^(?:not found)?$/i.test(body.trim())) {
      const near = bucket === "probe" ? { section: null, pages: [] } : nearestPages(url.pathname, await sitemapPaths(env));
      // The body follows Accept the way the pages do (lib/http.ts): an agent
      // that asked for Markdown or JSON gets it, an API-shaped path gets JSON
      // unless HTML was named, and everyone else plain text.
      const json = wantsJson(request) || (API_CALL_PATH.test(url.pathname) && !namesHtml(request));
      const kind = wantsMarkdown(request) ? "md" : json ? "json" : "text";
      const text = kind === "md" ? missMarkdown(url.origin, url.pathname, near)
        : kind === "json" ? `${JSON.stringify(missJson(url.origin, url.pathname, near), null, 2)}\n`
        : missBody(url.pathname, near);
      return {
        bucket,
        outcome: near.pages.length ? "404:suggested" : "404",
        response: new Response(request.method === "HEAD" ? null : text, {
          status: 404,
          headers: {
            "content-type": { md: "text/markdown", json: "application/json", text: "text/plain" }[kind] + "; charset=utf-8",
            "cache-control": "no-store",
            vary: "accept",
            link: MISS_LINKS,
          },
        }),
      };
    }
  } catch { /* fall through to the original, decorated */ }
  const out = new Response(response.body, response);
  out.headers.append("link", MISS_LINKS);
  return { bucket, outcome: "404", response: out };
}

/** One data point per miss, answered or recovered. Never throws. */
export function countMiss(env: { MISS_LEDGER?: AnalyticsEngineDataset }, request: Request, path: string, miss: MissOutcome) {
  try {
    env.MISS_LEDGER?.writeDataPoint({
      blobs: [callerClass(request.headers.get("user-agent")), miss.bucket, miss.outcome, path.slice(0, 96)],
      doubles: [1],
      indexes: [miss.bucket],
    });
  } catch { /* the ledger is best-effort; never break a response over it */ }
}
