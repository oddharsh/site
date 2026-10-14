// IndexNow: tell search engines which pages a release actually changed.
//
// The key is public by design: the protocol proves ownership by serving it at
// /<key>.txt on the host, so it lives in this tree like any other static file.

import type { ServedManifest } from "./served-manifest.ts";

export const INDEXNOW_KEY = "57f3182c72aa0d0075d7128bf27cb016";
export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

export function sitemapPaths(xml: string, host: string): string[] {
  const paths: string[] = [];
  for (const [, loc] of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
    let url: URL;
    try { url = new URL(loc); } catch { continue; }
    if (url.protocol === "https:" && url.host === host) paths.push(url.pathname || "/");
  }
  return paths;
}

export function contentUrl(path: string, files: Record<string, string>): string | null {
  const twin = path === "/" ? "/index.md" : `${path}.md`;
  if (files[twin]) return twin;
  const txt = /^\/writing\/[^/]+$/.test(path) ? `${path}.txt` : null;
  if (txt && files[txt]) return txt;
  return files[path] ? path : null;
}

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
