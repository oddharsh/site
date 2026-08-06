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
import { brotliCompressSync, brotliDecompressSync, constants as zc } from "node:zlib";

const ORIGIN = process.env.ROLL_ORIGIN || "https://aadhar.sh";

// The two halves stopped sharing a sourcing rule once page snapshots moved to the
// wire, so they can now be rolled separately. SHELL adoption reads the local built
// tree and is therefore only valid from the deployed commit (a branch build mints
// different `/a/` hashes, so its candidates are bytes no browser will ever hold).
// PAGE adoption reads production, so it is correct from anywhere and is the repair
// step whenever an edge feature starts rewriting documents. Default stays both.
const only = process.argv.includes("--pages") ? "pages"
           : process.argv.includes("--shell") ? "shell"
           : "both";

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

if (only === "pages") console.log("shell:roll — --pages given, leaving holding/a-dict/ alone.");
else {
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
}

// ── PAGE DICTIONARIES (holding/p-dict) ──────────────────────────────────────────
// Static pages have two useful dictionary populations. The immutable family corpus
// reaches every visitor who has loaded any page; these committed snapshots recover
// the 93-97% per-page ratio for visitors returning to a page they already hold.
// Snapshots are stored Brotli-compressed (build input only, never served), so the
// committed weight stays bounded while the dictionary bytes round-trip exactly.
//
// index.html used to be filtered out here, because `/` shipped no-cache and no
// browser would keep a dictionary offered under it, so a snapshot could only ever
// produce a delta nothing could ask for. `/` now takes PAGE_CACHE_CONTROL like every
// other document, so the exclusion is gone and the homepage earns the per-page tier.
//
// **Adoption reads PRODUCTION OVER THE WIRE, not the staged build**, and that is
// the whole correctness argument for this block. A dictionary is matched by the
// SHA-256 the browser computes over the body it stored, so the only bytes worth
// committing are the bytes production actually delivered. Those two used to be
// identical, which made reading `.build/holding` a harmless shortcut — until
// WebMCP was enabled on 2026-08-06 and Cloudflare began injecting
// `<script src="/.webmcp/bridge.js">` into every document with HTMLRewriter, at
// the edge, after this Worker is done. The staged file has no such tag, so every
// snapshot rolled from it hashed to something no browser could ever offer and the
// per-page tier silently fell back to the family dictionary. Measured on
// /garage/pretext: offering the committed tag answered `dcz`, offering the tag of
// the live body answered `br`.
//
// The general rule is worth more than the WebMCP instance: ANY edge feature that
// rewrites HTML after the Worker — an injected beacon, an A/B mutation, Email
// Obfuscation, Rocket Loader — breaks a dictionary derived from source, and breaks
// it without an error anywhere. Read the wire.
//
// Two consequences of reading the wire, both deliberate. Rolling now needs network
// and has to run against the DEPLOYED commit (which the shell half above already
// required). And a staged page production does not serve yet is SKIPPED with a
// named line rather than adopted, because a browser cannot hold bytes that were
// never sent to it.
if (only === "shell") console.log("pages:roll — --shell given, leaving holding/p-dict/ alone.");
else {
  const BUILT_PAGES = ".build/holding";
  const PDICTS = "holding/p-dict";
  const KEEP_PAGES = 2;
  const FETCH_CONCURRENCY = 6;
  const parse = (n) => {
    const m = n.match(/^(.+)\.([0-9a-f]{16})\.html\.br$/);
    return m ? { slug: m[1], tag: m[2], name: n } : null;
  };
  // `.build/holding/garage/pretext.html` is served at `/garage/pretext`, and an
  // index file is served at its directory: `garage/index.html` -> `/garage`,
  // `index.html` -> `/`.
  const routeOf = (rel) => {
    const path = rel.replace(/\.html$/, "").replace(/(^|\/)index$/, "$1");
    return `/${path}`.replace(/\/$/, "") || "/";
  };
  await mkdir(PDICTS, { recursive: true });
  const staged = (await readdir(BUILT_PAGES, { recursive: true }))
    .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html"));
  const liveSlugs = new Set();
  let adopted = 0, pruned = 0, missing = 0;
  const { createHash } = await import("node:crypto");

  // Ask for brotli and decode what comes back, rather than asking for `identity`
  // and trusting it. The Worker precompresses and cannot negotiate (gotcha 13), and
  // undici transparently decodes br while LEAVING the header in place, so neither
  // the request header nor the response header is evidence about the bytes in hand.
  // Try the decode, keep whatever survives — the same defence check-dictionary-support.mjs
  // documents at its own decode.
  const deliveredBytes = async (route) => {
    const res = await fetch(`${ORIGIN}${route}`, { headers: { "accept-encoding": "br" } });
    if (!res.ok) return { status: res.status, bytes: null };
    const body = Buffer.from(await res.arrayBuffer());
    let raw = body;
    try { raw = brotliDecompressSync(body); } catch { /* already plain */ }
    return { status: res.status, bytes: raw };
  };

  const jobs = staged.map((rel) => ({ rel, slug: rel.replace(/\.html$/, "").replace(/\//g, "__"), route: routeOf(rel) }));
  for (const job of jobs) liveSlugs.add(job.slug);
  for (let i = 0; i < jobs.length; i += FETCH_CONCURRENCY) {
    const batch = jobs.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(async (job) => {
      try { return { job, ...(await deliveredBytes(job.route)) }; }
      catch (err) { return { job, status: null, bytes: null, err }; }
    }));
    for (const { job, status, bytes, err } of results) {
      if (!bytes) {
        // Loud, and not fatal. A page added in this very commit legitimately 404s
        // until it deploys; a network failure legitimately wants a re-run. Either
        // way the honest outcome is no snapshot, said out loud.
        console.log(`skipped page ${job.slug} — ${ORIGIN}${job.route} answered ${err ? err.message : status}`);
        missing++;
        continue;
      }
      const tag = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const dest = `${PDICTS}/${job.slug}.${tag}.html.br`;
      if (existsSync(dest)) continue;
      await writeFile(dest, brotliCompressSync(bytes, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_LGWIN]: 24 } }));
      adopted++;
      console.log(`adopted page ${job.slug}.${tag}`);
    }
  }
  const byent = new Map();
  for (const d of (await readdir(PDICTS)).map(parse).filter(Boolean)) {
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
  console.log(`pages:roll — adopted ${adopted}, pruned ${pruned}, skipped ${missing}, keeping ${KEEP_PAGES} per page (source: ${ORIGIN}).`);
}
