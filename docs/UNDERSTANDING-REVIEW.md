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

## What the automation does, and why it stopped

Nothing automated. This is a practice, not a pipeline.

`.github/workflows/understanding-review.yml` used to post the reviewer prompts
as a maintained comment on every PR, refreshed on every push. It was deleted
2026-08-06 because the comment was byte-identical every time it ran, and this
repository has one human, who is the author and the reviewer of nearly every
PR. A bot reminding you to independently reconstruct your own change is not a
second perspective; it is a line of boilerplate standing where the second
perspective should be, which is worse than an empty space because it looks
answered.

The reviewer prompts live above, in this document. The author claim card lives
in `.github/pull_request_template.md`, where GitHub puts it in front of you at
the moment you are writing the description. Those two surfaces are the whole
mechanism now.

If a second regular reviewer ever joins, reconsider. The argument for deleting
the comment rests entirely on author and reviewer being the same person, so a
real reviewer who has not read this file is exactly the reader the prompt was
written for.

## Anti-patterns

- Do not require polished prose from a small docs or dependency change.
- Do not turn the five prompts into mandatory checkbox theater.
- Do not use an LLM-generated “understanding score” as a merge gate.
- Do not claim that green CI proves behavior the checks do not exercise.
- Do not hide uncertainty behind a complete-sounding summary.

The operating rule is simple: make the model legible, test the important
prediction, and leave the unknowns visible.
