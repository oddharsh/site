// ── the TOML reader reads the repository's TOML and refuses the rest ────────
// tools/lib/toml.ts replaced smol-toml on 2026-10-08, after its output
// deep-equalled smol-toml 1.9.0's on every TOML file in the tree. With
// smol-toml gone there is no oracle left to compare against, so these pin
// each construct the reader claims, with exact values, and each one it
// refuses. A refusal matters as much as a read: a date or a multi-line string
// it skipped silently would be a wrong value in the dependency audit.
import { readdirSync, readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";

const { parse } = await import("./lib/toml.ts");

test("every construct it claims, with exact values", () => {
  const doc = parse(`
# a comment
title = "a \\"quoted\\" \\u00e9 \\t tab" # trailing comment
literal = 'C:\\no\\escapes'
"quoted key" = 1
dotted.inner = true
hex = 0xff
oct = 0o17
bin = 0b101
under = 1_000_000
big = 9007199254740993
float = -3.5e2
pinf = inf
nan = nan
list = [
  1, # inside an array
  [2, "three"],
  { a = 1, b.c = "d" },
]

[table.sub]
x = false

[[many]]
n = 1

[[many]]
n = 2
`);
  assert.equal(doc.title, 'a "quoted" é \t tab');
  assert.equal(doc.literal, "C:\\no\\escapes");
  assert.equal(doc["quoted key"], 1);
  assert.deepEqual(doc.dotted, { inner: true });
  assert.deepEqual([doc.hex, doc.oct, doc.bin, doc.under], [255, 15, 5, 1000000]);
  assert.equal(doc.big, 9007199254740993n, "an integer past 2^53 stays exact, as a BigInt");
  assert.equal(doc.float, -350);
  assert.equal(doc.pinf, Infinity);
  assert.ok(Number.isNaN(doc.nan));
  assert.deepEqual(doc.list, [1, [2, "three"], { a: 1, b: { c: "d" } }]);
  assert.deepEqual(doc.table, { sub: { x: false } });
  assert.deepEqual(doc.many, [{ n: 1 }, { n: 2 }]);
});

test("what it doesn't read throws, naming the line", () => {
  const refuse = {
    "a date": "d = 1979-05-27",
    "a time": "t = 07:32:00",
    "a multi-line basic string": 's = """\nx\n"""',
    "a multi-line literal string": "s = '''\nx\n'''",
    "a key set twice": "a = 1\nb = 2\na = 3",
    "an unknown escape": 'a = "\\q"',
    "an unclosed array": "a = [1, 2",
    "a value after a value": "a = 1 2",
  };
  for (const [what, src] of Object.entries(refuse)) {
    assert.throws(() => parse(src), /^Error: toml: .+ at line \d+$/, what);
  }
  assert.throws(() => parse("a = 1\nb = 2\na = 3"), /duplicate key a at line 3/);
});

test("every TOML file in the tree parses, and the two the tools read have their shape", () => {
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const rel = `${dir}${e.name}`;
      if (e.isDirectory()) walk(`${rel}/`);
      else if (e.name.endsWith(".toml")) files.push(rel);
    }
  };
  walk("");
  assert.ok(files.length >= 8, `found ${files.length} TOML files; the walk stopped reaching the tree`);
  for (const f of files) assert.doesNotThrow(() => parse(readFileSync(new URL(f, ROOT), "utf8")), f);

  const cargo = parse(readFileSync(new URL("tools/photos/zenc/Cargo.toml", ROOT), "utf8"));
  assert.ok(Object.keys(cargo.dependencies ?? {}).length > 0, "zenc's Cargo.toml has a dependencies table");
  const osv = parse(readFileSync(new URL("osv-scanner.toml", ROOT), "utf8"));
  const ignored = /** @type {Record<string, unknown>[]} */ (Array.isArray(osv.IgnoredVulns) ? osv.IgnoredVulns : []);
  assert.ok(ignored.length > 0 && ignored.every((v) => String(v.id).startsWith("GHSA-")), "osv-scanner.toml's IgnoredVulns is an array of tables with advisory ids");
});
