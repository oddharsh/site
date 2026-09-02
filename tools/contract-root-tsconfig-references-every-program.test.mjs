// The root tsconfig.json exists for tsgolint alone (its header says why), and
// it works by naming every program in config/. A program added to config/ and
// not referenced here is linted against a default program with no includes,
// which is the blindness measured on 2026-09-02 (0 findings against 17),
// arriving one program at a time instead of all at once. So the references
// list is derived from the directory, and a new program joins by existing.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lib/jsonc.ts";

test("root tsconfig.json references every config/tsconfig.*.json program and holds no files of its own", async () => {
  const root = parseJsonc(await readFile(new URL("tsconfig.json", ROOT), "utf8"));
  assert.deepEqual(root.files, [], "the root program must hold nothing itself; it is a map, not a program");
  assert.equal(root.compilerOptions, undefined, "no compilerOptions: esbuild and bun read the nearest tsconfig.json too, and the Worker bundle was hashed byte-identical only because this carries none");
  const onDisk = readdirSync(fileURLToPath(new URL("config/", ROOT)))
    .filter((f) => /^tsconfig\..*\.json$|^tsconfig\.json$/.test(f)).map((f) => `config/${f}`).sort();
  const referenced = (root.references ?? []).map((r) => r.path).sort();
  assert.ok(onDisk.length >= 10, `expected 10+ programs in config/, found ${onDisk.length}: the glob is reading nothing`);
  assert.deepEqual(referenced, onDisk, "root tsconfig.json must reference exactly the programs in config/");
});
