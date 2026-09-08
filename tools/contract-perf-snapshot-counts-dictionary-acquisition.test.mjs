import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = new URL("./perf-snapshot.ts", import.meta.url);

const snapshot = (label, dictionaryBrotliBytes, bytes) => ({
  schema: 1,
  label,
  subject: label,
  worker: { gzipBytes: 1000, modules: {} },
  assets: {},
  pages: {},
  wire: {},
  dcz: { count: 55, bytes, dictionaryBrotliBytes },
});

test("the performance diff counts dictionary acquisition beside its deltas", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "perf-dictionary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, "base.json");
  const head = join(dir, "head.json");
  writeFileSync(base, JSON.stringify(snapshot("base", 14_925, 457_969)));
  writeFileSync(head, JSON.stringify(snapshot("head", 14_754, 457_959)));

  const output = execFileSync(process.execPath, [SCRIPT.pathname, "compare", base, head], { encoding: "utf8" });
  assert.match(output, /Family dictionary acquisition: 14\.58 KiB → 14\.41 KiB q11 \(-0\.17 KiB\)/);
  assert.match(output, /`pd\/`: 55 → 55 deltas, 447\.24 KiB → 447\.23 KiB \(-0\.01 KiB\)/);
});

test("the nightly row retains dictionary acquisition as its own series", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "perf-dictionary-row-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, "snapshot.json");
  writeFileSync(input, JSON.stringify(snapshot("abc1234", 14_754, 457_959)));

  const output = execFileSync(process.execPath, [SCRIPT.pathname, "row", input, "--date", "2026-09-01"], { encoding: "utf8" });
  const row = JSON.parse(output);
  assert.equal(row.dict_br, 14_754);
  assert.equal(row.assets_br, 0, "dictionary acquisition does not redefine the historical client-assets series");
});
