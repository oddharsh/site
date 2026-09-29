// ── conflict triage separates GitHub's view of a conflict from a local one ────
// Split-file convention: shared imports live in contract-shared.ts.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";
import { HEAVY_HUNK, gradeHunk, parseHunks } from "./conflict-triage.ts";

// tools/conflict-triage.ts answers "can this conflict go through GitHub's web
// editor", and its whole value is that the answer differs from what a local
// merge says: GitHub never runs this repository's merge drivers. So the fixture
// carries one conflict of each kind that matters, merged by a real git with the
// real drivers wired, and the assertions are about the three disagreeing.
//
// Canonical fixture root for the reason gotcha 45 gives: the driver asks git for
// an absolute git dir, and /var vs /private/var would split it on macOS.

const repoRoot = fileURLToPath(ROOT);
const tool = join(repoRoot, "tools", "conflict-triage.ts");
const driver = join(repoRoot, "tools", "merge-driver.ts");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const pkg = (scripts) => JSON.stringify({ name: "fixture", scripts }, null, 2) + "\n";
const notes = (line2) => ["one", line2, "three", "four", "five"].join("\n") + "\n";

/** base, then a `main` and a `feature` that conflict three different ways. */
function fixture({ wired }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "conflict-triage-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.invalid"]);
  git(dir, ["config", "user.name", "contract"]);
  if (wired) {
    for (const mode of ["json", "pin", "regen", "prose"]) {
      git(dir, ["config", `merge.${mode}.driver`, `bun ${driver} ${mode} %O %A %B %L %P`]);
    }
  }
  const write = (files) => {
    for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
  };
  write({
    ".gitattributes": readFileSync(join(repoRoot, ".gitattributes"), "utf8"),
    "package.json": pkg({ build: "bun build", test: "bun test" }),
    "notes.txt": notes("two"),
    "gone.txt": "kept on the feature branch\n",
  });
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  git(dir, ["branch", "-q", "feature"]);

  // main: a line edit, a deletion, and an added script.
  write({ "package.json": pkg({ build: "bun build", test: "bun test", lint: "oxlint" }), "notes.txt": notes("two, as main has it") });
  git(dir, ["rm", "-q", "gone.txt"]);
  git(dir, ["commit", "-qam", "main"]);

  // feature: the same line edited differently, the deleted file modified, and a
  // different script added beside main's (the add/add the json driver resolves).
  git(dir, ["checkout", "-q", "feature"]);
  write({
    "package.json": pkg({ build: "bun build", test: "bun test", dev: "bun dev" }),
    "notes.txt": notes("two, as the feature has it"),
    "gone.txt": "kept on the feature branch, and edited\n",
  });
  git(dir, ["commit", "-qam", "feature"]);
  return dir;
}

function run(dir) {
  const out = spawnSync("bun", [tool, "--base", "main", "--head", "feature", "--json"], { cwd: dir, encoding: "utf8" });
  return { status: out.status, report: out.status === 2 ? null : JSON.parse(out.stdout), stderr: out.stderr };
}

test("each conflict gets the verdict its kind earns, and the PR as a whole goes local", () => {
  const dir = fixture({ wired: true });
  try {
    const { status, report, stderr } = run(dir);
    assert.equal(status, 1, stderr);
    const byPath = Object.fromEntries(report.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ["gone.txt", "notes.txt", "package.json"]);

    // A line conflict: exactly what GitHub's editor is for.
    assert.equal(byPath["notes.txt"].verdict, "web-ok");
    assert.equal(byPath["notes.txt"].hunks.length, 1);
    assert.equal(byPath["notes.txt"].hunks[0].clash, "edit-edit");

    // Deleted on main, modified on the feature: GitHub disables its button.
    assert.equal(byPath["gone.txt"].verdict, "local-required");
    assert.equal(byPath["gone.txt"].github, "structural");
    assert.ok(byPath["gone.txt"].kinds.includes("modify/delete"), JSON.stringify(byPath["gone.txt"].kinds));

    // GitHub shows a conflict that the local json driver resolves outright.
    assert.equal(byPath["package.json"].github, "content");
    assert.equal(byPath["package.json"].local, "resolved");
    assert.equal(byPath["package.json"].verdict, "local-free");

    assert.equal(report.verdict, "local");
    assert.equal(report.webEditorAvailable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a triage run parks nothing in the real merge ledger", () => {
  // The drivers run inside `git merge-tree` exactly as in a real merge, so
  // without SITE_MERGE_LEDGER a triage would leave merge-finish a phantom job.
  const dir = fixture({ wired: true });
  try {
    // A regen-class conflict is the one that writes the ledger.
    git(dir, ["checkout", "-q", "main"]);
    writeFileSync(join(dir, "bun.lock"), "main\n");
    git(dir, ["add", "bun.lock"]);
    git(dir, ["commit", "-qm", "main lock"]);
    git(dir, ["checkout", "-q", "feature"]);
    writeFileSync(join(dir, "bun.lock"), "feature\n");
    git(dir, ["add", "bun.lock"]);
    git(dir, ["commit", "-qm", "feature lock"]);

    const { report } = run(dir);
    const lock = report.files.find((f) => f.path === "bun.lock");
    assert.equal(lock?.verdict, "regenerate");
    assert.ok(lock.owes.includes("bun install"), JSON.stringify(lock.owes));
    assert.equal(existsSync(join(git(dir, ["rev-parse", "--absolute-git-dir"]), "site-merge-pending")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control: with the drivers unwired, nothing reads as resolved for free", () => {
  // Without this, "local-free" could be an artifact of the GitHub view and the
  // local view being the same merge, which is the failure the control in the
  // tool itself guards from the other side.
  const dir = fixture({ wired: false });
  try {
    const { report } = run(dir);
    const json = report.files.find((f) => f.path === "package.json");
    assert.equal(json.local, "drivers-not-wired");
    assert.notEqual(json.verdict, "local-free");
    assert.ok(report.warnings.some((w) => w.includes("setup:merge")), JSON.stringify(report.warnings));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hunk grades separate keep-both from near-duplicates and size from kind", () => {
  assert.deepEqual(gradeHunk(["a  b"], ["x"], ["a b"]), { clash: "whitespace", grade: "trivial" });
  assert.deepEqual(gradeHunk(["lint: oxlint"], [], ["dev: bun dev"]), { clash: "add-add", grade: "easy" });
  // Two branches landing near-copies of one helper: keeping both duplicates it.
  const helper = ["function f() {", "  return 1;", "}"];
  assert.deepEqual(gradeHunk(helper, [], [...helper, "// newer"]), { clash: "add-add", grade: "judgment" });
  assert.deepEqual(gradeHunk([], ["old"], ["new"]), { clash: "edit-delete", grade: "judgment" });
  const big = Array.from({ length: HEAVY_HUNK }, (_, i) => `line ${i}`);
  assert.equal(gradeHunk(big, ["x"], ["y"]).grade, "heavy");

  const text = ["ctx", "<<<<<<< main", "m", "||||||| base", "b", "=======", "p", "p2", ">>>>>>> feature", "ctx"].join("\n");
  const [hunk] = parseHunks(text);
  assert.equal(hunk.line, 2);
  assert.deepEqual([hunk.main, hunk.base, hunk.pr], [1, 1, 2]);
});
