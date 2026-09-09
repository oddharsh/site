// Rust owns the component template and field/default contract. This entrypoint
// only writes its generated TypeScript projection, or checks it without writes.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = fileURLToPath(new URL("./xp/Cargo.toml", import.meta.url));
const output = new URL("../src/worker/lib/xp/window.ts", import.meta.url);
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("usage: bun tools/gen-xp.ts [--check]");
}
const generated = execFileSync("cargo", ["run", "--quiet", "--release", "--locked", "--manifest-path", manifest, "--", "typescript"], {
  cwd: root, encoding: "utf8", timeout: 120_000,
});
if (args[0] === "--check") {
  if (readFileSync(output, "utf8") !== generated) throw new Error("XP Window projection is stale; run bun tools/gen-xp.ts");
} else {
  writeFileSync(output, generated);
}
