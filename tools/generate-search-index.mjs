// Build the small, static corpus used by /search. The index is generated from
// the public source tree so search and the agent interface share the site's
// actual words without making the homepage pay for a client-side search bundle.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

// The served tree stopped being ONE directory on 2026-08-18: documents author in
// src/pages, prose in src/content, and only the bytes a browser fetches
// unchanged stay in public. This script still walked `www` afterwards, so it had
// been exiting ENOENT ever since and the committed index froze at whatever the
// last successful run produced. Nothing caught it, because the OUTPUT is
// committed: /search kept answering, out of a corpus nobody could rebuild.
//
// Hence three roots with three route mappings rather than one walk. A source
// path and a URL are different questions here, which is the same split
// CLAUDE.md draws for the client assets, and the mapping is the only place that
// knows the answer.
const ROOTS = [
  // Every HTML document, staged at its own path: garage/horizon.html -> /garage/horizon.
  { dir: "src/pages", route: (rel) => (
    rel === "index.html" ? "/"
      : rel.endsWith("/index.html") ? "/" + rel.slice(0, -"/index.html".length)
        : rel.endsWith(".html") ? "/" + rel.slice(0, -5)
          : null) },
  // Authored prose. The writing posts are .txt served at /writing/<slug>; of the
  // four Markdown files beside them only auth.md is a public URL, and index.md
  // (the homepage's twin) deliberately is not — indexing it would enter the
  // homepage's own words a second time under a second URL.
  { dir: "src/content", route: (rel) => (
    rel.startsWith("writing/") && rel.endsWith(".txt") ? "/writing/" + rel.slice("writing/".length, -4)
      : rel === "auth.md" ? "/auth.md"
        : null) },
  // Bytes, not documents. llms.txt is the one indexable thing in here.
  { dir: "public", route: (rel) => (rel === "llms.txt" ? "/llms.txt" : null) },
];
const OUT = join("public", "search-index.json");
const MAX_TEXT = 1800;
const SKIP_DIRS = new Set(["images", "i", "meta", "full", ".wrangler", "og", "cars", "dict", "a", "node_modules"]);
// Worker-rendered utilities the source-tree walk below can't see (no static
// file), injected from the surface registry so search and the shell share one
// list. Static pages are auto-indexed by the walk regardless of the manifest.
const manifest = JSON.parse(await readFile("config/site-manifest.json", "utf8"));
const MANUAL = manifest.surfaces
  .filter((s) => s.flags.searchIndex)
  .map((s) => [s.path, s.title, s.description, "utility"]);

// A code point becomes a character unless it is a control character, which has
// no business in a title or a description and would ride into the JSON as an
// escape nobody can read.
function safeChar(code) {
  if (!Number.isFinite(code) || code < 0x20 || (code >= 0x7f && code <= 0x9f)) return " ";
  try { return String.fromCodePoint(code); } catch { return " "; }
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  middot: "·", bull: "•", hellip: "…", mdash: "—", ndash: "–", minus: "-",
  ldquo: "\u201c", rdquo: "\u201d", lsquo: "\u2018", rsquo: "\u2019",
  times: "×", divide: "÷", plusmn: "±", deg: "°", micro: "µ",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔",
  le: "≤", ge: "≥", ne: "≠", asymp: "≈", infin: "∞", radic: "√", sum: "∑",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", lambda: "λ",
  mu: "μ", pi: "π", sigma: "σ", tau: "τ", phi: "φ", omega: "ω",
  copy: "©", reg: "®", trade: "™", sect: "§", para: "¶", dagger: "†",
  euro: "€", pound: "£", yen: "¥", cent: "¢",
};

function stripMarkup(value) {
  return String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    // comments BEFORE tags. this site's HTML is deliberately comment-heavy for
    // View Source, and a `>` inside a comment (an arrow, a shell redirect, a
    // nested tag name) made the tag pattern below match only as far as that
    // `>` and spill the rest of the comment into the indexed text.
    .replace(/<!--[\s\S]*?-->/g, " ")
    // quote-aware tag match: `[^>]+` stopped at the first `>` even when it sat
    // inside an attribute value, leaving a `">` fragment in 28 of 47 records.
    // Consume quoted runs whole so only a real tag-closing `>` ends the match.
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " ")
    // Decode ALL character references, not the six this used to know. The
    // leftovers were survivable while these records only ever became a search
    // snippet, and stopped being survivable when /ask started publishing them
    // inside a schema.org object: `description` is then structured data handed
    // to a machine, and "&middot;" in it is simply a wrong value. Numeric first,
    // then the named ones this site's prose actually uses.
    .replace(/&#(\d+);/g, (_m, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => safeChar(parseInt(n, 16)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, name) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleFor(text, path) {
  const htmlTitle = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const headingMd = text.match(/^#\s+(.+)$/m)?.[1];
  return stripMarkup(htmlTitle || heading || headingMd || path.split("/").pop() || "aadhar.sh").slice(0, 140);
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || (entry.isDirectory() && SKIP_DIRS.has(entry.name))) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

const records = [];
for (const [url, title, description, kind] of MANUAL) records.push({ url, title, description, text: `${title} ${description}`, kind });
for (const root of ROOTS) {
  for (const file of await walk(root.dir)) {
    const rel = relative(root.dir, file).replaceAll("\\", "/");
    const url = root.route(rel);
    if (!url || url === "/search") continue;
    if (!/\.(?:html|md|txt)$/i.test(rel)) continue;
    const raw = await readFile(file, "utf8");
    const text = stripMarkup(raw).slice(0, MAX_TEXT);
    if (!text) continue;
    records.push({
      url,
      title: titleFor(raw, url),
      description: text.slice(0, 240),
      text,
      kind: rel.endsWith(".txt") ? "writing" : rel.endsWith(".md") ? "document" : "page",
    });
  }
}

const byUrl = new Map(records.map((record) => [record.url, record]));
const result = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
await mkdir("public", { recursive: true });
await writeFile(OUT, JSON.stringify({ version: 1, generatedAt: "source-tree", records: result }, null, 2) + "\n");
console.log(`search index: ${result.length} records -> ${OUT}`);
