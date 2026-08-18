#!/usr/bin/env node
// gen-remote-config.mjs — derive a remote-bindings twin of a wrangler config.
//
//   node tools/gen-remote-config.mjs wrangler.dev.jsonc            # dev twin
//   node tools/gen-remote-config.mjs wrangler.jsonc --out x.jsonc  # oracle twin
//   node tools/gen-remote-config.mjs wrangler.dev.jsonc --d1       # opt into D1
//
// WHAT A REMOTE BINDING IS. Your Worker code still runs locally in workerd; the
// BINDING calls hop to the real Cloudflare resource instead of a local simulation.
// So `wrangler dev` reads the actual RN_KV, the actual aadhar-photos bucket, the
// actual Browser Run service — with your uncommitted edits in the handler.
//
// WHY THIS IS GENERATED AND NOT A THIRD COMMITTED CONFIG. There are already two
// (wrangler.jsonc and wrangler.dev.jsonc), build.mjs invariant #6 exists solely
// to warn when their binding sets drift, and that warning is the evidence that a
// third hand-maintained copy would rot. A twin derived at the moment of use is a
// pure function of the config it came from, which is the same argument the
// Markdown twins and the dcz deltas already won. Output goes under .build/ and
// is never committed.
//
// WHAT REMOTE CANNOT REACH, said up front because it decides what this is good
// for: SECRETS and vars are not remotable, and neither are Durable Objects,
// Workflows, static assets, version metadata, or Analytics Engine. So a route
// gated on a secret (the two /lens rows in the route oracle want the AadharshBot
// signing key) still needs a gitignored .dev.vars. Remote bindings fix the DATA
// gap, not the credential gap.
//
// WHY D1 IS OFF BY DEFAULT, AND THIS IS THE PART TO READ BEFORE PASSING --d1.
// The route oracle's remote-only rows need KV (the /around snapshot), R2 (the
// photo originals), and Browser Run (/lens/shot). Not one of them needs D1. Meanwhile the D1 bindings are the write-heaviest things
// on this Worker: SERENDIPITY_DB takes the Luma sync, SOCIAL_DB takes moderated
// third-party webmentions, RESTORE_DB is the append-only deploy log that both
// /restore and /updates read. A dev session pointed at those is one stray handler
// away from writing production history from a laptop. wrangler.dev.jsonc already
// says as much about SOCIAL_DB in its own comment. The flag exists because
// debugging a D1 handler against real rows is occasionally the only way, and it
// should cost a deliberate keystroke every time.
//
// WHY THIS IS WORKSTATION-ONLY. Remote bindings stand up a proxy Worker in the
// account, which needs a token that can WRITE. CI holds a read-only token and
// must keep holding only that (CLAUDE.md, "GitHub must never hold a Cloudflare
// token that can write"), so this script refuses to run in CI rather than
// tempting anyone to widen the scope. Same posture as infra:apply.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lib/jsonc.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Binding families Cloudflare supports in remote mode. Durable Objects,
// Workflows, Analytics Engine, static assets, version metadata, vars and secrets
// are NOT on this list and cannot be — they stay local, which is correct: a DO
// and a Workflow are stateful classes this Worker defines, and an AE write from
// a dev session belongs in no production series.
const REMOTABLE = {
  kv_namespaces: "KV",
  r2_buckets:    "R2",
  d1_databases:  "D1",
};

function main() {
  const argv = process.argv.slice(2);
  if (process.env.CI) {
    console.error("gen-remote-config: refusing to run in CI. Remote bindings need a token that can write; CI holds a read-only one on purpose.");
    process.exit(2);
  }

  const source = argv.find((a) => !a.startsWith("--")) || "wrangler.dev.jsonc";
  const withD1 = argv.includes("--d1");
  // Written to the repo ROOT, not under .build/, and that is load-bearing rather
  // than tidy-minded. Wrangler resolves `main`, `assets.directory` and the build
  // command's cwd RELATIVE TO THE CONFIG FILE, so the same config placed one
  // directory down silently becomes `.build/.build/public/...` and boots a
  // Worker with no entrypoint. Keeping the derived twin beside its source means
  // every relative path in it still means what it meant. Gitignored.
  const outArg = argv[argv.indexOf("--out") + 1];
  const out = argv.includes("--out") && outArg
    ? resolve(ROOT, outArg)
    : join(ROOT, ".wrangler.remote.jsonc");

  return { source, withD1, out };
}

const { source, withD1, out } = main();
const config = parseJsonc(await readFile(resolve(ROOT, source), "utf8"));

const marked = [];
for (const [key, label] of Object.entries(REMOTABLE)) {
  if (key === "d1_databases" && !withD1) continue;
  for (const binding of config[key] || []) {
    binding.remote = true;
    marked.push(`${label} ${binding.binding}`);
  }
}
// Browser Run is a single object rather than an array, and wrangler.dev.jsonc
// already marks it remote by hand (Quick Actions have no local simulation at
// all). Setting it here too makes the derived config self-sufficient, so the
// oracle twin derived from wrangler.jsonc gets it without a second edit.
if (config.browser && !config.browser.remote) {
  config.browser.remote = true;
  marked.push(`Browser ${config.browser.binding}`);
}

// Crons are stripped. A remote-bindings session is a debugging tool pointed at
// production data, and the last thing it should do is let a local tick fire the
// /around crawl or the Luma sync into the real KV and D1 it is now holding.
if (config.triggers) delete config.triggers.crons;

await mkdir(dirname(out), { recursive: true });
await writeFile(
  out,
  "// GENERATED by tools/gen-remote-config.mjs — do not edit, do not commit.\n" +
  `// Source: ${source}${withD1 ? " (--d1)" : ""}. Bindings below reach PRODUCTION resources.\n` +
  JSON.stringify(config, null, 2) + "\n",
);

console.log(`remote config: ${out.replace(ROOT + "/", "")}`);
console.log(`  from ${source}, ${marked.length} binding(s) remote: ${marked.join(", ")}`);
if (!withD1) console.log("  D1 stays LOCAL (pass --d1 to point it at production; read the header first)");
console.log("  crons stripped: a local tick must not run the real crawl");
