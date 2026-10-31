// ── push gate: which commands it holds, and what it says when it does ───────
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { GATES, pushDir, verdict } from "../push-gate.ts";

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
