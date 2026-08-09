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
//
// ALSO NOT MEASURED HERE, and this is the newer and more important boundary:
// whether THIS CHANGE moved anything. Every threshold below is an absolute line
// against a constant somebody typed, and the baseline history at
// WORKER_BASELINE_GZIP_KIB is the record of what that costs — a number that sat
// 58% stale for months while CI printed "hard checks green" over it every run.
// The differential half now lives in `scripts/perf-snapshot.mjs`, run by
// .github/workflows/perf-diff.yml, which builds the merge base and HEAD and
// posts the delta as a PR comment. It has no constants, so it cannot go stale.
//
// Read the two together and the division of labour is clean: THIS script is the
// gate (structural invariants that must never ship broken, plus a coarse alarm
// for a change large enough that nobody could have meant it), and the diff is
// the signal (what moved, by how much, in this PR). A slow 500-bytes-per-PR
// drift is invisible to everything here and obvious there.

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
  // Raised from 4/3.5 on 2026-08-08 for the interaction recipes: the chip row,
  // the before/after screenshot pair, and the six honest-null strings that say
  // WHY a recipe found nothing (a CSP refusing inline script, a forged receipt,
  // a wall that turned out to be cosmetic). Measured +1.4 KiB gzip, 3.0 -> 4.4.
  // Most of that is the copy, which IS the feature: a result the reader cannot
  // interpret is worth less than no result. Bumped deliberately rather than
  // discovered by CI.
  "lens-browser.js": { role: "optional browser island",    gzipKiB: 5,  brotliKiB: 4.5 },
  "quiz.js":        { role: "understanding-check island",  gzipKiB: 6,  brotliKiB: 5 },
  "tooltip.js":     { role: "optional hover island",       gzipKiB: 6,  brotliKiB: 5 },
  "hoist.js":       { role: "shared hover engine",         gzipKiB: 2,  brotliKiB: 1.5 },
  "luna.css":       { role: "shared render-blocking CSS",  gzipKiB: 12, brotliKiB: 10 },
  "lwe-base.css":   { role: "LWE render-blocking CSS",     gzipKiB: 2,  brotliKiB: 2 },
};

// This is an observability alert, not a platform limit. It is intentionally
// separate from the user-facing LCP budget: Worker code is server-side and can
// grow without changing a browser's transfer path, provided TTFB/CPU stay well.
//
// Baseline history, because a re-baseline that records only its new number is
// indistinguishable from someone silencing the check:
//
//   86 KiB     homepage Worker alone (pre-consolidation)
//   129.23 KiB the one-Worker consolidation (2026-06). The old homepage/Cal/
//              Serendipity aggregate measured 130.94 KiB, so keeping the 86 KiB
//              baseline would have reported a regression on every CI run for a
//              change that made the total smaller.
//   204.24 KiB HERE (2026-08-04), and the growth is /lens plus /serendipity.
//              lens.js is 141 KiB of the bundle and serendipity.js 110 KiB, 35%
//              between them; both landed after the consolidation baseline was
//              set. Nothing was imported to cause this: all of node_modules is
//              39 KiB of the bundle (the three @noble packages), and 94.4% of it
//              is first-party code.
//
//   258.34 KiB OBSERVED on 2026-08-08 at 295ee97, four days after the line
//              above was written, and already over the 255.30 KiB alert. NOT
//              re-baselined, deliberately. Re-baselining is what turns this
//              comment into a changelog of somebody silencing a check, and the
//              growth has not been attributed to anything yet.
//
// The 129.23 baseline had therefore been BREACHED continuously rather than
// occasionally, and because this check warns rather than fails, CI printed
// "hard checks green" over it every run. A permanently-firing advisory carries
// no information, which is the actual reason to re-baseline: the point is to
// catch the NEXT unexplained 50 KiB, and it could not.
//
// Four days from a fresh baseline to a firing advisory is the argument for the
// merge-base diff in one line. The constant is not wrong because somebody chose
// it badly; it is wrong because a constant describes a moment and the bundle
// does not hold still. What the diff gives that no re-baseline can is the
// attribution: 258.34 against 255.30 says nothing about which PR spent the 54
// KiB, and a per-PR module delta says exactly which one did, while the person
// who wrote it is still reading the thread.
//
// Re-baselining is safe here because the startup cost was measured directly on
// 2026-08-04 rather than assumed. The 723 KB bundle compiles in 6.25 ms cold,
// linear at ~8.5 us/KB, against Cloudflare's 400 ms startup-CPU limit; a V8 code
// cache removes 92% of even that. So bundle bytes are a bookkeeping signal for
// review, and the thing that would make them a latency problem is two orders of
// magnitude away. Do NOT read a breach here as a cold-start regression without
// re-measuring; `wrangler check startup` ranks frames but cannot cost them.
//
// Keep this number in DRY-RUN terms. `wrangler check startup` reports a smaller
// total for the same commit (200.44 vs 204.24 KiB gzip on 2026-07-31), and the
// value parsed below comes from `wrangler deploy --dry-run`, so the two are not
// interchangeable.
const WORKER_BASELINE_GZIP_KIB = 204.24;
const WORKER_ALERT_GROWTH = 0.25;

// `wrangler check startup` advisory ceiling, in ms of ACTIVE startup CPU.
//
// The baseline note above measured startup cost BY HAND on 2026-08-04 and
// concluded bundle bytes are two orders of magnitude away from being a latency
// problem. This runs that same measurement on every CI run, so the conclusion
// stops being a point-in-time finding somebody has to remember to re-take.
//
// Read it for what it is. That note's caveat holds: `check startup` ranks frames
// and does not cost them, and this profiles a local machine whose CPU is not
// Cloudflare's. So this is a DIAGNOSTIC, not a prediction of production startup,
// and a breach here means "go re-measure", never "cold start regressed".
//
// It was called a "regression tripwire" until the merge-base diff existed, and
// that was the wrong job for it. A sampled profile whose window lands ~5 samples
// cannot detect a regression; three consecutive runs of identical bytes read 9.6,
// 7.6 and 6.4 ms, a 50% spread on no change at all, and a fourth on 2026-08-08
// read 16.4 ms — 2.6x the low, still on bytes nobody had touched. The tripwire is the bundle
// gzip above and the per-module attribution below, both deterministic, and the
// per-PR movement in those is what scripts/perf-snapshot.mjs reports.
//
// That is also why the snapshot deliberately does NOT record this number.
// Diffing two draws from a noisy distribution manufactures findings: a run that
// happened to sample 9.6 against one that sampled 6.4 would read as a 50%
// startup regression, in a comment whose whole credibility rests on every row
// being real. Astral's answer to benchmark noise is to remove the noise source
// (CodSpeed counts simulated instructions; ty's memory job pins
// TY_MAX_PARALLELISM=1) rather than to widen a threshold around it. Here the
// cheaper version of that answer is available: measure the deterministic thing,
// and keep the sampled one as the flamegraph you open once it fires.
//
// 50ms is ~6x the observed 6.4-9.6ms and still an order of magnitude under the
// 400ms platform limit: room for the reading to wander, none for a real
// regression to hide. It wanders more than you would expect, because the profile
// window is ~20ms and lands about 5 samples — three consecutive runs here read
// 9.6, 7.6 and 6.4ms with nothing changed. Advisory, never fatal; a sampled
// profile at that resolution has no business failing a PR.
const WORKER_STARTUP_ALERT_MS = 50;
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
  // --outfile writes the single prebuilt bundle that `check startup` consumes
  // below, so the startup profile costs no second build.
  dryOut = execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", ".build/.perfbudget", "--outfile", ".build/.perfbudget/worker.bundle", "--metafile"], { encoding: "utf8" });
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

// 2a) startup CPU, from `wrangler check startup` ------------------------------
// The check above measures how BIG the Worker is; this one measures what that
// size costs at cold start, which is the constraint the size was ever a proxy
// for. Available since 2026-07-30 and it needs no credential.
//
// This settles an open question rather than opening one. The repo's standing
// conclusion is that cold start here is not eval-bound (measured 2026-07-28,
// when lazy route imports were tried and bought nothing but +27KB of wrappers).
// That was reasoned from bundle structure; this measures it directly, and it
// agrees: ~8ms of active startup CPU against a 400ms platform limit, on a
// Worker whose bundle grew 57% in the interim.
//
// Runs on the prebuilt bundle from the dry-run above, so it adds no build.
try {
  const startOut = execFileSync("npx", [
    "wrangler", "check", "startup",
    "--workerBundle", ".build/.perfbudget/worker.bundle",
    "--outfile", ".build/.perfbudget/worker-startup.cpuprofile",
  ], { encoding: "utf8" });
  // "│   Active: 9.6 ms (including 0.0 ms garbage collection)"
  const active = startOut.match(/Active:\s*([\d.]+)\s*ms/);
  if (active) {
    const ms = parseFloat(active[1]);
    ms > WORKER_STARTUP_ALERT_MS
      ? warn(`worker startup ${ms.toFixed(1)} ms active CPU > ${WORKER_STARTUP_ALERT_MS} ms advisory alert — open .build/.perfbudget/worker-startup.cpuprofile in Chrome DevTools for the flamegraph`)
      : ok(`worker startup ${ms.toFixed(1)} ms active CPU (advisory alert at ${WORKER_STARTUP_ALERT_MS} ms, platform limit 400 ms)`);
  } else {
    warn("could not read active CPU from `wrangler check startup`; skipping the startup check");
  }
} catch (e) {
  warn(`\`wrangler check startup\` did not run (${(e.message || "").split("\n")[0]}); skipping the startup check`);
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
  // A page is covered when EITHER tier produced a delta: its own previous-release
  // snapshot, or the 64KB family corpus. Both are emitted only when they beat
  // plain q11, so a page can legitimately have neither.
  const missing = pages
    .map((path) => path.replace(/\.html$/, "").replace(/\//g, "__"))
    .filter((slug) => !deltas.some((name) => name.startsWith(`${slug}.`) && name.endsWith(".dcz")));

  // A page with NO committed p-dict snapshot has never been deployed, so the
  // per-page tier structurally cannot exist for it yet and the family tier is its
  // only chance. When the family corpus also loses (a distinctive page: a lot of
  // prose, a vocabulary the rest of the site doesn't share), the page is
  // uncovered on its FIRST deploy and there is nothing honest to do about it here.
  // Seeding a snapshot from this branch is the one fix that must not happen: a
  // dictionary is only useful if it is bytes a browser already holds, and gotcha 14
  // is explicit that snapshots get rolled from the DEPLOYED build. So a first-deploy
  // page warns, and every page the site has already served still hard-fails, which
  // is the regression this check was actually built to catch. Rolling p-dict after
  // the deploy is what closes it.
  let snapshots = [];
  try { snapshots = await readdir("holding/p-dict"); } catch {}
  const seen = (slug) => snapshots.some((name) => name.startsWith(`${slug}.`));
  const regressed = missing.filter(seen);
  const firstDeploy = missing.filter((slug) => !seen(slug));

  if (regressed.length) bad(`site-page dictionary: missing useful DCZ variants for ${regressed.join(", ")}`);
  if (firstDeploy.length) {
    warn(`site-page dictionary: ${firstDeploy.join(", ")} beat both dictionary tiers with plain q11 and has no p-dict snapshot yet (never deployed) — run npm run shell:roll after this ships`);
  }
  if (!missing.length) ok(`site-page dictionary: all ${pages.length} static/deterministic pages have DCZ variants`);
  else if (!regressed.length) ok(`site-page dictionary: ${pages.length - missing.length} of ${pages.length} pages have DCZ variants, no regressions`);
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
