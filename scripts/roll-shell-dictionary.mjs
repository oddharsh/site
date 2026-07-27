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
