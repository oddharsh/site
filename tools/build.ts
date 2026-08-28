// build.mjs: the site's one build step, and it runs only at deploy.
//
// Authoring stays buildless: everything in public/, cal/, and serendipity/ is
// committed readable and is the source of truth. This script stages the static
// www tree plus the two embedded application modules under .build/ and
// minifies the selected client scripts (the assets pages load) plus the homepage
// HTML; images and _headers ship byte-identical to git. Each transformed asset
// gets a readable twin deployed alongside it, because View Source is part of the
// product and minification must not cost it.
//
// The garage/ and lwe/ HTML and the worker modules are NOT minified, but they are
// no longer byte-identical to git either: step 1b injects the client-edge CSS
// mirror into every staged page that carries the window geometry, derived from
// luna.css. It is one commented, readable line in a readable file — View Source
// still reads as hand-written CSS, and the line says where it came from.
//
//   bun run build                                         # stage .build/
//   bun run deploy:direct                                   # build + wrangler deploy -c .build/wrangler.jsonc
//
// THIS BUILD REQUIRES BUN. `lib/link-integrity.ts` parses each document with
// HTMLRewriter, which bun and workerd have and node does not, so `node
// tools/build.ts` dies with `ReferenceError: HTMLRewriter is not defined`
// before anything is written. That line read `node tools/build.ts` until
// 2026-08-24 and had been wrong since 2026-08-20; copying it took the nightly
// dictionary roll down for three nights. wrangler.jsonc's build command is
// `bun tools/build.ts`, so the pinned bun is what compiles production too.
//
// wrangler resolves `main` and `assets.directory` relative to the config file, so the
// root wrangler.jsonc is copied verbatim into .build/ and just works against the copy.

import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";

// One nonce per build for the dynamic imports below: the staged worker modules
// are rewritten in place by later steps, so each import site needs a fresh URL.
const BUILD_NONCE = process.hrtime.bigint().toString(36);
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, brotliDecompressSync, constants as zlibConstants, zstdCompressSync } from "node:zlib";
import minifyHtml from "@minify-html/node";
import { transform as transformCss } from "lightningcss";
import { minifySync } from "oxc-minify";
import { readManifest, workerModule, navFenceBody, readFenceBody, runProfilesBody } from "./gen-manifest.ts";
import { parseCss } from "./lib/css-parse.ts";
import { HTML_MARKERS } from "./lib/html-markers.ts";
import { zstdCompressDictionaryBatch } from "./lib/zstd-batch.ts";
import { patchStaticShell, renderDesktopArtifacts, staticShellPages } from "../tools/photos/gen-desktop-partial.ts";

const OUT = ".build";
// Every q11 file below is independent, but node:zlib's callback API shares
// libuv's four-thread default. Let clean builds use the same eight-core ceiling
// as the zstd batch while preserving an explicit caller override and libuv's
// four-thread floor on smaller CI hosts. This must run before the first async fs
// or zlib operation, when libuv fixes the process-wide pool size.
process.env.UV_THREADPOOL_SIZE ||= String(Math.max(4, Math.min(8, availableParallelism())));
const brotliCompressAsync = promisify(brotliCompress);

// q11 dominates clean builds, so use zlib's callback path to run independent
// files in the libuv pool. Promise.all preserves input order, and the callback
// and sync APIs produced a byte-identical staged tree in the 2026-08-15 trial.
// Keep the dcz encoder synchronous: its async API changed every `.dcz` byte.
function brotliQ11(bytes) {
  return brotliCompressAsync(bytes, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
      // 24 is the largest window legal for Content-Encoding: br (RFC 7932 §4).
      [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
    },
  });
}

// dcz framing (RFC 9842), the one construction both delta passes share: compress
// against the dictionary, then prepend the dictionary's SHA-256 in a Zstandard
// SKIPPABLE frame — magic 0x184D2A5E little-endian, a 4-byte LE length of 32, then
// the raw digest. Being valid zstd, that prefix is skipped by any conforming
// decoder, which is what lets `zstd -d -D dict` round-trip the whole file.
//
// One framing function because the shell pass and the page pass each built this by hand and
// the browser is the decoder: a byte wrong in either copy is a delta no client can
// apply, and only on the surface whose copy drifted. Consolidated 2026-07-28.
function frameDcz(frame, dictBytes) {
  const digest = createHash("sha256").update(dictBytes).digest();
  const len = Buffer.alloc(4);
  len.writeUInt32LE(digest.length, 0);
  return {
    out: Buffer.concat([Buffer.from([0x5e, 0x2a, 0x4d, 0x18]), len, digest, frame]),
    digest,
  };
}

function dczEncode(bytes, dictBytes) {
  const frame = zstdCompressSync(bytes, {
    dictionary: dictBytes,
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 },
  });
  return frameDcz(frame, dictBytes);
}

async function dczEncodeBatch(jobs) {
  const frames = await zstdCompressDictionaryBatch(jobs.map(({ bytes, dictBytes }) => ({
    bytes,
    dictionary: dictBytes,
  })));
  return jobs.map(({ dictBytes }, index) => frameDcz(frames[index], dictBytes));
}

// Parse host-shaped CSP sources before comparing DNS labels. A raw substring
// test is both imprecise and security-shaped: `cloudflareinsights.com.evil`
// contains the retired domain text but is not beneath that domain, while an
// arbitrary subdomain of cloudflareinsights.com is. Keep that distinction
// explicit so this invariant checks origins rather than URL spelling.
function containsRetiredRumHost(source) {
  const candidates = source.match(/\b(?:https?:\/\/)?(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?/gi) || [];
  for (const candidate of candidates) {
    const withoutWildcard = candidate.replace(/^\*\./, "");
    let hostname;
    try {
      hostname = new URL(/^[a-z]+:\/\//i.test(withoutWildcard)
        ? withoutWildcard
        : `https://${withoutWildcard}`).hostname.toLowerCase();
    } catch {
      continue;
    }
    const labels = hostname.split(".");
    if (labels.at(-2) === "cloudflareinsights" && labels.at(-1) === "com") return true;
  }
  return false;
}

// The served tree has THREE authored roots now, so anything that used to walk
// www/ walks all of them. Keeping this in one place is the point: a check that
// walks only some of the roots reports a clean tree it never fully read, which
// is the quietest way for one of these tripwires to stop meaning anything.
const SERVED_SOURCES = ["public", "src/pages", "src/content"];
const servedFiles = async (filter?: (rel: string) => boolean): Promise<string[]> => {
  const out: string[] = [];
  for (const root of SERVED_SOURCES) {
    for (const rel of await readdir(root, { recursive: true })) {
      if (filter && !filter(rel)) continue;
      out.push(`${root}/${rel}`);
    }
  }
  return out;
};

// One array-of-strings, read out of a wrangler config's source text by key.
//
// GENERIC because the alternative is what put this here. Two configs must agree
// on two such arrays, and each hand-rolled copy of this regex is one more place
// to be subtly different from the others: the dev twin lost "/ask", "/inbox",
// "/webmention" and "/webmention/*" (2026-08-27) and the "41 5 * * *" cron
// (2026-08-14) precisely because nothing compared them. Five readers share this
// now — invariant #1, both halves of the invariant #6 dev-twin diff, and the
// link resolver in step 7b.
//
// These are JSONC files and the // COMMENTS INSIDE THESE BLOCKS QUOTE VALUES, so
// a bare scan for quoted strings reads prose as data. wrangler.jsonc's fold note
// names all eight retired exact /lens rows that way, and the first version of the
// dev-twin diff duly reported seven of them as drift — a false positive on the
// one check whose job is telling real drift from none. That was harmless in
// invariant #1 (a phantom rule only ever makes `covered()` more permissive) and
// wrong in 7b, where a link to a path some comment happens to mention would
// resolve. One `//`-to-end-of-line strip fixes every reader; no value in either
// array can contain "//", since they are paths and cron expressions.
//
// Returns [] when the key is absent, which is why every caller floors on the
// length rather than trusting a clean-looking comparison of two empty lists.
const jsoncStringArray = (configSrc: string, key: string): string[] => {
  const block = (configSrc.match(new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`)) || [, ""])[1];
  return [...block.replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

// The run_worker_first allowlist. Entries starting with "!" are wrangler's
// negation form and are left in; a caller wanting only positive patterns filters
// them itself.
const runWorkerFirst = (configSrc: string): string[] => jsoncStringArray(configSrc, "run_worker_first");

// ── deploy-time invariant tripwires (explore-unknowns, phase A) ──────────────
// Silent-failure classes this codebase has hit or is one careless edit from
// hitting. They live here because build.mjs runs on every `bun run deploy:direct`, the
// one reliable path (Workers Builds CI has silently skipped pushes). The three
// deterministic checks HARD-BLOCK the deploy; the two that compare derived or
// duplicated text only WARN (exit 0), because a false positive on the one
// deploy path would get the whole guard commented out.
async function checkInvariants() {
  const read = (p) => readFile(p, "utf8");
  // Annotated because a bare `[]` infers never[], which made EVERY `.push(msg)`
  // in this function a TS2345 — 87 of the file's 91 baseline diagnostics, all of
  // them noise sitting on top of the one check that blocks the deploy.
  const hard: string[] = [], warn: string[] = [];

  // 0 (hard) — the authored roots merged into .build/public have no file-path
  // collisions. Staging copies them concurrently below, so there is no longer
  // a meaningful "last writer wins" order to hide a duplicate behind. A file
  // belongs to exactly one authored root; fail before copying if that changes.
  const stageRoots = ["public", "src/pages", "src/content", "src/client", "src/styles"];
  const stageOwner = new Map<string, string>();
  let stagedAuthored = 0;
  const walkStage = async (root, dir = root, prefix = "") => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (root === "public" && (rel === "images/meta" || rel.startsWith("images/meta/"))) continue;
      if (entry.isDirectory()) {
        await walkStage(root, `${dir}/${entry.name}`, rel);
        continue;
      }
      stagedAuthored++;
      const prior = stageOwner.get(rel);
      if (prior) hard.push(`served path ${rel} is authored by both ${prior} and ${root}; parallel staging has no overwrite order`);
      else stageOwner.set(rel, root);
    }
  };
  for (const root of stageRoots) await walkStage(root);

  // 1 (hard) — every index.js dispatch key is covered by the wrangler
  // run_worker_first allowlist, or that route silently serves static. BOTH tables
  // are checked: the exact ROUTES map, and the ordered PREFIX table (whose labels
  // become a concrete probe path). Allowlist globs are matched as patterns, never
  // required literally (a symmetric diff would false-fire on the glob entries —
  // the exact disable-magnet).
  const idx = await read("src/worker/index.ts");
  const wrangler = await read("wrangler.jsonc");
  // Reads ROUTE_TABLE, which is where the dispatch keys live. This matched
  // `const ROUTES = new Map([...])` until 2026-08-19, and that form stopped
  // existing when the table was extracted into its own const so the @type
  // annotation could sit on a declaration. The regex then captured nothing, so
  // routeKeys was EMPTY and this hard invariant asserted nothing about any of
  // the 85 exact routes — silently, because the PREFIX half below still found
  // its 13 and the summary line kept printing a plausible number.
  //
  // Two general lessons, both cheap to act on. A check that scrapes source text
  // is coupled to the shape of that source, so a refactor can retire it without
  // touching it. And a scanner that finds ZERO of something must say so rather
  // than pass: the floor below is what turns this class of failure back into a
  // red build, and it is the same guard tools/check-tools.ts puts on its own
  // scanners for the same reason.
  // The type annotation is OPTIONAL in this pattern because the declaration form
  // has now moved under this scanner TWICE: once when the table was extracted
  // into its own const (above), and again on 2026-08-20 when it gained
  // `: Array<[path: string, handler: Function]>` so tsc could resolve
  // `new Map(ROUTE_TABLE)`. Both times the regex captured nothing. The floor
  // below is the only reason either was noticed, and it caught this one before
  // the change left the worktree, which is what a floor is for.
  const routesBlock = (idx.match(/const ROUTE_TABLE(?::[^=]*)? = \[([\s\S]*?)\n\];/) || [, ""])[1];
  const routeKeys = [...routesBlock.matchAll(/\[\s*"([^"]+)"/g)].map((m) => m[1]);
  if (routeKeys.length < 60) hard.push(`route invariant scanned only ${routeKeys.length} ROUTE_TABLE keys — the scanner has lost the table, not the site its routes`);
  const allow = runWorkerFirst(wrangler);
  if (allow.length < 60) hard.push(`route invariant scanned only ${allow.length} run_worker_first entries — the scanner has lost the allowlist, not the config its rules`);
  const globRe = (g) => new RegExp("^" + g.replace(/[\\.+?^${}()|[\]]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const covered = (p) => allow.includes(p) || allow.some((a) => a.includes("*") && globRe(a).test(p));
  for (const k of routeKeys) if (!covered(k)) hard.push(`ROUTES key ${k} is not in wrangler run_worker_first (route would silently serve static)`);

  // the PREFIX table is the second dispatch surface and was never asserted, so a
  // route like /writing/<slug> could lose its allowlist entry and quietly go static.
  // Turn each label's placeholder into a path the glob matcher can actually test.
  const prefixBlock = (idx.match(/const PREFIX = \[([\s\S]*?)\n\];/) || [, ""])[1];
  const prefixProbes = [...prefixBlock.matchAll(/label:\s*"([^"]+)"/g)].map((m) =>
    m[1].replace("<slug>", "x").replace("<stem>", "x").replace("<key>", "x").replace("<thumb>", "x.avif"));
  for (const p of prefixProbes) if (!covered(p)) hard.push(`PREFIX route ${p} is not in wrangler run_worker_first (route would silently serve static)`);

  // 2 (hard) — wherever a worker emits a CSP with a style-src, it includes
  // 'self'. cal emits no CSP and passes vacuously (this is the exact thing that
  // blanked serendipity's taskbar).
  for (const f of ["public/_headers", "src/worker/lib/security.ts", "serendipity/serendipity.ts", "cal/src/templates.ts", "cal/src/index.ts"]) {
    let s; try { s = await read(f); } catch { continue; }
    for (const m of s.matchAll(/style-src([^;'"]*(?:'[^']*')?[^;'"]*)*/g)) {
      const dir = m[0];
      if (!dir.includes("'self'")) hard.push(`${f}: a CSP style-src omits 'self' (would block /luna.css): ${dir.slice(0, 60)}`);
    }
  }

  // 3 (hard) — nothing re-opts this site into View Transitions by accident.
  // The three white-blink rules this tripwire used to pin are gone with the
  // transition itself (2026-07-30); the inverse check is what protects the
  // choice now. The failure mode it guards is a page-level `@view-transition`
  // creeping back in, since the opt-in is per-document: one page carrying it
  // does nothing on its own, but two adjacent ones silently restore the
  // cross-document transition on the navigations between them, with none of
  // the choreography (or the white-blink fixes) that used to make it safe.
  // /garage/vt-check + /garage/vt-b are the deliberate exception: a self-
  // contained diagnostic pair that probes the PLATFORM, wired to no shell.
  const VT_DIAGNOSTIC = /^garage\/vt-(check|b)\.html$/;
  const vtSources = [
    ...(await servedFiles((r) => /\.(html|css|js)$/.test(r) && !VT_DIAGNOSTIC.test(r))),
    ...(await readdir("src/client")).filter((r) => r.endsWith(".js")).map((r) => `src/client/${r}`),
    ...(await readdir("src/styles")).filter((r) => r.endsWith(".css")).map((r) => `src/styles/${r}`),
    "cal/src/templates.ts", "serendipity/serendipity.ts", "pipelines/lwe/generate.mjs",
  ];
  for (const f of vtSources) {
    let s; try { s = await read(f); } catch { continue; }
    // Look at CSS only. /garage/horizon documents this decision at length and
    // quotes the at-rule inside <code>, so a whole-file grep flags the page
    // explaining why the rule is gone — a guard that fires on its own
    // documentation gets muted, the same reasoning as the font-law scan below.
    // For HTML that means <style> bodies; elsewhere the file minus its comments
    // (chrome.js / templates.js / generate.mjs carry CSS in template literals).
    const css = f.endsWith(".html")
      ? [...s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n")
      : s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/@view-transition\s*\{/.test(css)) hard.push(`${f}: re-opts into View Transitions (@view-transition), removed site-wide 2026-07-30`);
  }
  const luna = await read("src/styles/luna.css");

  // 3b (hard) — luna.css parses as valid CSS. A botched find-replace in v143
  // wrapped several .window/.xp-button declarations in :where(...) and left
  // unbalanced parens; esbuild only WARNS (never throws) and the served bytes
  // are byte-identical to git, so the corruption shipped silently for three
  // releases (the .window box-shadow + the whole .xp-button base rule dropped
  // from the CSSOM). Transform as CSS and block on any warning.
  try {
    const res = transformCss({ filename: "src/styles/luna.css", code: Buffer.from(luna), minify: false });
    for (const w of res.warnings) hard.push(`luna.css CSS parse warning: ${w.message}${w.loc ? ` (line ${w.loc.line})` : ""}`);
  } catch (e) {
    hard.push(`luna.css failed to parse as CSS: ${e.message.split("\n")[0]}`);
  }

  // 4 (hard) — the checked-in desktop shell is the exact projection of
  // shell-data.ts + site-manifest.json. The old count proxy let a whole page
  // keep an older taskbar as long as the central partial had the right number
  // of pins; /access did exactly that and silently missed /terminal. Render the
  // canonical artifacts in memory and compare every consumer byte-for-byte.
  try {
    const artifacts = renderDesktopArtifacts();
    if (await read("src/worker/lib/desktop.ts") !== artifacts.moduleSource) {
      hard.push("lib/desktop.js drifted from shell-data.ts/site-manifest.json — run bun run gen:shell");
    }
    if (await read("public/icons.svg") !== artifacts.sprite) {
      hard.push("icons.svg drifted from shell-data.ts — run bun run gen:shell");
    }
    for (const [name, svg] of Object.entries(artifacts.favicons)) {
      if (await read(`public/section-icons/${name}.svg`) !== svg) {
        hard.push(`section-icons/${name}.svg drifted from shell-data.ts — run bun run gen:shell`);
      }
    }
    for (const file of staticShellPages()) {
      const source = await read(file);
      if (patchStaticShell(source, artifacts) !== source) {
        hard.push(`${file}: static desktop partial drifted — run bun run gen:shell`);
      }
    }
  } catch (e) { hard.push(`desktop generator freshness check could not run: ${e.message}`); }

  // 5 (warn) — the OS-window critical-CSS copies are divergent per-context
  // subsets (cal carries almost none), so a full byte-guard would false-fire.
  // The one value that drifts and hurts is the taskbar-floor height: every
  // file that carries the calc must agree with luna.css, or first paint lands
  // a different window height than the final.
  const floors = new Map();
  for (const f of ["src/styles/luna.css", "src/worker/lib/chrome.ts", "src/worker/writing.ts", "serendipity/serendipity.ts"]) {
    let s; try { s = await read(f); } catch { continue; }
    // the BODY floor only (`height:calc(...)`), not a window `max-height:calc(...)`
    for (const m of s.matchAll(/(?<!max-)height:calc\(100dvh - (\d+)px\)/g)) floors.set(f, m[1]);
  }
  const floorVals = new Set(floors.values());
  if (floorVals.size > 1) warn.push(`taskbar-floor height disagrees across the critical-geometry copies (${[...floors].map(([f, v]) => `${f.split("/").pop()}:${v}px`).join(", ")}) — luna.css and the inline copies must match`);

  // 5b (hard) — the client edge (luna.css, search "THE CLIENT EDGE") is authored
  // exactly once and injected into the staged pages by clientEdgeMirror() below.
  // If the declaration can't be found in luna.css there is nothing to inject and
  // every page silently loses its first-paint mirror, so this blocks rather than
  // warns: a missing rule here is a rename or a bad edit, not a taste call.
  if (!clientEdgeDecl(await read("src/styles/luna.css"))) hard.push("luna.css: the client-edge declaration went missing (search \"THE CLIENT EDGE\") — build.mjs injects it into every windowed page and has nothing to inject");

  // 6 (warn) — the local-dev twin (wrangler.dev.jsonc) must declare the same
  // bindings as the deploy config (wrangler.jsonc), or local `wrangler dev`
  // diverges from prod. Compare the set of binding identifiers by name; a
  // mismatch means a binding was added to one config but not the other.
  //
  // The run_worker_first ALLOWLIST is compared the same way, and it was not until
  // 2026-08-27. Both files' headers say the two must match, and a check reading
  // only the bindings watched them diverge by four entries ("/ask", "/inbox",
  // "/webmention", "/webmention/*") while reporting a clean build. Same class as
  // the missing "41 5 * * *" cron of 2026-08-14, which wrangler.dev.jsonc's own
  // comment records — so the CRONS are diffed here too, at the end of this block,
  // and the COMPATIBILITY FLAGS after them.
  //
  // What that drift COST was nothing yet, measured rather than assumed: all four
  // answered identically under `bun run dev` with their entries absent, because
  // nothing is staged at those paths and the asset layer passes a path it cannot
  // serve to the Worker anyway. This claim is deliberately not stronger than the
  // measurement — the first draft of this comment said those routes "fell through
  // to the asset layer" locally, which is what the config says and not what the
  // wire said. The rule it enforces is unchanged either way: the allowlist governs
  // precedence WHERE AN ASSET EXISTS, so a divergence is inert exactly until a
  // file lands at one of the diverging paths, and this repo has two notes in that
  // config about routes the asset layer answered first once one did.
  //
  // Compared as SETS, in both directions, since an entry in the dev twin that
  // production does not claim is the more dangerous half: it makes local dev
  // exercise a path the deployed site serves statically.
  //
  // WARN rather than hard, on this function's stated policy for duplicated text
  // (see the header above): the drift is real, and blocking the one deploy path
  // over a local-dev-only file would gate production on something that cannot
  // reach it. The scanner cannot pass VACUOUSLY, which is the failure this would
  // otherwise share with every other text scraper here — invariant #1 floors the
  // same extraction at 60 entries and hard-fails, so a regex that has stopped
  // matching reddens the build before it can quietly agree with itself.
  try {
    const dev = await read("wrangler.dev.jsonc");
    const names = (s) => new Set([...s.matchAll(/"(?:binding|name|database_name|bucket_name|dataset)"\s*:\s*"([^"]+)"/g)].map((m) => m[1]));
    const a = names(wrangler), b = names(dev);
    const diff = [...new Set([...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x))))];
    if (diff.length) warn.push(`wrangler.jsonc and wrangler.dev.jsonc binding sets differ (${diff.join(", ")}) — keep the dev twin in sync`);

    const prodAllow = new Set(allow), devAllow = new Set(runWorkerFirst(dev));
    const prodOnly = [...prodAllow].filter((x) => !devAllow.has(x));
    const devOnly = [...devAllow].filter((x) => !prodAllow.has(x));
    if (prodOnly.length || devOnly.length) {
      const parts: string[] = [];
      if (prodOnly.length) parts.push(`missing from wrangler.dev.jsonc: ${prodOnly.join(", ")}`);
      if (devOnly.length) parts.push(`only in wrangler.dev.jsonc: ${devOnly.join(", ")}`);
      warn.push(`wrangler.jsonc and wrangler.dev.jsonc run_worker_first allowlists differ (${parts.join("; ")}) — the two configs disagree about which paths the Worker claims from the asset layer, so dev and prod diverge the moment a file is staged at one of them`);
    }

    // And the CRONS, which is the drift this file's own comment records: this
    // list was missing "41 5 * * *" entirely from 2026-08-14, so the daily
    // outbound tick existed in production and not in dev. That one was found by
    // hand while folding the /around crawl onto the tick, and it stayed on the
    // honour system for the whole time an allowlist check sat next to it.
    //
    // Compared ORDER-INSENSITIVELY, because index.ts dispatches on the cron
    // STRING (`switch (event.cron)`), so a reordering changes nothing and
    // failing on one would be a check with an opinion about formatting. Sorting
    // and joining rather than diffing two Sets keeps a duplicated entry visible,
    // which a symmetric set difference reports as no difference at all.
    //
    // Both lists print in full: there are four, and naming them beats a diff the
    // reader then has to reconstruct the lists from.
    //
    // Keyed on "crons" rather than the "triggers" that holds it, because
    // triggers opens an OBJECT and this reads arrays. Both files carry the key
    // exactly once, comments included, so the first match is the real one.
    const prodCrons = jsoncStringArray(wrangler, "crons"), devCrons = jsoncStringArray(dev, "crons");
    const sorted = (xs: string[]) => [...xs].sort().join(", ");
    // The floor. Four crons are documented at this key in both files and Workers
    // Free caps an account at five, so zero means the extraction lost the block
    // rather than the site losing its jobs. Deleting every cron is a real edit
    // that should come here and say so, which is the point of failing loudly.
    if (!prodCrons.length) hard.push("dev-twin drift check read 0 crons from wrangler.jsonc — the scanner has lost the triggers block, not the site its schedule");
    else if (sorted(prodCrons) !== sorted(devCrons)) {
      warn.push(`wrangler.jsonc and wrangler.dev.jsonc crons differ (wrangler.jsonc: ${prodCrons.join(", ") || "none"}; wrangler.dev.jsonc: ${devCrons.join(", ") || "none"}) — the two schedules must match, or a job fires in one config and not the other`);
    }

    // And the COMPATIBILITY FLAGS, added 2026-08-28 with the first one this repo
    // has ever set. A flag changes what the RUNTIME hands the Worker, so a
    // divergence here is worse than the three above: those make dev and prod
    // disagree about which paths compute, while this makes them disagree about
    // what the platform is. `enable_request_signal` is the live case, since it
    // decides whether request.signal aborts, and dispatchTraced() branches on
    // exactly that. A dev twin without it runs the not-instrumented arm on every
    // local request while production runs the other one, silently.
    //
    // Compared ORDER-INSENSITIVELY like the crons, and for the same reason: the
    // runtime reads this as a set, so a reordering changes nothing and failing
    // on one would be a check with an opinion about formatting.
    const prodFlags = jsoncStringArray(wrangler, "compatibility_flags");
    const devFlags = jsoncStringArray(dev, "compatibility_flags");
    // The floor, and it is a claim about this commit rather than about the key.
    // Zero flags was the TRUE state here until 2026-08-28, so an empty array is
    // a config a reader could reasonably expect; what it cannot be is invisible.
    // Both sides are lists and two empty lists agree, so without this a renamed
    // key or a reformatted array reports a clean build over a config it never
    // read. Removing the last flag is a real edit that should come here and say
    // so, which is the point of failing rather than warning.
    if (!prodFlags.length) hard.push("dev-twin drift check read 0 compatibility_flags from wrangler.jsonc — either the scanner lost the key or the last flag was dropped; both want a human here");
    else if (sorted(prodFlags) !== sorted(devFlags)) {
      warn.push(`wrangler.jsonc and wrangler.dev.jsonc compatibility_flags differ (wrangler.jsonc: ${prodFlags.join(", ") || "none"}; wrangler.dev.jsonc: ${devFlags.join(", ") || "none"}) — a flag changes what the runtime hands the Worker, so local dev exercises a different platform from the one that ships`);
    }
  } catch (e) { warn.push(`dev-config drift check could not run: ${e.message}`); }

  // 7 (hard) — every agent-skills digest matches the file it points at. The
  // discovery schema invites clients to verify these, so a stale digest doesn't
  // read as "the author forgot": it reads as tampering, and the skill gets
  // rejected. Editing SKILL.md without regenerating index.json already shipped
  // that state once, so the check belongs on the one unbypassable deploy path.
  let skillsChecked = 0;
  try {
    const idx = JSON.parse(await read("public/.well-known/agent-skills/index.json"));
    for (const s of idx.skills || []) {
      const path = "public" + new URL(s.url).pathname;
      const actual = "sha256:" + createHash("sha256").update(await readFile(path)).digest("hex");
      if (s.digest !== actual) hard.push(`agent-skills: ${s.name} digest is stale — index.json says ${s.digest.slice(0, 20)}…, ${path} hashes to ${actual.slice(0, 20)}… (regenerate index.json)`);
      skillsChecked++;
    }
  } catch (e) { warn.push(`agent-skills digest check could not run: ${e.message}`); }

  // 7b (hard) — browser RUM was removed on 2026-08-11. Keep all four runtime
  // surfaces absent together: the homepage loader, the Worker proxy/collector,
  // the asset-dispatch allowlists, and any third-party CSP allowance. A partial
  // restoration recreates the exact failure this check now guards against: a
  // browser loading a beacon whose collector route 404s.
  try {
    const runtimeFiles = [
      "src/pages/index.html",
      "src/worker/index.ts",
      "wrangler.jsonc",
      "wrangler.dev.jsonc",
    ];
    const forbidden = ["/ledger/rum", "data-cf-beacon", "cloudflareinsights.com"];
    for (const name of runtimeFiles) {
      const source = await read(name);
      for (const marker of forbidden) {
        if (source.includes(marker)) hard.push(`${name}: browser RUM is retired; remove ${marker}`);
      }
    }
    // Either extension: the Worker is TypeScript now, so a resurrected proxy
    // would be rum.ts and a check pinned to .js would wave it through.
    if ((await readdir("src/worker")).some((f) => f === "rum.js" || f === "rum.ts")) {
      hard.push("src/worker/rum.js: browser RUM is retired; remove the proxy module");
    }
    for (const [name, text] of [
      ["public/_headers", await read("public/_headers")],
      ["src/worker/lib/security.ts", await read("src/worker/lib/security.ts")],
    ]) {
      if (containsRetiredRumHost(text)) {
        hard.push(`${name}: browser RUM is retired; remove the Cloudflare Insights CSP allowance`);
      }
    }
  } catch (e) { warn.push(`no-RUM check could not run: ${e.message}`); }

  // 8 (hard) — the site surface registry (site-manifest.json) is the single truth
  // for which pages exist and where they show. Its two GENERATED projections must
  // match a fresh regen, and its three HAND-authored consumers (nav's Run palette,
  // sitemap.xml, the garage gallery) must agree with the registry's flags. This is
  // the check that would have caught the 10-vs-12-vs-15 garage drift these three
  // surfaces had accumulated before the manifest existed.
  let manifestChecked = 0;
  try {
    const { surfaces } = readManifest();
    const nav = await read("src/client/nav-run.js");
    const desktop = await read("src/worker/lib/desktop.ts");

    // 8a — generated projections match `bun run gen:manifest` output exactly.
    const modActual = (await read("src/worker/lib/site-manifest.ts")).trim();
    if (modActual !== workerModule(surfaces).trim()) hard.push("lib/site-manifest.js drifted from site-manifest.json — run bun run gen:manifest");
    for (const [section, marker] of [["garage", "garage-pages"], ["lwe", "lwe-pages"]]) {
      if (readFenceBody(nav, marker) !== navFenceBody(surfaces, section)) hard.push(`nav-run.js generated:${marker} drifted from site-manifest.json — run bun run gen:manifest`);
    }
    if (readFenceBody(nav, "run-profiles") !== runProfilesBody()) hard.push("nav-run.js profiles drifted from shell-data.ts — run bun run gen:manifest");

    // parse the live surfaces out of each hand-authored consumer.
    const navPagesBlock = (nav.match(/var PAGES = \[([\s\S]*?)\n {2}\];/) || [, ""])[1];
    const navRun = new Set([...navPagesBlock.matchAll(/path:\s*"(\/[^"]*)"/g)].map((m) => m[1]));
    const navTaskbar = new Set([...desktop.matchAll(/class=\\"axp-pin\\"[^>]*href=\\"([^"]+)\\"/g)].map((m) => m[1]));
    const sitemap = await read("public/sitemap.xml");
    const smLocs = new Set([...sitemap.matchAll(/<loc>https:\/\/aadhar\.sh([^<]*)<\/loc>/g)].map((m) => m[1] || "/"));
    // the generated desktop partial is chrome, not gallery content, and it links
    // every taskbar app — so a pin whose path matches the gallery shape (e.g.
    // /pixel-peeper) would otherwise read as a gallery card that isn't there.
    // Strip the partial before scanning so this only ever sees hand-written cards.
    const gallery = (await read("src/pages/garage/index.html"))
      .replace(/<!-- axp:shell -->[\s\S]*?<!-- \/axp:shell -->/g, "");
    // The id class here must match the one the generator ENFORCES, which is
    // /^[a-z0-9][a-z0-9-]*$/ in pipelines/garage/generate.mjs. It read
    // `[a-z0-9]+` until 2026-08-24 and no page had ever carried a hyphen, so the
    // two disagreed silently for as long as both existed: the first hyphenated
    // id generated fine, registered fine, got a hand-written shelf card, and
    // then failed this invariant claiming the card was missing from a file it
    // was sitting in. A scanner narrower than the names it scans for reports an
    // absence rather than a mismatch, which sends you looking at the wrong file.
    const galLinks = new Set([...gallery.matchAll(/href="(\/(?:garage\/[a-z0-9][a-z0-9-]*|pixel-peeper))"/g)].map((m) => m[1]));

    // 8b — each flag is the registry's contract with exactly one surface; assert
    // both directions so neither the registry nor the surface can drift alone.
    const want = (f) => surfaces.filter((s) => s.flags[f]).map((s) => s.path);
    const bidi = (label, wantPaths, have, opts: { subsetOnly?: boolean } = {}) => {
      const w = new Set(wantPaths) as Set<string>;
      for (const p of w) if (!have.has(p)) hard.push(`${label}: ${p} is flagged in site-manifest.json but missing from the surface`);
      if (!opts.subsetOnly) for (const p of have) if (!w.has(p)) hard.push(`${label}: ${p} is in the surface but not flagged in site-manifest.json`);
    };
    bidi("run/nav-run.js PAGES", want("run"), navRun);
    bidi("taskbar/compiled desktop", want("taskbar"), navTaskbar);
    bidi("gallery/garage index", want("gallery"), galLinks);
    // sitemap carries leaf content the registry doesn't own (writing posts,
    // resume files), so forward is full but reverse is scoped to garage/lwe.
    for (const p of want("sitemap")) if (!smLocs.has(p)) hard.push(`sitemap: ${p} is flagged sitemap in site-manifest.json but has no <loc>`);
    for (const p of smLocs) if (/^\/(garage|lwe)\//.test(p) && !surfaces.some((s) => s.path === p)) hard.push(`sitemap: ${p} has a <loc> but is not registered in site-manifest.json`);

    // 8c — every garage/lwe page on disk is registered (or an explicit exclusion),
    // so adding a page forces a registry entry rather than a silent omission.
    const BARE = new Set(["index.html", "vt-b.html", "vt-check.html"]);
    const known = new Set(surfaces.map((s) => s.path));
    for (const dir of ["garage", "lwe"]) {
      for (const f of await readdir(`public/${dir}`)) {
        if (!f.endsWith(".html") || BARE.has(f)) continue;
        const p = `/${dir}/${f.slice(0, -5)}`;
        if (!known.has(p)) hard.push(`${p} exists on disk but is not registered in site-manifest.json`);
      }
    }
    manifestChecked = surfaces.length;
  } catch (e) { hard.push(`site-manifest check could not run: ${e.message}`); }

  // 9 — the taste tripwires GREENFIELD.md asked for, calibrated against what the
  // site actually ships. Its list (ban cubic-bezier, any easing beyond linear,
  // any radius over 3px, any blurred shadow) would block this deploy today: the
  // window minimize/restore morph IS a cubic-bezier, luna.css runs 60ms ease-out
  // everywhere, canon defines --radius-window: 8px, and XP menus really did drop
  // a soft shadow. Banning those bans the site. So the split here is between the
  // one rule that is owner LAW (zero font bytes, hard) and the drift signals that
  // want a human look (warn). Demo pages are exempt from the taste warnings and
  // NOT from the font law: /garage and /lwe exist to show the platform off, so
  // frontier CSS in them is the point, while a web font anywhere is still fatal.
  let tasteScanned = 0, tasteOk = [];
  try {
    // Taste rules can execute only from text a browser parses or from a program
    // that emits that text. The old walk decoded EVERY served byte as UTF-8,
    // including all content-addressed AVIF/JPEG tiers and every OG PNG, while
    // missing most of src/worker even though that is where generated-page CSS
    // lives. Keep active textual assets plus the complete three Worker program
    // trees: less work, and coverage now follows the actual authors.
    const activeText = (rel: string): boolean =>
      rel === "_headers" || /\.(?:[cm]?[jt]sx?|css|html?|xhtml|xml|svg)$/i.test(rel);
    const programFiles = async (root: string): Promise<string[]> => (await readdir(root, { recursive: true }))
      .filter((rel) => /\.(?:[cm]?[jt]sx?)$/i.test(rel))
      .map((rel) => `${root}/${rel}`);
    const served = [
      ...await servedFiles(activeText),
      ...await programFiles("src/worker"),
      ...await programFiles("cal/src"),
      ...await programFiles("serendipity"),
    ];
    // Anchored on the SERVED_SOURCES roots, not on a tree name. This read
    // /^www\/(garage|lwe)\// until 2026-08-23, and www/ stopped existing on
    // 2026-08-18, so the exemption had been silently false for every file and
    // the build printed 14 taste warnings on demo pages on every single run.
    const isDemo = (p) => /^(?:public|src\/pages)\/(?:garage|lwe)\//.test(p);
    // Blank block comments before pattern-matching (luna.css discusses @font-face
    // in prose twice, and a guard that fires on its own documentation gets
    // muted). BLANK rather than delete: same length, newlines kept, so a match
    // offset still maps to its real line — which is what lets a finding be
    // traced back to the source line and checked for a taste-ok marker.
    const blank = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

    for (const f of served) {
      let raw; try { raw = await read(f); } catch { continue; }
      const src = blank(raw);
      const lines = raw.split("\n");
      const lineAt = (off) => lines[src.slice(0, off).split("\n").length - 1] || "";
      // A deliberate deviation is recorded ON THE LINE, as /* taste-ok: why */.
      // It silences the WARN-level checks only. There is no way to mark yourself
      // exempt from zero font bytes or from an overshoot curve, because those
      // are not taste calls. Reasons are printed in the build summary, so an
      // exemption stays visible instead of quietly becoming the new normal.
      const okOn = (off) => {
        const m = /taste-ok:\s*([^*/]+)/.exec(lineAt(off));
        if (!m) return false;
        tasteOk.push(`${f}: ${m[1].trim()}`);
        return true;
      };
      tasteScanned++;

      // 9a (hard) — zero font bytes, the one rule with no taste component. Every
      // way a page could acquire a downloadable face, not just @font-face.
      if (/@font-face\s*\{[^}]*url\(/i.test(src)) hard.push(`${f}: @font-face with url() — the site ships 0 font bytes (local() reference rules belong in design/tokens/fonts.css, never in a served file)`);
      if (/@import[^;]*(font|typekit)/i.test(src)) hard.push(`${f}: @import of a font stylesheet — the site ships 0 font bytes`);
      if (/as\s*=\s*"?font"?/i.test(src)) hard.push(`${f}: rel=preload as=font — the site ships 0 font bytes`);
      for (const host of ["fonts.googleapis.com", "fonts.gstatic.com", "use.typekit.net", "fonts.bunny.net"]) {
        if (src.includes(host)) hard.push(`${f}: references ${host} — the site ships 0 font bytes`);
      }

      // 9b (hard) — an overshoot easing curve. Unlike "is 300ms too slow", this
      // one is decidable: y outside [0,1] means the value springs past its target
      // and settles back, which is a 2015 motion language no Luna control had.
      for (const m of src.matchAll(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/g)) {
        const [y1, y2] = [Number(m[2]), Number(m[4])];
        if (y1 < 0 || y1 > 1 || y2 < 0 || y2 > 1) hard.push(`${f}: ${m[0]} overshoots — springy easing reads as a different era`);
      }
      if (isDemo(f)) continue;

      // 9c (warn) — a NEW easing curve outside the two the window morph uses.
      // Tuning one of these is a taste call, so this prompts a look, never a block.
      for (const m of src.matchAll(/cubic-bezier\([^)]*\)/g)) {
        const v = m[0].replace(/\s+/g, "");
        if (!["cubic-bezier(.4,0,1,1)", "cubic-bezier(0,0,.2,1)"].includes(v) && !okOn(m.index)) warn.push(`${f}: ${m[0]} is not one of the two window-morph curves — taste review`);
      }
      // 9d (warn) — radius past --radius-window (8px). Elliptical radii are
      // skipped: the Start orb is a real pill and its 9px/14px is correct.
      for (const m of src.matchAll(/border-radius:\s*([^;}"']+)/g)) {
        if (m[1].includes("/")) continue;
        for (const px of m[1].matchAll(/([\d.]+)px/g)) {
          if (Number(px[1]) > 8 && !okOn(m.index)) warn.push(`${f}: border-radius ${m[1].trim()} exceeds --radius-window (8px) — taste review`);
        }
      }
      // 9e (warn) — a soft shadow. XP dropped shadows on menus and dialogs, so
      // this can't be zero; luna.css's widest is 9px. Past 12px it stops reading
      // as a drop shadow and starts reading as a 2015 elevation surface.
      for (const m of src.matchAll(/box-shadow:\s*([^;}"']+)/g)) {
        if (/\binset\b/.test(m[1])) continue;
        // offsets may be a unitless 0 ("0 4px 24px"), so px is optional on them
        for (const px of m[1].matchAll(/-?[\d.]+(?:px)?\s+-?[\d.]+(?:px)?\s+([\d.]+)px/g)) {
          if (Number(px[1]) > 12 && !okOn(m.index)) warn.push(`${f}: box-shadow blur ${px[1]}px reads as a modern elevation shadow — taste review`);
        }
      }
      // 9f (warn) — smooth scrolling. XP scrolled instantly; a demo page showing
      // the property off is exempt above.
      const sb = /scroll-behavior:\s*smooth/.exec(src);
      if (sb && !okOn(sb.index)) warn.push(`${f}: scroll-behavior: smooth — XP scrolled instantly`);
    }
  } catch (e) { warn.push(`taste tripwire could not run: ${e.message}`); }

  // 10 (hard) — no git conflict markers in anything the site serves. A rebase on
  // 2026-07-27 left an empty-vs-empty conflict in src/pages/garage/compression.html;
  // `git add -A` swallowed the three residue lines, and the build, the perf
  // budget, and all 24 contract tests passed. A human caught them by eye, in a
  // screenshot, rendering as visible text above the taskbar. Nothing in the
  // toolchain would have stopped them. A marker in a served file is never
  // intentional, so this blocks rather than warns.
  //
  // Anchored at line start ONLY, and `=======` must be the WHOLE line. The garage
  // pages legitimately discuss diffs, heredocs, and shell redirection in prose and
  // in code samples, so an unanchored match would false-fire on real content —
  // which is exactly how a guard on the one deploy path ends up commented out.
  let conflictScanned = 0;
  try {
    const collect = async (dir, match, skip = /^$/, out = []) => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) { if (!skip.test(e.name)) await collect(p, match, skip, out); }
        else if (match.test(e.name)) out.push(p);
      }
      return out;
    };
    const flat = async (dir, match) =>
      (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && match.test(e.name)).map((e) => `${dir}/${e.name}`);
    const files = [
      ...await collect("src/pages", /\.html$/, /^(i|images|og|cars|node_modules)$/),
      ...await flat("src/client", /\.js$/),
      ...await flat("src/styles", /\.css$/),
      ...await collect("src/worker", /\.ts$/),
      ...await flat("cal/src", /\.ts$/),
      ...await flat("serendipity", /\.js$/),
    ];
    const MARKER = /^(<{7} |={7}$|>{7} )/;
    for (const f of files) {
      let src; try { src = await read(f); } catch { continue; }
      conflictScanned++;
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, "");
        if (MARKER.test(line)) hard.push(`${f}:${i + 1}: git conflict marker in a served file — ${line.slice(0, 60)}`);
      }
    }
  } catch (e) { hard.push(`conflict-marker check could not run: ${e.message}`); }

  if (warn.length) console.warn("build: invariant WARNINGS (deploy continues):\n  - " + warn.join("\n  - "));
  if (hard.length) throw new Error("build: invariant tripwires FAILED, deploy blocked:\n  - " + hard.join("\n  - "));
  console.log(`invariants ok: ${stagedAuthored} staged paths collision-free, ${routeKeys.length + prefixProbes.length} routes mirrored (${prefixProbes.length} prefix), CSP style-src, blink-fix, generator, geometry, ${skillsChecked} skill digest${skillsChecked === 1 ? "" : "s"}, ${manifestChecked} surfaces registered, ${tasteScanned} files taste-scanned${tasteOk.length ? ` (${tasteOk.length} taste-ok: ${tasteOk.join("; ")})` : ""}, ${conflictScanned} files conflict-free${warn.length ? " (with warnings above)" : ""}`);
}

// ── the client edge, authored once and mirrored at deploy ────────────────────
// luna.css owns the rule (search "THE CLIENT EDGE") and every windowed page
// inherits it at runtime, so the SOURCE is already correct with nothing to
// remember on a new page. The mirror below exists purely for first paint: luna
// loads non-render-blocking and the edge's 6px gutter is layout, so without a
// copy in the page's own inline block the document lays out 12px wider and
// re-wraps once when luna lands.
//
// Hand-maintaining that copy in ~30 files was the thing worth deleting: it is
// derived data, it drifts, and forgetting it on a new page is invisible until
// someone watches a reflow. So the build derives it instead, from luna.css, and
// a page author never writes it. Local dev (wrangler.dev.jsonc) serves the
// unbuilt tree, where the edge simply arrives with luna.css.
//
// This is the ONLY generated CSS in the build. It adds no new rule and changes
// no cascade: the injected declaration is byte-identical to luna's, so when luna
// applies, nothing moves.

// pull the declaration body out of luna.css so there is one definition of it
const clientEdgeDecl = (luna) => {
  const m = /\.window>\.content,\.window>\.body\{(border:\d+px solid #ece9d8[^}]*outline-offset:-\d+px)\}/.exec(luna);
  return m ? m[1] : null;
};

// the geometry mirror every windowed page already carries; the edge goes after it
const GEOMETRY_MIRROR = /^([ \t]*)(\.window\s*>\s*\.content(?:\s*,\s*\.window\s*>\s*\.body)?\s*\{[^}]*overflow:\s*auto[^}]*\})[ \t]*$/m;

// insert the edge right after the geometry mirror, matching the file's own
// spacing so garage/lwe View Source still reads as hand-written CSS.
const clientEdgeMirror = (source, decl) => {
  const m = GEOMETRY_MIRROR.exec(source);
  if (!m) return null;
  const [, indent, rule] = m;
  const sel = rule.slice(0, rule.indexOf("{")).trim();
  const spaced = sel.includes(" > ");
  const body = spaced ? decl.replace(/([:,])(?! )/g, "$1 ").replace(/;/g, "; ") : decl;
  const line = spaced
    ? `${indent}/* client edge — generated by build.mjs from luna.css */\n${indent}${sel} { ${body}; }`
    : `${indent}/* client edge — generated by build.mjs from luna.css */\n${indent}${sel}{${body}}`;
  return source.slice(0, m.index + m[0].length) + "\n" + line + source.slice(m.index + m[0].length);
};

// the client scripts to minify: [file, banner pointer, tripwire the minified output MUST contain]
// sw.js left this list in v136: it's a ~15-line unregister stub now, shipped
// readable and verbatim (no version string, no twin, nothing to tripwire).
const SHELLS = [
  ["nav.js",     "/nav.src.js",     "axp-histnav"],
  ["nav-run.js", "/nav-run.src.js", "axp-run"],
  ["nav-tray.js", "/nav-tray.src.js", "axp-balloon"],
  ["notepad.js", "/notepad.src.js", "np-window"],
  ["lens-boot.js", "/lens-boot.src.js", "requestSubmit"],
  ["lens-webmcp.js", "/lens-webmcp.src.js", "LensWebMcp"],
  ["lens.js",    "/lens.src.js",    "replaceState"],   // verify-routes.mjs marker
  ["lens-browser.js", "/lens-browser.src.js", "LensBrowser"],
  ["lens-reader.js", "/lens-reader.src.js", "LensReader"],
  ["lens-wire.js",   "/lens-wire.src.js",   "LensWire"],
  ["lens-tools.js",  "/lens-tools.src.js",  "LensTools"],
  ["lens-nlweb.js",  "/lens-nlweb.src.js",  "LensNlweb"],
  ["lens-markdown.js", "/lens-markdown.src.js", "LensMarkdown"],
  ["quiz.js",    "/quiz.src.js",    "luq-data"],       // the understanding-check widget
  ["tooltip.js", "/tooltip.src.js", "function start"],
  ["infotip.js", "/infotip.src.js", "axp-infotip"],   // the shell's own tooltips
  // the shared hover engine. tooltip.js imports it statically; the serendipity
  // shell and nav.js import it dynamically. Deliberately NOT content-hashed:
  // the /a/ repointer is attribute-scoped (src=/href= only) and would never
  // rewrite an `import` specifier, so it stays a plain /hoist.js like its peers.
  ["hoist.js",   "/hoist.src.js",   "createHoist"],
  // first-party WebMCP registration. Unhashed for hoist.js's reason: nav.js and
  // lens-webmcp.js both reach it through an `import()` specifier, which the /a/
  // repointer is attribute-scoped and would never rewrite.
  ["webmcp.js",  "/webmcp.src.js",  "registerSiteTools"],
];

// fail fast on a broken invariant before doing any staging work
await checkInvariants();

// Generated delta dirs must never exist in the SOURCE tree. They were committed under an
// earlier design and are pure build output now, but a leftover public/ad/ gets copied in
// by the staging step below and ships artifacts current code would never build — which is
// how an icons.*.dcz survived #119's svg exclusion locally, long after the guard forbidding
// it was in place. That guard stops GENERATION, not staging of stale files.
for (const dead of ["public/ad"]) {
  await rm(dead, { recursive: true, force: true });
}
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// 1) stage: public/ verbatim (.assetsignore rides along). No wrangler config is
// copied into .build anymore — the deploy config (wrangler.jsonc) points main +
// assets at .build/public and runs THIS script via its build.command, so the
// build output never needs its own config. (Local dev uses wrangler.dev.jsonc.)
//
// public/scripts USED TO BE the one exception here, and it was 89% of the tree's
// bytes: the zenc cargo target/ and the uv venv put it at ~232 MB across 767
// files, against ~27 MB for everything that actually ships, so the build copied
// a quarter of a gigabyte per run for .assetsignore to then refuse to upload.
//
// The pipeline lives at tools/photos now, outside public/ entirely, so there is
// nothing to skip and no exception to keep correct. That is the point of moving
// it: an exception that existed only because dev tooling sat in the served tree
// disappears when the tooling leaves, rather than being maintained forever.
//
// What still catches a page that starts referencing it is LINK-INTEGRITY, which
// resolves every same-origin href/src against the staged tree and finds no
// /scripts/ there. Verified rather than assumed, with a link to
// /scripts/shell-data.ts injected into a page's prose: link-integrity reported
// 1 internal reference pointing at nothing this site serves.
//
// The served tree is COMPOSED from four source directories now, and its shape
// under .build/public is unchanged, so every public URL is where it was. What
// moved is where each file is AUTHORED: public/ is byte-for-byte assets,
// src/pages/ is every HTML document, src/content/ is authored prose, and
// src/client + src/styles supply the shell. src/dict/ is deliberately absent:
// the committed dictionary snapshots are build INPUT (#455).
const STAGE_SKIP = new Set(["public/images/meta"]);
// The invariant above proves that the five served roots do not contend for a
// destination file. Copy all independent source trees in one filesystem latency
// window instead of serializing eight recursive walks.
await Promise.all([
  mkdir(`${OUT}/public`, { recursive: true }),
  mkdir(`${OUT}/src`, { recursive: true }),
  mkdir(`${OUT}/cal`, { recursive: true }),
  mkdir(`${OUT}/serendipity`, { recursive: true }),
]);
await Promise.all([
  cp("public", `${OUT}/public`, {
    recursive: true,
    filter: (source) => !STAGE_SKIP.has(source.split(sep).join("/")),
  }),
  cp("src/pages", `${OUT}/public`, { recursive: true }),
// The Worker is a PROGRAM, not a document, so its source lives in src/worker
// beside cal/ and serendipity/ rather than inside the tree of things a browser
// can fetch. Its STAGED position is unchanged: wrangler.jsonc still points main
// at .build/src/worker/index.ts, and every deploy path and content hash
// downstream is therefore untouched by the move.
  cp("src/worker", `${OUT}/src/worker`, { recursive: true }),
// The client islands and stylesheets author in src/ beside the Worker, and stage
// back to the ROOT of the served tree because their public URLs are /nav.js and
// /luna.css. Source layout and URL layout are different questions; only the first
// one moved, so every served byte and every /a/ content hash is untouched.
// Authored PROSE and the registries beside it: the writing posts and their
// posts.json, the hand-written Markdown twins for the Worker-rendered pages, and
// the four root .md documents. They stage back into the served tree at the SAME
// paths, so /writing/<slug>.txt, /index.md and the rest answer exactly where they
// did. Source layout and URL layout are different questions, and only the first
// one moved.
  cp("src/content", `${OUT}/public`, { recursive: true }),
  cp("src/client", `${OUT}/public`, { recursive: true }),
  cp("src/styles", `${OUT}/public`, { recursive: true }),
  cp("cal/src", `${OUT}/cal/src`, { recursive: true }),
  cp("serendipity/serendipity.ts", `${OUT}/serendipity/serendipity.ts`),
]);
// 1a) /images/meta/<stem>.json, DERIVED rather than copied.
//
// These are the tooltip's per-photo self-heal: a stem missing from the shared
// EXIF index, or a tile with no baked histogram, falls back to one of these. They
// used to be 158 COMMITTED files, and they are a pure projection of two files
// that are also committed — verified 158/158, text half and histogram half both
// exact. Same argument the Markdown twins won: a pure function of committed bytes
// should not be a second committed copy that can fall behind, and generating it
// here means there is no step anyone can forget.
//
// public/images/meta is in STAGE_SKIP for this reason. Copying whatever happens to be
// on the local disk and then writing over it would make the built tree depend on
// pipeline leftovers; deriving it makes the two indexes the only source.
//
// The histogram values come back quantized to the index's 64 levels rather than
// the original 0-100, so a regenerated file differs from the retired committed one
// by at most 1. That is 0.32px in the 32-unit SVG these feed, and the real source
// of truth is the photograph, which `zenc histogram` can re-bake.
{
  const exif = JSON.parse(await readFile(`${OUT}/public/images/exif.json`, "utf8").catch(() => "{}"));
  const packed = JSON.parse(await readFile(`${OUT}/public/images/histograms.json`, "utf8").catch(() => "{}"));
  const CHANNELS = ["l", "r", "g", "b"];
  const BINS = 64, HIST_BASE = 63, HIST_LEVELS = 64;
  await mkdir(`${OUT}/public/images/meta`, { recursive: true });
  let written = 0;
  // Parsed at the boundary: a packed entry becomes channels or nothing, and every
  // caller below branches on the channels rather than on the string. A wrong-typed
  // entry has no .length and falls out here the same as a missing one.
  const unpackChannels = (p) => {
    if (!p || p.length !== CHANNELS.length * BINS) return null;
    const hi = {};
    for (const [ci, channel] of CHANNELS.entries()) {
      hi[channel] = Array.from({ length: BINS }, (_, i) =>
        Math.round((p.charCodeAt(ci * BINS + i) - HIST_BASE) * 100 / (HIST_LEVELS - 1)));
    }
    return hi;
  };
  for (const [stem, record] of Object.entries(exif) as [string, Record<string, any>][]) {
    const out = { ...record };
    const hi = unpackChannels(packed[stem]);
    if (hi) out.hi = hi;
    await writeFile(`${OUT}/public/images/meta/${stem}.json`, JSON.stringify(out));
    written++;
  }
  // A silent zero here serves 404s to every fallback fetch, which reads as a
  // tooltip that has quietly stopped self-healing rather than as a broken build.
  if (written < 30) throw new Error(`meta twins: only ${written} per-photo files generated — is images/exif.json staged?`);
  console.log(`meta twins: ${written} per-photo files derived from exif.json + histograms.json`);
}


// 1b) inject the client edge into every staged page that carries the window
// geometry mirror. Runs BEFORE minification so the injected CSS is minified with
// the rest of the page rather than riding along as a readable line in a minified
// file. Pages that load luna.css render-blocking (garage/gpt56.html) carry no
// geometry mirror and correctly get nothing.
{
  const decl = clientEdgeDecl(await readFile("src/styles/luna.css", "utf8"));
  const targets = (await readdir(`${OUT}/public`, { recursive: true }))
    .filter((f) => /\.(html|js)$/.test(f) && !/\.src\.|^(i|images|og|cars)\//.test(f))
    .map((f) => `${OUT}/public/${f}`)
    // The Worker modules stage outside the asset tree now, and several of them
    // RENDER pages (/bot, /lens) that carry the geometry mirror. Walking only
    // .build/public silently dropped those two from the mirror, which the floor
    // below did not catch because 31 still cleared it.
    .concat((await readdir(`${OUT}/src/worker`, { recursive: true }))
      .filter((f) => f.endsWith(".js") || f.endsWith(".ts"))
      .map((f) => `${OUT}/src/worker/${f}`))
    .concat([`${OUT}/cal/src/templates.ts`, `${OUT}/serendipity/serendipity.ts`]);

  let mirrored = 0, skipped = 0;
  for (const f of targets) {
    let src; try { src = await readFile(f, "utf8"); } catch { continue; }
    if (!GEOMETRY_MIRROR.test(src)) { skipped++; continue; }
    const out = clientEdgeMirror(src, decl);
    if (!out) throw new Error(`client edge: ${f} matched the geometry mirror but the injection did not fire`);
    await writeFile(f, out);
    mirrored++;
  }
  // a rename in luna.css or in the geometry mirror would silently mirror nothing
  // and cost every page a reflow, so the count is the tripwire.
  if (mirrored < 32) throw new Error(`client edge: mirrored into only ${mirrored} pages (expected 32+) — did the geometry-mirror shape change, or did a walk stop reaching the Worker modules?`);
  console.log(`client edge: mirrored into ${mirrored} staged pages from luna.css (${skipped} files carry no window geometry)`);
}

// 1c) the Markdown twins used to run HERE, before any page was generated, which
// is exactly why /updates and /restore never got one. Moved below 1f, after the
// deploy-time documents exist. See the block there.

const minifyJavaScript = (filename, sourceText) => {
  const result = minifySync(filename, sourceText, {
    module: false,
    compress: {
      // The site deliberately targets modern browsers. This preserves modern
      // syntax while enabling Oxc's full ESNext compression set.
      target: "esnext",
      dropDebugger: true,
      unused: true,
      joinVars: true,
      sequences: true,
      treeshake: {
        annotations: true,
        propertyReadSideEffects: "always",
        propertyWriteSideEffects: true,
        unknownGlobalSideEffects: true,
        invalidImportSideEffects: true,
      },
    },
    // Keep top-level names stable: several shell files expose globals that
    // other site code discovers by name.
    mangle: { toplevel: false },
    codegen: { removeWhitespace: true, legalComments: "none" },
  });
  if (result.errors.length) {
    throw new Error(`${filename}: Oxc parse/minify failed: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result.code;
};

// The tolerated-warning family and the pass-through re-proof live in
// tools/lib/css-parse.ts, shared with check-page-contracts.mjs so a stylesheet
// cannot pass one CSS check and fail the other. See that file for why.
const minifyCss = (filename, sourceText) => parseCss(filename, sourceText, { minify: true });

// Homepage HTML uses minify-html for structure only; inline CSS/JS are passed
// through the same Lightning CSS and Oxc settings used everywhere else in the
// build. JSON-LD and speculation rules remain data, not JavaScript.
const HTML_MINIFY_CFG = {
  allow_noncompliant_unquoted_attribute_values: false,
  allow_optimal_entities: false,
  allow_removing_spaces_between_attributes: false,
  keep_closing_tags: true,
  keep_comments: false,
  keep_html_and_head_opening_tags: true,
  keep_input_type_text_attr: true,
  keep_ssi_comments: true,
  minify_css: false,
  minify_doctype: false,
  minify_js: false,
  // The template-passthrough pair, both at the library default. They are here
  // so the 15 options @minify-html/node 0.18.1 declares are 15 DECISIONS: this
  // block enumerated 13 and inherited 2, and an inherited default is a byte
  // change nobody reviews the day upstream flips one. Nothing here authors in
  // a `{{ }}` or `<% %>` template language, and /garage/horizon ships hostile
  // demo payloads as content, so a passthrough that swallowed source until a
  // matching close brace would be a parser this build cannot see into.
  // Verified as a no-op: 1614 staged files, byte-identical, measured
  // 2026-08-27. A moved byte would re-mint an `/a/` URL (gotcha 35).
  preserve_brace_template_syntax: false,
  preserve_chevron_percent_template_syntax: false,
  remove_bangs: false,
  remove_processing_instructions: false,
};
const RAW_HTML_TAGS = new Set(["pre", "script", "style", "textarea"]);

const findHtmlTagEnd = (source, start) => {
  let quote = "";
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  throw new Error("HTML inline transform: unterminated tag at byte " + start);
};

const scriptType = (openTag) => {
  const match = openTag.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/i);
  return (match ? (match[1] || match[2] || match[3] || "") : "").toLowerCase();
};

const isJavaScriptScript = (openTag) => {
  const type = scriptType(openTag);
  return !type || ["text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript", "module"].includes(type);
};

// `label` names the document in any error the inline minifiers raise. It used to
// be hardcoded to src/pages/index.html, which was true while the homepage was the
// only caller and became a lie the moment step 7b started feeding 43 pages
// through here: /garage/horizon's CSS failure reported itself as index.html.
const transformInlineHtmlBlocks = (source, label = "src/pages/index.html") => {
  let out = "";
  let cursor = 0;

  while (cursor < source.length) {
    const lt = source.indexOf("<", cursor);
    if (lt === -1) {
      out += source.slice(cursor);
      break;
    }

    out += source.slice(cursor, lt);
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      if (end === -1) throw new Error("HTML inline transform: unterminated comment at byte " + lt);
      out += source.slice(lt, end + 3);
      cursor = end + 3;
      continue;
    }

    const gt = findHtmlTagEnd(source, lt);
    const token = source.slice(lt, gt + 1);
    out += token;
    cursor = gt + 1;

    const match = token.match(/^<\s*(\/?)\s*([A-Za-z][^\s/>]*)/);
    if (!match || match[1] || !RAW_HTML_TAGS.has(match[2].toLowerCase())) continue;

    const tag = match[2].toLowerCase();
    const close = new RegExp("<\\/\\s*" + tag + "\\s*>", "i").exec(source.slice(cursor));
    if (!close) throw new Error("HTML inline transform: unterminated <" + tag + "> element");
    const closeAt = cursor + close.index;
    const body = source.slice(cursor, closeAt);

    if (tag === "style") {
      out += minifyCss(`${label} inline <style>`, body);
    } else if (tag === "script" && isJavaScriptScript(token)) {
      out += minifyJavaScript(`${label} inline <script>`, body);
    } else {
      out += body;
    }

    out += source.slice(closeAt, closeAt + close[0].length);
    cursor = closeAt + close[0].length;
  }

  return out;
};

// The exact transform step 7b writes for every non-homepage HTML document. Kept
// here as one function because the page-family dictionary samples the bytes the
// browser will actually receive, before step 7b reaches the files themselves.
// A dictionary sampled from the readable pre-minification source still works, but
// wastes its scarce 64KB on whitespace and comments absent from every target.
const minifiedPage = (staged, rel) => {
  const twinRel = rel.replace(/\.html$/, ".src.html");
  const banner = `<!-- minified at deploy; readable source: /${twinRel} -->\n`;
  return banner + minifyHtml.minify(
    Buffer.from(transformInlineHtmlBlocks(staged, `public/${rel}`)),
    HTML_MINIFY_CFG,
  ).toString();
};

const inlineProbe = transformInlineHtmlBlocks(
  '<style>/* probe */ .x { color: red; }</style>\n' +
  '<script>/* probe */ const x = 1 + 2;</script>\n' +
  '<script type="application/ld+json">\n{ "x": 1 }\n</script>'
);
if (inlineProbe.includes("/* probe */") ||
    !inlineProbe.includes('<script type="application/ld+json">\n{ "x": 1 }\n</script>')) {
  throw new Error("inline CSS/JS transform self-test failed");
}


// 1d) the homepage's baked fallback grid + last-modified date.
//
// `/` used to be four HTMLRewriter injections over a skeleton (tracks, photo
// grid, visit counter, last-modified). That made its bytes different on every
// request, which is the one thing a precomputed dcz delta and a 304 cannot
// survive. Three of the four moved to the client; this bakes the fourth and
// gives the grid a real, deterministic fallback so the page still says
// something to a crawler or a visitor without JavaScript.
//
// Determinism is the contract. The twelve are chosen by stem sort and the date
// comes from the committed pool, so this output changes only when the pool
// does — which is also the only time the page's meaning changes.
{
  const nonce = `?build=${BUILD_NONCE}`;
  const grid = await import(pathToFileURL(resolve(OUT, "src/worker/lib/photo-grid.ts")).href + nonce);
  const photos = await import(pathToFileURL(resolve(OUT, "src/worker/photos.ts")).href + nonce);
  const pool = photos.derivePhotoPool(
    JSON.parse(await readFile(`${OUT}/src/worker/photo-index.json`, "utf8")),
    JSON.parse(await readFile(`${OUT}/public/images/hashes.json`, "utf8")),
  );
  if (!pool.length) throw new Error("homepage bake: the photo pool is empty — the grid fallback would ship as bare frames");
  const altMap = JSON.parse(await readFile(`${OUT}/public/images/alt.json`, "utf8").catch(() => "{}"));
  const histograms = JSON.parse(await readFile(`${OUT}/public/images/histograms.json`, "utf8").catch(() => "{}"));
  const twelve = grid.deterministicTwelve(pool);
  if (twelve.length !== 12) throw new Error(`homepage bake: expected 12 fallback tiles, pool yielded ${twelve.length}`);
  // A silent {} here would ship a grid whose tiles all fall back to the per-hover
  // fetch, which is the pre-#440 behaviour and looks like nothing is wrong.
  const histed = twelve.filter((p) => histograms[p.stem]).length;
  if (histed !== 12) throw new Error(`homepage bake: ${histed} of 12 baked tiles carry a histogram — run bun run photos or node tools/photos/build-histogram-index.mjs`);
  const slots = grid.renderPhotoSlots(twelve, altMap, { histograms });

  let html = await readFile(`${OUT}/public/index.html`, "utf8");
  const section = /(<section class="photos"[^>]*>)([\s\S]*?)(<\/section>)/;
  if (!section.test(html)) throw new Error("homepage bake: no <section class=\"photos\"> to fill — did the grid markup move?");
  html = html.replace(section, (_m, open, _inner, close) =>
    open.replace(/\sdata-ssr="[^"]*"/, "") + slots + close);

  // Newest photo wins, floored by the hand-written date already in the file, so
  // a copy-only edit can still bump it by hand.
  let newest = 0;
  for (const p of pool) { const t = p.uploaded ? Date.parse(p.uploaded) : NaN; if (!isNaN(t) && t > newest) newest = t; }
  if (newest > 0) {
    const d = new Date(newest);
    const iso = d.toISOString().slice(0, 10);
    const shown = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    html = html.replace(/<time datetime="([^"]*)"[^>]*>([^<]*)<\/time>/, (m, floor) =>
      iso >= floor ? `<time datetime="${iso}">${shown}</time>` : m);
  }
  await writeFile(`${OUT}/public/index.html`, html);
  console.log(`homepage bake: 12 deterministic fallback tiles + last-modified ${new Date(newest).toISOString().slice(0, 10)}`);
}

// 1e) /photos and /bot as deploy-time documents.
//
// Both render from build-time inputs only, so their bytes are knowable here, and
// emitting them as HTML buys the q11 twin plus both dcz delta tiers that step 8
// already gives every other page. /photos was the largest page on the site (60KB)
// and the largest still taking Cloudflare's on-the-fly zstd-3 with no twin at all.
//
// Same import-from-the-built-tree shape as step 1d: the Worker's own renderer runs
// in Node against the committed artifacts, so there is ONE renderer rather than a
// Node copy that can drift from the served one. The route keeps the dynamic handler
// as a 404 fallback, so a failure here degrades to today's behaviour instead of a
// missing page — but these throws exist because a SILENTLY empty contact sheet is
// worse than a failed deploy.
{
  const nonce = `?build=${BUILD_NONCE}`;
  const photos = await import(pathToFileURL(resolve(OUT, "src/worker/photos.ts")).href + nonce);
  const bot = await import(pathToFileURL(resolve(OUT, "src/worker/bot.ts")).href + nonce);

  const pool = photos.derivePhotoPool(
    JSON.parse(await readFile(`${OUT}/src/worker/photo-index.json`, "utf8")),
    JSON.parse(await readFile(`${OUT}/public/images/hashes.json`, "utf8")),
  );
  if (!pool.length) throw new Error("photos page: the pool is empty — the contact sheet would ship with no tiles");
  const altMap = JSON.parse(await readFile(`${OUT}/public/images/alt.json`, "utf8").catch(() => "{}"));

  const photosHtml = await photos.renderPhotosPage(pool, altMap).text();
  if (!photosHtml.includes("class=\"ph\"")) throw new Error("photos page: rendered document has no tiles — did the markup move?");
  await writeFile(`${OUT}/public/photos.html`, photosHtml);

  const botHtml = await bot.renderBotPage().text();
  if (!botHtml.includes("AadharshBot")) throw new Error("bot page: rendered document does not name the crawler — did the copy move?");
  await writeFile(`${OUT}/public/bot.html`, botHtml);

  console.log(`pages(gen): photos.html ${photosHtml.length}B (${pool.length} tiles), bot.html ${botHtml.length}B`);
}

// 1f) /updates and /restore as deploy-time documents.
//
// The only two dynamic pages whose data changes solely AT DEPLOY: bump-version.sh
// inserts the checkpoint row moments before `bun run deploy:direct`, and nothing else
// writes that table. So baking them costs no freshness at all — unlike /reading
// (6h Curius refresh) or /around (30m crawl), whose feeds move on their own and
// which are deliberately left dynamic for exactly that reason.
//
// D1 remains the source of truth. checkpoints.json is its committed projection,
// written by bump-version.sh right after a successful insert, and
// `bun run checkpoints:check` re-reads D1 and fails on drift.
{
  const nonce = `?build=${BUILD_NONCE}`;
  const updates = await import(pathToFileURL(resolve(OUT, "src/worker/updates.ts")).href + nonce);
  const points = JSON.parse(await readFile(`${OUT}/src/worker/checkpoints.json`, "utf8"));
  if (!points.length) throw new Error("updates/restore: the checkpoint projection is empty — both pages would ship with no log");
  const cp = { points, state: "ok" };

  const updatesHtml = await (await updates.renderWindowsUpdate(cp)).text();
  if (!updatesHtml.includes("wu-tag")) throw new Error("updates page: no changelog rows rendered — did the markup move?");
  await writeFile(`${OUT}/public/updates.html`, updatesHtml);

  const restoreHtml = await (await updates.renderSystemRestore(cp)).text();
  if (!restoreHtml.includes("srList")) throw new Error("restore page: no restore-point stage rendered — did the markup move?");
  await writeFile(`${OUT}/public/restore.html`, restoreHtml);

  console.log(`pages(gen): updates.html ${updatesHtml.length}B, restore.html ${restoreHtml.length}B (${points.length} checkpoints, newest ${points[points.length - 1].version})`);
}

// 1g) the Markdown twins + per-section llms.txt indexes. Generated from the
// READABLE source in public/ wherever a page has one, never from the staged
// copy: the staged pages are about to be rewritten (client edge, hashed asset
// refs) and index.html is about to be minified, none of which belongs in a twin.
// Because a twin is a pure function of source bytes, generating it here makes
// drift structurally impossible — no committed copy to fall behind, no step to
// forget. Same argument the dcz deltas won.
//
// It runs HERE, after 1d-1f, rather than up at 1c where it used to. A page with
// no prose source got skipped, which was right when every such page was rendered
// live by the Worker and wrong the moment the build started baking some of them
// into HTML. /updates and /restore fell into that gap: baked at 1f, twinned
// never, still advertising `flags.agents: true` and still answering an agent's
// `Accept: text/markdown` with HTML. Ordering was the whole bug.
//
// generatedRoot is therefore the staged tree, read in the one window where it is
// still honest: after the canonical renderers have written these documents and
// before the hashing, ref-rewriting, and minification passes touch them. Source
// first, hand-authored second (so /bot keeps the twin checkTwinFacts pins),
// generated only as the last resort.
// Handed to 1g2 below, which may only advertise a twin the build really wrote.
let twinFiles;
// Set by 1g2: dresses one page with the Explorer chrome + its Markdown link.
// The readable .src.html twins at step 7b call it too, so a twin never drifts
// from the page it claims to be the source of.
// The placeholder throws, so inference reads it as `() => never` and every later
// call is "Expected 0 arguments, but got 2". The annotation states the shape 1g2
// actually installs, which is also what the sole caller passes.
/** Installed by step 1g2; the placeholder exists so a mis-ordered call fails loudly. */
let dressPage: (html: string, rel: string) => { html: string; addedLink: boolean; addedChrome: boolean } =
  () => { throw new Error("explorer: dressPage used before 1g2 defined it"); };
{
  const { buildTwins, checkTwinFacts } = await import("./gen-md-twins.ts");
  const drift = checkTwinFacts(".");
  if (drift.length) {
    throw new Error("md twins: a hand-authored twin disagrees with the Worker that renders its page:\n  - " + drift.join("\n  - "));
  }
  const { files, skipped, generated } = buildTwins(".", { generatedRoot: OUT });
  twinFiles = files;
  for (const [rel, body] of files) {
    const dest = `${OUT}/public${rel}`;
    await mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    await writeFile(dest, body);
  }
  const twins = [...files.keys()].filter((k) => k.endsWith(".md")).length;
  const indexes = [...files.keys()].filter((k) => k.endsWith("llms.txt")).length;
  // Losing the twins would otherwise be silent: pages keep serving HTML and only
  // `Accept: text/markdown` degrades, which nothing else in the build watches.
  if (twins < 30) throw new Error(`md twins: generated only ${twins} twins (expected 30+) — did site-manifest.json or the page shape change?`);
  // The generated tier gets its own tripwire, because the failure that produced it
  // was silent in exactly this way: the reordering above is what feeds it, so a
  // future step that moves back ahead of 1f would empty it without failing anything.
  if (!generated.length) throw new Error("md twins: no twin came from the generated tier — did the twin step move back above the deploy-time page renders?");
  console.log(`md twins: ${twins} pages + ${indexes} section indexes staged (${generated.length} from generated HTML: ${generated.join(", ")}; ${skipped.length} Worker-rendered surfaces carry no prose source)`);
}

// 1g2) the Explorer chrome, and the Markdown link that makes it worth having.
//
// Runs immediately after 1g because it needs the twin set that step just wrote:
// a page may only advertise `rel=alternate` where the build actually produced
// the file. Twins are build output, so no committed list could be right — the
// same argument that keeps lib/csp-hashes.js empty in the source tree.
//
// Injection is deliberately two string splices per page and no wrapper element:
// the address bar goes before `.content`, the pane goes just inside it, and
// luna.css turns `.content` into a two-column grid only when it finds a pane
// (`:has`). Wrapping the document would mean finding the matching close tag of
// `.content` in 30-odd staged files by hand, which is the one fragile way to do
// this.
//
// The homepage is excluded on purpose, and not for byte budget. It is not a
// folder: asked for a task list it has nothing to offer but "up to itself", and
// asked for a count it answers about whichever list it happens to render. The
// devices describe an object inside a folder, so they go where that is true.
{
  const { PLACES, addressBar, taskPane } = await import("../src/worker/lib/explorer.ts");

  // PLACES is a literal in a Worker module (no data file at runtime), so the
  // manifest is what keeps it honest. A section registered for the taskbar and
  // missing from the pane is drift the pane cannot show you.
  const manifest = JSON.parse(await readFile("config/site-manifest.json", "utf8"));
  const pinned = manifest.surfaces.filter((s) => s.flags && s.flags.taskbar).map((s) => s.path).sort();
  const declared = PLACES.map((p) => p.path).sort();
  if (pinned.join(",") !== declared.join(",")) {
    throw new Error(`explorer: lib/explorer.js PLACES disagrees with site-manifest.json taskbar surfaces\n  manifest: ${pinned.join(" ")}\n  explorer: ${declared.join(" ")}`);
  }

  // The twin set, as canonical request paths, for both consumers below.
  const twinPaths = [...twinFiles.keys()]
    .filter((rel) => rel.endsWith(".md"))
    .map((rel) => (rel === "/index.md" ? "/" : rel.slice(0, -3)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // Generated-module convention (shell-assets.js, csp-hashes.js): rewrite the
  // marked line in the STAGED copy so the Worker-rendered pages advertise the
  // same twins from the same source.
  {
    const target = `${OUT}/src/worker/lib/twins.ts`;
    const source = await readFile(target, "utf8");
    const marker = /^export const TWIN_PATHS = .*; \/\/ build:twins$/m;
    if (!marker.test(source)) throw new Error("explorer: build:twins marker missing from lib/twins.js");
    await writeFile(target, source.replace(marker, `export const TWIN_PATHS = ${JSON.stringify(twinPaths)}; // build:twins`));
  }

  // Read the object's own name out of its h1, minus the status pill the garage
  // marks each experiment with: the pill is state, not name, and sweeping it up
  // published "Thumbnail encoding study shipped" as a breadcrumb.
  const nameOf = (html) => {
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    if (!h1) return "";
    return h1[1]
      .replace(/<span\b[^>]*\bclass="[^"]*\bstatus\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const pages = (await readdir(`${OUT}/public`, { recursive: true }))
    .filter((f) => f.endsWith(".html") && !f.endsWith('.src.html') && !/^(i|images|og|cars|a)\//.test(f))
    .filter((f) => f !== "index.html");

  // One page's worth of work, shared with the twin writer at 7b.
  dressPage = (html, rel) => {
    const route = "/" + rel.replace(/(?:^|\/)index\.html$/, "").replace(/\.html$/, "");
    const normalized = route === "/" ? "/" : route.replace(/\/+$/, "");
    const twin = twinPaths.includes(normalized)
      ? (normalized === "/" ? "/index.md" : `${normalized}.md`)
      : null;

    // A count is a folder fact. The section indexes list their children in a
    // .shelf; every other page reports none rather than counting whatever list
    // it happens to contain.
    const details = [];
    if (rel.endsWith('/index.html') || !rel.includes("/")) {
      const shelf = /<ul\b[^>]*class="[^"]*\bshelf\b[^"]*"[\s\S]*?<\/ul>/.exec(html);
      const items = shelf ? (shelf[0].match(/<li\b/g) || []).length : 0;
      if (items) details.push({ term: "Contains", value: `${items} experiments` });
    }

    const options = {
      path: normalized,
      name: nameOf(html),
      tasks: twin ? [{ href: twin, label: "Read this as Markdown" }] : [],
      details,
    };

    let out = html, addedLink = false;
    if (twin && !/rel="alternate"[^>]*text\/markdown/.test(out)) {
      const tag = `<link rel="alternate" type="text/markdown" title="markdown source" href="${twin}">`;
      // Anchor on the canonical link where there is one, else on </head>. The
      // deploy-time documents come out of lunaPage(), which emits no canonical
      // tag, so a canonical-only anchor inserted nothing on exactly the pages
      // that could not advertise their twin any other way — while still counting
      // itself a success.
      const before = out;
      out = /<link rel="canonical"[^>]*>/i.test(out)
        ? out.replace(/(<link rel="canonical"[^>]*>)/i, `$1\n${tag}`)
        : out.replace(/<\/head>/i, `${tag}\n</head>`);
      if (out === before) throw new Error(`explorer: ${rel} has a twin but no <link rel=canonical> and no </head> to anchor the alternate link to`);
      addedLink = true;
    }

    let addedChrome = false;
    if (!out.includes('class="axp-tasks"')) {
      // Match AFTER the <head> edit above. Taking the index first and splicing
      // second put the address bar 90-odd characters early, inside the close
      // button's own <a> tag, on every page that gained a twin link.
      //
      // Both devices go BEFORE .content as its siblings; luna.css grids the
      // window around them. Putting the pane inside .content cost every page a
      // hole under its heading, because the pane then owned grid row 1.
      const contentOpen = /<div class="content"[^>]*>/.exec(out);
      if (contentOpen) {
        out = out.slice(0, contentOpen.index)
          + String(addressBar(options))
          + String(taskPane(options))
          + out.slice(contentOpen.index);
        addedChrome = true;
      }
    }
    return { html: out, addedLink, addedChrome };
  };

  let dressed = 0, linked = 0;
  for (const rel of pages) {
    const file = `${OUT}/public/${rel}`;
    const html = await readFile(file, "utf8");
    const hasChrome = html.includes('class="axp-tasks"');
    const windowed = /<div class="content"[^>]*>/.test(html) && /<div class="window"/.test(html);
    if (!hasChrome && !windowed) continue;
    const result = dressPage(html, rel);
    if (result.addedLink) linked++;
    if (result.addedChrome) dressed++;
    await writeFile(file, result.html);
  }

  // Both counts are tripwires for the same silent failure: a shape change in the
  // staged markup that makes the regexes above match nothing, leaving every page
  // quietly without its chrome or its alternate link.
  if (dressed < 30) throw new Error(`explorer: dressed only ${dressed} staged pages (expected 30+) — did the .window/.content shape change?`);
  if (linked < 30) throw new Error(`explorer: linked only ${linked} pages to a Markdown twin (expected 30+) — is the canonical link still in <head>?`);
  console.log(`explorer chrome: address bar + task pane on ${dressed} staged pages; ${linked} advertise a Markdown twin; ${twinPaths.length} twin paths handed to the Worker`);
}

// 1h) RSS feeds for the three authored sections.
//
// Build output for the same reason the twins are: a feed is a pure function of
// site-manifest.json, the sitemap's <lastmod> dates, and posts.json, so there is
// no committed copy to fall behind. Dates come from the sitemap rather than git,
// because a whitespace fix must not republish an item to every subscriber.
//
// The count is asserted for the same reason the twin count is: losing a feed is
// silent, since the pages keep serving and only subscribers notice.
{
  const { buildFeeds, FEEDS } = await import("./gen-feeds.ts");
  const feeds = buildFeeds(".");
  if (feeds.size !== FEEDS.length) {
    throw new Error(`feeds: generated ${feeds.size} of ${FEEDS.length} declared feeds`);
  }
  let items = 0;
  for (const [route, body] of feeds) {
    const count = (body.match(/<item>/g) || []).length;
    // An empty feed is worse than no feed: a reader that subscribes to one keeps
    // polling it forever and never learns anything went wrong.
    if (!count) throw new Error(`feeds: ${route} has no items — did the manifest sections or sitemap lastmod dates change shape?`);
    items += count;
    const dest = `${OUT}/public${route}`;
    await mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    await writeFile(dest, body);
  }
  console.log(`feeds: ${feeds.size} RSS feeds, ${items} items total`);
}


// 1i) /search-index.json, the corpus /search ranks and /ask publishes.
//
// Build output on the twins' argument, and it earned the move the hard way: the
// index was a COMMITTED file and froze twice, on 2026-08-18 (the roots walked a
// `www` the src/pages split had deleted, so the script exited ENOENT) and again
// on 2026-08-24 (the roots were right and nobody ran the script). Two different
// causes, one shape — a checked-in derivative with nothing diffing it against
// the source it derives from. Generating it here retires the shape rather than
// the cause, which is why this is not a third fix to the generator.
//
// The walk reads SOURCE, never the staged tree, so this may sit anywhere in
// step 1. That is deliberate and is NOT the ordering bug 1g records: a page
// rendered at 1e/1f has no prose file to index, and the surface registry's
// `searchIndex` flag is the declared way in for exactly those (all 11 of them
// today), which is what MANUAL injects. A generated page is missing from search
// because nobody set its flag, never because this step ran too early.
{
  const { buildSearchIndex } = await import("./generate-search-index.ts");
  const index = await buildSearchIndex(".");
  // Both floors guard a SILENT failure, which is the only kind this artifact
  // has. getSearchIndex() in search.ts falls back to `{ records: [] }` on a
  // missing or unreadable file, so a collapsed index renders /search perfectly
  // and finds nothing, and /ask answers with an empty result set rather than an
  // error. Neither reaches a log. A number that must not fall is the only
  // tripwire available.
  if (index.records.length < 50) {
    throw new Error(`search index: only ${index.records.length} records (expected 50+) — did a ROOTS directory move, or site-manifest.json change shape?`);
  }
  // The registry is a SECOND input and gets its own floor, because a corpus can
  // be the right size and still have lost every worker-rendered surface. Note
  // what the controls actually showed: emptying the registry today trips the
  // count floor first (46 walked records, so 46 < 50), which makes this line
  // unreachable at the moment. Keep it anyway — the walk is 4 pages off that
  // floor and grows every time somebody adds a page, and on the day it passes
  // 50 this is the only thing left watching the registry half.
  const manual = index.records.filter((r) => r.kind === "utility").length;
  if (!manual) throw new Error("search index: no manifest-injected records — is site-manifest.json readable and are any surfaces still flagged searchIndex?");
  await writeFile(`${OUT}/public/search-index.json`, JSON.stringify(index, null, 2) + "\n");
  console.log(`search index: ${index.records.length} records staged (${manual} from the surface registry)`);
}


// 2) homepage HTML: deploy the readable original as /index.src.html and
// minify only the served copy. The worker rewrites this response as a stream,
// so doing this before ASSETS.fetch keeps the rewriter path allocation-free.
{
  // TWO sources on purpose, and the split is the whole point of the twin:
  //   - `authored` is src/pages/index.html untouched. It is what /index.src.html
  //     ships, and perf-budget.mjs asserts the twin is byte-identical to it.
  //     "Readable source" means the file a human wrote, not a build artifact.
  //   - `staged` is that file plus step 1b's injected client edge, and it is what
  //     gets minified and served. Reading `authored` here instead would drop the
  //     injection on the floor and quietly cost the homepage its first-paint
  //     mirror (it did, for one commit).
  // The twin is not lying by omission: the inline block says in so many words
  // that the client edge is injected by build.mjs from luna.css.
  const authored = await readFile("src/pages/index.html", "utf8");
  const staged = await readFile(`${OUT}/public/index.html`, "utf8");
  const srcPath = "/index.src.html";
  const banner = `<!-- minified at deploy; readable source: ${srcPath} -->\n`;
  const inlineMinified = transformInlineHtmlBlocks(staged, "src/pages/index.html");
  const body = minifyHtml.minify(Buffer.from(inlineMinified), HTML_MINIFY_CFG).toString();
  const min = banner + body;
  for (const [label, marker] of HTML_MARKERS) {
    if (!marker.test(min)) throw new Error("index.html: HTML minifier lost required marker " + label);
  }
  // the served copy must actually carry the injection; the twin must not
  if (!/border:\s*6px solid #ece9d8/.test(min)) throw new Error("index.html: the minified homepage lost the injected client edge");
  await writeFile(`${OUT}/public/${srcPath.slice(1)}`, authored);
  await writeFile(`${OUT}/public/index.html`, min);
  console.log(`index.html: ${staged.length} -> ${min.length} bytes (+ ${srcPath}, byte-identical to source; inline JS/CSS use existing minifiers)`);
}


// 3) shells: deploy the readable original as <name>.src.js, minify the served file
for (const [file, srcPath, marker] of SHELLS) {
  const src = await readFile(`src/client/${file}`, "utf8");
  await writeFile(`${OUT}/public/${srcPath.slice(1)}`, src);

  const code = minifyJavaScript(`src/client/${file}`, src);
  const banner = `/*! minified at deploy - readable source: ${srcPath} */\n`;
  const min = banner + code;

  // tripwires: a transform that breaks these invariants must fail the deploy
  if (marker && !min.includes(marker)) {
    throw new Error(`${file}: minified output lost the "${marker}" marker`);
  }

  await writeFile(`${OUT}/public/${file}`, min);
  console.log(`${file}: ${src.length} -> ${min.length} bytes (+ ${srcPath})`);
}

// 4) luna.css: the one shared external stylesheet, minified with a readable
// /luna.src.css twin (same readable-twin philosophy as the shells). Repaired, it
// goes 63KB->35KB raw / 16.0KB->7.35KB brotli — an ~8.7KB saving on a
// render-blocking sheet every worker-rendered + garage/lwe page loads, almost
// all of it the heavy View-Source comments (which live on in luna.src.css).
// Owner-approved 2026-07 as the ONE non-shell file the build is allowed to
// minify. The three first-interaction sheets below are explicit exceptions: each
// was extracted byte-for-byte from luna.css and loads only with its matching JS.
{
  const src = await readFile("src/styles/luna.css", "utf8");
  await writeFile(`${OUT}/public/luna.src.css`, src);
  const code = minifyCss("src/styles/luna.css", src);
  const out = `/*! minified at deploy - readable source: /luna.src.css */\n` + code;
  await writeFile(`${OUT}/public/luna.css`, out);
  console.log(`luna.css: ${src.length} -> ${out.length} bytes (+ /luna.src.css)`);
}

for (const file of ["nav-run.css", "nav-tray.css", "infotip.css"]) {
  const src = await readFile(`src/styles/${file}`, "utf8");
  await writeFile(`${OUT}/public/${file.replace(".css", ".src.css")}`, src);
  const code = minifyCss(`src/styles/${file}`, src);
  const out = `/*! minified at deploy - readable source: /${file.replace(".css", ".src.css")} */\n` + code;
  await writeFile(`${OUT}/public/${file}`, out);
  console.log(`${file}: ${src.length} -> ${out.length} bytes`);
}

// 4b) the LWE conversation pages share their byte-identical structural CSS
// instead of embedding it eleven times. Keep the same readable-twin contract as
// luna.css: author the source directly, ship a small minified render-blocker.
{
  const src = await readFile("src/styles/lwe-base.css", "utf8");
  await writeFile(`${OUT}/public/lwe-base.src.css`, src);
  const code = minifyCss("src/styles/lwe-base.css", src);
  const out = `/*! minified at deploy - readable source: /lwe-base.src.css */\n` + code;
  await writeFile(`${OUT}/public/lwe-base.css`, out);
  console.log(`lwe-base.css: ${src.length} -> ${out.length} bytes (+ /lwe-base.src.css)`);
}

// 5) worker-module CSS: minify static CSS template literals marked with a
// leading /*min*/ sentinel. Dynamic page CSS stays unmarked; readable source
// remains in public/ while only the staged worker bytes shrink on the wire.
{
  const dir = `${OUT}/src/worker`;
  const jsFiles = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".js") || f.endsWith(".ts"));
  const marker = /`(\/\*min\*\/[^`]*)`/g;
  let litCount = 0, saved = 0, fileCount = 0;
  for (const rel of jsFiles) {
    const path = `${dir}/${rel}`;
    const src = await readFile(path, "utf8");
    const matches = [...src.matchAll(marker)];
    if (!matches.length) continue;
    let out = "", last = 0;
    for (const m of matches) {
      const cssLiteral = m[1];
      if (cssLiteral.includes("${")) throw new Error(`${rel}: a /*min*/ CSS literal carries interpolation`);
      const min = minifyCss(`src/worker/${rel}`, cssLiteral).replace(/\n+$/, "");
      out += src.slice(last, m.index) + "`" + min + "`";
      last = m.index + m[0].length;
      saved += m[0].length - (min.length + 2);
      litCount++;
    }
    out += src.slice(last);
    const parsed = minifySync(`src/worker/${rel}`, out, {
      module: false,
      compress: false,
      mangle: false,
      codegen: { removeWhitespace: false, legalComments: "inline" },
    });
    if (parsed.errors.length) {
      throw new Error(`${rel}: minifying CSS broke JS parse: ${parsed.errors.map((e) => e.message).join("; ")}`);
    }
    await writeFile(path, out);
    fileCount++;
  }
  // A FLOOR, because every failure this pass has had was an absence. The marker
  // scan matched nothing at all after the Worker moved from .js to .ts, and with
  // no floor it printed "0 literals" and shipped unminified CSS on every
  // Worker-rendered page for as long as nobody read the line. The extension list
  // above is fixed; the next rename, or an edit to the sentinel, is not.
  if (litCount < 7) throw new Error(`worker CSS: found only ${litCount} /*min*/ literals (expected 7+) — did the sentinel change, or did the walk stop reaching the staged Worker modules?`);
  console.log(`worker CSS: minified ${litCount} /*min*/ literals across ${fileCount} modules, ~${(saved / 1024).toFixed(1)}KB raw saved`);
}

// 5b) render deterministic Worker pages into the staged static tree. They keep
// their canonical renderers as the sole HTML source; the build invokes those
// renderers after CSS-literal minification, then the ordinary hashing and page
// precompression passes treat the results exactly like garage/LWE documents.
{
  const root = resolve(OUT, "public");
  const assets = {
    async fetch(input) {
  // A deliberate two-shape signature (string | Request), not a wire value.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
      const url = new URL(typeof input === "string" ? input : input.url);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!rel || rel.includes("..")) return new Response("not found", { status: 404 });
      try {
        const bytes = await readFile(resolve(root, rel));
        const type = rel.endsWith(".json") ? "application/json" : rel.endsWith(".txt") ? "text/plain; charset=utf-8" : "application/octet-stream";
        return new Response(bytes, { headers: { "content-type": type } });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  };
  const nonce = `?build=${BUILD_NONCE}`;
  const lens = await import(pathToFileURL(resolve(OUT, "src/worker/lens.ts")).href + nonce);
  const run = await import(pathToFileURL(resolve(OUT, "src/worker/run.ts")).href + nonce);
  const search = await import(pathToFileURL(resolve(OUT, "src/worker/search.ts")).href + nonce);
  const writing = await import(pathToFileURL(resolve(OUT, "src/worker/writing.ts")).href + nonce);

  const lensResponse = lens.renderLensShell();
  if (lensResponse.status !== 200) throw new Error(`static /lens renderer returned ${lensResponse.status}`);
  await writeFile(`${OUT}/public/lens.html`, await lensResponse.text());

  const runResponse = run.renderRun();
  if (runResponse.status !== 200) throw new Error(`static /run renderer returned ${runResponse.status}`);
  const runHtml = await runResponse.text();
  if (!runHtml.includes('form action="/run"')) throw new Error("static /run renderer lost its no-JS form");
  await writeFile(`${OUT}/public/run.html`, runHtml);

  const searchResponse = search.renderSearchPage();
  if (searchResponse.status !== 200) throw new Error(`static /search renderer returned ${searchResponse.status}`);
  const searchHtml = await searchResponse.text();
  if (!searchHtml.includes('form method="get" action="/search"')) throw new Error("static /search renderer lost its blank search form");
  await writeFile(`${OUT}/public/search.html`, searchHtml);

  const env = { ASSETS: assets };
  const indexResponse = await writing.renderWritingIndex(env);
  if (indexResponse.status !== 200) throw new Error(`static /writing renderer returned ${indexResponse.status}`);
  await mkdir(`${OUT}/public/writing`, { recursive: true });
  await writeFile(`${OUT}/public/writing/index.html`, await indexResponse.text());

  const posts = JSON.parse(await readFile(`${OUT}/public/writing/posts.json`, "utf8"));
  for (const post of posts) {
    const response = await writing.renderWritingPost(post.slug, env);
    if (response.status !== 200) throw new Error(`static /writing/${post.slug} renderer returned ${response.status}`);
    await writeFile(`${OUT}/public/writing/${post.slug}.html`, await response.text());
  }
  console.log(`static renders: /lens + blank /run + blank /search + /writing index + ${posts.length} notes staged from canonical Worker renderers`);
}

// 6) content-hash the critical-path shell assets (nav.js + luna.css + lens-boot.js) into
// immutable /a/<name>.<hash8>.<ext> URLs, then repoint every <script src>/<link
// href> that loads them. /a/<name>.<hash8> names exact bytes (same content-
// addressed contract as /i/ thumbnails, and edge-direct for the same reason: not
// in run_worker_first), so it earns the year + immutable cache Lighthouse's
// "efficient cache lifetimes" audit wants — which the short-cached /nav.js +
// /luna.css can't. Those unhashed files stay as fallbacks (cal/coffee's absolute
// refs + any stale HTML still resolve). The rewrite is ATTRIBUTE-SCOPED (src=/href=
// only), so the garage pages' documentary /nav.js mentions (path:"/nav.js",
// wrangler "!/nav.js") are untouched, and it skips the shell scripts themselves
// (nav.js carries its own /luna.css fallback string, which must stay plain and must
// not desync the hash we just computed). Owner-approved 2026-07-21 — the one place
// the build is allowed past the six shells + luna.css (hard rule 3).
{
  const hash8 = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 8);
  const esc = (s) => s.replace(/[\\/.*+?^${}()|[\]]/g, "\\$&");
  await mkdir(`${OUT}/public/a`, { recursive: true });

  const ASSETS = [
    { attr: "src",  from: "/nav.js",   base: "nav",  ext: "js",  witness: "index.html" },
    { attr: "href", from: "/luna.css", base: "luna", ext: "css", witness: "index.html" },
    // The server-rendered idle Lens shell emits only the interaction bootstrap.
    // Phase 0 hashes the full client and rewrites its URL into this file first;
    // hashing the bootstrap here makes the complete two-step chain immutable.
    { attr: "src",  from: "/lens-boot.js",  base: "lens-boot", ext: "js",  witness: "../src/worker/lens.ts" },
    // the desktop icon sprite. Unlike the three above, every ref carries a
    // #fragment (src="/icons.svg#pin-garage"), so `frag` widens the match to
    // keep it. Its witness is the desktop partial, which is where all 12 live.
    // src= rather than href= because the refs are <img> against <view>s, not
    // <svg><use> against <symbol>s — see the WebKit note in gen-desktop-partial.mjs.
    { attr: "src", from: "/icons.svg", base: "icons", ext: "svg", frag: true, witness: "../src/worker/lib/desktop.ts" },
    // quiz.js + notepad.js joined 2026-07-27. Both were served unhashed at max-age=300,
    // so hashing them buys a year + immutable outright, and enrolling them in /a/ means
    // they inherit the brotli q11 twin and the dcz delta path for free.
    //
    // These two and no others of the five deferred islands. tooltip.js and hoist.js load
    // via `import("/tooltip.js")`, and lens-browser.js via `script.src = "..."`: all three
    // are JS STRING literals, not attributes. The repointer below is attribute-scoped on
    // purpose, so that it cannot rewrite the garage pages' documentary /nav.js mentions.
    // It would silently miss those three and the witness tripwire would fail the deploy.
    // Moving them needs a different mechanism, not another line here.
    { attr: "src", from: "/quiz.js",    base: "quiz",    ext: "js", witness: "garage/encoding.html" },
    { attr: "src", from: "/notepad.js", base: "notepad", ext: "js", witness: "../src/worker/writing.ts" },
    // Shared LWE structure is a separate warm-cache object.
    { attr: "href", from: "/lwe-base.css", base: "lwe-base", ext: "css", witness: "lwe/vigenere.html" },
  ];
  const hashedFor: Record<string, string> = {};
  // ── phase 0: the three JS-STRING-loaded islands (tooltip, hoist, lens-browser) ──
  // These load via `import("/hoist.js")` / `script.src = "/lens-browser.js?v=1"`, which
  // the attribute-scoped repointer below cannot touch. They are hashed FIRST, and their
  // loader strings rewritten across the staged tree BEFORE nav.js / lens-boot.js are
  // hashed, so a dependent's hash covers its final bytes (nav.js imports hoist;
  // lens.js loads its four feature modules; lens-boot.js imports lens.js). The
  // patterns are exact call-syntax matches — `import((["'`])/x.js\1)`
  // — so the garage pages' documentary "/hoist.js" prose mentions cannot be caught, which
  // is the precision the attribute rule existed to protect. The ?v=1 ritual on
  // lens-browser retires here: the hash IS the version.
  //
  // hoist has TWO loader shapes, and missing the second one cost a real serialized
  // fetch in production: nav.js + index.html reach it through `import("/hoist.js")`,
  // but tooltip.js reaches it through a STATIC `import {...} from "/hoist.js"`. With
  // only the call-syntax pattern, tooltip.js kept the unhashed specifier, so every
  // homepage load fetched hoist twice — once hashed (the inline warm-up, parallel with
  // tooltip.js) and once unhashed, discovered only after tooltip.js had parsed. Measured
  // on production 2026-07-27: tooltip.js finished at 1112ms and /hoist.js only STARTED at
  // 1114ms, the one serialized fetch left on the page, and the duplicate came back
  // max-age=300 while its immutable twin sat in cache unused.
  //
  // ORDER IS LOAD-BEARING and the list is sorted leaves-first. Each asset's rewrites are
  // applied to the staged tree immediately after it is hashed, so a dependent hashed
  // later reads bytes that already carry its dependency's hashed URL. tooltip depends on
  // hoist, so hoist must be hashed and rewritten first — otherwise tooltip's `/a/` copy
  // ships the unhashed specifier forever, since the rewrite pass deliberately skips `a/`.
  // `/a/<base>.<hash8>.<ext>` must dehash back to the asset's own filename, or
  // perf-snapshot's merge (which keys on that dehashed name) reads the top-level
  // copy and the /a/ copy as two separate assets and counts every byte twice. So
  // base tracks the FILE, and the js/css pairs that now share a stem are told
  // apart by extension in hashedFor instead of by a "-style" suffix nothing else
  // knew about. #341's own size table read +4.82 KiB for what is a -1.28 KiB
  // change, which is how this was found.
  const hashKey = (a) => (a.ext && a.ext !== "js" ? `${a.base}.${a.ext}` : a.base);
  const STRING_ASSETS = [
    { file: "/nav-run.css",     base: "nav-run",           ext: "css", mk: (to) => [
      [/("nav-run"\s*:\s*)(["'`])\/nav-run\.css\2/g, `$1$2${to}$2`] ] },
    { file: "/nav-tray.css",    base: "nav-tray",          ext: "css", mk: (to) => [
      [/("nav-tray"\s*:\s*)(["'`])\/nav-tray\.css\2/g, `$1$2${to}$2`] ] },
    { file: "/infotip.css",     base: "infotip",           ext: "css", mk: (to) => [
      [/(\binfotip\b\s*:\s*)(["'`])\/infotip\.css\2/g, `$1$2${to}$2`] ] },
    { file: "/hoist.js",        base: "hoist",        mk: (to) => [
      [/import\((["'`])\/hoist\.js\1\)/g, `import($1${to}$1)`],
      [/(\bfrom\s*)(["'`])\/hoist\.js\2/g, `$1$2${to}$2`] ] },
    // First-interaction shell islands. nav-run depends on hoist, so hoist must
    // be rewritten into its source before nav-run receives its own hash. Both
    // are then rewritten into nav.js before the shared shell is hashed below.
    { file: "/nav-run.js",      base: "nav-run",      mk: (to) => [
      [/import\((["'`])\/nav-run\.js\1\)/g, `import($1${to}$1)`] ] },
    { file: "/nav-tray.js",     base: "nav-tray",     mk: (to) => [
      [/import\((["'`])\/nav-tray\.js\1\)/g, `import($1${to}$1)`] ] },
    { file: "/lens-browser.js", base: "lens-browser", mk: (to) => [
      [/(["'`])\/lens-browser\.js\?v=1\1/g, `$1${to}$1`] ] },
    { file: "/lens-reader.js",  base: "lens-reader",  mk: (to) => [
      [/(["'`])\/lens-reader\.js\?v=1\1/g, `$1${to}$1`] ] },
    { file: "/lens-wire.js",    base: "lens-wire",    mk: (to) => [
      [/(["'`])\/lens-wire\.js\?v=1\1/g, `$1${to}$1`] ] },
    { file: "/lens-tools.js",   base: "lens-tools",   mk: (to) => [
      [/(["'`])\/lens-tools\.js\?v=1\1/g, `$1${to}$1`] ] },
    { file: "/lens-nlweb.js",   base: "lens-nlweb",   mk: (to) => [
      [/(["'`])\/lens-nlweb\.js\?v=1\1/g, `$1${to}$1`] ] },
    { file: "/lens-markdown.js", base: "lens-markdown", mk: (to) => [
      [/(["'`])\/lens-markdown\.js\?v=1\1/g, `$1${to}$1`] ] },
    // The WebMCP-capable idle shell loads only this registrar. Hash it before
    // lens-boot so the bootstrap's immutable URL covers the complete lazy chain.
    { file: "/lens-webmcp.js",  base: "lens-webmcp",  mk: (to) => [
      [/import\((["'`])\/lens-webmcp\.js\1\)/g, `import($1${to}$1)`] ] },
    // The full Lens application depends on all six feature modules above. It
    // must be hashed after they rewrite it, and before lens-boot.js is hashed by
    // ASSETS below, so every URL names the final bytes of its complete subtree.
    { file: "/lens.js",         base: "lens",         mk: (to) => [
      [/import\((["'`])\/lens\.js\?v=1\1\)/g, `import($1${to}$1)`] ] },
    { file: "/tooltip.js",      base: "tooltip",      mk: (to) => [
      [/import\((["'`])\/tooltip\.js\1\)/g, `import($1${to}$1)`] ] },
    // nav.js's shell infotips. Same shape as tooltip, and it depends on hoist
    // for the same reason, so it sits below hoist in this leaves-first list.
    { file: "/infotip.js",      base: "infotip",      mk: (to) => [
      [/import\((["'`])\/infotip\.js\1\)/g, `import($1${to}$1)`] ] },
  ];
  {
    // Every staged surface that can carry a loader: HTML pages, the top-level shell
    // scripts themselves (nav.js imports hoist), worker modules, serendipity. NOT the
    // .src twins, and NOT `a/` — the hashed copies are already-final bytes, which is
    // precisely why each asset must be rewritten before the next one is hashed.
    const stringTargets = [`${OUT}/serendipity/serendipity.ts`];
    for (const rel of await readdir(`${OUT}/public`, { recursive: true })) {
      if (rel.includes(".src.")) continue;
      if (rel.endsWith(".html") || (rel.endsWith(".js") && !rel.startsWith("a/"))) {
        stringTargets.push(`${OUT}/public/${rel}`);
      }
    }
    let hits = 0;
    for (const a of STRING_ASSETS) {
      const bytes = await readFile(`${OUT}/public${a.file}`);
      const to = `/a/${a.base}.${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}.${a.ext || "js"}`;
      await writeFile(`${OUT}/public${to}`, bytes);
      hashedFor[hashKey(a)] = to;
      const reps = a.mk(to);
      for (const path of stringTargets) {
        let t; try { t = await readFile(path, "utf8"); } catch { continue; }
        let out = t;
        for (const [re, sub] of reps) out = out.replace(re, sub);
        if (out !== t) { await writeFile(path, out); hits++; }
      }
      console.log(`hashed asset (string-loaded): ${a.file} -> ${to} (${bytes.length} bytes)`);
    }
    // Witnesses: each island's loader must now carry the hashed URL, or the enrolment
    // silently did nothing and the deploy must not proceed.
    const idx = await readFile(`${OUT}/public/index.html`, "utf8");
    const nav = await readFile(`${OUT}/public/nav.js`, "utf8");
    const lens = await readFile(`${OUT}/public/lens.js`, "utf8");
    const tip = await readFile(`${OUT}/public${hashedFor.tooltip}`, "utf8");
    const run = await readFile(`${OUT}/public${hashedFor["nav-run"]}`, "utf8");
    if (!idx.includes(hashedFor.tooltip)) throw new Error("index.html was not repointed to hashed tooltip.js");
    if (!idx.includes(hashedFor.hoist) || !run.includes(hashedFor.hoist)) throw new Error("a hoist.js loader was not repointed (index.html or nav-run.js)");
    if (!nav.includes(hashedFor["nav-run"]) || !nav.includes(hashedFor["nav-tray"])) throw new Error("nav.js was not repointed to its first-interaction islands");
    for (const style of ["nav-run", "nav-tray", "infotip"]) {
      if (!nav.includes(hashedFor[`${style}.css`])) throw new Error(`nav.js was not repointed to hashed ${style}.css`);
    }
    if (!lens.includes(hashedFor["lens-browser"])) throw new Error("lens.js was not repointed to hashed lens-browser.js");
    if (!lens.includes(hashedFor["lens-reader"])) throw new Error("lens.js was not repointed to hashed lens-reader.js");
    if (!lens.includes(hashedFor["lens-wire"])) throw new Error("lens.js was not repointed to hashed lens-wire.js");
    if (!lens.includes(hashedFor["lens-tools"])) throw new Error("lens.js was not repointed to hashed lens-tools.js");
    if (!lens.includes(hashedFor["lens-nlweb"])) throw new Error("lens.js was not repointed to hashed lens-nlweb.js");
    if (!lens.includes(hashedFor["lens-markdown"])) throw new Error("lens.js was not repointed to hashed lens-markdown.js");
    const lensBoot = await readFile(`${OUT}/public/lens-boot.js`, "utf8");
    if (!lensBoot.includes(hashedFor.lens)) throw new Error("lens-boot.js was not repointed to hashed lens.js");
    if (!lensBoot.includes(hashedFor["lens-webmcp"])) throw new Error("lens-boot.js was not repointed to hashed lens-webmcp.js");
    // the SERVED tooltip bytes, not the staged source: this is the copy the browser gets,
    // and the one the old ordering left pointing at the unhashed duplicate.
    if (!tip.includes(hashedFor.hoist)) throw new Error(`${hashedFor.tooltip} still imports an unhashed /hoist.js — STRING_ASSETS ordering broke (hoist must be hashed before tooltip)`);
    console.log(`string-loaded islands: rewritten across ${hits} staged files`);
  }

  const reps = [];
  for (const a of ASSETS) {
    const bytes = await readFile(`${OUT}/public${a.from}`);   // exact served bytes (banner incl.)
    const to = `/a/${a.base}.${hash8(bytes)}.${a.ext}`;
    hashedFor[a.base] = to;
    await writeFile(`${OUT}/public${to}`, bytes);
    // one regex for quoted "x" AND backslash-escaped \"x\" (writing.js builds its
    // <head> as an escaped string); a second for minify-html's unquoted x.
    const frag = a.frag ? "(#[\\w-]+)" : "";
    const keep = a.frag ? "$2" : "";
    reps.push({ re: new RegExp(`\\b${a.attr}=(\\\\?")${esc(a.from)}${frag}\\1`, "g"), sub: `${a.attr}=$1${to}${keep}$1` });
    reps.push({ re: new RegExp(`\\b${a.attr}=${esc(a.from)}${a.frag ? "(#[\\w-]+)" : ""}(?=[\\s/>])`, "g"), sub: `${a.attr}=${to}${a.frag ? "$1" : ""}` });
    console.log(`hashed asset: ${a.from} -> ${to} (${bytes.length} bytes)`);
  }

  // repoint: every served HTML file + the two worker tag-emitters (chrome.js,
  // writing.js) + the serendipity shell. NOT the top-level shell scripts /
  // luna.css, and NOT the readable *.src.html twin (it must stay byte-identical
  // to src/pages/index.html for the perf-budget twin check — View Source is the
  // authoring source, which keeps the plain /nav.js the fallback still serves).
  // cal/src rides along: /coffee's SSR templates load the shell too, and were the
  // whole reason the unhashed fallbacks existed. Their nav ref is attribute-shaped so
  // the ordinary reps catch it; the luna refs are ABSOLUTE (cal.aadhar.sh serves the
  // same templates, where a relative /luna.css would 404) and get their own pass below.
  const targets = [`${OUT}/serendipity/serendipity.ts`];
  for (const rel of await readdir(`${OUT}/cal/src`).catch(() => [])) {
    if (rel.endsWith(".ts")) targets.push(`${OUT}/cal/src/${rel}`);
  }
  for (const rel of await readdir(`${OUT}/public`, { recursive: true })) {
    if (rel.endsWith(".html") && !rel.endsWith(".src.html")) targets.push(`${OUT}/public/${rel}`);
  }
  // The Worker stages beside cal and serendipity now rather than inside the asset
  // tree, so it needs its own walk. It was never served (.assetsignore listed
  // _worker.js), and mirroring the source layout is what lets one relative
  // specifier resolve in both the source and the staged tree.
  for (const rel of await readdir(`${OUT}/src/worker`, { recursive: true })) {
    if (rel.endsWith(".js") || rel.endsWith(".ts")) targets.push(`${OUT}/src/worker/${rel}`);
  }
  let refCount = 0, filesTouched = 0;
  for (const path of targets) {
    let s; try { s = await readFile(path, "utf8"); } catch { continue; }
    let out = s, hits = 0;
    for (const { re, sub } of reps) {
      const m = out.match(re);
      if (m) { hits += m.length; out = out.replace(re, sub); }
    }
    if (hits) { await writeFile(path, out); refCount += hits; filesTouched++; }
  }

  // /coffee's absolute shell refs (https://aadhar.sh/luna.css) — the attr reps above
  // only match leading-slash paths, so the absolute form is rewritten here, scoped to
  // the staged cal modules alone.
  {
    const p = `${OUT}/cal/src/templates.ts`;
    let t; try { t = await readFile(p, "utf8"); } catch { t = null; }
    if (t !== null) {
      const out = t.split("https://aadhar.sh/luna.css").join(`https://aadhar.sh${hashedFor.luna}`);
      if (out !== t) await writeFile(p, out);
      const now = await readFile(p, "utf8");
      if (!now.includes(hashedFor.luna)) throw new Error("cal/src/templates.ts was not repointed to hashed luna.css");
      if (!now.includes(hashedFor.nav)) throw new Error("cal/src/templates.ts was not repointed to hashed nav.js");
      console.log(`cal: /coffee templates repointed to ${hashedFor.luna} + ${hashedFor.nav}`);
    }
  }

  // RFC 9842 requires dcz to treat the supplied bytes as a RAW dictionary. A zstd
  // --train artifact is self-describing, so a server library recognizes its tables
  // while Chrome treats those same response bytes as raw content; the decoders
  // disagree and the navigation fails. Build one site-wide corpus from the final,
  // repointed bytes of two complementary pages: the compact LWE shell plus the
  // Garage compression explainer. Then spend part of the fixed 64KB on the tails of
  // the four layouts that corpus used to lose to plain q11 on. Measured 2026-08-11:
  // the representative prefix moved family coverage from 42/46 to 46/46 and cut
  // the preferred-family wire set from 450,321 B to 428,238 B (plain q11: 494,073 B).
  //
  // The corpus is a LIST rather than a fixed pair, and it is read in order until the
  // 64KB is filled. Two pages happened to cover it with 1,656 bytes to spare, which
  // meant an ordinary edit trimming either page by ~2% would have hard-failed the
  // deploy under a message naming the wrong cause. The trailing entries are slack:
  // they contribute nothing while the leading pages are long enough, and they keep a
  // content edit from becoming a release incident.
  {
    const BASE_CORPUS = [
      "lwe/drivers.html",           // the compact LWE conversation shell
      "garage/compression.html",    // the Garage explainer, the other structural family
      "lwe/vigenere.html",          // slack, in corpus order
      "garage/chunks.html",
    ];
    const REPRESENTATIVES = [
      "garage/horizon.html",        // very large standalone lab
      "garage/vt-b.html",           // tiny browser fixture
      "garage/vt-check.html",       // tiny browser fixture
      "access/index.html",          // standalone device matrix
    ];
    const REPRESENTATIVE_BYTES = 16_384;
    const SIZE = 65_536;
    const parts = [];
    let total = 0;
    for (const rel of BASE_CORPUS) {
      const bytes = await readFile(`${OUT}/public/${rel}`);
      parts.push(bytes);
      total += bytes.length;
      if (total >= SIZE) break;
    }
    if (total < SIZE) {
      throw new Error(
        `page-family dictionary: the corpus pages total ${total} B, ${SIZE - total} B short of the ${SIZE} B dictionary. ` +
        `Add another staged page to BASE_CORPUS in build.mjs (order is load-bearing; append, do not reorder).`,
      );
    }
    const base = Buffer.concat(parts).subarray(0, SIZE);
    const representatives = [];
    for (const rel of REPRESENTATIVES) {
      const staged = await readFile(`${OUT}/public/${rel}`, "utf8");
      const final = Buffer.from(minifiedPage(staged, rel));
      representatives.push(final.subarray(Math.max(0, final.length - REPRESENTATIVE_BYTES)));
    }
    const prefix = Buffer.concat(representatives);
    if (prefix.length >= SIZE) {
      throw new Error(`page-family dictionary representatives consume ${prefix.length} B of ${SIZE} B; reduce REPRESENTATIVE_BYTES`);
    }
    const dictionary = Buffer.concat([prefix, base.subarray(prefix.length)]);
    if (dictionary.readUInt32LE(0) === 0xec30a437) {
      throw new Error("page-family dictionary starts with the zstd --train magic — dcz needs RAW bytes, not a trained dictionary");
    }
    const to = `/a/page-family.${hash8(dictionary)}.dict`;
    await writeFile(`${OUT}/public${to}`, dictionary);
    hashedFor["page-family"] = to;
    console.log(`hashed asset: site-page corpus -> ${to} (${dictionary.length} raw bytes)`);
  }

  // Point the worker's Early-Hints header and its HTML dictionary Link header at
  // the exact same content-addressed assets as the staged documents.
  {
    const p = `${OUT}/src/worker/lib/shell-assets.ts`;
    const src = await readFile(p, "utf8");
    const line = `export const SHELL_ASSETS = { luna: ${JSON.stringify(hashedFor.luna)}, nav: ${JSON.stringify(hashedFor.nav)} }; // build:shell-assets`;
    const dictionaryLine = `export const PAGE_DICTIONARY: string = ${JSON.stringify(hashedFor["page-family"])}; // build:page-dictionary`;
    const shellPatched = src.replace(/^export const SHELL_ASSETS = .*\/\/ build:shell-assets$/m, line);
    const out = shellPatched.replace(/^export const PAGE_DICTIONARY(: string)? = .*\/\/ build:page-dictionary$/m, dictionaryLine);
    if (shellPatched === src) throw new Error("shell-assets.js: the `// build:shell-assets` marker line was not found — did the export shape change?");
    if (out === shellPatched) throw new Error("shell-assets.js: the `// build:page-dictionary` marker line was not found");
    await writeFile(p, out);
    console.log(`shell-assets: Early-Hints -> ${hashedFor.luna} + ${hashedFor.nav}; page dictionary -> ${hashedFor["page-family"]}`);
  }

  // same Early-Hints preload for the STATIC garage/lwe pages: rewrite the
  // angle-bracketed Link targets in the staged _headers to the hashed URLs. only
  // the `</luna.css>` / `</nav.js>` Link forms are touched; the bare `/nav.js` +
  // `/luna.css` PATH-pattern rules (their own cache blocks) have no angle
  // brackets, so they're left alone.
  {
    const p = `${OUT}/public/_headers`;
    const src = await readFile(p, "utf8");
    const out = src
      .split("</luna.css>").join(`<${hashedFor.luna}>`)
      .split("</nav.js>").join(`<${hashedFor.nav}>`)
      .split("</lwe-base.css>").join(`<${hashedFor["lwe-base"]}>`);
    if (out === src) throw new Error("_headers: no shell Link target found to hash — did the Early-Hints rule move?");
    await writeFile(p, out);
    console.log(`_headers: Early-Hints Link rewritten to hashed shell URLs`);
  }

  // tripwires: the rewrite must fire, and each asset's own entry point must load
  // the hashed URL (a moved ref or renamed asset would silently drop the immutable
  // win). Each asset names its WITNESS: the served file that must carry the hashed
  // ref. index.html for the two shell assets it loads; the lens shell for lens-boot.js,
  // which the homepage never loads.
  if (!refCount) throw new Error("hashed-asset rewrite matched zero references — did the src=/href= ref shape change?");
  for (const a of ASSETS) {
    const to = hashedFor[a.base];
    const body = await readFile(`${OUT}/public/${a.witness}`, "utf8");
    if (!body.includes(to)) throw new Error(`${a.witness} was not repointed to hashed ${a.base} (${to})`);
  }
  console.log(`hashed-asset refs: repointed ${refCount} references across ${filesTouched} files`);
}

// 7) precompress the /a/ shell assets at brotli q11, next to the bytes they encode.
//
// The edge compresses on the fly at about q4, and when a browser offers everything
// it picks zstd — which measured LARGER than Cloudflare's own brotli on this site
// (13,264 vs 12,457 bytes on the homepage, 2026-07-26). Encoding offline at q11 is
// a measured ~19% off the wire for the two render-path assets, and it is free at
// decode: brotli decode time is independent of encode QUALITY, because the decoder
// makes one pass over a stream that is now smaller (0.070ms at q4 vs 0.081ms at q11
// on a 47KB document, in-process, 300 iterations). GREENFIELD.md asked for exactly
// this in July 2026 ("static documents precompress offline at brotli q11") and
// measured the same ~19% tax; wrangler.jsonc deferred it as migration scope rather
// than rejecting it.
//
// Only /a/ is precompressed. Those four files are content-addressed, immutable, and
// on the render path, so they are the whole win in one bounded directory. The static
// garage/lwe HTML is the next candidate and needs its own routing decision.
//
// This is safe to add because it degrades to exactly today's behavior: the worker
// serves a .br twin only when the request actually offers `br` AND the twin exists.
// A skipped build step, or a client without brotli, gets the identity bytes.
{
  const dir = `${OUT}/public/a`;
  const files = (await readdir(dir)).filter((f) => /\.(js|css|svg|dict)$/.test(f));
  if (!files.length) throw new Error("precompression found no /a/ shell assets — did step 6 stop emitting them?");
  let raw = 0, enc = 0;
  const compressed = await Promise.all(files.map(async (f) => {
    const bytes = await readFile(`${dir}/${f}`);
    return { f, bytes, out: await brotliQ11(bytes) };
  }));
  for (const { f, bytes, out } of compressed) {
    // Refuse to ship a "compressed" twin that isn't smaller. Cheap guard against a
    // future asset type where q11 loses (already-compressed bytes, tiny files).
    if (out.length >= bytes.length) {
      console.log(`precompress: SKIPPED /a/${f} (br ${out.length} >= raw ${bytes.length})`);
      continue;
    }
    await writeFile(`${dir}/${f}.br`, out);

    raw += bytes.length; enc += out.length;
    console.log(`precompressed: /a/${f} ${bytes.length} -> ${out.length} bytes (br q11)`);
  }
  console.log(`precompress: ${(raw / 1024).toFixed(1)}KB -> ${(enc / 1024).toFixed(1)}KB brotli q11 across ${files.length} shell assets`);

  // ── dcz deltas, generated HERE rather than committed ─────────────────────────
  // A returning Chromium visitor that accepted our Use-As-Dictionary offer sends back the
  // SHA-256 of the shell it holds; the worker answers with the diff. Measured on a real
  // luna.css change: 116 bytes against 7,615.
  //
  // This used to be a workstation script with committed artifacts, on the belief that
  // dictionary compression was unreachable from Node. That was true of BROTLI AT THE TIME and I
  // wrongly generalized it: node:zlib's zstd DOES take a `dictionary` option. (node 26 has since
  // given brotli one too, nodejs/node#61763, which retires the limit rather than the choice —
  // dcz won on decode speed, not on either encoder's availability. See gotcha 14.) It is also better
  // than shelling out — 116 bytes where the zstd CLI produced 120 — and portable, verified
  // by having the foreign `zstd -d -D` CLI decode Node's bytes byte-exact, skippable prefix
  // and all. That interop check is the one that matters, because the real decoder is a
  // browser, not Node.
  //
  // Consequences worth naming: no zstd CLI in the deploy path, no committed .dcz artifacts,
  // no `bun run shell:deltas` step to forget, and no staleness tripwire needed at all,
  // because a delta is now a pure function of bytes this build just produced.
  //
  // Still committed, and unavoidably so: src/dict/a-dict/, the DICTIONARY set. A dictionary
  // has to be bytes the BROWSER already holds, which no build can derive from source.
  {
    // HARD CHECK: is the `dictionary` option actually honored by this Node?
    //
    // Node 22 ACCEPTS the option and silently ignores it. That produced a dictionary-less
    // "delta" of 8,197 bytes against luna.css in Workers Builds (plain zstd-19 is ~8,161),
    // which lost to the plain brotli twin, so the guard below discarded it and printed
    // "delta: none needed". The feature shipped as a no-op for a full deploy and the log
    // read like everything was fine. Local Node 26 honored the option, so it worked here
    // and nowhere else.
    //
    // Feature-detect rather than version-sniff: compressing a buffer against ITSELF must
    // collapse to almost nothing if the dictionary is real. Throwing is correct because
    // .node-version pins the runtime, so this firing means the pin was lost, and a silent
    // no-op is exactly the failure this whole page-worth of debugging came from.
    const probe = Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(200));
    const withDict = zstdCompressSync(probe, { dictionary: probe, params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } });
    const noDict = zstdCompressSync(probe, { params: { [zlibConstants.ZSTD_c_compressionLevel]: 19 } });
    if (withDict.length >= noDict.length * 0.5) {
      throw new Error(
        `zstd dictionary compression is not honored by ${process.version} ` +
        `(probe: ${withDict.length} bytes with a dictionary vs ${noDict.length} without; expected a collapse). ` +
        `Node 24+ is required — see .node-version. Shell deltas would silently ship as no-ops.`,
      );
    }

    const dictDir = "src/dict/a-dict";
    const dicts = await readdir(dictDir).catch(() => []);
    const parse = (n) => { const m = n.match(/^(.+)\.([0-9a-f]{8})\.(js|css|svg)$/); return m ? { base: m[1], hash8: m[2], ext: m[3], name: n } : null; };
    const shell = files.map(parse).filter(Boolean);
    const cands = dicts.map(parse).filter(Boolean);
    if (cands.length) await mkdir(`${OUT}/public/ad`, { recursive: true });
    let n = 0, deltaBytes = 0;
    for (const asset of shell) {
      // Images sit out the dictionary path — see DICTIONARY_TYPES in lib/assets.js. The
      // worker will never answer an svg with a dcz, so building one here would ship a
      // delta nothing can ask for.
      if (asset.ext === "svg") continue;
      const targetBytes = await readFile(`${dir}/${asset.name}`);
      for (const d of cands) {
        if (d.base !== asset.base || d.ext !== asset.ext) continue;
        const dictBytes = await readFile(`${dictDir}/${d.name}`);
        // Identical bytes mean the content-hashed URL did not change, so no client will
        // ever request a new URL for them — a delta here could not be asked for.
        if (dictBytes.equals(targetBytes)) continue;

        const { out, digest } = dczEncode(targetBytes, dictBytes);

        // A delta that lost to the plain q11 twin is worse than no delta: the worker would
        // serve more bytes AND cost the client a dictionary lookup.
        const plainTwin = (await readFile(`${dir}/${asset.name}.br`).catch(() => null))?.length ?? Infinity;
        if (out.length >= plainTwin) {
          console.log(`delta: SKIPPED ${asset.name} vs ${d.hash8} (dcz ${out.length} >= br ${plainTwin})`);
          continue;
        }
        const tag = digest.toString("hex").slice(0, 16);
        await writeFile(`${OUT}/public/ad/${asset.base}.${asset.hash8}.${tag}.dcz`, out);
        n++; deltaBytes += out.length;
        console.log(`delta: /ad/${asset.base}.${asset.hash8}.${tag}.dcz ${out.length} bytes (vs ${plainTwin} plain br)`);
      }
    }
    // Distinguish the two reasons for zero deltas. "Every candidate matches" is normal and
    // expected. "Candidates exist but none produced a delta" means every pair lost to plain
    // brotli, which is the shape the Node 22 bug wore, so say so loudly.
    const changed = shell.some((a) => cands.some((d) => d.base === a.base && d.ext === a.ext && d.hash8 !== a.hash8));
    if (n) console.log(`delta: ${n} dcz delta(s), ${deltaBytes} bytes total`);
    else if (changed) console.log("delta: WARNING the shell changed but every candidate lost to plain brotli — dictionary compression may not be working");
    else console.log("delta: none needed (every dictionary candidate matches the shipping shell)");
  }

}

// 7b) every OTHER served HTML page gets what the homepage has had since step 2:
// a minified served copy plus a readable `.src.html` twin. Owner call, 2026-07-31,
// replacing the long-standing rule that garage and LWE HTML is never minified.
//
// Measured before shipping, over the 32 garage + LWE pages: 376,665 B brotli today
// against 341,296 minified, so 9.4% and about 1.1KB per page. Small, and smaller
// still in practice, because a returning visitor is answered with a per-page dcz
// delta at 93-97% off and never sees these bytes. The readable twin is what makes
// the trade payable: View Source stops being the served page and becomes one click
// away, and the twin is the SAME program either way, which is the property that
// separates minification from compilation.
//
// Placed after step 6 (shell refs are rewritten) and before 7c (a CSP hash is only
// true of final bytes), for exactly the reason 7c's own header gives.
//
// The twin is the readable source where one exists, matching step 2's rule that
// "readable source" means the file a human wrote. Ten of these 43 pages are
// generated into the staged tree with no authored file behind them (/bot, /lens,
// /photos, /updates, /restore, and the five /writing documents), so for those the
// twin is the pre-minification staged copy, which is the most readable thing that
// ever exists for that URL.
{
  const { PAGE_MARKERS } = await import("./lib/html-markers.ts");
  const pages = (await readdir(`${OUT}/public`, { recursive: true }))
    .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html") && rel !== "index.html")
    .sort();

  // The understanding check's answer key rides in an application/json block.
  // transformInlineHtmlBlocks leaves non-JavaScript scripts alone by design, but
  // minify-html still walks the whole document, so prove the payload survived
  // rather than assume it. contract-tests asserts over 1100+ of these strings,
  // and a silently mangled block would take the answer key with it.
  const quizPayload = (source) => {
    const m = source.match(/<script[^>]*\bid=(?:"luq-data"|luq-data)[^>]*>([\s\S]*?)<\/script>/i);
    return m ? m[1] : null;
  };

  let before = 0, after = 0, checked = 0, generated = 0;
  for (const rel of pages) {
    const staged = await readFile(`${OUT}/public/${rel}`, "utf8");
    const twinRel = rel.replace(/\.html$/, ".src.html");
    const min = minifiedPage(staged, rel);

    for (const [label, marker] of PAGE_MARKERS) {
      if (marker.test(staged) && !marker.test(min)) {
        throw new Error(`${rel}: HTML minifier lost required marker ${label}`);
      }
    }
    const authored = quizPayload(staged);
    if (authored) {
      const shipped = quizPayload(min);
      if (!shipped) throw new Error(`${rel}: HTML minifier dropped the understanding-check payload`);
      if (JSON.stringify(JSON.parse(authored)) !== JSON.stringify(JSON.parse(shipped))) {
        throw new Error(`${rel}: HTML minifier altered the understanding-check payload`);
      }
      checked++;
    }

    let twin = staged;
    try {
      // The AUTHORED page, which lives at src/pages now. Pointing this at the
      // staged copy instead is silent: the catch below just counts the page as
      // "no authored source" and ships the staged bytes, which by this point
      // carry rewritten /a/ hashes. The twin then stops being the readable
      // original that View Source is supposed to show. The counter in the log
      // line is the tell, 12 from staged against 47.
      twin = await readFile(`src/pages/${rel}`, "utf8");
      // The authored file is the readable source, but it predates the Explorer
      // chrome the build injects at 1g2, and a twin missing markup the page
      // carries stops being the same program — which is the entire argument for
      // minifying these pages at all. Dress the twin from the same builder.
      if (staged.includes('class="axp-tasks"') && !twin.includes('class="axp-tasks"')) {
        twin = dressPage(twin, rel).html;
      }
    } catch {
      generated++;
    }
    await writeFile(`${OUT}/public/${twinRel}`, twin);
    await writeFile(`${OUT}/public/${rel}`, min);
    before += staged.length;
    after += min.length;
  }
  console.log(`pages(min): ${pages.length} documents ${before} -> ${after} bytes (${(((before - after) / before) * 100).toFixed(1)}% off raw), ${pages.length} .src.html twins (${generated} from staged, no authored source), ${checked} understanding-check payloads verified byte-equal`);
}

// 7b-links) Does every internal href/src point at something this site serves?
//
// Moving or renaming a page turned every page LINKING to it into a 404, and no gate
// in this repo read a page body to notice. routes:check sweeps the routes it is
// told about; invariant #1 asserts the Worker's routes reach run_worker_first.
// Neither looks at an href.
//
// Runs on the MINIFIED tree, deliberately: those are the bytes a visitor gets, and
// the minifier rewrites asset refs to their hashed /a/ form. Checking the source
// tree would validate paths nobody is served.
//
// Cost, measured: 2645 refs across 48 pages in ~45ms, so this is complete rather
// than scoped to a diff. A diff-scoped version would be more code and would miss
// the case where the moved page is not in the diff but its dependents are.
{
  const { makeResolver, internalRefs } = await import("./lib/link-integrity.ts");

  // every served path in the staged tree, each carrying a leading slash
  const served = new Set<string>();
  for (const rel of await readdir(`${OUT}/public`, { recursive: true })) served.add("/" + rel);

  const idxSrc = await readFile("src/worker/index.ts", "utf8");
  const wranglerSrc = await readFile("wrangler.jsonc", "utf8");
  const routesSrc = (idxSrc.match(/const ROUTES = new Map\(\[([\s\S]*?)\]\);/) || [, ""])[1];
  const surfaceList = JSON.parse(await readFile("config/site-manifest.json", "utf8")).surfaces;

  const resolves = makeResolver({
    files: served,
    routeKeys: new Set([...routesSrc.matchAll(/\[\s*"([^"]+)"/g)].map((m) => m[1])),
    allow: runWorkerFirst(wranglerSrc).filter((a) => !a.startsWith("!")),
    surfaces: new Set(surfaceList.map((s) => s.path)),
  });

  const docs = [...served].filter((f) => f.endsWith(".html") && !f.endsWith(".src.html"));
  const dangling = new Map();
  let refs = 0;
  for (const doc of docs) {
    for (const path of await internalRefs(await readFile(`${OUT}/public${doc}`, "utf8"))) {
      refs++;
      if (resolves(path)) continue;
      if (!dangling.has(path)) dangling.set(path, new Set());
      dangling.get(path).add(doc);
    }
  }

  if (dangling.size) {
    const lines = [...dangling].slice(0, 12)
      .map(([p, from]) => `  ${p}  <- ${[...from].slice(0, 4).join(", ")}${from.size > 4 ? ` +${from.size - 4}` : ""}`);
    throw new Error(
      `link-integrity: ${dangling.size} internal reference(s) point at nothing this site serves:\n`
      + lines.join("\n")
      + (dangling.size > 12 ? `\n  … and ${dangling.size - 12} more` : "")
      + "\n  A moved or renamed page leaves its inbound links behind. Fix the href, or"
      + "\n  register the new path in config/site-manifest.json (bun run gen:manifest).",
    );
  }
  console.log(`links: ${refs} internal refs across ${docs.length} documents all resolve`);
}

// 7b-paths) Does every repository path CITED in the staged bytes still exist?
//
// The sibling of the link check above, and the direction it cannot see. That one
// asks whether an href resolves to something this site SERVES. This one asks
// whether a path in the prose resolves to something this repository HAS, which is
// the failure a rename actually produces here.
//
// Two shapes, and the branch that wrote this scan produced both.
//
// STALE: a page describing the architecture keeps naming a directory after it
// moves. Byte-identity discipline makes this MORE likely rather than less, since
// preserving bytes means reverting served files and leaving their prose behind.
// /garage/workers is a page ABOUT the Worker and it cited www/_worker.js/index.js
// for the ten days after that directory stopped existing.
//
// COUPLED: a repository path inside a CONTENT-ADDRESSED artifact ties the file
// layout to a public URL, so moving the source re-mints /a/<name>.<hash8>.<ext>
// and orphans every committed dictionary naming the old one. icons.svg did exactly
// that, through a banner naming its generator by path.
//
// It reads the STAGED tree for the same reason the link check does: a comment in a
// client island reaches its .src.js twin alone, while a string literal reaches the
// hashed asset too, and only the served bytes decide. The Worker tree is scanned
// beside it because a Worker string literal is served the moment somebody asks for
// the route that prints it — /terminal/radar printed `node
// tools/photos/radar-sample.mjs` long after that file became .ts.
{
  // Anchored on a real top-level entry of this repository, so a URL path like
  // /images/x, an MCP method like tools/list, or somebody else's src/ do not
  // match. The three RETIRED names are the point: www/, holding/ and scripts/ can
  // never resolve, so any surviving citation of them fails by construction.
  const REPO_PATH = /(?<![\w./-])(www|holding|scripts|src|tools|cal|cf-garage|lens-reader|lwe-ask|pipelines|config|serendipity|public|design|docs|migrations|talks)\/[A-Za-z0-9_./-]+/g;

  // Only a token naming a FILE is a citation that has to resolve. A bare directory
  // mention is usually prose ("used to sit at www/scripts") or a build path that
  // exists under .build alone, and flagging those makes this a nuisance. A nuisance
  // check gets commented out, which is the failure every tripwire here warns about.
  const NAMES_A_FILE = /\.[A-Za-z0-9]{1,5}$/;
  const BINARY = /\.(br|dcz|dict|png|jpe?g|avif|webp|gif|pdf|woff2?|ico|mp4|zip|wasm)$/i;

  // One entry, and it is a file in SOMEBODY ELSE'S repository. /lwe/vigenere ports
  // a periodic-cipher attack from github.com/0xdiid/buttcrack and names the file it
  // came from, which is attribution rather than a reference into this tree.
  const ELSEWHERE = [/^src\/buttcrack\//];

  const cited = new Map<string, Set<string>>();
  let scanned = 0;
  for (const root of ["public", "src"]) {
    for (const rel of await readdir(`${OUT}/${root}`, { recursive: true })) {
      if (BINARY.test(rel)) continue;
      let body: string;
      try { body = await readFile(`${OUT}/${root}/${rel}`, "utf8"); } catch { continue; }
      scanned++;
      for (const token of new Set(body.match(REPO_PATH) || [])) {
        const path = token.replace(/[,;:)\]]+$/, "").replace(/\.$/, "");
        if (!NAMES_A_FILE.test(path)) continue;
        if (ELSEWHERE.some((r) => r.test(path))) continue;
        if (existsSync(path)) continue;
        if (!cited.has(path)) cited.set(path, new Set());
        cited.get(path)!.add(`${root}/${rel}`);
      }
    }
  }

  // Counted, because a scanner that stops matching asserts nothing and still
  // reports a pass. This build has caught three naive scanners on its own output.
  if (scanned < 300) throw new Error(`repo-paths: scanned only ${scanned} staged files, expected 300+ — did a walk stop reaching the staged tree?`);

  if (cited.size) {
    const lines = [...cited].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, from]) => `  ${p}  <- ${[...from].sort().slice(0, 4).join(", ")}${from.size > 4 ? ` +${from.size - 4}` : ""}`);
    throw new Error(
      `repo-paths: ${cited.size} repository path(s) named in served bytes do not exist:\n`
      + lines.join("\n")
      + "\n  A move is finished when the prose still says where things are, not when"
      + "\n  the build matches. Update the citation, or cite the new location.",
    );
  }
  console.log(`repo-paths: every repository path cited across ${scanned} staged files resolves`);
}

// 7c) CSP: hash every inline <script> in the staged documents, so script-src can
// drop 'unsafe-inline'. Runs LAST of the HTML passes and before the compression in
// step 8, because a hash is only true of the FINAL bytes: step 2 minifies the
// homepage's inline blocks, step 6 rewrites shell refs into /a/ URLs, and either
// would invalidate a hash taken earlier.
//
// Why hashes and not a nonce: see the long note in _worker.js/lib/security.js. The
// short version is that these documents are precompressed, so nothing can be
// injected into them per request.
{
  const pages = (await readdir(`${OUT}/public`, { recursive: true }))
    .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html"))
    .sort();

  // Canonical request path for a staged asset path. Mirrors the html_handling
  // rules in wrangler.jsonc (drop-trailing-slash, .html elided) and the
  // canonicalPath() the worker applies to the incoming pathname. If these two
  // ever disagree the map silently misses and the page quietly stays loose, which
  // is why the coverage floor below is a HARD failure.
  const pathOf = (asset) => {
    const p = "/" + asset.replace(/\.html$/, "");
    return p === "/index" ? "/" : p.endsWith("/index") ? p.slice(0, -6) : p;
  };

  // The scanner is HTMLRewriter now, in lib/csp-scan.ts. It used to be a
  // hand-rolled tag walker right here, correct only because it had been patched
  // three times against the served bytes; the module header carries that record
  // and the reason a parser is the right shape. lib/link-integrity.ts made the
  // same move on 2026-08-20.
  const { scanDocument, requireParser } = await import("./lib/csp-scan.ts");
  requireParser();

  const map = {};
  const handlers = [];
  let blocks = 0;
  for (const page of pages) {
    const source = await readFile(`${OUT}/public/${page}`, "utf8");
    const found = await scanDocument(source, page);
    handlers.push(...found.handlers);
    // Record EVERY staged document, including the ones with no inline script at
    // all. An empty list is a real and stronger answer than an absent key: absent
    // falls back to 'unsafe-inline', while empty means this document is known to
    // need no inline execution and gets a bare `script-src 'self'`. 10 of the 43
    // are in that happy state, and they should be allowed to say so.
    map[pathOf(page)] = [...new Set(found.hashes)];
    blocks += found.hashes.length;
  }

  // Inline event handlers are the one thing a hash policy cannot express. Leaving
  // them would mean adding 'unsafe-hashes', which re-permits attribute execution
  // generally and gives back most of what dropping 'unsafe-inline' just bought. So
  // this is a hard stop with the exact sites named, not a warning.
  if (handlers.length) {
    console.error("csp-hash: inline event-handler attributes cannot be hashed. Refactor to addEventListener:");
    for (const h of handlers) console.error(`  ${h}`);
    throw new Error(`csp-hash: ${handlers.length} inline event-handler attribute(s) block the hashed policy`);
  }

  // Coverage floor, same shape as the md-twin and precompression guards. An empty
  // or collapsed map is SILENT in production: every page just falls back to the
  // loose policy and looks fine. 40 is a floor under the 43 documents that exist,
  // loose enough to survive deleting a page and tight enough to catch a pass that
  // stopped emitting.
  const covered = Object.keys(map).length;
  if (covered < 40) {
    throw new Error(`csp-hash: only ${covered} of ${pages.length} documents got hashes (floor is 40) — did an earlier HTML pass change shape?`);
  }

  const target = `${OUT}/src/worker/lib/csp-hashes.ts`;
  const source = await readFile(target, "utf8");
  const marker = /^export const PAGE_SCRIPT_HASHES = .*; \/\/ build:csp-hashes$/m;
  if (!marker.test(source)) throw new Error("csp-hash: build:csp-hashes marker missing from lib/csp-hashes.js");
  await writeFile(target, source.replace(
    marker,
    `export const PAGE_SCRIPT_HASHES = ${JSON.stringify(map)}; // build:csp-hashes`,
  ));

  const bytes = (Object.values(map) as string[][]).reduce((n, h) => n + h.length * 72, 0);
  console.log(`csp-hash: ${blocks} inline blocks across ${covered} documents, ${Object.values(map).flat().length} hashes (~${Math.round(bytes / covered)} B/page of header)`);
}

// 8) static and deterministically rendered pages: brotli q11 twins + dcz deltas.
//
// These are the biggest repeated text payloads on the site, and they fit
// dictionary transport better than the hashed shell does. The shell is
// content-addressed, so a changed asset is a new URL. A garage page is mutable at a
// STABLE url under `max-age=0, must-revalidate`, which is the canonical case the RFC was
// written for: the browser revalidates, the bytes moved, and the server answers with the
// diff instead of the document.
//
// A page delta is keyed by SLUG plus the dictionary tag:
// /pd/<slug>.<dicttag>.dcz. The family corpus is the broad, preferred path for anyone
// who has visited any page. Committed per-page snapshots preserve a high-ratio path
// while that idle-loaded family dictionary is not cached yet. Both candidates are
// emitted when they beat the ordinary q11 twin. The browser tells the worker which
// one it selected via Available-Dictionary, so no unsafe guess is made server-side.
{
  // EVERY deploy-time HTML document, the homepage included. `/` used to be the
  // one exception, because four HTMLRewriter injections made its bytes differ
  // per request and no precomputed response could equal them. Step 1d bakes
  // those out, so it is now an ordinary deterministic document and earns the
  // same twin, delta, and validator as the rest.
  const pages = (await readdir(`${OUT}/public`, { recursive: true }))
    .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html"));
  // slug: the request path with separators folded, so it survives as one filename segment.
  const slugOf = (assetPath) => assetPath.replace(/\.html$/, "").replace(/\//g, "__");

  const dictDir = "src/dict/p-dict";
  const dicts = (await readdir(dictDir).catch(() => []));
  const parseDict = (n) => {
    const m = n.match(/^(.+)\.([0-9a-f]{16})\.html\.br$/);
    return m ? { slug: m[1], tag: m[2], name: n } : null;
  };
  const pageDicts = dicts.map(parseDict).filter(Boolean);
  const familyName = (await readdir(`${OUT}/public/a`)).find((n) => /^page-family\.[0-9a-f]{8}\.dict$/.test(n));
  const familyBytes = familyName ? await readFile(`${OUT}/public/a/${familyName}`) : null;
  const familyTag = familyBytes ? createHash("sha256").update(familyBytes).digest("hex").slice(0, 16) : null;
  if (familyBytes) {
    console.log(`page-delta: site-page dictionary ${familyName} (${familyBytes.length} bytes, tag ${familyTag})`);
  }
  if (familyBytes || pageDicts.length) await mkdir(`${OUT}/public/pd`, { recursive: true });

  let brCount = 0, brRaw = 0, brEnc = 0, dCount = 0, dBytes = 0, dPlain = 0, pageCount = 0, pageBytes = 0, familyCount = 0, familyBytesOut = 0;
  const compressedPages = await Promise.all(pages.map(async (page) => {
    const bytes = await readFile(`${OUT}/public/${page}`);
    return { page, bytes, br: await brotliQ11(bytes) };
  }));
  const deltaJobs = [];
  for (const { page, bytes, br } of compressedPages) {
    if (br.length < bytes.length) {
      await writeFile(`${OUT}/public/${page}.br`, br);
      brCount++; brRaw += bytes.length; brEnc += br.length;
    }

    const slug = slugOf(page);
    for (const candidate of pageDicts.filter((d) => d.slug === slug)) {
      const dictBytes = brotliDecompressSync(await readFile(`${dictDir}/${candidate.name}`));
      if (dictBytes.equals(bytes)) continue;
      deltaJobs.push({ kind: "page", slug, tag: candidate.tag, bytes, dictBytes, br });
    }
    if (familyBytes) {
      deltaJobs.push({ kind: "family", slug, bytes, dictBytes: familyBytes, br });
    }
  }
  const deltas = await dczEncodeBatch(deltaJobs);
  for (let i = 0; i < deltaJobs.length; i++) {
    const job = deltaJobs[i];
    const { out, digest } = deltas[i];
    if (out.length >= job.br.length) {
      const label = job.kind === "page" ? `per-page ${job.tag.slice(0, 8)}` : "site-page";
      console.log(`page-delta: SKIPPED ${job.slug} vs ${label} (dcz ${out.length} >= br ${job.br.length})`);
      continue;
    }
    await writeFile(`${OUT}/public/pd/${job.slug}.${digest.toString("hex").slice(0, 16)}.dcz`, out);
    dCount++; dBytes += out.length; dPlain += job.br.length;
    if (job.kind === "page") {
      pageCount++; pageBytes += out.length;
    } else {
      familyCount++; familyBytesOut += out.length;
    }
  }
  console.log(`pages: ${brCount} brotli q11 twins, ${(brRaw / 1024).toFixed(1)}KB -> ${(brEnc / 1024).toFixed(1)}KB`);
  console.log(dCount
    ? `page-delta: ${dCount} dcz delta(s), ${dBytes} bytes against ${dPlain} plain brotli (${pageCount} per-page/${pageBytes} B, ${familyCount} family/${familyBytesOut} B)`
    : `page-delta: none (no dictionary candidate beat plain brotli)`);
}

console.log(`staged ${OUT}/ - deploy with: wrangler deploy (self-builds via build.command) or bun run deploy:direct`);
