// Step 5e gives class names short names across the staged tree, and a short
// name inside a content-hashed shell file is part of that file's /a/ URL, so a
// page edit that moved one would re-mint every page (gotcha 35's cost, which
// the custom property tiers already pay to avoid).
//
// Two page edits can reach a shell name here. A page can use a shell class
// more, and a page's prose can reserve a word (a tainted script mentions it),
// which takes that name out of the rename. planClassNames ranks shell names by
// their positions inside the shell alone, and a name that drops out leaves its
// slot empty instead of letting the names below it move up. This file pins
// both, plus the control that shows the fixture can fail.
import { assert, test } from "./contract-shared.ts";
import { censusClasses } from "spokeshave/classes";
import { planClassNames, planRename, proveRename, renameClasses, shortClassName } from "../lib/class-names.ts";

const SHELL = new Set(["public/luna.css"]);
const luna = ".frame{}.frame .title-bar{}.frame .status-bar{}.title-bar{}.title-bar .controls{}.title-bar .controls{}.controls{}";
const tree = (page: string, script = "") => {
  const files = new Map([
    ["public/luna.css", luna],
    ["public/index.html", page],
  ]);
  if (script) files.set("public/page.js", script);
  return files;
};
const plan = (files: Map<string, string>) => planClassNames(censusClasses(files, { publicDir: "public" }), SHELL);
const shellNames = (m: Map<string, string>) => ["controls", "title-bar", "frame", "status-bar"].map((n) => `${n}=${m.get(n)}`).join(" ");

test("the shell's short names are ranked by the shell's own uses", () => {
  const m = plan(tree('<div class="frame"><div class="title-bar"></div></div>'));
  // title-bar x4, then controls and frame x3 (a tie goes by name), status-bar x1.
  assert.equal(shellNames(m), "controls=b title-bar=a frame=c status-bar=d");
});

test("a page that uses a shell class more moves no shell name", () => {
  const quiet = plan(tree('<div class="frame"></div>'));
  const loud = plan(tree('<div class="status-bar"></div>'.repeat(40)));
  assert.equal(shellNames(loud), shellNames(quiet));
});

test("a page that reserves one shell name leaves the others where they were", () => {
  const before = plan(tree('<div class="frame"></div>'));
  // An untraced sink taints page.js, and its prose then reserves "title-bar".
  const after = plan(tree('<div class="frame"></div>', 'export const set = (el, v) => { el.className = v; }; const note = "title-bar";'));
  assert.equal(after.has("title-bar"), false);
  assert.equal(shellNames(after), "controls=b title-bar=undefined frame=c status-bar=d");
  assert.equal(before.get("frame"), after.get("frame"));
  // The control: ranking only the names still renameable would have moved
  // frame and status-bar up into the empty slot.
  const renameable = ["controls", "frame", "status-bar"];
  assert.deepEqual(
    renameable.map((_, i) => shortClassName(i)),
    ["a", "b", "c"],
  );
  assert.notEqual(after.get("frame"), shortClassName(renameable.indexOf("frame")));
});

test("the step rewrites every file and proves it", () => {
  const { map, after } = renameClasses(tree('<div class="frame"><p class=controls></p></div>'), SHELL, 4);
  assert.equal(map.size, 4);
  assert.equal(after.get("public/index.html"), '<div class="c"><p class=b></p></div>');
  assert.equal(after.get("public/luna.css"), ".c{}.c .a{}.c .d{}.a{}.a .b{}.a .b{}.b{}");
});

// A worker that registers its handler late drops the job and never answers
// (gotcha 115), which this reads as a timeout on the first call.
test("the proof on its worker thread passes a clean rename and fails one that missed a file", async () => {
  const planned = planRename(tree('<div class="frame"><p class=controls></p></div>'), SHELL);
  await proveRename(planned, 4);
  // The stylesheet's rewrite is lost, as a census blind spot would leave it.
  const missed = { ...planned, after: new Map(planned.after).set("public/luna.css", luna) };
  await assert.rejects(proveRename(missed, 4), /the rename changed more than names/);
});
