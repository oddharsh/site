#!/usr/bin/env node
// roll-shell-dictionary.mjs — adopt the CURRENT built shell as a dictionary candidate.

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants as zc } from "node:zlib";
import { execFileSync } from "node:child_process";
import { chooseFamilyDictionary, FAMILY_DICT_DIR, FAMILY_FRESH, FAMILY_REPORT, hash8, readCommittedFamily, writeCommittedFamily } from "./lib/page-family.ts";
import { SHELL_DISCOVERY_ROOTS, shellAssetRefs } from "./lib/shell-roots.ts";
import { dictionaryTag } from "./lib/dcz.ts";
import { pageSlug, pageSnapshotName, parseFamilyDictionary, parsePageSnapshot, parseShellAsset } from "../src/worker/lib/dictionary-names.ts";

// **How old is a committed dictionary?** mtime cannot answer that, because
// `git checkout` stamps every file it writes with the checkout time — so in a
// fresh worktree (which the collaboration rules ask for) every pre-existing
// candidate is exactly as old as every other and the prune ordering degenerates
// to readdir order. It bit the page half on 2026-08-06: a roll from a clean
// worktree kept a snapshot from an old release and deleted the bytes production
// had been serving that morning, which is precisely the one a returning visitor
// could still offer.
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

const only = process.argv.includes("--family") ? "family"
           : process.argv.includes("--pages") ? "pages"
           : process.argv.includes("--shell") ? "shell"
           : "both";

const live = process.argv.includes("--live");

const BUILT = ".build/public/a";
const DICTS = "src/dict/a-dict";
const KEEP = 3;

const parse = parseShellAsset;

if (!live && !existsSync(BUILT)) {
  console.error(`shell:roll — ${BUILT} is missing. Run \`bun run build\` first: the /a/ hashes`);
  console.error("  come from the MINIFIED bytes, so the built tree is the only place they exist.");
  console.error("  Or pass --live to adopt what production is serving instead, which needs no build.");
  process.exit(1);
}

const liveBody = new Map();
const assetRefs = (body) => shellAssetRefs(body.toString("utf8"));

async function fetchLive(path) {
  let r;
  try { r = await fetch(`${ORIGIN}${path}`, { headers: { "accept-encoding": "identity" } }); }
  catch (e) { console.log(`  skipped ${path} (${e.message})`); return null; }
  if (!r.ok) { console.log(`  skipped ${path} (HTTP ${r.status})`); return null; }
  return Buffer.from(await r.arrayBuffer());
}

async function liveShell() {
  const names = new Set<string>();
  for (const path of SHELL_DISCOVERY_ROOTS) {
    const body = await fetchLive(path);
    if (body) for (const n of assetRefs(body)) names.add(n);
  }
  const queue: string[] = [...names];
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
  if (!names.size) {
    console.error(`shell:roll --live: no /a/ references found at ${ORIGIN}. Refusing to roll.`);
    process.exit(1);
  }
  return [...names].map(parse).filter(Boolean);
}

if (only === "pages" || only === "family") console.log(`shell:roll — --${only} given, leaving src/dict/a-dict/ alone.`);
else {
await mkdir(DICTS, { recursive: true });
const shell = live ? await liveShell() : (await readdir(BUILT)).map(parse).filter(Boolean);
console.log(`shell:roll: ${shell.length} candidate(s) from ${live ? `${ORIGIN} (live)` : BUILT}`);
let adopted = 0;
for (const a of shell) {
  if (existsSync(`${DICTS}/${a.name}`)) continue;
  const bytes = live
    ? liveBody.get(a.name) ?? Buffer.from(await (await fetch(`${ORIGIN}/a/${a.name}`, { headers: { "accept-encoding": "identity" } })).arrayBuffer())
    : await readFile(`${BUILT}/${a.name}`);
  await writeFile(`${DICTS}/${a.name}`, bytes);
  adopted++;
  console.log(`adopted ${a.name}`);
}
const currentShell = new Set(shell.map((a) => a.name));

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
console.log("  Commit src/dict/a-dict/. build.ts regenerates the deltas on its own from here.");
}

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
if (only === "shell" || only === "family") console.log(`pages:roll — --${only} given, leaving src/dict/p-dict/ alone.`);
else {
  const BUILT_PAGES = ".build/public";
  const PDICTS = "src/dict/p-dict";
  const KEEP_PAGES = 4;
  const FETCH_CONCURRENCY = 6;
  const parse = parsePageSnapshot;
  const routeOf = (rel) => {
    const path = rel.replace(/\.html$/, "").replace(/(^|\/)index$/, "$1");
    return `/${path}`.replace(/\/$/, "") || "/";
  };
  await mkdir(PDICTS, { recursive: true });
  const staged = (await readdir(BUILT_PAGES, { recursive: true }))
    .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html"));
  const liveSlugs = new Set();
  let adopted = 0, pruned = 0, missing = 0;
  const adoptedNow = new Set();

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
    try { raw = brotliDecompressSync(body); } catch { }
    return { status: res.status, bytes: raw };
  };

  const jobs = staged.map((rel) => ({ rel, slug: pageSlug(rel), route: routeOf(rel) }));
  for (const job of jobs) liveSlugs.add(job.slug);
  for (let i = 0; i < jobs.length; i += FETCH_CONCURRENCY) {
    const batch = jobs.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(batch.map(async (job) => {
      try { return { job, ...(await deliveredBytes(job.route)) }; }
      catch (err) { return { job, status: null, bytes: null, err }; }
    }));
    for (const { job, status, bytes, err } of results) {
      if (!bytes) {
        console.log(`skipped page ${job.slug} — ${ORIGIN}${job.route} answered ${err ? err.message : status}`);
        missing++;
        continue;
      }
      const tag = dictionaryTag(bytes);
      const snapshot = pageSnapshotName(job.slug, tag);
      const dest = `${PDICTS}/${snapshot}`;
      adoptedNow.add(snapshot);
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
    for (const g of await oldestFirst(PDICTS, group, { keep: KEEP_PAGES, current: adoptedNow })) {
      await rm(`${PDICTS}/${g.name}`, { force: true });
      pruned++;
      console.log(`pruned page ${g.slug}.${g.tag}`);
    }
  }
  console.log(`pages:roll — adopted ${adopted}, pruned ${pruned}, skipped ${missing}, keeping ${KEEP_PAGES} per page (source: ${ORIGIN}).`);
}

if (only === "shell") console.log(`family:roll — --shell given, leaving ${FAMILY_DICT_DIR}/ alone.`);
else {
  if (!existsSync(FAMILY_REPORT) || !existsSync(FAMILY_FRESH)) {
    console.error(`family:roll — ${FAMILY_REPORT} is missing. Run \`bun run build\` first: the fresh corpus`);
    console.error("  is derived from the FINAL staged pages, and the drift check compares against those bytes.");
    process.exit(1);
  }
  const report = JSON.parse(await readFile(FAMILY_REPORT, "utf8"));
  const fresh = await readFile(FAMILY_FRESH);
  if (hash8(fresh) !== report.fresh) {
    console.error(`family:roll — ${FAMILY_FRESH} (${hash8(fresh)}) disagrees with ${FAMILY_REPORT} (${report.fresh}); rebuild.`);
    process.exit(1);
  }
  const finalPages = await Promise.all(
    (await readdir(".build/public", { recursive: true }))
      .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html"))
      .sort()
      .map((rel) => readFile(`.build/public/${rel}`)),
  );
  const committed = await readCommittedFamily();
  const pct = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

  const keep = committed ? await chooseFamilyDictionary({ fresh, committed: committed.bytes, pages: finalPages }) : null;
  if (committed && keep && keep.source === "committed") {
    console.log(`family:roll — ${FAMILY_DICT_DIR}/${committed.name} is within drift of the fresh corpus (${pct(keep.drift ?? 0)} on ${finalPages.length} pages); leaving it alone.`);
  } else {
    if (committed && keep) console.log(`family:roll — committed ${committed.hash8} has drifted ${pct(keep.drift ?? 0)} past the ${pct(keep.threshold).slice(1)} line; replacing it.`);
    else console.log(`family:roll — ${FAMILY_DICT_DIR}/ is empty.`);

    let adopt = fresh, why = "the fresh corpus, which the next build ships";
    if (live) {
      // What browsers hold: the dictionary production's own documents advertise.
      // Decode whatever comes back rather than trusting a request for identity;
      // the Worker precompresses and cannot negotiate (gotcha 13).
      const home = await fetch(`${ORIGIN}/`, { headers: { "accept-encoding": "identity" } });
      const offered = home.headers.get("link")?.match(/<([^>]+)>;\s*rel="compression-dictionary"/)?.[1];
      try { await home.body?.cancel(); } catch {}
      if (!offered) {
        console.error(`family:roll --live: no rel="compression-dictionary" Link on ${ORIGIN}/. Refusing to roll.`);
        process.exit(1);
      }
      const res = await fetch(`${ORIGIN}${offered}`, { headers: { "accept-encoding": "br" } });
      const body = Buffer.from(await res.arrayBuffer());
      let liveBytes = body;
      try { liveBytes = brotliDecompressSync(body); } catch { }
      const liveHash = parseFamilyDictionary(offered.split("/").pop() ?? "");
      if (!res.ok || liveHash !== hash8(liveBytes)) {
        console.error(`family:roll --live: ${offered} answered ${res.status} and hashes to ${hash8(liveBytes)}; refusing to adopt bytes the URL does not name.`);
        process.exit(1);
      }
      const asLive = await chooseFamilyDictionary({ fresh, committed: liveBytes, pages: finalPages });
      if (asLive.source === "committed") {
        adopt = liveBytes;
        why = `what production serves (${liveHash}), ${pct(asLive.drift ?? 0)} from the fresh corpus`;
      } else {
        why = `the fresh corpus; production's ${liveHash} is ${pct(asLive.drift ?? 0)} from it, past the ${pct(asLive.threshold).slice(1)} line`;
      }
    }
    if (committed && committed.hash8 === hash8(adopt)) {
      console.log(`family:roll — ${committed.name} is already the right file; nothing to write.`);
    } else {
      const name = await writeCommittedFamily(adopt);
      console.log(`adopted family ${name}: ${why}`);
      console.log(`  Commit ${FAMILY_DICT_DIR}/. The next build ships it at /a/page-family.${hash8(adopt)}.dict and keeps that URL until it drifts.`);
    }
  }
}
