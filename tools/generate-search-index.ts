// Build the small, static corpus used by /search. The index is generated from
// the public source tree so search and the agent interface share the site's
// actual words without making the homepage pay for a client-side search bundle.
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { stripRawText } from "./lib/html-raw-text.ts";

// THE INDEX IS BUILD OUTPUT AND IS NEVER COMMITTED. It froze twice while it was
// a checked-in file, and the two causes were different, which is the argument
// for taking the file away rather than fixing the cause again:
//
//   1. 2026-08-18. The served tree stopped being ONE directory: documents author
//      in src/pages, prose in src/content, and only the bytes a browser fetches
//      unchanged stay in public. This script still walked `www`, so it exited
//      ENOENT and the index froze at whatever the last good run produced.
//   2. 2026-08-24. The roots were correct and nobody ran the script. #542 added
//      /garage/hidden-flags, /garage/typed-config and /lwe/fuse, and the index
//      kept describing a site of 54 pages that had 57.
//
// Both were silent for the same reason, and it was never the cause: /search
// answers out of the committed corpus, so a stale index is a working page with
// three pages missing from it, and /ask publishes those same records as
// schema.org objects, so a missing record is a page an agent cannot find. There
// is no error either failure could have raised. Nothing but a diff would do.
//
// So build.ts step 1i calls buildSearchIndex() and writes the result into the
// staged tree, on the argument CLAUDE.md already makes for the Markdown twins:
// a pure function of committed source bytes should be BUILT rather than
// committed, because then there is no second copy that can fall behind. The
// third failure of this kind is now impossible rather than merely watched for.
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
// A real annotation rather than JSDoc, because this is a .ts file and a @typedef
// here would be inert (CLAUDE.md gotcha 42). Without it `const records = []`
// infers never[] and every consumer reading record.url is a type error.
export type SearchRecord = {
  url: string;
  title: string;
  description: string;
  text: string;
  kind: "page" | "writing" | "document" | "utility";
};

const MAX_TEXT = 1800;
const SKIP_DIRS = new Set(["images", "i", "meta", "full", ".wrangler", "og", "cars", "dict", "a", "node_modules"]);

// Worker-rendered utilities the source-tree walk below can't see (no static
// file), injected from the surface registry so search and the shell share one
// list. Static pages are auto-indexed by the walk regardless of the manifest.
async function manualRecords(root) {
  const manifest = JSON.parse(await readFile(join(root, "config/site-manifest.json"), "utf8"));
  return manifest.surfaces
    .filter((s) => s.flags.searchIndex)
    .map((s) => [s.path, s.title, s.description, "utility"]);
}

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
  // script and style are removed by SCAN rather than by a regex per element,
  // because a `<\/script>` pattern misses `</script >`, `</script\t\n bar>` and
  // `</script/>`, and a missed close spills a script body into the indexed text
  // of a record that /ask now publishes as a schema.org description. The scan
  // and the shapes it accepts are argued at tools/lib/html-raw-text.ts.
  return stripRawText(stripRawText(String(value || ""), "script"), "style")
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

/**
 * The whole corpus, as the payload /search-index.json carries. A pure function
 * of committed bytes (the three ROOTS plus site-manifest.json), which is why
 * step 1h of the build calls this instead of a checked-in file existing at all.
 */
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
  return { version: 1, generatedAt: "source-tree", records: [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url)) };
}

// Follow a symlink chain by hand to the path a write would LAND on, dangling
// links included. Bounded because a symlink loop is otherwise a hang.
export async function linkTarget(path: string): Promise<string> {
  let current = resolve(path);
  for (let hop = 0; hop < 10; hop++) {
    const info = await lstat(current).catch(() => null);
    if (!info?.isSymbolicLink()) return current;
    current = resolve(dirname(current), await readlink(current));
  }
  return current;
}

// Same CLI shape as gen-md-twins.ts: the argument is the STAGED tree to write
// into, defaulting to the build's, because there is no longer a copy in the
// source tree for a bare run to refresh. Useful by hand for `bun run dev`,
// where /search is otherwise a build-only surface (see the note at the top).
async function main() {
  const outDir = process.argv[2] || ".build/public";
  const payload = await buildSearchIndex(".");
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, "search-index.json");

  // Resolve SYMLINKS before writing, because the dev farm is made of them and
  // one of them points here. .dev-assets/search-index.json was staged while the
  // index was still committed, so it still points at ../public/search-index.json
  // long after that file is gone; `search:index .dev-assets` then writes THROUGH
  // the dangling link and recreates the committed copy in the source tree. Hit
  // on the change that removed it, and the first guard written for it MISSED,
  // because it resolved the parent DIRECTORY (a real directory) when the symlink
  // is the FILE. realpath() is no use either: it throws on a dangling link, and
  // dangling is precisely the state the farm leaves behind. So walk the chain.
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
