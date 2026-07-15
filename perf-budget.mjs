#!/usr/bin/env node
// perf-budget.mjs — the pre-deploy performance budget gate for aadhar.sh.
//
// Deterministic, buildtime checks that catch a perf regression BEFORE it ships:
//   1. luna.css parses clean (no esbuild CSS warnings) — the v143-corruption
//      tripwire, so a broken stylesheet can never reach a deploy.
//   2. the build output is actually minified: the three shells + luna.css each
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
  // fixes, and the counterfactual score view. Keep an explicit ceiling above
  // that intentional feature surface rather than silently letting it grow.
  "lens.js": 48_000,
  "luna.css": 40_000,
};
// The readiness probes add a bounded server-side envelope and bot matrix, and
// HTML negotiation adds a no-script fragment contract. The merged Worker is
// 75.76 KiB gzip; 77 KiB leaves a small measured allowance without making the
// dependency and feature budget meaningless.
const BUNDLE_GZIP_KIB = 77;
const TWINS = ["nav.src.js", "notepad.src.js", "lens.src.js", "luna.src.css"];

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
