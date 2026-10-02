---
name: conflict-triage
description: Walk a PR's merge conflicts one at a time, explain what each side of each hunk did and which commit or PR did it, show that as a three-way view, and say whether GitHub's web editor can resolve it or it needs a local checkout, then resolve it the right way. Use when a PR shows "This branch has conflicts", when the Resolve conflicts button is greyed out, when a local merge, rebase or cherry-pick stops on conflicts (the repo's conflict hook names this skill when that happens), when reviewing a PR that conflicts with main, or on "explain these conflicts", "what do these diffs do", "can I fix this in the web editor", "triage the conflicts on #N", "which open PRs conflict", "sweep conflicting PRs".
---

# Conflict triage

GitHub's web editor resolves plain line conflicts and nothing else. This repository adds a second problem on top: `.gitattributes` routes `package.json`, the lockfiles, the bun pin and the long-form prose through `tools/merge-driver.ts`, and **GitHub never runs it**. So GitHub shows conflicts a local merge resolves for free, and it will let you hand-merge `bun.lock` in a textarea, which CI's frozen install then refuses.

`bun run conflicts` measures both views with `git merge-tree` and touches no worktree, so it is safe to run while other sessions use the tree. Read its header (`tools/conflict-triage.ts`) if a verdict surprises you.

## 1. Measure

```bash
bun run conflicts -- <PR#> --json        # one PR
bun run conflicts -- --json              # this branch against origin/main
bun run conflicts -- --all --json        # every open PR that conflicts
bun run conflicts -- --in-progress --json  # the merge/rebase/cherry-pick git just stopped on, here
```

`.claude/settings.json` runs `tools/conflict-hook.ts` after every Bash call. When a git command leaves unmerged files behind, it injects a note naming them and this skill. Treat that note as the start of step 1 with `--in-progress`, run from the directory it names. `--in-progress` re-runs the merge in memory, so it describes the conflict as git first stopped on it even if some files are already resolved in the worktree.

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

For each hunk, read the actual sides before saying anything about it. They are in the JSON as `hunk.sides.main`, `hunk.sides.base` and `hunk.sides.pr`, and `hunk.why` names the commits on each side whose patches wrote or removed those lines, strongest first, with the PR when the subject ends in `(#N)`.

**Explain the intent, then the resolution.** The commit subjects are evidence, not the answer: for each side, read the top commit before describing what it meant (`git show <sha> -- <path>`, or `gh pr view <N>` when `pr` is set) and say what that side was trying to do in a sentence a reviewer could check against it. An empty `why` on a side means no commit since the merge base touched those lines, usually because the side kept the base text; say that rather than inventing an author. For a hunk-less file (modify/delete), `file.history` has the newest commits per side.

Then say what the resolution should be, in one or two sentences:

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

## 2b. Show it

Put the explanations on the page beside the sides they explain. Write them to a notes file in the scratchpad, keyed `<path>:<line>` per hunk (the `hunk.line` from the JSON), `<path>` per file, and `*` for a one-paragraph summary of the whole merge. Plain text; backticks render as code.

```json
{
  "*": "Two conflicts, both main renaming route registration (#1102) under a branch that documented the old shape.",
  "CLAUDE.md:1444": "Main (#1102) rewrote this to say routes are records in `src/worker/routes.ts`. The branch reworded the OLD sentence, which named `route()` in `_worker.js`. #1102's text is current; keep it and fold in any point the branch added."
}
```

Then render with the same target arguments as step 1 and send the file:

```bash
bun run conflicts -- <target> --html <scratchpad>/conflicts.html --notes <scratchpad>/notes.json
```

A key that names no hunk exits 2 rather than vanishing from the page. Send the file with `SendUserFile` (`display: "render"`), which works from the desktop app and from a phone. Keep the per-hunk prose in chat short once the page carries it: one line per hunk plus the route.

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
