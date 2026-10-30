// ── every git census sees a file before `git add` ───────────────────────────
import { readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";
import { repoFiles } from "../lib/repo-files.ts";

// Gotcha 90. A check that collects files with bare `git ls-files` or `git grep`
// reads the index, so a file nobody has `git add`ed is invisible to it and a
// local run reads green on the defect CI then fails on. 21 scans did that until
// 2026-10-29; repoFiles() and `git grep --untracked` see the file. This holds
// every argv-form git census to one of them. The argv form is the only one
// the repo writes (no Bun `$` or shell-string census on 2026-10-29), so a
// census spelled another way is outside what this reads.
//
// A scan that has to mean the index alone takes a `tracked-only:` comment on
// one of the three lines above it, saying why.

const CENSUS = /"git",\s*\[\s*"(ls-files|grep)"/g;

/** Every argv-form git census in `src` that would miss an untracked file, as
 *  `line: text`. The argv runs to the first `]` that closes it (followed by a
 *  comma or paren), which skips a `[0-9]` inside a pattern. */
export function blindCensuses(src: string): { blind: string[]; seen: number } {
  const blind: string[] = [];
  let seen = 0;
  for (const m of src.matchAll(CENSUS)) {
    seen++;
    const rest = src.slice(m.index);
    const close = rest.search(/\]\s*[,)]/);
    const argv = close < 0 ? rest : rest.slice(0, close);
    if (argv.includes(m[1] === "ls-files" ? '"--others"' : '"--untracked"')) continue;
    const line = src.slice(0, m.index).split("\n").length;
    const above = src.split("\n").slice(Math.max(0, line - 4), line - 1);
    if (above.some((l) => l.includes("tracked-only:"))) continue;
    blind.push(`${line}: ${src.split("\n")[line - 1].trim()}`);
  }
  return { blind, seen };
}

test("the census reader flags a bare scan and passes the two that see untracked files", () => {
  // Built, never written out, so this file holds no census of its own.
  const call = (argv: string) => `execFileSync("git", [${argv}], { cwd });`;
  assert.equal(blindCensuses(call(`"ls-files", "-z", "*.sh"`)).blind.length, 1, "control: bare ls-files is flagged");
  assert.equal(blindCensuses(call(`"grep", "-hoIEi", "gotchas? +#?[0-9]+"`)).blind.length, 1, "control: bare grep is flagged");
  assert.equal(blindCensuses(call(`"ls-files", "-z", "--cached", "--others", "--exclude-standard"`)).blind.length, 0);
  assert.equal(blindCensuses(call(`"grep", "--untracked", "-hoIEi", "gotchas? +#?[0-9]+"`)).blind.length, 0);
  assert.equal(blindCensuses(`// tracked-only: the index is the question here\n${call(`"ls-files"`)}`).blind.length, 0);
});

test("every git census in the repo sees untracked files", () => {
  const files = repoFiles(["*.ts", "*.mjs", "*.js"]).filter((f) => !f.startsWith("src/dict/") && !f.startsWith("tools/fixtures/"));
  // FLOORS. 643 sources and 3 censuses (repo-files.ts and the two
  // `--untracked` greps) on 2026-10-29; a pathspec or pattern that stopped
  // matching would read zero and pass.
  assert.ok(files.length >= 500, `only ${files.length} sources listed`);
  let seen = 0;
  const blind = files.flatMap((f) => {
    const r = blindCensuses(readFileSync(new URL(f, ROOT), "utf8"));
    seen += r.seen;
    return r.blind.map((b) => `${f}:${b}`);
  });
  assert.ok(seen >= 3, `only ${seen} git censuses found; the pattern has stopped matching`);
  assert.deepEqual(blind, [], "a git census that reads only the index; use repoFiles() from tools/lib/repo-files.ts, or git grep --untracked");
});
