// ── conflict triage: which conflicts GitHub's web editor can take ────────────
// Split-file convention: shared imports live in contract-shared.ts.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";
import { HEAVY_HUNK, gradeHunk, parseHunks, renderHtml } from "./conflict-triage.ts";

// tools/conflict-triage.ts answers "can this conflict go through GitHub's web
// editor". The fixture carries one conflict of each kind that matters, merged
// by a real git. The root is canonicalised so /var vs /private/var cannot split
// paths on macOS.

const repoRoot = fileURLToPath(ROOT);
const tool = join(repoRoot, "tools", "conflict-triage.ts");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const pkg = (scripts) => JSON.stringify({ name: "fixture", scripts }, null, 2) + "\n";
const notes = (line2) => ["one", line2, "three", "four", "five"].join("\n") + "\n";

/** base, then a `main` and a `feature` that conflict three different ways. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "conflict-triage-")));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@example.invalid"]);
  git(dir, ["config", "user.name", "contract"]);
  const write = (files) => {
    for (const [path, body] of Object.entries(files)) writeFileSync(join(dir, path), body);
  };
  write({
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
  // different script added beside main's.
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
  const dir = fixture();
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

    // Two scripts added side by side: a plain line conflict.
    assert.equal(byPath["package.json"].github, "content");
    assert.equal(byPath["package.json"].verdict, "web-ok");

    assert.equal(report.verdict, "local");
    assert.equal(report.webEditorAvailable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lockfile conflict is regenerated, never merged", () => {
  const dir = fixture();
  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ref git cannot merge is the instrument failing, never a clean merge", () => {
  // `git merge-tree` exits 1 for "not something we can merge", the same code
  // as "merged with conflicts", and prints nothing on stdout. Read as a result,
  // that is an empty conflict list, so the first version of the tool reported a
  // typo'd base as a PR with no conflicts. Found by greyout's suite.
  const dir = fixture();
  try {
    const out = spawnSync("bun", [tool, "--base", "no-such-ref", "--head", "feature", "--json"], { cwd: dir, encoding: "utf8" });
    assert.equal(out.status, 2, out.stdout);
    assert.match(out.stderr, /no-such-ref/);
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

// ── why each side looks the way it does ─────────────────────────────────────
// A verdict says where to resolve a conflict; `why` says what each side was
// doing, which is what a resolution actually needs. The control is the part
// that matters: a commit that touched the SAME FILE but none of the hunk's
// lines must not be credited with the hunk, or every busy file's top commit
// would claim every conflict in it.

test("each side of a hunk is attributed to the commit that wrote it, and only that one", () => {
  const dir = fixture();
  try {
    git(dir, ["checkout", "-q", "feature"]);
    writeFileSync(join(dir, "notes.txt"), notes("two, as the feature has it").replace("five", "five, unrelated"));
    git(dir, ["commit", "-qam", "unrelated edit further down (#7)"]);

    const { report } = run(dir);
    const hunk = report.files.find((f) => f.path === "notes.txt").hunks[0];
    assert.deepEqual(hunk.sides, { main: ["two, as main has it"], base: ["two"], pr: ["two, as the feature has it"] });
    assert.deepEqual(hunk.why.main.map((o) => o.subject), ["main"]);
    // The control: "unrelated edit" touched notes.txt and none of this hunk.
    assert.deepEqual(hunk.why.pr.map((o) => o.subject), ["feature"]);
    assert.equal(hunk.why.pr[0].lines, 2, "the added line and the base line it replaced");

    // A modify/delete has no hunk to attribute, so the file carries its history:
    // main's side is the commit that deleted it.
    const gone = report.files.find((f) => f.path === "gone.txt");
    assert.equal(gone.hunks.length, 0);
    assert.equal(gone.history.main[0].subject, "main");
    assert.equal(report.mergeBase, git(dir, ["merge-base", "main", "feature"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--in-progress keeps main on the main side for a merge AND for a cherry-pick", () => {
  // The two operations put the branches on opposite sides of git's markers
  // (ours is the branch for a merge, upstream for a cherry-pick), so a mode that read HEAD as "the PR" would label a cherry-pick
  // backwards and every explanation built on it would credit the wrong side.
  const dir = fixture();
  const inProgress = () => {
    const out = spawnSync("bun", [tool, "--in-progress", "--json"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(out.status, 2, out.stderr);
    return JSON.parse(out.stdout).files.find((f) => f.path === "notes.txt").hunks[0].sides;
  };
  try {
    git(dir, ["checkout", "-q", "feature"]);
    assert.equal(spawnSync("git", ["merge", "-q", "main"], { cwd: dir }).status, 1, "the merge should stop on conflicts");
    assert.deepEqual(inProgress(), { main: ["two, as main has it"], base: ["two"], pr: ["two, as the feature has it"] });
    git(dir, ["merge", "--abort"]);

    git(dir, ["checkout", "-q", "main"]);
    assert.equal(spawnSync("git", ["cherry-pick", "feature"], { cwd: dir }).status, 1, "the cherry-pick should stop on conflicts");
    assert.deepEqual(inProgress(), { main: ["two, as main has it"], base: ["two"], pr: ["two, as the feature has it"] });
    git(dir, ["cherry-pick", "--abort"]);

    const idle = spawnSync("bun", [tool, "--in-progress"], { cwd: dir, encoding: "utf8" });
    assert.equal(idle.status, 2, "nothing in progress is the instrument refusing, never a clean result");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the conflict hook speaks only when git left unmerged files behind", () => {
  const hook = join(repoRoot, "tools", "conflict-hook.ts");
  const dir = fixture();
  const call = (input) => {
    const out = spawnSync("bun", [hook], { input: JSON.stringify(input), encoding: "utf8" });
    assert.equal(out.status, 0, "a hook must never fail the tool call");
    return out.stdout ? JSON.parse(out.stdout) : null;
  };
  try {
    git(dir, ["checkout", "-q", "feature"]);
    // Before anything conflicts: a merge verb, no unmerged files, nothing to say.
    assert.equal(call({ hook_event_name: "PostToolUse", cwd: dir, tool_input: { command: "git merge --ff-only main" } }), null);

    spawnSync("git", ["merge", "-q", "main"], { cwd: dir });
    // The failing merge, reached through a `cd` from somewhere else.
    const said = call({ hook_event_name: "PostToolUseFailure", cwd: tmpdir(), tool_input: { command: `cd ${dir} && git merge main` } });
    assert.equal(said.hookSpecificOutput.hookEventName, "PostToolUseFailure");
    assert.match(said.hookSpecificOutput.additionalContext, /notes\.txt/);
    assert.match(said.hookSpecificOutput.additionalContext, /conflict-triage/);
    assert.match(said.hookSpecificOutput.additionalContext, /--in-progress/);

    // Controls: the tree is still mid-merge, but neither of these could have
    // caused it, so repeating the note on every command would be noise.
    assert.equal(call({ hook_event_name: "PostToolUse", cwd: dir, tool_input: { command: "git status" } }), null);
    assert.equal(call({ hook_event_name: "PostToolUse", cwd: dir, tool_input: { command: "ls" } }), null);
    assert.equal(spawnSync("bun", [hook], { input: "not json", encoding: "utf8" }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the three-way view escapes every side and every note", () => {
  // Hunk text is file content and notes are model-written, so neither may
  // reach the page as markup.
  /** @type {import("./conflict-triage.ts").Report} */
  const report = {
    label: "fixture",
    base: "main",
    head: "f".repeat(40),
    mergeBase: "b".repeat(40),
    repo: "https://github.com/o/r",
    tree: "t",
    verdict: "web",
    webEditorAvailable: true,
    warnings: [],
    files: [
      {
        path: "page.html",
        github: "content",
        kinds: ["content"],
        stages: [1, 2, 3],
        verdict: "web-ok",
        reasons: [],
        owes: [],
        history: { main: [], pr: [] },
        hunks: [
          {
            line: 3,
            main: 1,
            base: 1,
            pr: 1,
            clash: "edit-edit",
            grade: "easy",
            preview: { main: "", pr: "" },
            sides: { main: ["<script>alert(1)</script>"], base: ["<p>"], pr: ["<img src=x onerror=alert(2)>"] },
            why: { main: [{ sha: "a".repeat(40), subject: "add <b>bold</b> (#12)", pr: 12, lines: 1 }], pr: [] },
          },
        ],
      },
    ],
  };
  const page = renderHtml([report], { "page.html:3": "Main added a `<script>`; <i>keep</i> the PR side." });
  assert.ok(!page.includes("<script>alert"), "side text escaped");
  assert.ok(!page.includes("<img src=x"), "side text escaped");
  assert.ok(!page.includes("<b>bold"), "commit subject escaped");
  assert.ok(!page.includes("<i>keep"), "note escaped");
  assert.ok(page.includes("<code>&lt;script&gt;</code>"), "backticks still render as code");
  assert.ok(page.includes('href="https://github.com/o/r/pull/12"'), "the PR is linked");
});
