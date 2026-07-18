# Understanding-first PR review

This repository treats review as an understanding exercise, not only a diff
inspection exercise. A PR is ready to approve when a second person can explain
the intended behavior, trace the mechanism that should make it true, name a
way it could be wrong, point to evidence, and state what remains uncertain.

The practice is deliberately small. It should make the model of a change
clearer, not add a second project-management ritual.

## The default loop

### 1. The author writes the claim card

The PR description should answer five questions:

- **Intended model:** What is changing, and why is this the right boundary?
- **Prediction:** What should a user, operator, or dependent system observe?
- **Likely misconception or failure mode:** What is easy to misunderstand or
  what would be the first plausible way this could be wrong?
- **Evidence:** Which test, invariant, trace, dry-run, or live check supports
  the prediction?
- **Remaining uncertainty:** What did this PR not prove?

The claim card is a compact handoff from the person who built the change to
the person who will review it. For a documentation or dependency PR, a short
answer or an explicit “none” is enough.

### 2. The reviewer reconstructs the model

Before approving, the reviewer should be able to answer independently:

1. What do I think this change does?
2. What path or invariant makes that behavior true?
3. What would falsify my model?
4. What evidence did I inspect?
5. What remains unproven?

If the reviewer cannot answer those questions, the right response is to ask
for a clearer explanation or better evidence—not to infer understanding from
the size of the diff or the green checkmarks.

### 3. Evidence closes the loop

Tests are evidence about specific claims, not proof that the whole change is
understood. The useful review comment connects the claim to the check:

> I expected X because Y. The check at Z supports X. It does not cover W,
> which remains the residual risk.

That format keeps “passed CI” from becoming a substitute for a causal model.

## Scale it, do not waive it

| Change type | Minimum useful review card |
|---|---|
| Docs or copy | Intended reader change, one prediction, and how wording was checked |
| Dependency or tooling | Update surface, compatibility risk, checks, and a concrete leverage point or “none” |
| UI or behavior | Causal path, falsifiable prediction, likely user misconception, and behavioral evidence |
| Infrastructure or production path | Boundaries, failure/rollback behavior, local and remote evidence, and residual risk |

The questions stay constant; the amount of detail changes with the blast
radius. A five-question quiz is appropriate for a learning page. A PR usually
needs a short claim card and a short reconstruction, not a full exam.

## What the automation does

`.github/workflows/understanding-review.yml` adds or refreshes one maintained
comment on every PR. The comment contains the reviewer prompts and links back
to this document. It is a prompt, not a score and not a merge gate.

The workflow uses `pull_request_target` only to call the GitHub API. It does
not check out the PR branch, run PR code, parse untrusted files, or use an AI
grader. That keeps the default prompt safe for forked PRs and makes the
comment idempotent when a PR is synchronized.

The PR template carries the author claim card. The reviewer prompt remains a
separate comment so the author’s explanation does not become a substitute for
the reviewer’s own reconstruction.

## Anti-patterns

- Do not require polished prose from a small docs or dependency change.
- Do not turn the five prompts into mandatory checkbox theater.
- Do not use an LLM-generated “understanding score” as a merge gate.
- Do not claim that green CI proves behavior the checks do not exercise.
- Do not hide uncertainty behind a complete-sounding summary.

The operating rule is simple: make the model legible, test the important
prediction, and leave the unknowns visible.
