// repo-files.ts: the files a commit of this tree would hold, for the scans
// that census the repo through git instead of walking the disk.
//
// `git ls-files` alone answers for the index, so a file nobody has `git add`ed
// is invisible to it. An agent who adds a module and runs `bun run test` reads
// green, and CI, which sees the file committed, goes red. On 2026-10-29 the
// gotcha 16 guard passed locally that way on a new src/worker/lib/*.ts that
// imported cloudflare:workers, and #1410 hit the same trap (gotcha 90).
//
// A directory walk is the wrong fix: it reads node_modules, .build and
// vendored clones. `--others --exclude-standard` adds exactly the untracked
// files .gitignore would let `git add -A` pick up. The cost is that an
// untracked scratch file now counts. That is the point, since it's one
// `git add -A` from CI. A tracked file deleted from disk stays listed, so a
// reader that opens it fails loudly; contract-tool-prerequisite-census holds
// check-tools.ts to that.
//
// `git grep` takes `--untracked` for the same reason. The contract test
// git-scans-see-untracked-files holds every census to one or the other.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** Tracked and untracked-but-not-ignored files under `root` matching
 *  `pathspec` (git's pathspec rules, so `*.ts` matches at any depth), as
 *  repo-relative paths. */
export function repoFiles(pathspec: string[] = [], root: string = REPO): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...pathspec], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  // --cached lists an unmerged path once per stage
  return [...new Set(out.split("\0"))].filter(Boolean);
}
