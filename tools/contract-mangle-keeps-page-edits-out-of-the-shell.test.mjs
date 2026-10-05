// Step 5c gives every custom property a short name, and a short name inside a
// content-hashed shell file is part of that file's /a/ URL. Until 2026-09-24
// one site-wide ranking decided every name, so ONE more `var(--sh)` in
// /pixel-peeper's inline CSS made the page-local `--sh` (25 uses) outrank
// luna.css's `--blue-65` (23), the two swapped letters inside luna.css, and
// luna.5e0c7979.css became luna.5b20cdaa.css: 311 staged files, every page and
// every page dictionary, for a one-line edit to one page (gotcha 35's cost).
//
// planNames now takes the shell set. A name the shell DEFINES is ranked by the
// shell's own uses; everything else is placed by a hash of its name. This file
// pins both halves on a fixture shaped like that incident, plus the control
// that shows the fixture could fail: the old single ranking, on the same edit,
// does move the shell.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { applyMangle, assertIntegrity, planNames } from "./lib/mangle-custom-properties.ts";
import { CLIENT_ASSETS, contentHashedFiles, shellRankedFiles } from "./lib/client-assets.ts";

const SHELL = new Set(["public/luna.css"]);

// Shell: --blue-65 is its most-used token (7 site-wide against --sh's 5), so
// it earns the shortest name, and the edits below push --sh past it.
const luna = [
  ":root{--blue-65:#3169c6;--face:#ece9d8;--ink:#000}",
  ".a{color:var(--blue-65)}.b{border-color:var(--blue-65)}.c{outline-color:var(--blue-65)}",
  ".f{fill:var(--blue-65)}.g{stroke:var(--blue-65)}.h{caret-color:var(--blue-65)}",
  ".d{background:var(--face)}.e{color:var(--ink)}",
].join("");

// A page with its own local token, used more than anything in the shell.
const pageWith = (extra) =>
  [
    "<style>:root{--sh:#aca899}",
    ".x{border:1px solid var(--sh)}.y{outline:1px solid var(--sh)}.z{box-shadow:0 0 0 1px var(--sh)}",
    ".w{border-top:1px solid var(--sh)}.v{color:var(--blue-65)}",
    extra,
    "</style>",
  ].join("");

// A second page that shares the local name, the way /access and /pixel-peeper
// both define their own `--sh`.
const other = "<style>:root{--sh:#aca899;--sc:#fff}.q{border:1px solid var(--sh);color:var(--sc)}</style>";

const tree = (extra) =>
  new Map([
    ["public/luna.css", luna],
    ["public/pixel-peeper/index.html", pageWith(extra)],
    ["public/access/index.html", other],
  ]);

const render = (files, shell) => {
  const map = planNames(files, shell);
  return { map, out: new Map([...files].map(([f, t]) => [f, applyMangle(t, map)])) };
};

const EDITS = {
  "one more var() use of the page-local name": ".u{border-left:1px solid var(--sh)}".repeat(6),
  "a CSS comment that mentions the page-local name": "/* borrows var(--sh) var(--sh) var(--sh) var(--sh) var(--sh) var(--sh) */",
  "more page uses of a SHELL token": ".t{color:var(--face)}".repeat(9),
};

for (const [label, extra] of Object.entries(EDITS)) {
  test(`${label} leaves the shell stylesheet byte-identical`, () => {
    const before = render(tree(""), SHELL);
    const after = render(tree(extra), SHELL);
    assert.equal(after.out.get("public/luna.css"), before.out.get("public/luna.css"), "the /a/ bytes, and so the /a/ URL, must not move");
    assert.equal(
      after.out.get("public/access/index.html"),
      before.out.get("public/access/index.html"),
      "a page sharing the local name is untouched too",
    );
  });
}

test("CONTROL: the old site-wide ranking DOES move the shell on the same edit", () => {
  // Without a shell set every file counts, which is the pre-2026-09-24 plan.
  // If this ever passes identical, the fixture stopped exercising the bug.
  const before = render(tree(""));
  const after = render(tree(EDITS["one more var() use of the page-local name"]));
  assert.notEqual(after.out.get("public/luna.css"), before.out.get("public/luna.css"));
});

test("the shell's most-used token gets the shortest name, ranked by the shell alone", () => {
  const { map } = render(tree(EDITS["more page uses of a SHELL token"]), SHELL);
  assert.equal(map.get("--blue-65"), "--a", "page uses of --face must not promote it over --blue-65");
});

test("page-local names come from the two-character tier and never shadow a shell name", () => {
  const { map } = render(tree(""), SHELL);
  const shellNames = new Set(["--blue-65", "--face", "--ink"].map((n) => map.get(n)));
  for (const local of ["--sh", "--sc"]) {
    const short = map.get(local);
    // `--sh` is already four characters, so the two-character tier cannot beat it.
    if (short) {
      assert.equal(short.length, 4, `${local} -> ${short}`);
      assert.ok(!shellNames.has(short), `${local} took a shell name`);
    }
  }
  const longLocal = planNames(new Map([["public/luna.css", luna], ["p.html", "<style>:root{--local-accent:red}.k{color:var(--local-accent)}</style>"]]), SHELL);
  assert.equal(longLocal.get("--local-accent")?.length, 4, "a long page-local name is placed in the two-character tier");
});

test("the rename still passes the dangling-reference invariant", () => {
  const files = tree(".r{color:var(--never-defined)}");
  const { map, out } = render(files, SHELL);
  assert.doesNotThrow(() => assertIntegrity(files, out, map, 3));
});

// The page-scoped hashed files (ask.js, the pretext library, dotfiles.js, the
// pixel-peeper manifest) are content-hashed and still ranked as PAGES: ask.js
// reads three --font-* tokens, and in the shell set its edits would reorder
// luna.css's names. "more page uses of a SHELL token" above is that case, so
// what is left to pin is that 5c actually hands them over on the page side.
//
// The shell set and the set step 6 hashes are two projections of ONE registry
// (tools/lib/client-assets.ts), so they cannot disagree and the drift throw
// build.ts carried between its three lists is gone with the lists.
test("step 5c plans with the registry's shell tier, which is every hashed file minus the page-scoped ones", () => {
  const build = readFileSync(new URL("./build.ts", import.meta.url), "utf8");
  assert.ok(build.includes("planNames(before, SHELL_RANKED)"), "5c must plan with the shell part of the content-hashed set");
  assert.ok(build.includes("const SHELL_RANKED = shellRankedFiles();"), "and that set must come from the registry step 6 hashes from");
  assert.ok(build.includes("await hashClientAssets(OUT,"), "step 6 must hash from the same registry");

  const shell = shellRankedFiles();
  const hashed = contentHashedFiles();
  const pageScoped = ["serendipity.js", "lwe/ask.js", "garage/pretext.lib.js", "dotfiles.js", "pixel-peeper/manifest.json", "quiz.css", "prose.css"].map((f) => `public/${f}`);
  assert.deepEqual([...hashed].filter((f) => !shell.has(f)).sort(), pageScoped.sort(), "exactly these seven are hashed and ranked as pages");
  assert.ok([...shell].every((f) => hashed.has(f)), "the shell tier is a subset of what step 6 hashes");
  assert.ok(shell.has("public/luna.css") && shell.has("public/nav.js"), "the two files every page links are shell");
  assert.equal(hashed.size, CLIENT_ASSETS.length, "every registered asset is hashed");
});

test("CONTROL: an asset declared shell-scoped joins the shell tier, so the scope field is what decides it", () => {
  const moved = CLIENT_ASSETS.map((a) => (a.file === "lwe/ask.js" ? { ...a, scope: /** @type {const} */ ("shell") } : a));
  assert.ok(shellRankedFiles(moved).has("public/lwe/ask.js"));
  assert.ok(!shellRankedFiles().has("public/lwe/ask.js"));
});
