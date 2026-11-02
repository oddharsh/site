// Claude Code hook: before an agent runs `git push` or `gh pr create`, run the
// cheap half of `validate` on the tree and block the command when any of it
// fails, so the failure costs 7 seconds here instead of a CI round trip.
//
// Registered in .claude/settings.json on PreToolUse for Bash. Exit code 2
// blocks the tool call and hands stderr to the agent.
//
// Why these five: of the 55 failed CI runs in October 2026, 28 failed one of
// them, and every one of those reproduces locally. format:check alone failed
// #1468 and #1469, whose edits went through sed and perl, where the format hook
// never sees them. Together they take about 7 s in parallel, most of it lint;
// the contract suite (44 s) stays CI's.
//
// It checks the working tree rather than the commits being pushed, so an
// uncommitted edit counts. That's the cheaper read and, in a worktree an agent
// owns, the same tree. SKIP_PUSH_GATE=1 anywhere in the command skips it, for a
// push that has to go out red (a branch CI should see fail, a WIP save).
// A bug in the hook never blocks a push: anything thrown exits 0.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export const GATES = ["format:check", "typecheck", "pages:check", "derive:check", "lint"];

const PUSH = /^(?:\w+=\S*\s+)*(?:rtk\s+)?git\s+(?:-C\s+(\S+)\s+)?push\b/;
const PR_CREATE = /^(?:\w+=\S*\s+)*(?:rtk\s+)?gh\s+pr\s+create\b/;

const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, "$2").replace(/^(?:~|\$HOME)(?=\/|$)/, homedir());
const inside = (dir: string, root: string) => {
  const rel = relative(root, dir);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * The directory a push in `command` runs from, when it pushes from inside
 * `root`; otherwise null. Follows `cd` and `git -C` through a chain of `&&`,
 * `;` and `||`, so a push to another repo isn't held to this one's checks.
 */
export function pushDir(command: string, cwd: string, root: string): string | null {
  if (/\bSKIP_PUSH_GATE=1\b/.test(command)) return null;
  let dir = cwd;
  for (const raw of command.split(/&&|\|\||;|\n/)) {
    const seg = raw.trim();
    const cd = /^cd\s+(\S+)$/.exec(seg);
    if (cd) {
      dir = resolve(dir, unquote(cd[1]));
      continue;
    }
    const push = PUSH.exec(seg);
    if (push && !/\s(?:--delete|-d)\b/.test(seg)) {
      const at = push[1] ? resolve(dir, unquote(push[1])) : dir;
      return inside(at, root) ? at : null;
    }
    if (PR_CREATE.test(seg)) return inside(dir, root) ? dir : null;
  }
  return null;
}

type Result = { gate: string; code: number; out: string };

function run(gate: string, root: string): Promise<Result> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["run", gate], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ gate, code: code ?? 1, out });
    });
  });
}

/** The message that blocks the push, or null when every gate passed. */
export function verdict(results: Result[]): string | null {
  const failed = results.filter((r) => r.code !== 0);
  if (!failed.length) return null;
  const tail = (s: string) => s.trimEnd().split("\n").slice(-20).join("\n");
  return [
    `push gate: ${failed.map((r) => r.gate).join(", ")} failed on this tree, so CI's validate would too.`,
    ...failed.map((r) => `\n== bun run ${r.gate} ==\n${tail(r.out)}`),
    `\nFix it and push again (\`bun run format\` fixes format:check). SKIP_PUSH_GATE=1 in the command skips the gate.`,
  ].join("\n");
}

if (import.meta.main) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as { cwd?: string; tool_input?: { command?: string } };
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const command = input.tool_input?.command ?? "";
    if (pushDir(command, input.cwd ?? root, root)) {
      const message = verdict(await Promise.all(GATES.map((g) => run(g, root))));
      if (message) {
        process.stderr.write(message + "\n");
        process.exit(2);
      }
    }
  } catch {
    // Fall through: a broken gate must not hold every push hostage.
  }
  process.exit(0);
}
