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

// The browser's half. nav.ts is the one script every page runs, and the first
// Intl object in a document loads ICU data there too: the taskbar clock's
// Intl.DateTimeFormat was 8 to 17 ms of every page load in Chrome on a
// workstation and 30 to 53 ms under 4x CPU throttle, the largest script cost
// on a median page (2026-11-10). The islands nav.ts imports on demand
// (nav-run, infotip, nav-tips) may use Intl; they run after a click or hover.
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the shell script every page runs touches no Intl API", () => {
  const INTL = /\bIntl\.|\.toLocale\w*String\(/;
  assert.match(code('// prose about Intl.DateTimeFormat\nvar f = new Intl.DateTimeFormat("en-US");'), INTL, "the scan must see Intl in code");
  assert.doesNotMatch(code("// prose about Intl.DateTimeFormat\nvar f = 1;"), INTL, "and must not read it out of a comment");
  assert.doesNotMatch(
    code(readFileSync(new URL("src/client/nav.ts", ROOT), "utf8")),
    INTL,
    "format by hand in nav.ts, or move the work into an island that loads on demand",
  );
});
