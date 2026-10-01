// The served manifest: every URL a built static tree serves, mapped to the
// sha256 of the bytes a reader should get back from it.
//
// Two builders make the same commit here. GitHub's `validate` job builds it to
// test it, and Workers Builds builds it again to ship it. Everything in this repo
// that calls a build "a pure function of the commit" (the q11 twins, the dcz
// deltas, the 0-of-1443 asset upload after the bun cutover) is a claim that
// those two agree, and until 2026-10-01 nothing compared them. CI now cuts this
// manifest from its own build and signs it (actions/attest-build-provenance), and
// tools/check-served.ts fetches each URL from production and compares.
//
// The first comparison, 2026-10-01: a macOS build of 5fb917b3 against the Linux
// Workers Builds build production served, 1849 of 1850 URLs identical after
// decoding. The 1850th was a real bug: /dotfiles/index.src.html answered 307,
// because that section postdated build.ts's text-twin allowlist.
//
// WHAT IT CAN AND CANNOT SEE. It covers the static tree, documents included,
// because a built document is served byte for byte (precompressed, so nothing
// rewrites it on the way out). It cannot cover the Worker bundle, since no public
// URL returns those bytes, or a route the Worker renders per request. Say so
// wherever its verdict is quoted.
//
// Pure and node-safe: fetch is injected, nothing reads repo globals, so it can
// leave this repository the way timbrado and halflight did.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

export const SCHEMA = "aadhar.sh/served-manifest/v1";

export interface ServedManifest {
  schema: typeof SCHEMA;
  /** The commit CI built; null for a local build of a tree nobody committed. */
  commit: string | null;
  /** URL path -> sha256 hex of the decoded body a GET should return. */
  files: Record<string, string>;
}

// ── which staged files are URLs ──────────────────────────────────────────────

// Files in the staged tree that are config or an ENCODING rather than a URL of
// their own. A `.br` or `.dcz` is how the Worker answers for its plain sibling,
// so the sibling's decoded body is what proves it; `_headers` is read by the
// asset layer and never served.
const NOT_URLS = new Set(["_headers", "_redirects", ".assetsignore"]);
const ENCODINGS = /\.(?:br|dcz)$/;

/**
 * `.assetsignore` patterns, in the subset this repo uses: a bare name matches
 * that path segment at any depth (gitignore's rule for a pattern with no
 * slash), a leading `/` anchors it to the root, and `*` matches within a
 * segment. Anything else THROWS, so a rule this reader would misread fails the
 * manifest instead of quietly listing a file the asset upload skips.
 */
export function parseAssetsIgnore(text: string): (rel: string) => boolean {
  const rules = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const matchers = rules.map((rule) => {
    if (rule.startsWith("!") || rule.includes("**") || /[?[\]\\]/.test(rule)) {
      throw new Error(`.assetsignore: ${JSON.stringify(rule)} uses syntax served-manifest does not implement; extend parseAssetsIgnore first`);
    }
    const anchored = rule.startsWith("/");
    const body = rule.replace(/^\//, "").replace(/\/$/, "");
    const parts = body.split("/").map((seg) => new RegExp(`^${seg.replace(/[.+^${}()|]/g, "\\$&").replace(/\*/g, "[^/]*")}$`));
    return (rel: string) => {
      const segs = rel.split("/");
      const starts = anchored || parts.length > 1 ? [0] : segs.map((_, i) => i);
      return starts.some((s) => parts.every((re, k) => s + k < segs.length && re.test(segs[s + k])));
    };
  });
  return (rel) => matchers.some((m) => m(rel));
}

/** True when a staged file is served at a URL of its own. */
export function isServedFile(rel: string, ignored: (rel: string) => boolean): boolean {
  if (ignored(rel)) return false;
  if (NOT_URLS.has(posix.basename(rel))) return false;
  return !ENCODINGS.test(rel);
}

/**
 * The canonical URL for a staged file, the one a GET answers 200 on with no
 * redirect. The asset layer's html_handling serves `x.html` at `/x` and
 * `dir/index.html` at `/dir` (it 307s both the `.html` and the trailing-slash
 * forms there). The readable `.src.html` twins are the exception: the Worker
 * answers them at their full name, which is what each page's banner links.
 */
export function canonicalUrl(rel: string): string {
  if (rel === "index.html") return "/";
  if (rel.endsWith(".src.html")) return `/${rel}`;
  if (rel.endsWith("/index.html")) return `/${rel.slice(0, -"/index.html".length)}`;
  if (rel.endsWith(".html")) return `/${rel.slice(0, -".html".length)}`;
  return `/${rel}`;
}

// ── making one ───────────────────────────────────────────────────────────────

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(root, p, out);
    else out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

/** Cut a manifest from a staged tree (`.build/public`). */
export function buildManifest(root: string, commit: string | null): ServedManifest {
  let ignoreText = "";
  try { ignoreText = readFileSync(join(root, ".assetsignore"), "utf8"); } catch { /* no file, nothing ignored */ }
  const ignored = parseAssetsIgnore(ignoreText);
  const files: Record<string, string> = {};
  for (const rel of walk(root).sort()) {
    if (!isServedFile(rel, ignored)) continue;
    const url = canonicalUrl(rel);
    if (files[url]) throw new Error(`served-manifest: two staged files claim ${url}; canonicalUrl cannot tell them apart`);
    files[url] = sha256(readFileSync(join(root, rel)));
  }
  return { schema: SCHEMA, commit, files };
}

/** Stable bytes, so two builds of one commit write identical manifests. */
export function serializeManifest(m: ServedManifest): string {
  const files = Object.fromEntries(Object.keys(m.files).sort().map((k) => [k, m.files[k]]));
  return `${JSON.stringify({ schema: m.schema, commit: m.commit, files }, null, 1)}\n`;
}

/**
 * Parse and VALIDATE: a downloaded manifest is input, and one malformed entry
 * would otherwise surface as a confusing mismatch on whatever URL it named.
 */
export function parseManifest(text: string): ServedManifest {
  const m = JSON.parse(text);
  if (m?.schema !== SCHEMA) throw new Error(`served-manifest: schema is ${JSON.stringify(m?.schema)}, expected ${SCHEMA}`);
  if (m.commit !== null && !/^[0-9a-f]{40}$/.test(String(m.commit))) throw new Error(`served-manifest: commit ${JSON.stringify(m.commit)} is neither null nor a 40-hex commit`);
  if (m.files === null || m.files === undefined || Array.isArray(m.files) || Object.getPrototypeOf(m.files) !== Object.prototype) {
    throw new Error("served-manifest: files is not a URL-to-sha256 map");
  }
  const files: Record<string, string> = {};
  for (const [url, digest] of Object.entries(m.files)) {
    if (!url.startsWith("/") || !/^[0-9a-f]{64}$/.test(String(digest))) throw new Error(`served-manifest: ${JSON.stringify(url)} -> ${JSON.stringify(digest)} is not a path and a sha256`);
    files[url] = String(digest);
  }
  return { schema: SCHEMA, commit: m.commit, files };
}

/** URLs whose expected bytes differ, or that are new, in `next` against `prev`. */
export function changedUrls(prev: ServedManifest, next: ServedManifest): string[] {
  return Object.keys(next.files).filter((u) => prev.files[u] !== next.files[u]).sort();
}

// ── checking one against an origin ───────────────────────────────────────────

export type Verdict = "match" | "mismatch" | "redirect" | "status" | "error";

export interface UrlResult { url: string; verdict: Verdict; detail?: string }

export interface CheckOptions {
  origin: string;
  urls: string[];
  concurrency?: number;
  /** The one call this makes, so a test can stand in for the network. */
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
}

/**
 * GET each URL and compare the DECODED body's sha256 with the manifest. Decoded
 * because a worker cannot negotiate encoding (gotcha 13) and the brotli stream
 * at q11 is not the same bytes on every machine (gotcha 14); what a reader holds
 * after decoding is the claim. Redirects are not followed: the manifest names
 * canonical URLs, so a 3xx means the URL rule and the site disagree, which is a
 * finding about this tool or the site and never a match.
 */
export async function checkOrigin(manifest: ServedManifest, opts: CheckOptions): Promise<UrlResult[]> {
  const get = opts.fetch ?? fetch;
  const queue = [...opts.urls];
  const results: UrlResult[] = [];
  const one = async (url: string): Promise<UrlResult> => {
    const want = manifest.files[url];
    if (!want) return { url, verdict: "error", detail: "not in the manifest" };
    try {
      const r = await get(new URL(url, opts.origin), { redirect: "manual", headers: { accept: "*/*", ...opts.headers } });
      const body = new Uint8Array(await r.arrayBuffer());
      if (r.status >= 300 && r.status < 400) return { url, verdict: "redirect", detail: `${r.status} -> ${r.headers.get("location")}` };
      if (r.status !== 200) return { url, verdict: "status", detail: String(r.status) };
      const got = sha256(body);
      return got === want ? { url, verdict: "match" } : { url, verdict: "mismatch", detail: `${body.length} B, ${r.headers.get("content-type") ?? "no type"}` };
    } catch (e) {
      return { url, verdict: "error", detail: (e as Error).message };
    }
  };
  const lanes = Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) results.push(await one(url));
  });
  await Promise.all(lanes);
  return results.sort((a, b) => a.url.localeCompare(b.url));
}
