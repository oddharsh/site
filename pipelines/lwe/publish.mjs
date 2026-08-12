#!/usr/bin/env node
// publish.mjs — Phase 3 of lwe-publish. One command: spec -> page -> corpus -> wire.
//
//   node pipelines/lwe/publish.mjs <concept>
//
// Steps (all local, safe to re-run):
//   1. generate the page from specs/<concept>.json
//   2. rebuild the ask corpus if lwe-ask/corpus/<concept>.json exists (the page's
//      built-in "ask" box is grounded in it, sandboxed to this concept)
//   3. wire the registry-driven regions (sitemap, buddy list, nav Run entries)
//
// Everything here is local and writes only into the source tree. Shipping is
// PRINTED, never run: the site publishes through merge -> CI -> production ->
// Workers Builds, so a local script has no business touching production. The
// lwe-ask corpus is a separate auxiliary Worker and stays a manual deploy
// because it needs the reindex secret.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");   // pipelines/<name>/ -> repo root
const concept = process.argv[2];

if (!concept || concept.startsWith("--")) {
  console.log("usage: node pipelines/lwe/publish.mjs <concept>");
  process.exit(1);
}

const run = (cmd, cwd = ROOT) => { console.log(`$ ${cmd}`); execSync(cmd, { cwd, stdio: "inherit" }); };

console.log(`\n=== lwe-publish: ${concept} ===\n`);

if (!existsSync(join(ROOT, "pipelines", "lwe", "specs", `${concept}.json`))) {
  console.error(`no spec at pipelines/lwe/specs/${concept}.json`);
  process.exit(1);
}

// 1. generate the page
run(`node pipelines/lwe/generate.mjs page ${concept}`);

// 2. rebuild the ask corpus (grounds the built-in ask box for this concept)
const corpusFile = join(ROOT, "lwe-ask", "corpus", `${concept}.json`);
if (existsSync(corpusFile)) {
  run(`node pipelines/lwe/build-corpus.mjs`);
  console.log(`  ask box grounded in lwe-ask/corpus/${concept}.json (sandboxed to "${concept}")`);
} else {
  console.log(`  no lwe-ask/corpus/${concept}.json yet -> the ask box stays off for "${concept}".`);
  console.log(`  add republishable passages there (page's own explanations, Wikipedia w/ attribution,`);
  console.log(`  or your own docs; never third-party copyrighted text) + set hasAsk:true in the spec.`);
}

// 3. wire the registry-driven regions
run(`node pipelines/lwe/generate.mjs wire`);

console.log(`\n=== built locally. to ship: ===`);
console.log(`  1) commit the generated page + wired regions on a branch, open a PR`);
console.log(`  2) merge it — CI promotes the tested commit to production and Workers`);
console.log(`     Builds deploys the site Worker. Nothing to bump by hand.`);
if (existsSync(corpusFile)) {
  console.log(`  3) cd lwe-ask && pnpm exec wrangler deploy        # the auxiliary ask Worker`);
  console.log(`  4) curl -X POST https://aadhar.sh/lwe/ask/reindex -H "x-reindex-secret: $REINDEX_SECRET"  # embed it`);
}
