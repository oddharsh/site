// The root tsconfig.json maps every program for the checker and the type-aware lint. A program added to config/ and
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

// Node type-strips these files directly (routes:check, cpu-sweep, test:node), and strip mode rejects enums,
// namespaces and parameter properties that Bun transpiles without complaint. A program without the flag lets
// one through that only Node's path would trip on. Measured 2026-10-17: forcing it on added 0 diagnostics to
// every program that lacked it.
const sets = (program: { compilerOptions?: { erasableSyntaxOnly?: boolean; strict?: boolean } }) => program.compilerOptions?.erasableSyntaxOnly === true;

test("every config/tsconfig.*.json program sets erasableSyntaxOnly", async () => {
  const dir = fileURLToPath(new URL("config/", ROOT));
  const programs = readdirSync(dir).filter((f) => /^tsconfig\..*\.json$|^tsconfig\.json$/.test(f));
  assert.ok(programs.length >= 10, `expected 10+ programs in config/, found ${programs.length}: the glob is reading nothing`);
  const missing: string[] = [];
  for (const f of programs) {
    if (!sets(parseJsonc(await readFile(new URL(`config/${f}`, ROOT), "utf8")))) missing.push(f);
  }
  assert.deepEqual(missing, [], "these programs would accept an enum or namespace that Node's type stripping rejects");
});

test("the erasableSyntaxOnly check can fail (control)", () => {
  assert.equal(sets({ compilerOptions: { strict: false } }), false, "a program without the flag must read as missing");
  assert.equal(sets({ compilerOptions: { erasableSyntaxOnly: false } }), false, "an explicit false must read as missing");
  assert.equal(sets({}), false, "a program with no compilerOptions must read as missing");
  assert.equal(sets({ compilerOptions: { erasableSyntaxOnly: true } }), true);
});
