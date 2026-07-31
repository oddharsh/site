#!/usr/bin/env node
// perf-budget.mjs — deterministic build/deploy invariants + advisory wire-size
// reporting for aadhar.sh.
//
// User experience is measured by Cloudflare RUM and a controlled browser lab;
// this script cannot honestly turn a guessed byte number into an LCP guarantee.
// It therefore HARD-fails only on facts that must never be ambiguous:
//   1. luna.css parses clean (the v143-corruption tripwire);
//   2. deploy assets are actually minified and retain readable source twins;
//   3. the build output contains every expected asset.
//
// It also reports gzip + Brotli sizes against generous, role-aware envelopes.
// Those envelopes are ADVISORY until RUM has enough observations to justify a
// user-centered threshold. A deferred page island is not allowed to veto a
// homepage feature merely because its raw source grew.
//
//   node perf-budget.mjs        (or: npm run perf-budget)
//
// Not measured here (needs a real browser): LCP/FCP/INP/CLS, TTFB by field
// cohort, and the per-viewport photo-transfer delta. Cloudflare RUM is the
// outcome source; a controlled 4G lab run is the repeatable pre-merge signal.

import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { transform as transformCss } from "lightningcss";
import { HTML_MARKERS } from "./scripts/lib/html-markers.mjs";

// Wire-size envelopes, not raw-source ceilings. These start from the current
// built output with enough room for ordinary feature work; they are deliberately
// advisory until the Cloudflare RUM baseline tells us which paths matter.
const ASSET_ENVELOPES = {
  "nav.js":         { role: "shared deferred shell",       gzipKiB: 20, brotliKiB: 18 },
  "notepad.js":     { role: "writing-only island",         gzipKiB: 4,  brotliKiB: 3.5 },
  "lens.js":        { role: "lens-only island",             gzipKiB: 24, brotliKiB: 21 },
  "lens-browser.js": { role: "optional browser island",    gzipKiB: 4,  brotliKiB: 3.5 },
  "quiz.js":        { role: "understanding-check island",  gzipKiB: 6,  brotliKiB: 5 },
  "tooltip.js":     { role: "optional hover island",       gzipKiB: 6,  brotliKiB: 5 },
  "hoist.js":       { role: "shared hover engine",         gzipKiB: 2,  brotliKiB: 1.5 },
  "luna.css":       { role: "shared render-blocking CSS",  gzipKiB: 12, brotliKiB: 10 },
  "lwe-base.css":   { role: "LWE render-blocking CSS",     gzipKiB: 2,  brotliKiB: 2 },
};

// This is an observability alert, not a platform limit. It is intentionally
// separate from the user-facing LCP budget: Worker code is server-side and can
// grow without changing a browser's transfer path, provided TTFB/CPU stay well.
// Intentional one-Worker consolidation baseline. The old homepage/Cal/
// Serendipity aggregate measured 130.94 KiB gzip; the consolidated Worker is
// 129.23 KiB gzip, so comparing it to the old homepage-only 86 KiB baseline
// would report a misleading regression on every CI run.
const WORKER_BASELINE_GZIP_KIB = 129.23;
const WORKER_ALERT_GROWTH = 0.25;
const TWINS = [
  "nav.src.js", "notepad.src.js", "lens.src.js", "lens-browser.src.js",
  "quiz.src.js", "tooltip.src.js", "hoist.src.js", "luna.src.css",
  "lwe-base.src.css",
];
const HTML_TWIN = "index.src.html";
const HTML_ENVELOPE = {
  role: "homepage document",
  gzipKiB: 22,
  brotliKiB: 20,
};

const fails = [];
const warnings = [];
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); fails.push(m); };
const warn = (m) => { console.log(`  warn  ${m}`); warnings.push(m); };
const kib = (bytes) => bytes / 1024;
const compressedSizes = (bytes) => ({
  gzip: kib(gzipSync(bytes, { level: 9 }).length),
  brotli: kib(brotliCompressSync(bytes, {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
  }).length),
});
const fmt = (value) => `${value.toFixed(1)} KiB`;

console.log("perf-budget: aadhar.sh pre-deploy gate\n");

// 1) luna.css parses clean ---------------------------------------------------
try {
  const css = await readFile("holding/luna.css", "utf8");
  const { warnings } = transformCss({ filename: "holding/luna.css", code: Buffer.from(css), minify: false });
  if (warnings.length) bad(`luna.css: ${warnings.length} CSS parse warning(s): ${warnings.map((w) => w.message).join("; ")}`);
  else ok("luna.css parses clean (0 warnings)");
} catch (e) {
  bad(`luna.css: could not read/parse (${e.message})`);
}

// 2) worker bundle gzip via wrangler dry-run (self-builds .build/holding) -----
let dryOut = "";
try {
  dryOut = execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", ".build/.perfbudget", "--metafile"], { encoding: "utf8" });
} catch (e) {
  dryOut = (e.stdout || "") + "\n" + (e.stderr || "");
}
const gz = dryOut.match(/gzip:\s*([\d.]+)\s*KiB/);
let overBudget = false;
if (gz) {
  const kib = parseFloat(gz[1]);
  const alertAt = WORKER_BASELINE_GZIP_KIB * (1 + WORKER_ALERT_GROWTH);
  overBudget = kib > alertAt;
  if (overBudget) warn(`worker bundle ${kib.toFixed(2)} KiB gzip > ${alertAt.toFixed(2)} KiB advisory alert (${Math.round(WORKER_ALERT_GROWTH * 100)}% over ${WORKER_BASELINE_GZIP_KIB} KiB baseline)`);
  else ok(`worker bundle ${kib.toFixed(2)} KiB gzip (advisory alert at ${alertAt.toFixed(2)} KiB)`);
} else {
  warn("could not read bundle gzip from wrangler dry-run (offline/unauth?); skipping bundle-size check");
}

// 2b) bundle attribution, from esbuild's metafile (--metafile, above) ---------
// The gzip number above says the bundle grew; it cannot say WHAT grew. The
// metafile carries per-input bytes, so the advisory can name the modules
// instead of leaving a number for someone to bisect by hand. Attribution only
// prints when the advisory fires: on a green run it is noise.
try {
  const meta = JSON.parse(await readFile(".build/.perfbudget/bundle-meta.json", "utf8"));
  const entry = Object.entries(meta.outputs).find(([name]) => name.endsWith(".js") && !name.endsWith(".map"));
  const inputs = Object.entries(entry?.[1]?.inputs ?? {})
    .map(([name, v]) => [name, v.bytesInOutput ?? 0])
    .sort((a, b) => b[1] - a[1]);
  if (!inputs.length) warn("metafile carried no input attribution; skipping bundle breakdown");
  else if (overBudget) {
    console.log(`        ${inputs.length} modules in the bundle; largest:`);
    for (const [name, bytes] of inputs.slice(0, 5)) console.log(`          ${fmt(kib(bytes)).padStart(9)}  ${name}`);
  } else ok(`bundle attribution available (${inputs.length} modules, largest ${inputs[0][0]} at ${fmt(kib(inputs[0][1]))})`);
} catch (e) {
  warn(`could not read bundle metafile (${e.message}); skipping bundle breakdown`);
}

// 3) minified shells + luna.css: banner + compressed advisory envelope --------
for (const [file, envelope] of Object.entries(ASSET_ENVELOPES)) {
  const path = `.build/holding/${file}`;
  let bytes;
  try { bytes = await readFile(path); } catch { bad(`${file}: missing from build output (run build first)`); continue; }
  const text = bytes.toString("utf8");
  const banner = text.startsWith("/*!") && text.includes("minified at deploy");
  if (!banner) { bad(`${file}: missing "minified at deploy" banner (build bypassed / not minified?)`); continue; }
  const sizes = compressedSizes(bytes);
  const overGzip = sizes.gzip > envelope.gzipKiB;
  const overBrotli = sizes.brotli > envelope.brotliKiB;
  const line = `${file}: ${bytes.length} B raw, ${fmt(sizes.gzip)} gzip, ${fmt(sizes.brotli)} Brotli (${envelope.role})`;
  if (overGzip || overBrotli) warn(`${line}; advisory envelope ${envelope.gzipKiB}/${envelope.brotliKiB} KiB gzip/Brotli`);
  else ok(`${line}; envelope ${envelope.gzipKiB}/${envelope.brotliKiB} KiB gzip/Brotli`);
}

// 4) readable twins present --------------------------------------------------
for (const t of TWINS) {
  try { await stat(`.build/holding/${t}`); ok(`twin ${t} present`); }
  catch { bad(`twin ${t} missing from build output`); }
}

// 4b) dictionary + generated-page pipeline ----------------------------------
try {
  const name = (await readdir(".build/holding/a"))
    .find((f) => /^page-family\.[0-9a-f]{8}\.dict$/.test(f));
  if (!name) bad("page-family.dict: content-hashed build asset missing");
  else {
    const [dict, br] = await Promise.all([
      readFile(`.build/holding/a/${name}`),
      readFile(`.build/holding/a/${name}.br`),
    ]);
    if (dict.length !== 65_536 || dict.readUInt32LE(0) === 0xec30a437) {
      bad("page-family.dict: expected an exact 64KB raw-content dictionary, not a trained zstd dictionary");
    } else if (br.length >= dict.length) {
      bad("page-family.dict: q11 twin is not smaller than the dictionary");
    } else {
      ok(`page-family.dict: ${dict.length} B raw source -> ${br.length} B q11 immutable asset`);
    }
  }
} catch (e) {
  bad(`page-family.dict: missing or unreadable (${e.message})`);
}

try {
  const pages = (await readdir(".build/holding", { recursive: true }))
    .filter((path) => path.endsWith(".html") && !path.endsWith(".src.html"));
  const deltas = await readdir(".build/holding/pd");
  const missing = pages
    .map((path) => path.replace(/\.html$/, "").replace(/\//g, "__"))
    .filter((slug) => !deltas.some((name) => name.startsWith(`${slug}.`) && name.endsWith(".dcz")));
  if (missing.length) bad(`site-page dictionary: missing useful DCZ variants for ${missing.join(", ")}`);
  else ok(`site-page dictionary: all ${pages.length} static/deterministic pages have DCZ variants`);
} catch (e) {
  bad(`site-page dictionary: generated DCZ set unreadable (${e.message})`);
}

for (const path of [
  "lens.html",
  "writing/index.html",
  "writing/big-screens-and-small-screens.html",
  "writing/education-in-tech.html",
  "writing/in-flux.html",
  "writing/colophon.html",
  "pixel-peeper/index.html",
]) {
  try {
    const [raw, br] = await Promise.all([
      readFile(`.build/holding/${path}`),
      readFile(`.build/holding/${path}.br`),
    ]);
    if (br.length >= raw.length) bad(`${path}: q11 twin is not smaller than the generated page`);
    else ok(`${path}: deterministic renderer staged ${raw.length} B -> ${br.length} B q11`);
  } catch {
    bad(`${path}: deterministic render or q11 twin missing from build output`);
  }
}

// 5) homepage HTML: minification banner, readable twin, and semantic anchors
let homepage;
try {
  homepage = await readFile(".build/holding/index.html");
} catch {
  bad("index.html: missing from build output");
}
if (homepage) {
  const text = homepage.toString("utf8");
  const banner = text.startsWith("<!-- minified at deploy; readable source: /index.src.html -->");
  if (!banner) bad("index.html: missing deploy-time minification banner");
  for (const [label, marker] of HTML_MARKERS) {
    if (!marker.test(text)) bad("index.html: missing required marker " + label);
  }
  try {
    const source = await readFile("holding/index.html");
    const twin = await readFile(`.build/holding/${HTML_TWIN}`);
    if (!source.equals(twin)) bad("index.src.html: readable twin differs from holding/index.html");
    else ok("index.src.html: readable homepage twin present");
  } catch {
    bad("index.src.html: readable homepage twin missing");
  }
  // Every OTHER served page has carried the same contract since 2026-07-31. This is
  // the shipped-artifact half of the gate build.mjs step 7b enforces at write time,
  // the same two-moment arrangement HTML_MARKERS already uses.
  //
  // The twin is checked for EXISTENCE and readability rather than byte-equality with
  // a source file, because ten of these pages are generated into the staged tree and
  // have no authored file to compare against. Readability is the claim that matters:
  // a twin that came back minified would make View Source a dead link.
  try {
    const { readdir } = await import("node:fs/promises");
    const served = (await readdir(".build/holding", { recursive: true }))
      .filter((rel) => rel.endsWith(".html") && !rel.endsWith(".src.html") && rel !== "index.html")
      .sort();
    let missing = 0, unbannered = 0, unreadable = 0;
    for (const rel of served) {
      const page = (await readFile(`.build/holding/${rel}`)).toString("utf8");
      const twinRel = rel.replace(/\.html$/, ".src.html");
      if (!page.startsWith(`<!-- minified at deploy; readable source: /${twinRel} -->`)) unbannered++;
      let twin;
      try { twin = (await readFile(`.build/holding/${twinRel}`)).toString("utf8"); }
      catch { missing++; continue; }
      // The claim is that the twin is the PRE-minification document, so the exact
      // test is that it does not itself carry the banner the minifier stamps on.
      //
      // A line-count comparison was the obvious heuristic and it was wrong: the five
      // /writing Notepad pages hold their text inside a <textarea>, whose newlines
      // the minifier must preserve, so twin and page have the same line count and the
      // banner tipped it the wrong way. Minification is non-expanding, so the size
      // floor below is the honest sanity bound.
      if (twin.startsWith("<!-- minified at deploy;")) unreadable++;
      else if (twin.length < page.length - 120) unreadable++;
    }
    if (missing) bad(`${missing} of ${served.length} served pages are missing their .src.html twin`);
    else if (unbannered) bad(`${unbannered} of ${served.length} served pages lack the minification banner`);
    else if (unreadable) bad(`${unreadable} of ${served.length} .src.html twins are not more readable than the page they twin`);
    else ok(`${served.length} served pages minified, each with a readable .src.html twin`);
  } catch (error) {
    bad(`page twins: could not verify (${error.message})`);
  }
  const sizes = compressedSizes(homepage);
  const overGzip = sizes.gzip > HTML_ENVELOPE.gzipKiB;
  const overBrotli = sizes.brotli > HTML_ENVELOPE.brotliKiB;
  const line = `index.html: ${homepage.length} B raw, ${fmt(sizes.gzip)} gzip, ${fmt(sizes.brotli)} Brotli (${HTML_ENVELOPE.role})`;
  if (overGzip || overBrotli) warn(`${line}; advisory envelope ${HTML_ENVELOPE.gzipKiB}/${HTML_ENVELOPE.brotliKiB} KiB gzip/Brotli`);
  else ok(`${line}; envelope ${HTML_ENVELOPE.gzipKiB}/${HTML_ENVELOPE.brotliKiB} KiB gzip/Brotli`);
}

console.log("");
if (fails.length) {
  console.error(`perf-budget: ${fails.length} breach(es) — GATE FAILED`);
  process.exit(1);
}
console.log(`perf-budget: hard checks green${warnings.length ? ` (${warnings.length} advisory warning${warnings.length === 1 ? "" : "s"})` : ""}`);
