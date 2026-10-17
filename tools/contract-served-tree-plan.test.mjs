// The served URL root is composed from five authored directories. One module,
// tools/lib/served-tree.ts, plans that merge, and two adapters consume the
// plan: the build copies it into .build/public, local dev symlinks it into
// .dev-assets.
//
// These tests run the module and both adapters on a fixture tree. They replace
// a test that regexed cp() calls out of build.ts to hold dev's root list to the
// build's, which could only compare two spellings of a list and never ran
// either merge.
import assert from "node:assert/strict";
import test from "node:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTHORED_ROOTS,
  BROWSER_IMPORT_ROOTS,
  copyServedTree,
  DERIVED_PATHS,
  linkServedTree,
  planServedTree,
  SERVED_ROOTS,
  ServedTreeCollision,
  STAGED_ROOTS,
} from "./lib/served-tree.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

// A fixture laid out like the real tree in miniature: `assets` and `pages` share
// the root and `garage/`, `assets` alone owns `images/` and `i/`, and
// `assets/images/meta` plays a derived path.
const FIXTURE = {
  "assets/_headers": "headers",
  "assets/i/a.avif": "avif",
  "assets/images/hashes.json": "{}",
  "assets/garage/enc/sample.jpg": "jpg",
  "pages/index.html": "<!doctype html>home",
  "pages/garage/horizon.html": "<!doctype html>horizon",
  "client/nav.js": "nav",
};
const ROOTS = ["assets", "pages", "client"];
const DERIVED = ["assets/images/meta"];

async function fixture(extra = {}) {
  // realpath: macOS reaches $TMPDIR through the /var symlink (gotcha 45), and
  // the link assertions below compare resolved paths.
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "served-tree-")));
  for (const [file, body] of Object.entries({ ...FIXTURE, ...extra })) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), body);
  }
  return cwd;
}

// Every file reachable under `dir`, following symlinks, as served path -> bytes.
async function servedBytes(dir) {
  const out = {};
  const walk = async (rel) => {
    for (const name of await readdir(path.join(dir, rel))) {
      const child = rel ? `${rel}/${name}` : name;
      if ((await stat(path.join(dir, child))).isDirectory()) await walk(child);
      else out[child] = await readFile(path.join(dir, child), "utf8");
    }
  };
  await walk("");
  return out;
}

const isLink = async (file) => (await lstat(file)).isSymbolicLink();

test("one plan maps every served path to the one root that authors it", async () => {
  const cwd = await fixture();
  try {
    const plan = await planServedTree({ cwd, roots: ROOTS, derived: DERIVED });
    assert.deepEqual(Object.fromEntries(plan.files), {
      "_headers": "assets/_headers",
      "i/a.avif": "assets/i/a.avif",
      "images/hashes.json": "assets/images/hashes.json",
      "garage/enc/sample.jpg": "assets/garage/enc/sample.jpg",
      "index.html": "pages/index.html",
      "garage/horizon.html": "pages/garage/horizon.html",
      "nav.js": "client/nav.js",
    });
    assert.deepEqual(plan.directories.get(""), ROOTS, "every root provides the URL root");
    assert.deepEqual(plan.directories.get("garage"), ["assets", "pages"], "garage/ is shared by two roots");
    assert.deepEqual(plan.directories.get("garage/enc"), ["assets"]);
    assert.deepEqual(plan.skipped, [], "nothing derived exists in a clean fixture");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the copy adapter and the symlink adapter serve the same tree from one plan", async () => {
  const cwd = await fixture();
  try {
    const plan = await planServedTree({ cwd, roots: ROOTS, derived: DERIVED });
    const copied = await copyServedTree(plan, "out/public", { cwd });
    const linked = await linkServedTree(plan, "farm", { cwd });

    const expected = Object.fromEntries([...plan.files].map(([served, source]) => [served, FIXTURE[source]]));
    assert.deepEqual(await servedBytes(path.join(cwd, "out/public")), expected, "the build adapter copies exactly the plan");
    assert.deepEqual(await servedBytes(path.join(cwd, "farm")), expected, "the dev adapter links exactly the plan");
    assert.equal(copied.files, 7);

    // The copy is real bytes: nothing under it is a link back into the source.
    assert.equal(await isLink(path.join(cwd, "out/public/i")), false);
    assert.equal(await isLink(path.join(cwd, "out/public/index.html")), false);

    // The farm's SHAPE is the dev loop's contract. A directory one root owns is
    // one directory symlink, so a file created in it later needs no re-stage. A
    // directory several roots share is real, with one link per entry.
    assert.equal(await isLink(path.join(cwd, "farm")), false, "the URL root is shared, so it is a real directory");
    assert.equal(await isLink(path.join(cwd, "farm/garage")), false, "garage/ is shared, so it is a real directory");
    assert.equal(await isLink(path.join(cwd, "farm/i")), true, "a single-owner directory is ONE symlink");
    assert.equal(await isLink(path.join(cwd, "farm/images")), true);
    assert.equal(await isLink(path.join(cwd, "farm/garage/enc")), true, "single-owner again one level down");
    assert.equal(await isLink(path.join(cwd, "farm/garage/horizon.html")), true);
    assert.equal(await readlink(path.join(cwd, "farm/garage/enc")), "../../assets/garage/enc", "links are relative and name the authoring root");
    assert.equal(await readlink(path.join(cwd, "farm/nav.js")), "../client/nav.js");
    assert.deepEqual(linked, { links: 7, dirs: 2 }, "_headers, i, images, index.html, nav.js, garage/enc, garage/horizon.html across the root and garage/");

    // A file created later inside a single-owner directory is served with no
    // re-stage, which is what the whole-directory symlink buys.
    await writeFile(path.join(cwd, "assets/i/later.avif"), "later");
    assert.equal(await readFile(path.join(cwd, "farm/i/later.avif"), "utf8"), "later");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a served path two roots author is refused once, by the planner, with the path named", async () => {
  // CONTROL: the same fixture without the duplicate plans cleanly (first test).
  const cwd = await fixture({ "pages/_headers": "second owner", "client/garage": "a FILE where two roots have a directory" });
  try {
    const refused = await planServedTree({ cwd, roots: ROOTS, derived: DERIVED }).then(() => null, (error) => error);
    assert.ok(refused instanceof ServedTreeCollision, "the planner must refuse, and say which kind of refusal it is");
    assert.deepEqual(refused.paths.sort(), ["_headers", "garage"], "file against file, and file against directory");
    assert.match(refused.message, /served path _headers is authored by both assets and pages/);
    assert.match(refused.message, /served path garage is authored by both assets and pages and client/);

    // Refused BEFORE either adapter ran: there is no plan to hand them.
    assert.deepEqual((await readdir(cwd)).sort(), ["assets", "client", "pages"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a derived path is left out of BOTH adapters, even inside a single-owner directory", async () => {
  const leftovers = {
    "assets/images/meta/L1.json": "stale histogram",
    "assets/images/meta/deep/L2.json": "stale histogram",
  };
  const cwd = await fixture(leftovers);
  try {
    const plan = await planServedTree({ cwd, roots: ROOTS, derived: DERIVED });
    assert.deepEqual(plan.skipped, ["assets/images/meta"], "the plan reports what it left out on this machine");
    await copyServedTree(plan, "out", { cwd });
    await linkServedTree(plan, "farm", { cwd });

    for (const tree of ["out", "farm"]) {
      const served = await servedBytes(path.join(cwd, tree));
      assert.deepEqual(Object.keys(served).filter((file) => file.startsWith("images/")), ["images/hashes.json"],
        `${tree}: the leftover under images/meta must not be served`);
    }
    // images/ has one owner, and it still cannot be one symlink here: a link to
    // the whole directory would carry the leftover with it.
    assert.equal(await isLink(path.join(cwd, "farm/images")), false);
    assert.equal(await isLink(path.join(cwd, "farm/images/hashes.json")), true);
    assert.equal(await isLink(path.join(cwd, "farm/i")), true, "a directory with nothing to hide is still one symlink");

    // CONTROL: with no derived paths declared, the same leftovers ARE served by
    // both adapters, so the assertions above are the skip rule and nothing else.
    const open = await planServedTree({ cwd, roots: ROOTS, derived: [] });
    await copyServedTree(open, "out-open", { cwd });
    await linkServedTree(open, "farm-open", { cwd });
    for (const tree of ["out-open", "farm-open"]) {
      const served = await servedBytes(path.join(cwd, tree));
      assert.equal(served["images/meta/deep/L2.json"], "stale histogram", `${tree}: control`);
    }
    assert.equal(await isLink(path.join(cwd, "farm-open/images")), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a root that does not exist is refused by name rather than planned around", async () => {
  const cwd = await fixture();
  try {
    await assert.rejects(planServedTree({ cwd, roots: [...ROOTS, "www"], derived: DERIVED }), /root "www" does not exist/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the real tree plans cleanly, and every projection is a view of the one declaration", async () => {
  const plan = await planServedTree({ cwd: ROOT });
  assert.deepEqual(plan.roots, STAGED_ROOTS);
  assert.deepEqual(STAGED_ROOTS, SERVED_ROOTS.map((root) => root.dir));
  // Floors, since every failure here is an absence: 1344 files on 2026-10-02.
  assert.ok(plan.files.size > 900, `only ${plan.files.size} served files planned`);
  assert.ok(plan.directories.get("")?.length === STAGED_ROOTS.length, "every root contributes to the URL root");
  assert.ok((plan.directories.get("garage")?.length ?? 0) > 1, "garage/ is the canonical shared directory");
  assert.equal(plan.files.get("index.html"), "src/pages/index.html");
  assert.equal(plan.files.get("nav.js"), "src/client/nav.js");
  assert.equal(plan.files.get("luna.css"), "src/styles/luna.css");
  assert.equal(plan.files.get("_headers"), "public/_headers");

  for (const root of [...AUTHORED_ROOTS, ...BROWSER_IMPORT_ROOTS]) {
    assert.ok(STAGED_ROOTS.includes(root), `${root} is projected from the declaration, so it must be staged`);
  }
  for (const source of DERIVED_PATHS) {
    assert.ok(STAGED_ROOTS.some((root) => source.startsWith(`${root}/`)), `${source} must sit under a staged root`);
  }
});

// config/tsconfig.browser.json maps `/*` across the roots an absolute browser
// import can resolve in. JSON cannot import the declaration, so this holds it.
test("tsconfig.browser.json resolves absolute imports across the plan's browser roots", async () => {
  const { parseJsonc } = await import("./lib/jsonc.ts");
  const mapped = (source) => parseJsonc(source).compilerOptions.paths["/*"]
    .map((entry) => entry.replace(/^\.\.\//, "").replace(/\/\*$/, ""))
    .sort();
  const source = await readFile(path.join(ROOT, "config/tsconfig.browser.json"), "utf8");
  assert.deepEqual(mapped(source), [...BROWSER_IMPORT_ROOTS].sort(),
    "tsconfig.browser.json's `/*` paths must be exactly served-tree.ts's BROWSER_IMPORT_ROOTS");

  // CONTROL: a config that lost one root is told apart.
  const narrowed = source.replace(`"../src/styles/*", `, "");
  assert.notEqual(narrowed, source, "the control must actually edit the config");
  assert.notDeepEqual(mapped(narrowed), [...BROWSER_IMPORT_ROOTS].sort());
});

// The behavioural tests above prove the module. This one stops a consumer from
// growing a second definition beside it, which is the shape this replaced.
test("neither consumer restates the roots or the skip list", async () => {
  const build = await readFile(path.join(ROOT, "tools/build.ts"), "utf8");
  const dev = await readFile(path.join(ROOT, "tools/dev-stage.ts"), "utf8");
  assert.match(build, /copyServedTree\(servedPlan, `\$\{OUT\}\/public`\)/, "build.ts step 1 must copy the plan");
  assert.doesNotMatch(build, /\bcp\("[^"]+",\s*`\$\{OUT\}\/public`/, "build.ts must not copy a root into the served tree by hand");
  assert.match(dev, /linkServedTree\(plan, FARM\)/, "dev-stage.ts must link the plan");
  for (const [name, source] of [["build.ts", build], ["dev-stage.ts", dev]]) {
    for (const derived of DERIVED_PATHS) {
      assert.ok(!source.includes(`"${derived}"`), `${name} must not carry its own copy of the derived path ${derived}`);
    }
    assert.doesNotMatch(source, /\[\s*"public",\s*"src\/pages"/, `${name} must not carry its own root list`);
  }
});
