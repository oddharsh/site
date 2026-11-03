// ── no Intl object is built at module scope (gotcha 92) ─────────────────────
// Constructing an Intl formatter or segmenter loads ICU data, and at module
// scope that cost lands on every isolate's startup instead of the request that
// needs it. guestbook.ts's `new Intl.Segmenter()` was 18.7 ms of a 58 ms node
// startup of the bundle (2026-11-03). This imports every Worker module in a
// fresh bun process, so no earlier test's import hides one, with each Intl
// constructor counting what it builds.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { assert, ROOT, test } from "./contract-shared.ts";
import { repoFiles } from "../lib/repo-files.ts";

const bun = process.versions.bun ? process.execPath : "bun";
const CLOUDFLARE_WORKERS = /^import[^;]*from\s*["']cloudflare:workers["']/m;

const probe = (files: string[]) => `
const made = [];
for (const name of ["Segmenter", "DateTimeFormat", "Collator", "NumberFormat", "PluralRules", "ListFormat", "RelativeTimeFormat", "DisplayNames"]) {
  const Real = Intl[name];
  Intl[name] = class extends Real {
    constructor(...args) {
      super(...args);
      made.push("Intl." + name + " " + (new Error().stack.split("\\n")[2] || "").trim());
    }
  };
}
new Intl.Segmenter();
const control = made.splice(0).length;
const failed = [];
for (const file of ${JSON.stringify(files)}) {
  try {
    await import(${JSON.stringify(ROOT)} + file);
  } catch (error) {
    if (!/cloudflare:workers/.test(String(error))) failed.push(file + ": " + String(error).slice(0, 160));
  }
}
console.log(JSON.stringify({ control, failed, made }));
`;

test("importing every Worker module builds no Intl object", () => {
  const files = repoFiles(["src/worker", "serendipity", "cal/src"]).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !CLOUDFLARE_WORKERS.test(readFileSync(new URL(f, ROOT), "utf8")),
  );
  assert.ok(files.length > 100, `only ${files.length} modules to import; the census lost the Worker`);
  const run = spawnSync(bun, ["-e", probe(files)], { cwd: new URL(".", ROOT), encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const { control, failed, made } = JSON.parse(run.stdout.trim().split("\n").pop() ?? "{}");
  assert.equal(control, 1, "the counters did not see a construction made in front of them, so an empty list below proves nothing");
  assert.deepEqual(failed, [], "a module that cannot be imported here is a module this test cannot check");
  assert.deepEqual(made, [], "build it on first use instead (`x ??= new Intl.…()`), as tui.ts and reading.ts do");
});
