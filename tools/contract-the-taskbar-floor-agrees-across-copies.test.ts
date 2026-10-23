// ── the taskbar floor agrees across luna.css and its two inline copies ──────
// Split-file convention: shared imports live in contract-shared.ts.
import { readFileSync } from "node:fs";
import { assert, ROOT, test } from "./contract-shared.ts";
import { taskbarFloors } from "./lib/taskbar-floor.ts";

// Build step 5 compares the body floor in the three documents that set it
// (luna.css, the homepage, cal's templates). It went blind once: #1369 spelled
// luna's floor through a --taskbar-h token, the regex wanted a literal px, and
// every build warned "no taskbar-floor calc found" while comparing nothing
// (gotcha 80). These tests hold the parser to the spellings the tree uses, and
// each control is a mistake the build must now refuse.

const COPIES = ["src/styles/luna.css", "src/pages/index.html", "cal/src/templates.ts"];
const read = (path: string) => readFileSync(new URL(path, ROOT), "utf8");
const floorOf = (css: string) => taskbarFloors(css);

test("every copy sets exactly one floor, and all three agree", () => {
  const found = COPIES.map((f) => [f, taskbarFloors(read(f))] as const);
  for (const [f, floors] of found) assert.equal(floors.length, 1, `${f} should set one body floor, found ${JSON.stringify(floors)}`);
  const distinct = new Set(found.flatMap(([, floors]) => floors));
  assert.equal(distinct.size, 1, `the copies disagree: ${JSON.stringify(found)}`);
});

test("the token spelling and the written-out spelling reduce to the same floor", () => {
  const token = floorOf(`html{--sa-b:env(safe-area-inset-bottom,0px);--taskbar-h:calc(30px + var(--sa-b))}
    body{height:calc(100dvh - var(--taskbar-h))}`);
  const spelled = floorOf("body { height: calc(100dvh - 30px - env(safe-area-inset-bottom, 0px)); }");
  const nested = floorOf("body{height:calc(100dvh - (calc(28px + 2px) + env(safe-area-inset-bottom, 0px)))}");
  assert.equal(token.length, 1);
  assert.deepEqual(spelled, token);
  assert.deepEqual(nested, token);
});

test("control: a different bar height or a dropped inset disagrees", () => {
  const base = floorOf("body{height:calc(100dvh - 30px - env(safe-area-inset-bottom,0px))}");
  assert.notDeepEqual(floorOf("body{height:calc(100dvh - 28px - env(safe-area-inset-bottom,0px))}"), base);
  assert.notDeepEqual(floorOf("body{height:calc(100dvh - 30px)}"), base);
  assert.notDeepEqual(floorOf("html{--taskbar-h:calc(32px + env(safe-area-inset-bottom,0px))} body{height:calc(100dvh - var(--taskbar-h))}"), base);
});

test("control: a document with no body floor yields nothing, so the build refuses it", () => {
  assert.deepEqual(floorOf("body{min-height:calc(100dvh - 30px)} .window{max-height:calc(100dvh - 30px)}"), []);
  assert.deepEqual(floorOf("body{height:calc(100svh - 30px)}"), []);
  assert.deepEqual(floorOf("/* body{height:calc(100dvh - 30px)} */"), []);
  // An unresolvable token keeps its var(), which can never match a resolved copy.
  assert.deepEqual(floorOf("body{height:calc(100dvh - var(--taskbar-h))}"), ["100dvh - var(--taskbar-h)"]);
});

test("build step 5 fails, rather than warns, on a missing or disagreeing floor", () => {
  const build = read("tools/build.ts");
  assert.match(build, /import \{ taskbarFloors \} from "\.\/lib\/taskbar-floor\.ts"/);
  assert.match(build, /if \(!found\.length\)\s*hard\.push\(\s*`\$\{f\}: no taskbar-floor calc found/);
  assert.match(build, /if \(floorVals\.size > 1\)\s*hard\.push\(\s*`taskbar-floor disagrees/);
  for (const f of COPIES) assert.ok(build.includes(`"${f}"`), `build step 5 no longer lists ${f}`);
});
