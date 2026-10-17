// ── no Worker module imports another lazily ──────────────────────────────────
// Split-file convention: shared imports live in contract-shared.ts.
import { execFileSync } from "node:child_process";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// Gotcha 56. A module reached through `import()` runs its top level inside the
// request while wrangler inlines it, and in global scope the moment workerd
// loads it as its own module, where random values and timers throw. Nothing in
// a Worker lazy-loads today, so the cheap way to keep the trap shut is to fail
// the first one. If a lazy import earns its place (the 2026-07-28 measurement
// found it saved nothing), delete this test in the same change and keep that
// module's top level to definitions, as the gotcha says.

const WORKER_SOURCES = [
  "src/worker/**.ts", "serendipity/**.ts", "cal/src/**.ts", "counter/src/**.ts",
  "cf-garage/src/**.ts", "lwe-ask/src/**.ts", "lens-reader/src/**.ts",
];

/** Lines that call `import()`, skipping comments and `typeof import()` types. */
function lazyImports(text) {
  return text.split("\n").flatMap((line, i) => {
    const code = line.trimStart();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return [];
    return /(?<![\w.$])import\s*\(/.test(code.replace(/typeof\s+import\s*\(/g, "")) ? [i + 1] : [];
  });
}

test("the lazy-import matcher finds a lazy import and nothing else", () => {
  assert.deepEqual(lazyImports(`const m = await import("./x.ts");`), [1]);
  assert.deepEqual(lazyImports(`a;\nconst load = () => import ("./y.ts");`), [2]);
  assert.deepEqual(lazyImports(`// await import("./x.ts")\n * import("./x.ts").Thing`), []);
  assert.deepEqual(lazyImports(`type T = typeof import("./x.ts");`), []);
  assert.deepEqual(lazyImports(`import { a } from "./x.ts";\nreimport(1);`), []);
});

test("no Worker module imports another lazily", async () => {
  const files = execFileSync("git", ["ls-files", ...WORKER_SOURCES], {
    cwd: new URL(".", ROOT), encoding: "utf8",
  }).split("\n").filter(Boolean);
  // 127 on 2026-10-14; a glob that stopped matching would pass over nothing.
  assert.ok(files.length >= 80, `only ${files.length} Worker sources found; the globs have stopped matching`);

  const found: any[] = [];
  for (const file of files) {
    for (const line of lazyImports(await readFile(new URL(file, ROOT), "utf8"))) found.push(`${file}:${line}`);
  }
  assert.deepEqual(found, [],
    "lazy import() in a Worker (gotcha 56): import it statically, or keep that module's top level to definitions and delete this test");
});
