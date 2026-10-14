// Build the small, static corpus used by /search. The index is generated from
// the public source tree so search and the agent interface share the site's
// actual words without making the homepage pay for a client-side search bundle.
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { stripRawText } from "./lib/html-raw-text.ts";
import { readDocument } from "./lib/html-to-md.ts";
import type { SearchRecord } from "../src/worker/search.ts";
export type { SearchRecord } from "../src/worker/search.ts";

const ROOTS = [
  { dir: "src/pages", route: (rel) => (
    rel === "index.html" ? "/"
      : rel.endsWith("/index.html") ? "/" + rel.slice(0, -"/index.html".length)
        : rel.endsWith(".html") ? "/" + rel.slice(0, -5)
          : null) },
  { dir: "src/content", route: (rel) => (
    rel.startsWith("writing/") && rel.endsWith(".txt") ? "/writing/" + rel.slice("writing/".length, -4)
      : null) },
  { dir: "public", route: (rel) => (rel === "llms.txt" ? "/llms.txt" : null) },
];
const SKIP_DIRS = new Set(["images", "i", "meta", "full", ".wrangler", "og", "cars", "dict", "a", "node_modules"]);

async function manualRecords(root) {
  const manifest = JSON.parse(await readFile(join(root, "config/site-manifest.json"), "utf8"));
  return manifest.surfaces
    .filter((s) => s.flags.searchIndex)
    .map((s) => [s.path, s.title, s.description, "utility"]);
}

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
  return stripRawText(stripRawText(String(value || ""), "script"), "style")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " ")
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

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || (entry.isDirectory() && SKIP_DIRS.has(entry.name))) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

export async function buildSearchIndex(root = "."): Promise<{ version: number; generatedAt: string; records: SearchRecord[] }> {
  const records: SearchRecord[] = [];
  for (const [url, title, description, kind] of await manualRecords(root)) {
    records.push({ url, title, description, text: `${title} ${description}`, kind });
  }
  for (const source of ROOTS) {
    const dir = join(root, source.dir);
    for (const file of await walk(dir)) {
      const rel = relative(dir, file).replaceAll("\\", "/");
      const url = source.route(rel);
      if (!url || url === "/search") continue;
      if (!/\.(?:html|md|txt)$/i.test(rel)) continue;
      const raw = await readFile(file, "utf8");
      const doc = rel.endsWith(".html") ? readDocument(raw, { format: "text" }) : null;
      const text = doc ? doc.body : stripMarkup(raw);
      if (!text && !doc?.title && !doc?.description) continue;
      records.push({
        url,
        title: (doc?.title || titleFor(raw, url)).slice(0, 140),
        description: (doc?.description || text).replace(/\s+/g, " ").trim().slice(0, 240),
        text,
        kind: rel.endsWith(".txt") ? "writing" : rel.endsWith(".md") ? "document" : "page",
      });
    }
  }
  const byUrl = new Map(records.map((record) => [record.url, record]));
  return { version: 1, generatedAt: "source-tree", records: [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url)) };
}

export async function linkTarget(path: string): Promise<string> {
  let current = resolve(path);
  for (let hop = 0; hop < 10; hop++) {
    const info = await lstat(current).catch(() => null);
    if (!info?.isSymbolicLink()) return current;
    current = resolve(dirname(current), await readlink(current));
  }
  return current;
}

async function main() {
  const outDir = process.argv[2] || ".build/public";
  const payload = await buildSearchIndex(".");
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, "search-index.json");

  const target = await linkTarget(out);
  for (const forbidden of ["public", "src"]) {
    const root = resolve(forbidden);
    if (target === root || target.startsWith(root + sep)) {
      throw new Error(
        `search index: refusing to write into the source tree (${relative(".", target)}). ` +
        "The index is build output; it is staged into .build/ by build.ts step 1i and has no committed copy. " +
        (outDir.includes(".dev-assets")
          ? "This is the dev farm's stale symlink from the committed era — re-run `bun run dev` to re-stage it."
          : "Pass a staged tree instead."),
      );
    }
  }

  await writeFile(out, JSON.stringify(payload, null, 2) + "\n");
  console.log(`search index: ${payload.records.length} records -> ${out}`);
}

if (import.meta.main) await main();
