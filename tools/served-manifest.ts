// Cut the served manifest from a staged tree: `bun run served:manifest`.

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
if (count < 1000) {
  console.error(`served-manifest: only ${count} URLs under ${values.root} (expected 1000+); is that a built tree?`);
  process.exit(2);
}
writeFileSync(values.out, serializeManifest(manifest));
console.log(`served-manifest: ${count} URLs from ${values.root}${commit ? ` at ${commit.slice(0, 12)}` : ""} -> ${values.out}`);
