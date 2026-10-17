// Cut the served manifest from a staged tree: `bun run served:manifest`.
//
//   bun run served:manifest -- --commit <sha> --out served-manifest.json
//
// CI runs it on every push to main, against the `.build/public` its wrangler
// dry-run just staged, and signs the output. tools/lib/served-manifest.ts says
// what the manifest covers and what it cannot.

import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { buildManifest, serializeManifest } from "./lib/served-manifest.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: ".build/public" },
    commit: { type: "string" },
    out: { type: "string", default: "served-manifest.json" },
  },
});

const commit = values.commit?.trim().toLowerCase() || null;
if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`served-manifest: --commit ${JSON.stringify(values.commit)} is not a 40-hex commit`);
  process.exit(2);
}

const manifest = buildManifest(values.root, commit);
const count = Object.keys(manifest.files).length;
// The floor, since every failure here is an absence: 1850 URLs on 2026-10-01. A
// walk pointed at the wrong root, or an ignore rule that swallowed a directory,
// reads as a smaller site and would verify perfectly.
if (count < 1000) {
  console.error(`served-manifest: only ${count} URLs under ${values.root} (expected 1000+); is that a built tree?`);
  process.exit(2);
}
writeFileSync(values.out, serializeManifest(manifest));
console.log(`served-manifest: ${count} URLs from ${values.root}${commit ? ` at ${commit.slice(0, 12)}` : ""} -> ${values.out}`);
