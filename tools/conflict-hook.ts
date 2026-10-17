// Claude Code hook: when a git command stops on merge conflicts, put the
// conflict-triage skill in front of the model before it starts resolving.
//
// Registered in .claude/settings.json on BOTH PostToolUse and
// PostToolUseFailure for Bash, and the second is the one that matters: a merge
// that stops on a conflict exits 1, and a non-zero Bash command fires
// PostToolUseFailure. Git's own hooks cannot do this job at all, because
// post-merge does not fire on a conflicted merge.
//
// It reads STATE rather than output. Git's "CONFLICT (content)" lines are
// human text that changes between versions and vanishes under -q, while an
// unmerged index entry is the definition of a conflict. So the command text
// only gates whether to look (a git verb that can stop mid-merge), and the
// index decides whether there is anything to say. A `git status` in a tree
// that is still mid-merge says nothing, which is what keeps this from
// repeating on every command until the merge is done.
//
// It never fails the tool call: anything unexpected exits 0 with no output.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Git verbs that can leave a worktree stopped on conflicts. */
export const STOPS = /\bgit\b[^\n;|&]*?\s(merge|rebase|cherry-pick|pull|revert|am|stash\s+(?:pop|apply))\b/;

type HookInput = { hook_event_name?: string; cwd?: string; tool_input?: { command?: string } };

const git = (dir: string, args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** Every directory the command could have run git in: the session's, each `cd` target, each `git -C`. */
export function candidateDirs(command: string, cwd: string): string[] {
  const out = [cwd];
  for (const m of command.matchAll(/(?:^|[;&|]\s*|\s)(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) out.push(m[1].replace(/^["']|["']$/g, ""));
  for (const m of command.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/g)) out.push(m[1].replace(/^["']|["']$/g, ""));
  return [...new Set(out.map((d) => (isAbsolute(d) ? d : resolve(cwd, d))))].filter((d) => existsSync(d));
}

function operation(dir: string): string {
  const has = (ref: string) => {
    try {
      git(dir, ["rev-parse", "-q", "--verify", ref]);
      return true;
    } catch {
      return false;
    }
  };
  if (has("MERGE_HEAD")) return "merge";
  if (has("REBASE_HEAD")) return "rebase";
  if (has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (has("REVERT_HEAD")) return "revert";
  return "stash or am";
}

export function respond(input: HookInput): object | null {
  const command = input.tool_input?.command ?? "";
  if (!STOPS.test(command)) return null;
  const cwd = input.cwd ?? process.cwd();
  for (const dir of candidateDirs(command, cwd)) {
    let unmerged: string[];
    let top: string;
    try {
      top = git(dir, ["rev-parse", "--show-toplevel"]).trim();
      unmerged = git(dir, ["diff", "--name-only", "--diff-filter=U", "-z"]).split("\0").filter(Boolean);
    } catch {
      continue;
    }
    if (unmerged.length === 0) continue;
    const op = operation(dir);
    const triageable = op === "merge" || op === "rebase" || op === "cherry-pick";
    const shown = unmerged.slice(0, 12).join(", ") + (unmerged.length > 12 ? `, and ${unmerged.length - 12} more` : "");
    const context = [
      `git stopped on ${unmerged.length} conflicted file(s) in ${top} (${op}): ${shown}.`,
      "Before resolving any of them, use the conflict-triage skill to explain what each side of each hunk did and why.",
      triageable
        ? `From ${top}: \`bun run conflicts -- --in-progress --json\` gives every hunk's sides and the commits (and PRs) that wrote each one. Write a note per hunk, render \`--html <scratchpad>/conflicts.html --notes <notes.json>\`, and send that file to the user before proposing resolutions.`
        : `\`bun run conflicts -- --in-progress\` does not cover a ${op}; read the markers in each file and \`git log -3 -- <path>\` on each side instead.`,
      "Resolve only after the user has seen the explanation, and never resolve a regenerate-class file (a lockfile, a derived artifact) by hand.",
    ].join(" ");
    return {
      systemMessage: `Merge stopped on ${unmerged.length} conflicted file(s); explaining each before resolving.`,
      hookSpecificOutput: { hookEventName: input.hook_event_name ?? "PostToolUse", additionalContext: context },
    };
  }
  return null;
}

if (import.meta.main) {
  try {
    const out = respond(JSON.parse(readFileSync(0, "utf8")) as HookInput);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {
    // A hook that throws shows the user an error on an unrelated command.
  }
  process.exit(0);
}
