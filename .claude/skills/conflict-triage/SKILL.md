---
name: conflict-triage
description: Walk a PR's merge conflicts one at a time and say, for each, whether GitHub's web editor can resolve it or it needs a local checkout, then resolve it the right way. Use when a PR shows "This branch has conflicts", when the Resolve conflicts button is greyed out, when reviewing a PR that conflicts with main, or on "can I fix this in the web editor", "triage the conflicts on #N", "which open PRs conflict", "sweep conflicting PRs".
---

# Conflict triage

GitHub's web editor resolves plain line conflicts and nothing else. This repository adds a second problem on top: `.gitattributes` routes `package.json`, the lockfiles, the bun pin and the long-form prose through `tools/merge-driver.ts`, and **GitHub never runs it**. So GitHub shows conflicts a local merge resolves for free, and it will let you hand-merge `bun.lock` in a textarea, which CI's frozen install then refuses.

`bun run conflicts` measures both views with `git merge-tree` and touches no worktree, so it is safe to run while other sessions use the tree. Read its header (`tools/conflict-triage.ts`) if a verdict surprises you.

## 1. Measure

```bash
bun run conflicts -- <PR#> --json        # one PR
bun run conflicts -- --json              # this branch against origin/main
bun run conflicts -- --all --json        # every open PR that conflicts
```

Exit 0: nothing needs a local checkout. Exit 1: something does. **Exit 2: the instrument failed.** Report its message and stop there. Never read an exit 2 as "no conflicts", and never fall back to guessing from `gh pr view`.

If `warnings` names `setup:merge`, the drivers are not wired in this clone and every `local-free` verdict is missing. Say so; running `bun run setup:merge` once fixes it for every worktree.

If `warnings` says GitHub and the emulated view disagree, re-run once. `mergeable` is computed lazily on GitHub's side and a branch may have just moved (another session rebases these). If it still disagrees, report both readings and trust neither.

## 2. Walk it conflict by conflict

Files arrive sorted strongest verdict first. Present them in that order, one at a time, as a short block per file: the path, the verdict, the `reasons`, and one line per hunk. Do not collapse them into a summary paragraph; the point is that each conflict gets its own call.

| verdict | means | what to say |
|---|---|---|
| `local-required` | not a line conflict (modify/delete, rename, file location, binary, mode) | GitHub's Resolve button is disabled for the whole PR. Name the kind. |
| `regenerate` | a derived file | Hand-merging it is wrong by construction. Name the command in `owes`. |
| `local-free` | a repo merge driver resolves it | GitHub shows it; `git merge origin/main` locally clears it with no edit. |
| `local-recommended` | renderable, but too big, too many hunks, or owes a command | The web editor would work but is the wrong tool. Say which reason. |
| `web-ok` | small line conflict | Fine in the web editor, unless another file forces the PR local. |

For each hunk, read the actual sides before saying anything about it. `tree` in the JSON is the GitHub-view result tree, and `hunk.line` is the `<<<<<<<` line in it:

```bash
git cat-file -p <tree>:<path> | sed -n '<line>,<line+main+base+pr+4>p'
```

Then say what each side did and what the resolution should be, in one or two sentences:

- `trivial` whitespace: take either side.
- `easy` add-add: keep both, and check the order and any trailing commas (JSON).
- `judgment` add-add: near-copies of one thing. Keeping both duplicates it; pick the newer or merge them.
- `judgment` edit-delete: one side deleted what the other changed. Find out why before picking: `git log origin/main --oneline -3 -- <path>`.
- `edit-edit`: say what each side intended. If they are compatible, write the blended text.
- `heavy`: summarize the two intents rather than pasting 40+ lines, and recommend a local diff tool.

For `local-required` modify/delete, always look for where the content went before proposing anything. This repository moves files often (`holding/` to `www/` to `public/` + `src/`, `wrangler.jsonc` to `cloudflare.config.ts`), so the usual answer is to port the PR's change to the file's new home rather than to resurrect or drop it:

```bash
git log origin/main --diff-filter=D --format='%h %s' -1 -- <path>
```

## 3. Say the route

End with the PR-level call, in one line: web editor, or one local merge.

**If any file is not `web-ok`, the whole PR goes local, including its `web-ok` files.** Two resolutions of one PR (some hunks in the browser, the rest locally) means two merge commits and a second chance to get the first set wrong. The web editor's merge commit also runs none of this repo's hooks, so `merge-finish` never drains what the drivers parked.

When the route is the web editor, give the user the exact replacement text for each hunk so they can paste it.

## 4. Resolve locally, only when asked

Resolving is a separate step. Ask before starting it, and ask again before pushing: the branch may belong to another session (CLAUDE.md, "Assume another session is in this tree").

```bash
git fetch origin
git worktree add .claude/worktrees/resolve-<PR#> <headRefName>   # a worktree of its own
cd .claude/worktrees/resolve-<PR#> || exit 1
git merge origin/main       # MERGE, not rebase: a rebased PR branch needs a force push
```

Resolve the files in the triage order, then:

```bash
bun run merge:finish -- --check   # what the drivers parked
bun run merge:finish              # drains it (bun install for lockfiles)
```

Run every command in each file's `owes`, then the gates the touched files reach (`bun run lint`, `bun run typecheck`, `bun run test`; `bun run derive:check` if a derivation input or `config/derivations.json` moved). Commit the merge. Push only after the user says yes.

## Posting to the PR

`bun run conflicts -- <PR#> --markdown` renders the same triage as a PR comment. Posting it is outward-facing, so show it and ask first; then `gh pr comment <PR#> --body-file <file>`.

## Running it as a routine

`bun run conflicts -- --all --markdown` is the sweep. It triages every open PR, prints only the ones that conflict, and needs `gh` auth plus a checkout, so it suits a local scheduled task rather than CI. Offer to set one up; do not create it unasked.
