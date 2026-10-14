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

export const API_CALL_PATH = /\.json$|^\/api(?:\/|$)|^\/v\d+(?:\/|$)/i;

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

type AssetsEnv = { ASSETS?: { fetch: (r: Request | string) => Promise<Response> } };
let _sitemap: string[] | undefined;

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
    const body = request.method === "HEAD" ? "" : await response.clone().text();
    if (/^(?:not found)?$/i.test(body.trim())) {
      const near = bucket === "probe" ? { section: null, pages: [] } : nearestPages(url.pathname, await sitemapPaths(env));
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
  } catch { }
  const out = new Response(response.body, response);
  out.headers.append("link", MISS_LINKS);
  return { bucket, outcome: "404", response: out };
}

export function countMiss(env: { MISS_LEDGER?: AnalyticsEngineDataset }, request: Request, path: string, miss: MissOutcome) {
  try {
    env.MISS_LEDGER?.writeDataPoint({
      blobs: [callerClass(request.headers.get("user-agent")), miss.bucket, miss.outcome, path.slice(0, 96)],
      doubles: [1],
      indexes: [miss.bucket],
    });
  } catch { }
}
