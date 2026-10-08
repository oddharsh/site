// ── the early bake writes only where it is told ─────────────────────────────
// build.ts starts tools/bake-worker-pages.ts right after step 5 and lets it run
// beside steps 1h to 4, collecting its pages at 5b. That is only safe while the
// bake writes into the private directory it is handed: step 1g4 skips a page
// that is not staged yet (/garage/dyno), so a page landing in public/ early
// would change what ships, and differently on a slow machine than a fast one.
// These read the source, because the hazard is an edit that adds one write.
import {
  assert,
  readFile,
  ROOT,
  test,
} from "./contract-shared.ts";

const bake = await readFile(new URL("tools/bake-worker-pages.ts", ROOT), "utf8");
const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");

test("every page the bake writes goes under PAGES, never straight into public/", () => {
  const writes = [...bake.matchAll(/\b(?:writeFile|mkdir|rename|cp|copyFile|Bun\.write)\s*\(([^,)]*)/g)].map((m) => m[1].trim());
  assert.ok(writes.length >= 15, `found ${writes.length} write calls; the scan stopped matching the file`);
  for (const target of writes) {
    assert.match(target, /^(?:`\$\{PAGES\}|resolve\(PAGES\b)/, `a write outside PAGES: ${target}`);
  }
  assert.match(bake, /const PAGES = process\.argv\[3\] \?\? `\$\{OUT\}\/public`;/);
});

test("the build hands the early bake a private directory and collects it at 5b", () => {
  const spawned = /spawn\(process\.execPath, \["tools\/bake-worker-pages\.ts", OUT, BAKED\]/;
  assert.match(build, spawned);
  assert.match(build, /const BAKED = `\$\{OUT\}\/baked`;/);
  // started after step 5 (its last input) and collected inside 5b
  const at = (s) => build.indexOf(s);
  assert.ok(at('phase("5 worker css");') < build.search(spawned), "the bake starts after step 5 minified the Worker CSS");
  assert.ok(build.search(spawned) < at('phase("1h feeds");'), "and before the steps it overlaps");
  const fiveB = build.slice(at('phase("5b rendered pages");'), at('phase("5c custom properties");'));
  assert.match(fiveB, /await bake;/);
  assert.match(fiveB, /rename\(from, `\$\{OUT\}\/public\/\$\{rel\}`\)/);
});
