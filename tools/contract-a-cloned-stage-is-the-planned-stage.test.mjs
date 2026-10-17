// ── a cloned stage is the planned stage ─────────────────────────────────────
// Build step 1 stages public/ with one clonefile(2) on macOS under bun
// (tools/lib/clone-tree.ts) and file by file everywhere else. The clone takes
// the whole directory, so it is trimmed to the plan and checked against it,
// falling back to the copy on any mismatch. These pin that the two paths stage
// the same tree, that a link forces the fallback, and that a staged file is a
// copy: the build rewrites staged files in place, and a write that reached the
// source would edit the repository.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assert,
  test,
} from "./contract-shared.ts";

const { copyServedTree, planServedTree } = await import("./lib/served-tree.ts");

// two roots and a derived path, the shape of public/ + src/pages
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "stage-"));
  const put = (rel, body) => { mkdirSync(join(cwd, rel, ".."), { recursive: true }); writeFileSync(join(cwd, rel), body); };
  put("pub/index.css", "a{}");
  put("pub/i/one.avif", Buffer.from([0, 1, 2, 3]));
  put("pub/images/meta/stale.json", "{\"stale\":true}");
  put("pub/.well-known/x.json", "{}");
  put("pages/garage/a.html", "<p>a</p>");
  return cwd;
}
const roots = ["pub", "pages"];
// where the clone path exists at all; elsewhere every stage is the copy
const canClone = process.platform === "darwin" && Boolean(process.versions.bun);
const derived = ["pub/images/meta"];

// every file under dir, with its bytes and whether it is a link
function tree(dir) {
  const out = {};
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const st = lstatSync(join(dir, rel));
    if (st.isDirectory()) continue;
    out[rel.split("\\").join("/")] = { link: st.isSymbolicLink(), bytes: readFileSync(join(dir, rel)).toString("base64") };
  }
  return out;
}

async function stage(cwd, dest, clone) {
  const before = process.env.BUILD_CLONE;
  if (clone) delete process.env.BUILD_CLONE; else process.env.BUILD_CLONE = "0";
  let cloned;
  try {
    const plan = await planServedTree({ cwd, roots, derived });
    ({ cloned } = await copyServedTree(plan, dest, { cwd }));
  } finally {
    if (before === undefined) delete process.env.BUILD_CLONE; else process.env.BUILD_CLONE = before;
  }
  return { files: tree(join(cwd, dest)), cloned };
}

test("cloning and copying stage the same planned tree", async () => {
  const cwd = fixture();
  try {
    const copied = await stage(cwd, "out-copy", false);
    const cloned = await stage(cwd, "out-clone", true);
    assert.equal(copied.cloned, null, "BUILD_CLONE=0 copies");
    // the clone path really ran; a fallback would pass every comparison below
    assert.equal(cloned.cloned, canClone ? "pub" : null);
    assert.deepEqual(cloned.files, copied.files);
    assert.deepEqual(Object.keys(copied.files).sort(), [".well-known/x.json", "garage/a.html", "i/one.avif", "index.css"]);
    assert.ok(!("images/meta/stale.json" in cloned.files), "a derived path the plan skips is not staged");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a link in the cloned root falls back to copying, which stages its target's bytes", async () => {
  const cwd = fixture();
  try {
    symlinkSync(join(cwd, "pub/index.css"), join(cwd, "pub/alias.css"));
    const copied = await stage(cwd, "out-copy", false);
    const cloned = await stage(cwd, "out-clone", true);
    assert.equal(cloned.cloned, null, "the link refused the clone");
    assert.deepEqual(cloned.files, copied.files);
    assert.equal(cloned.files["alias.css"].link, false, "the staged file is a file, as copyFile makes it");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a staged file is a copy: rewriting it leaves the source alone", async () => {
  const cwd = fixture();
  try {
    const { cloned } = await stage(cwd, "out", true);
    assert.equal(cloned, canClone ? "pub" : null);
    writeFileSync(join(cwd, "out/index.css"), "b{}");
    assert.equal(readFileSync(join(cwd, "pub/index.css"), "utf8"), "a{}");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
