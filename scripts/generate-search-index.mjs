// Build the small, static corpus used by /search. The index is generated from
// the public source tree so search and the agent interface share the site's
// actual words without making the homepage pay for a client-side search bundle.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const ROOT = "www";
const OUT = join(ROOT, "search-index.json");
const MAX_TEXT = 1800;
const SKIP_DIRS = new Set(["images", "i", "meta", "full", ".wrangler"]);
// Worker-rendered utilities the source-tree walk below can't see (no static
// file), injected from the surface registry so search and the shell share one
// list. Static pages are auto-indexed by the walk regardless of the manifest.
const manifest = JSON.parse(await readFile("config/site-manifest.json", "utf8"));
const MANUAL = manifest.surfaces
  .filter((s) => s.flags.searchIndex)
  .map((s) => [s.path, s.title, s.description, "utility"]);

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
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " }[m] || " "))
    .replace(/\s+/g, " ")
    .trim();
}

function titleFor(text, path) {
  const htmlTitle = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const headingMd = text.match(/^#\s+(.+)$/m)?.[1];
  return stripMarkup(htmlTitle || heading || headingMd || path.split("/").pop() || "aadhar.sh").slice(0, 140);
}

function routeFor(rel) {
  if (rel === "index.html") return "/";
  if (rel.endsWith("/index.html")) return "/" + rel.slice(0, -"/index.html".length);
  if (rel.endsWith(".html")) return "/" + rel.slice(0, -5);
  if (rel.startsWith("writing/") && rel.endsWith(".txt")) return "/writing/" + rel.slice("writing/".length, -4);
  if (rel === "llms.txt" || rel === "auth.md") return "/" + rel;
  return null;
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
for (const file of await walk(ROOT)) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  const url = routeFor(rel);
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

const byUrl = new Map(records.map((record) => [record.url, record]));
const result = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
await mkdir(join(ROOT), { recursive: true });
await writeFile(OUT, JSON.stringify({ version: 1, generatedAt: "source-tree", records: result }, null, 2) + "\n");
console.log(`search index: ${result.length} records -> ${OUT}`);
