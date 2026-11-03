// ── push gate: which commands it holds, and what it says when it does ───────
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, test } from "./contract-shared.ts";
import { GATES, passedBefore, pushDir, remember, treeId, verdict } from "../push-gate.ts";

// tools/push-gate.ts runs before every Bash call an agent makes, so it has to
// pick out the pushes from this repo and leave everything else alone,
// including pushes to the upstream repos sessions also work in.

const root = "/work/site";

test("push gate: catches a push or PR from this repo, however the command is chained", () => {
  for (const command of [
    "git push",
    "rtk git push -u origin claude/x",
    "git add -A && git commit -m msg && rtk git push",
    "cd tools && git push",
    "GIT_TRACE=0 git push --force-with-lease",
    "gh pr create --title t --body b",
    `git -C ${root} push`,
  ])
    assert.equal(pushDir(command, root, root) !== null, true, command);
});

test("push gate: leaves alone what isn't a push from this repo", () => {
  for (const command of [
    "git status",
    "git log --oneline origin/main..",
    "echo git push",
    "gh pr view 1492",
    "git push origin --delete claude/old",
    "SKIP_PUSH_GATE=1 git push",
    "cd ~/noodling/bun && git push",
    "cd /elsewhere && gh pr create",
    "git -C /elsewhere push",
  ])
    assert.equal(pushDir(command, root, root), null, command);
});

test("push gate: says which gates failed, and nothing when all pass", () => {
  const pass = (gate) => ({ gate, code: 0, out: "ok" });
  assert.equal(verdict(GATES.map(pass)), null);
  const msg = verdict([pass("lint"), { gate: "typecheck", code: 1, out: "src/x.ts(1,1): error TS2322" }]);
  assert.match(msg ?? "", /typecheck failed/);
  assert.match(msg ?? "", /TS2322/);
  assert.doesNotMatch(msg ?? "", /== bun run lint/);
});

test("push gate: is registered on Bash, and every gate is a package.json script", () => {
  const settings = JSON.parse(readFileSync(new URL("../../.claude/settings.json", import.meta.url), "utf8"));
  const pre = settings.hooks.PreToolUse.find((h) => h.matcher === "Bash");
  assert.match(pre?.hooks?.[0]?.command ?? "", /tools\/push-gate\.ts/);
  const { scripts } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  for (const gate of GATES) assert.ok(scripts[gate], `${gate} is not a script`);
});

test("push gate: a tree's id moves with every file the gates read, and leaves the index alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "push-gate-tree-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q");
    writeFileSync(join(dir, ".gitignore"), "out/\n");
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    const base = treeId(dir);
    assert.equal(base, git("rev-parse", "HEAD^{tree}").trim(), "a clean tree is the commit's tree");
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out/build.js"), "ignored");
    assert.equal(treeId(dir), base, "an ignored file isn't something the gates read");
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    const untracked = treeId(dir);
    assert.notEqual(untracked, base, "an untracked file is");
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    assert.notEqual(treeId(dir), untracked, "so is an unstaged edit");
    assert.equal(git("diff", "--cached", "--name-only"), "", "the real index never moved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("push gate: remembers a passing tree, and only that one", () => {
  const dir = mkdtempSync(join(tmpdir(), "push-gate-memo-"));
  try {
    const memo = join(dir, "push-gate-passed");
    assert.equal(passedBefore(memo, "t1 bun-1.4.4"), false);
    remember(memo, "t1 bun-1.4.4");
    assert.equal(passedBefore(memo, "t1 bun-1.4.4"), true);
    assert.equal(passedBefore(memo, "t1 bun-1.4.5"), false, "another bun runs the gates again");
    for (let i = 0; i < 60; i++) remember(memo, `t${i + 2} bun-1.4.4`);
    assert.equal(passedBefore(memo, "t1 bun-1.4.4"), false, "the memo keeps the last 50");
    assert.equal(passedBefore(memo, "t61 bun-1.4.4"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
