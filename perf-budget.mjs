#!/usr/bin/env node
// perf-budget.mjs — the pre-deploy performance budget gate for aadhar.sh.
//
// Deterministic, buildtime checks that catch a perf regression BEFORE it ships:
//   1. luna.css parses clean (no esbuild CSS warnings) — the v143-corruption
//      tripwire, so a broken stylesheet can never reach a deploy.
//   2. the build output is actually minified: the client scripts + luna.css each
//      carry the "minified at deploy" banner, sit under their byte budget, and
//      ship a readable twin (/<name>.src.js / /luna.src.css).
//   3. the bundled Worker stays under the gzip budget (via wrangler --dry-run,
//      which self-builds via build.command).
//
// Exits non-zero on any breach, so it gates a deploy or CI run.
//
//   node perf-budget.mjs        (or: npm run perf-budget)
//
// NOT covered here (needs a real browser): Slow-4G LCP/FCP traces, CLS, and the
// per-viewport photo-transfer delta. Run those with Lighthouse or the web-perf
// tooling. For the LIVE minified + twin assertions after deploying, use
// `node verify-routes.mjs https://aadhar.sh` (its prod-only checks cover them).

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { transform } from "esbuild";

// byte ceilings for the minified build output (uncompressed), and the worker
// bundle's gzip ceiling. Bump these deliberately, with a reason, when real
// growth is justified — an unexplained jump is the signal this is meant to catch.
const SHELL_BUDGET = {
  "nav.js": 50_000,
  "notepad.js": 8_000,
  // Lens now carries the readiness rubric, six bot observations, copyable
  // fixes, the counterfactual score view, the opt-in Browser Run loader, AND
  // the teaching surface added 2026-07:
  // the agent-trace console, the always-on dollar verdict strip, per-check
  // consumption annotations, and the idle state-of-web hide logic. Deferred +
  // cached, not render-blocking. Ceiling raised from 48K for that surface.
  // Browser Run's rendered code remains split into its own deferred twin.
  "lens.js": 54_000,
  "lens-browser.js": 8_000,
  // Rich hover content is an idle-prefetched island, not homepage-critical JS.
  // Keep it bounded so the first-hover optimization does not become another
  // shared shell by accident.
  "tooltip.js": 18_000,
  "luna.css": 40_000,
};
// The readiness probes add a bounded server-side envelope and bot matrix, HTML
// negotiation adds a no-script fragment contract, CachedPages adds a named
// Workers Cache entrypoint, and the 2026-07 /lens work grew the Worker again:
// the state-of-web panel + verdict/trace/consumption renderers and CSS, plus
// census.js (the weekly longitudinal sweep, the /lens/census page + JSON twin).
// Measured ~84.8 KiB gzip; 86 leaves ~1.2 KiB, enough to cover the ~0.2 KiB
// gzip variance between the local and CI Node runtimes without going flaky.
const BUNDLE_GZIP_KIB = 86;
const TWINS = ["nav.src.js", "notepad.src.js", "lens.src.js", "lens-browser.src.js", "tooltip.src.js", "luna.src.css"];

const fails = [];
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); fails.push(m); };
const warn = (m) => console.log(`  warn  ${m}`);

console.log("perf-budget: aadhar.sh pre-deploy gate\n");

// 1) luna.css parses clean ---------------------------------------------------
try {
  const css = await readFile("holding/luna.css", "utf8");
  const { warnings } = await transform(css, { loader: "css", minify: false });
  if (warnings.length) bad(`luna.css: ${warnings.length} CSS parse warning(s): ${warnings.map((w) => w.text).join("; ")}`);
  else ok("luna.css parses clean (0 warnings)");
} catch (e) {
  bad(`luna.css: could not read/parse (${e.message})`);
}

// 2) worker bundle gzip via wrangler dry-run (self-builds .build/holding) -----
let dryOut = "";
try {
  dryOut = execFileSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", ".build/.perfbudget"], { encoding: "utf8" });
} catch (e) {
  dryOut = (e.stdout || "") + "\n" + (e.stderr || "");
}
const gz = dryOut.match(/gzip:\s*([\d.]+)\s*KiB/);
if (gz) {
  const kib = parseFloat(gz[1]);
  if (kib > BUNDLE_GZIP_KIB) bad(`worker bundle ${kib} KiB gzip > ${BUNDLE_GZIP_KIB} KiB budget`);
  else ok(`worker bundle ${kib} KiB gzip (budget ${BUNDLE_GZIP_KIB})`);
} else {
  warn("could not read bundle gzip from wrangler dry-run (offline/unauth?); skipping bundle-size check");
}

// 3) minified shells + luna.css: banner + under budget -----------------------
for (const [file, budget] of Object.entries(SHELL_BUDGET)) {
  const path = `.build/holding/${file}`;
  let s;
  try { s = await readFile(path, "utf8"); } catch { bad(`${file}: missing from build output (run build first)`); continue; }
  const bytes = Buffer.byteLength(s);
  const banner = s.startsWith("/*!") && s.includes("minified at deploy");
  if (!banner) { bad(`${file}: missing "minified at deploy" banner (build bypassed / not minified?)`); continue; }
  if (bytes > budget) bad(`${file}: ${bytes} B > ${budget} B budget`);
  else ok(`${file}: ${bytes} B minified (budget ${budget})`);
}

// 4) readable twins present --------------------------------------------------
for (const t of TWINS) {
  try { await stat(`.build/holding/${t}`); ok(`twin ${t} present`); }
  catch { bad(`twin ${t} missing from build output`); }
}

console.log("");
if (fails.length) {
  console.error(`perf-budget: ${fails.length} breach(es) — GATE FAILED`);
  process.exit(1);
}
console.log("perf-budget: all budgets green");
