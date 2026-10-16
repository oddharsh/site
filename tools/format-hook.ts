// Claude Code hook: after an agent writes or edits a file, run `bun fmt` on
// that one file, so agent edits land already formatted and `validate`'s
// format check has nothing to say about them.
//
// Registered in .claude/settings.json on PostToolUse for Edit, Write and
// MultiEdit. bun fmt honours bunfig.toml's [fmt].ignorePatterns for explicit
// paths too (measured 2026-10-16: handed docs/GOTCHAS.md, luna.css,
// derivations.json and nav-run.js, it formatted none), so a protected file
// stays byte for byte as written (gotchas 71 to 74).
//
// It formats from the project root, which is where Bun finds bunfig.toml. A bun
// with no formatter (anything before 1.4.3-canary.20261013.1) fails the spawn,
// and that is ignored: the hook never fails the tool call, and `validate` still
// runs `bun run format:check`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

type HookInput = { cwd?: string; tool_input?: { file_path?: string } };

/** The file to format, relative to the root, or null when the edit landed outside it. */
export function target(input: HookInput, root: string): string | null {
  const path = input.tool_input?.file_path;
  if (!path) return null;
  const abs = isAbsolute(path) ? path : resolve(input.cwd ?? root, path);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(abs)) return null;
  return rel;
}

if (import.meta.main) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const rel = target(input, root);
    if (rel)
      spawnSync(process.execPath, ["fmt", "--no-error-on-unmatched-pattern", "--log-level=silent", rel], { cwd: root, stdio: "ignore", timeout: 20_000 });
  } catch {
    // A hook that throws shows the user an error on an unrelated edit.
  }
  process.exit(0);
}
