#!/usr/bin/env node
// roll-shell-dictionary.mjs — adopt the CURRENT built shell as a dictionary candidate.
//
//   npm run shell:roll
//
// This is all that remains of the old gen-shell-deltas.mjs. The deltas themselves moved
// into build.mjs once it turned out node:zlib's zstd takes a `dictionary` option (the
// "unreachable from Node" limit was BROTLI's, and I had over-generalized it), so they are
// build output now: no zstd CLI, no committed artifacts, nothing to forget.
//
// Rolling stays a deliberate human step for one reason: it WRITES INTO THE SOURCE TREE, and
// build.mjs must never do that. Its output has to be committed, because a dictionary must be
// bytes the BROWSER already holds, which no build can derive from source.
//
// Rolling is also not urgent. A dictionary 11 days stale still delivered 87-93%, so the
// useful cadence is "occasionally", not "every deploy".

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { brotliCompressSync, brotliDecompressSync, constants as zc } from "node:zlib";
import { existsSync } from "node:fs";

const BUILT = ".build/holding/a";
const DICTS = "holding/a-dict";
// Each extra candidate costs one delta per asset per deploy and widens the cache-variant
// fan-out, while only serving visitors who skipped exactly that many deploys.
const KEEP = 3;

// js and css only, matching DICTIONARY_TYPES in _worker.js/lib/assets.js. The icon
// sprite is served as plain brotli and never as a delta, so adopting it would file
// candidates nothing can ever read — and the roller would keep filing a new one on
// every sprite change, forever.
const parse = (n) => {
  const m = n.match(/^(.+)\.([0-9a-f]{8})\.(js|css)$/);
  return m ? { base: m[1], hash8: m[2], ext: m[3], name: n } : null;
};

if (!existsSync(BUILT)) {
  console.error(`shell:roll — ${BUILT} is missing. Run \`node build.mjs\` first: the /a/ hashes`);
  console.error("  come from the MINIFIED bytes, so the built tree is the only place they exist.");
  process.exit(1);
}

await mkdir(DICTS, { recursive: true });
const shell = (await readdir(BUILT)).map(parse).filter(Boolean);
let adopted = 0;
for (const a of shell) {
  if (existsSync(`${DICTS}/${a.name}`)) continue;
  await writeFile(`${DICTS}/${a.name}`, await readFile(`${BUILT}/${a.name}`));
  adopted++;
  console.log(`adopted ${a.name}`);
}

// Prune per base, so a rarely-changing asset (icons.svg) keeps its history instead of being
// evicted by a churny neighbour (nav.js). mtime is the only ordering available — a content
// hash carries none.
const byBase = new Map();
for (const d of (await readdir(DICTS)).map(parse).filter(Boolean)) {
  if (!byBase.has(d.base)) byBase.set(d.base, []);
  byBase.get(d.base).push(d);
}
let pruned = 0;
for (const [, group] of byBase) {
  if (group.length <= KEEP) continue;
  const withTime = await Promise.all(group.map(async (g) => ({ g, t: (await stat(`${DICTS}/${g.name}`)).mtimeMs })));
  withTime.sort((a, b) => a.t - b.t);
  for (const { g } of withTime.slice(0, withTime.length - KEEP)) {
    await rm(`${DICTS}/${g.name}`, { force: true });
    pruned++;
    console.log(`pruned ${g.name}`);
    }
}
console.log(`shell:roll — adopted ${adopted}, pruned ${pruned}, keeping ${KEEP} per asset.`);
console.log("  Commit holding/a-dict/. build.mjs regenerates the deltas on its own from here.");

// ── PAGE DICTIONARIES (holding/p-dict) ──────────────────────────────────────────
// The same roll, for the 30 static garage/lwe pages. Without this the page dictionary
// set decays exactly the way a-dict did before #117: seeded once, covering only the
// version nobody holds anymore. Snapshots are stored BROTLI'd (build input, never
// served, round-trips exactly), which keeps the committed weight ~75% down.
//
// KEEP is 2 here, not 3. A page delta serves whoever holds the CURRENT or PREVIOUS
// version of that page; pages change one at a time (unlike the shell, which ripples
// through every page on any hash change), so the third candidate would mostly cover
// visitors of a version two edits back — while doubling the committed weight of the
// biggest directory in the repo.
{
  const BUILT_PAGES = ".build/holding";
  const PDICTS = "holding/p-dict";
  const KEEP_PAGES = 2;
  const parse = (n) => {
    const m = n.match(/^(.+)\.([0-9a-f]{16})\.html\.br$/);
    return m ? { slug: m[1], tag: m[2], name: n } : null;
  };
  await mkdir(PDICTS, { recursive: true });
  const staged = [];
  for (const dir of ["garage", "lwe"]) {
    for (const rel of await readdir(`${BUILT_PAGES}/${dir}`, { recursive: true }).catch(() => [])) {
      if (rel.endsWith(".html") && !rel.endsWith(".src.html")) staged.push(`${dir}/${rel}`);
    }
  }
  const liveSlugs = new Set();
  let adopted = 0, pruned = 0;
  const { createHash } = await import("node:crypto");
  for (const rel of staged) {
    const slug = rel.replace(/\.html$/, "").replace(/\//g, "__");
    liveSlugs.add(slug);
    const bytes = await readFile(`${BUILT_PAGES}/${rel}`);
    const tag = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const dest = `${PDICTS}/${slug}.${tag}.html.br`;
    if (existsSync(dest)) continue;
    await writeFile(dest, brotliCompressSync(bytes, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_LGWIN]: 24 } }));
    adopted++;
    console.log(`adopted page ${slug}.${tag}`);
  }
  const byent = new Map();
  for (const d of (await readdir(PDICTS)).map(parse).filter(Boolean)) {
    // A slug that no longer exists on the site keeps no candidates at all: its deltas
    // could never be requested, and the dead snapshots would sit in git forever.
    if (!liveSlugs.has(d.slug)) { await rm(`${PDICTS}/${d.name}`, { force: true }); pruned++; continue; }
    if (!byent.has(d.slug)) byent.set(d.slug, []);
    byent.get(d.slug).push(d);
  }
  for (const [, group] of byent) {
    if (group.length <= KEEP_PAGES) continue;
    const withTime = await Promise.all(group.map(async (g) => ({ g, t: (await stat(`${PDICTS}/${g.name}`)).mtimeMs })));
    withTime.sort((a, b) => a.t - b.t);
    for (const { g } of withTime.slice(0, withTime.length - KEEP_PAGES)) {
      await rm(`${PDICTS}/${g.name}`, { force: true });
      pruned++;
    }
  }
  console.log(`pages:roll — adopted ${adopted}, pruned ${pruned}, keeping ${KEEP_PAGES} per page.`);
}
