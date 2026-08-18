#!/usr/bin/env node
// roll-shell-dictionary.mjs — adopt the CURRENT built shell as a dictionary candidate.
//
//   pnpm run shell:roll
//
// This is all that remains of the old gen-shell-deltas.mjs. The deltas themselves moved
// into build.mjs once it turned out node:zlib's zstd takes a `dictionary` option (the
// "unreachable from Node" limit was BROTLI's at the time, I had over-generalized it, and
// node 26 has since given brotli one as well), so they are
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
import { execFileSync } from "node:child_process";

// ------------------------------------------------------- adoption order ----

// **How old is a committed dictionary?** mtime cannot answer that, because
// `git checkout` stamps every file it writes with the checkout time — so in a
// fresh worktree (which the collaboration rules ask for) every pre-existing
// candidate is exactly as old as every other and the prune ordering degenerates
// to readdir order. It bit the page half on 2026-08-06: a roll from a clean
// worktree kept a snapshot from an old release and deleted the bytes production
// had been serving that morning, which is precisely the one a returning visitor
// could still offer.
//
// Commit time survives checkout, and one `git log` walk over the directory
// answers for every file at once. Anything this run confirmed as currently
// served is newest by definition; anything git has never seen falls back to
// mtime, which is all an untracked stray leaves us.
function gitTimes(dir) {
  const times = new Map();
  try {
    const log = execFileSync("git", ["log", "--format=%ct", "--name-only", "--", dir],
                             { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let t = 0;
    for (const line of log.split("\n")) {
      const row = line.trim();
      if (/^\d+$/.test(row)) { t = Number(row); continue; }
      const base = row.split("/").pop();
      // First mention wins: git log walks newest-first, and what matters is the
      // most recent commit that touched the file.
      if (base && !times.has(base)) times.set(base, t);
    }
  } catch {
    console.log(`  (no git history for ${dir}; falling back to mtime, which a fresh checkout flattens)`);
  }
  return times;
}

// Oldest first, so the caller can slice the head off.
async function oldestFirst(dir, group, { keep, current = new Set() }) {
  const times = gitTimes(dir);
  const withTime = await Promise.all(group.map(async (g) => ({
    g,
    t: current.has(g.name) ? Infinity
      : times.has(g.name) ? times.get(g.name)
      : (await stat(`${dir}/${g.name}`)).mtimeMs / 1000,
  })));
  withTime.sort((a, b) => a.t - b.t);
  return withTime.slice(0, Math.max(0, withTime.length - keep)).map((x) => x.g);
}

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

// --live sources the SHELL half from production instead of the built tree, which is
// the same argument the page half makes below: a dictionary is matched by the SHA-256
// the browser computed over the body it STORED, so the bytes worth committing are the
// bytes production actually delivered.
//
// For `/a/` assets the two are normally identical (no edge feature rewrites js/css the
// way WebMCP rewrites HTML), so this is not a correctness fix the way the page half was.
// What it buys is that adoption no longer has to run FROM the deployed commit. Reading
// the built tree can only ever capture the shell THIS checkout builds, so a release that
// went by without a roll is unrecoverable, and an unramped checkout would adopt bytes no
// browser holds and evict one that is still in use (KEEP is 3). Reading the wire captures
// whatever is live, from anywhere, which is what lets a scheduled job do this unattended.
const live = process.argv.includes("--live");

const BUILT = ".build/public/a";
const DICTS = "src/dict/a-dict";
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

if (!live && !existsSync(BUILT)) {
  console.error(`shell:roll — ${BUILT} is missing. Run \`node tools/build.mjs\` first: the /a/ hashes`);
  console.error("  come from the MINIFIED bytes, so the built tree is the only place they exist.");
  console.error("  Or pass --live to adopt what production is serving instead, which needs no build.");
  process.exit(1);
}

// The live shell, read the way the page half reads pages. No single document references
// every dictionary-carrying asset, so this walks a few: the homepage pulls nav + luna +
// hoist + tooltip, /lens pulls lens-boot, an LWE page pulls lwe-base.css and quiz.js.
//
// Walking DOCUMENTS alone is not enough, and the gap was silent for as long as --live has
// been the nightly path. An asset loaded lazily from JavaScript appears in no document, so
// an HTML-only scan found 8 of 19 and the other 11 had never been given a dictionary at
// all — including nav-run, nav-tray and infotip, which nav.js pulls on EVERY page, so a
// returning visitor re-downloaded them in full where a delta is a few hundred bytes.
//
// The references are transitive (/lens -> lens-boot -> lens -> lens-tools is three hops),
// so this closes over the graph rather than following a level and calling it done.
//
// Bodies are CACHED because the adoption loop below wants the same bytes. Fetching twice
// costs a second request per asset and, worse, opens a window for a deploy to land between
// the scan and the adopt, which would store bytes this run never actually read.
const liveBody = new Map();
const assetRefs = (body) => [...body.toString("utf8").matchAll(/\/a\/([\w-]+\.[0-9a-f]{8}\.(?:js|css))/g)].map(([, n]) => n);

async function fetchLive(path) {
  let r;
  try { r = await fetch(`${ORIGIN}${path}`, { headers: { "accept-encoding": "identity" } }); }
  catch (e) { console.log(`  skipped ${path} (${e.message})`); return null; }
  if (!r.ok) { console.log(`  skipped ${path} (HTTP ${r.status})`); return null; }
  return Buffer.from(await r.arrayBuffer());
}

async function liveShell() {
  const names = new Set();
  for (const path of ["/", "/lens", "/lwe/utf8", "/writing"]) {
    const body = await fetchLive(path);
    if (body) for (const n of assetRefs(body)) names.add(n);
  }
  // Close over the graph. Only .js can name another asset, and the visited set is the
  // termination proof: the /a/ namespace is finite and each name is fetched at most once.
  const queue = [...names];
  const walked = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (!name.endsWith(".js") || walked.has(name)) continue;
    walked.add(name);
    const body = await fetchLive(`/a/${name}`);
    if (!body) continue;
    liveBody.set(name, body);
    for (const n of assetRefs(body)) if (!names.has(n)) { names.add(n); queue.push(n); }
  }
  // Abort rather than adopt nothing. An empty read means production is down or the ref
  // shape moved, and continuing would hand the prune below an empty `current` set, which
  // is precisely when it is free to evict the bytes browsers are holding.
  if (!names.size) {
    console.error(`shell:roll --live: no /a/ references found at ${ORIGIN}. Refusing to roll.`);
    process.exit(1);
  }
  return [...names].map(parse).filter(Boolean);
}

if (only === "pages") console.log("shell:roll — --pages given, leaving src/dict/a-dict/ alone.");
else {
await mkdir(DICTS, { recursive: true });
const shell = live ? await liveShell() : (await readdir(BUILT)).map(parse).filter(Boolean);
console.log(`shell:roll: ${shell.length} candidate(s) from ${live ? `${ORIGIN} (live)` : BUILT}`);
let adopted = 0;
for (const a of shell) {
  if (existsSync(`${DICTS}/${a.name}`)) continue;
  // liveBody already holds every .js the walk fetched; css was never walked, so it
  // still costs one request here.
  const bytes = live
    ? liveBody.get(a.name) ?? Buffer.from(await (await fetch(`${ORIGIN}/a/${a.name}`, { headers: { "accept-encoding": "identity" } })).arrayBuffer())
    : await readFile(`${BUILT}/${a.name}`);
  await writeFile(`${DICTS}/${a.name}`, bytes);
  adopted++;
  console.log(`adopted ${a.name}`);
}
// Whatever is live must survive the prune: those are the bytes browsers hold right now,
// so evicting one is the exact failure this roll exists to prevent. Same protection the
// page half gives its currently-served snapshots.
const currentShell = new Set(shell.map((a) => a.name));

// Prune per base, so a rarely-changing asset (icons.svg) keeps its history instead of being
// evicted by a churny neighbour (nav.js). Ordering is COMMIT time, not mtime, for the reason
// gitTimes() explains — a content hash carries no ordering of its own.
const byBase = new Map();
for (const d of (await readdir(DICTS)).map(parse).filter(Boolean)) {
  if (!byBase.has(d.base)) byBase.set(d.base, []);
  byBase.get(d.base).push(d);
}
let pruned = 0;
for (const [, group] of byBase) {
  if (group.length <= KEEP) continue;
  for (const g of await oldestFirst(DICTS, group, { keep: KEEP, current: currentShell })) {
    await rm(`${DICTS}/${g.name}`, { force: true });
    pruned++;
    console.log(`pruned ${g.name}`);
  }
}
console.log(`shell:roll — adopted ${adopted}, pruned ${pruned}, keeping ${KEEP} per asset.`);
console.log("  Commit src/dict/a-dict/. build.mjs regenerates the deltas on its own from here.");
}

// ── PAGE DICTIONARIES (src/dict/p-dict) ──────────────────────────────────────────
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
// identical, which made reading `.build/public` a harmless shortcut — until
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
if (only === "shell") console.log("pages:roll — --shell given, leaving src/dict/p-dict/ alone.");
else {
  const BUILT_PAGES = ".build/public";
  const PDICTS = "src/dict/p-dict";
  const KEEP_PAGES = 2;
  const FETCH_CONCURRENCY = 6;
  const parse = (n) => {
    const m = n.match(/^(.+)\.([0-9a-f]{16})\.html\.br$/);
    return m ? { slug: m[1], tag: m[2], name: n } : null;
  };
  // `.build/public/garage/pretext.html` is served at `/garage/pretext`, and an
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
  // Every snapshot this run confirmed as CURRENTLY SERVED, whether it wrote the
  // file or found it already there. These are never prune candidates.
  const adoptedNow = new Set();
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
      // Record it either way: an already-present snapshot is still what production
      // is serving right now, so it must not become a prune candidate just because
      // this run had nothing to write.
      adoptedNow.add(`${job.slug}.${tag}.html.br`);
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
  // Ordering is COMMIT time here for the same reason as the shell half, and this
  // is the half where it actually bit: see gitTimes(). `adoptedNow` is what makes
  // the current release un-prunable regardless of how git dates it.
  for (const [, group] of byent) {
    if (group.length <= KEEP_PAGES) continue;
    for (const g of await oldestFirst(PDICTS, group, { keep: KEEP_PAGES, current: adoptedNow })) {
      await rm(`${PDICTS}/${g.name}`, { force: true });
      pruned++;
      console.log(`pruned page ${g.slug}.${g.tag}`);
    }
  }
  console.log(`pages:roll — adopted ${adopted}, pruned ${pruned}, skipped ${missing}, keeping ${KEEP_PAGES} per page (source: ${ORIGIN}).`);
}
