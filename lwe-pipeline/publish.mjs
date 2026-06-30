#!/usr/bin/env node
// publish.mjs — Phase 3 of lwe-publish. One command: spec -> page -> corpus -> wire.
//
//   node lwe-pipeline/publish.mjs <concept> [--deploy]
//
// Steps (all local, safe to re-run):
//   1. generate the page from specs/<concept>.json
//   2. rebuild the ask corpus if lwe-ask/corpus/<concept>.json exists (the page's
//      built-in "ask" box is grounded in it, sandboxed to this concept)
//   3. wire the registry-driven regions (sitemap, buddy list, nav Run entries)
//
// The worker deploy + Vectorize reindex + service-worker bump are PRINTED, not run
// (they touch the live account and need the secrets). --deploy runs only the Pages
// deploy; the worker/reindex stay manual on purpose.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const concept = process.argv[2];
const deploy = process.argv.includes("--deploy");

if (!concept || concept.startsWith("--")) {
  console.log("usage: node lwe-pipeline/publish.mjs <concept> [--deploy]");
  process.exit(1);
}

const run = (cmd, cwd = ROOT) => { console.log(`$ ${cmd}`); execSync(cmd, { cwd, stdio: "inherit" }); };

console.log(`\n=== lwe-publish: ${concept} ===\n`);

if (!existsSync(join(ROOT, "lwe-pipeline", "specs", `${concept}.json`))) {
  console.error(`no spec at lwe-pipeline/specs/${concept}.json`);
  process.exit(1);
}

// 1. generate the page
run(`node lwe-pipeline/generate.mjs page ${concept}`);

// 2. rebuild the ask corpus (grounds the built-in ask box for this concept)
const corpusFile = join(ROOT, "lwe-ask", "corpus", `${concept}.json`);
if (existsSync(corpusFile)) {
  run(`node lwe-pipeline/build-corpus.mjs`);
  console.log(`  ask box grounded in lwe-ask/corpus/${concept}.json (sandboxed to "${concept}")`);
} else {
  console.log(`  no lwe-ask/corpus/${concept}.json yet -> the ask box stays off for "${concept}".`);
  console.log(`  add republishable passages there (page's own explanations, Wikipedia w/ attribution,`);
  console.log(`  or your own docs; never third-party copyrighted text) + set hasAsk:true in the spec.`);
}

// 3. wire the registry-driven regions
run(`node lwe-pipeline/generate.mjs wire`);

console.log(`\n=== built locally. to ship: ===`);
console.log(`  1) bump holding/sw.js CACHE_VERSION (nav.js/ask.js changes need it)`);
console.log(`  2) wrangler pages deploy holding --project-name aadhar-sh --branch holding --commit-dirty=true`);
if (existsSync(corpusFile)) {
  console.log(`  3) cd lwe-ask && npx wrangler deploy        # ship the updated corpus`);
  console.log(`  4) curl -X POST https://aadhar.sh/lwe/ask/reindex -H "x-reindex-secret: $REINDEX_SECRET"  # embed it`);
}

if (deploy) {
  console.log(`\n--deploy: running the Pages deploy (worker + reindex left manual for safety)`);
  run(`wrangler pages deploy holding --project-name aadhar-sh --branch holding --commit-dirty=true`);
}
