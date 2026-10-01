// IndexNow: tell search engines which pages a release actually changed.
//
// One POST to api.indexnow.org reaches every participating engine (Bing,
// Yandex, Naver, Seznam, Yep; the protocol shares submissions between them).
// Google does not take part, so this is no substitute for the sitemap.
//
// WHAT COUNTS AS CHANGED is the whole design. The sitemap's <lastmod> dates are
// hand-kept and were stale for 11 of 56 pages on 2026-10-01, so they cannot say.
// A page's HTML bytes over-say: a shell asset re-mint rewrites every page's
// hashed /a/ refs without changing a word. So the signal is each page's
// CONTENT-ONLY representation in the served manifest ci.yml signs (#1073): its
// Markdown twin, which the build derives from the prose alone with scripts and
// controls stripped, or a writing post's .txt source, or for a file that IS its
// content (/resume.pdf) the file itself. 56 of 56 sitemap pages have one.
//
// The key is public by design: the protocol proves ownership by serving it at
// /<key>.txt on the host, so it lives in this tree like any other static file.

import type { ServedManifest } from "./served-manifest.ts";

export const INDEXNOW_KEY = "57f3182c72aa0d0075d7128bf27cb016";
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/**
 * The sitemap's page paths on `host`, `/` included. Each <loc> is parsed as a
 * URL and its host compared exactly, rather than building a regex out of the
 * host name: a host is input, and escaping it into a pattern is one missed
 * metacharacter from matching somebody else's domain.
 */
export function sitemapPaths(xml: string, host: string): string[] {
  const paths: string[] = [];
  for (const [, loc] of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    let url: URL;
    try { url = new URL(loc); } catch { continue; }
    if (url.protocol === "https:" && url.host === host) paths.push(url.pathname || "/");
  }
  return paths;
}

/**
 * The manifest URL whose bytes stand for a page's content: its Markdown twin,
 * else a /writing post's .txt source, else the URL itself. null when the
 * manifest carries none of them (a page this cannot judge).
 */
export function contentUrl(path: string, files: Record<string, string>): string | null {
  const twin = path === "/" ? "/index.md" : `${path}.md`;
  if (files[twin]) return twin;
  const txt = /^\/writing\/[^/]+$/.test(path) ? `${path}.txt` : null;
  if (txt && files[txt]) return txt;
  return files[path] ? path : null;
}

/** Pages whose content moved or arrived between two releases, as absolute URLs. */
export function changedPages(prev: ServedManifest, next: ServedManifest, paths: string[], host: string): string[] {
  const out: string[] = [];
  for (const path of paths) {
    const key = contentUrl(path, next.files);
    if (!key) continue;
    if (prev.files[key] !== next.files[key]) out.push(`https://${host}${path}`);
  }
  return out;
}

export function submission(host: string, urlList: string[]) {
  return { host, key: INDEXNOW_KEY, keyLocation: `https://${host}/${INDEXNOW_KEY}.txt`, urlList };
}

/** What each status the protocol defines means, and whether it is a success. */
export function readStatus(status: number): { ok: boolean; meaning: string } {
  switch (status) {
    case 200: return { ok: true, meaning: "accepted" };
    case 202: return { ok: true, meaning: "accepted, key validation pending" };
    case 400: return { ok: false, meaning: "bad request: the payload is malformed" };
    case 403: return { ok: false, meaning: "forbidden: the key file is missing or does not match" };
    case 422: return { ok: false, meaning: "unprocessable: a URL does not belong to the host" };
    case 429: return { ok: false, meaning: "too many requests: treated as spam" };
    default: return { ok: false, meaning: `unexpected status ${status}` };
  }
}
