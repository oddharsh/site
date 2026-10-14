---
name: blast-radius
description: Find what a change could break outside its own diff, then prove the one fact it's safe because of by running real code. Use for "blast radius of X", "what could this break", "is this safe to merge", reviewing a small diff you don't trust yet, and before merging any PR labelled `release-path` or `hashed-asset`, or one that touches `src/worker/routes.ts`, a stored KV or D1 shape, a public JSON or MCP surface, or anything under `/a/` or `/i/`.
---

# Blast radius

Find what a change breaks somewhere else, before it ships. Listing callers isn't the job, since `git grep` does that in a second. The job is the breakage grep can't show you.

Adapted from Lauren Tan's `blast-radius` skill in Cursor's pstack plugin (MIT, see `LICENSE` beside this file), with this repository's tools in place of pstack's.

## Don't trust your own writeup

A blast-radius writeup that sounds right is worth nothing, because it reads as convincing whether or not it's true. Find the one or two facts the change's safety depends on and prove them by running code.

For each fact, get as far down this ladder as is cheap, and say where it stopped:

1. You said so. Worth nothing on its own.
2. You pointed at the line: a real `path:line`, or the library's own source at the pinned version.
3. You walked the failure step by step and showed it can't reach.
4. You ran it: a script or contract test that calls the real code and fails loudly if you're wrong.
5. You reproduced it against the running site: `bun run dev`, or the branch's preview URL, which Workers Builds mints on every push.

Step 4 is usually one small script that imports the module the Worker ships and calls the exact function you're worried about. The contract suite already does this for most of `src/worker/`, so a new `test()` in the nearest `tools/contract-*.test.mjs` is often the cheapest proof.

## Steps

1. **Read the change.** Read the diff and every symbol it adds, changes or deletes, including what it now does differently that the diff doesn't spell out. Pull the history with `gh pr view <N>`, `git log -p --follow -- <file>` and `git log -S'<symbol>'`.
2. **Find the one fact it's safe because of.** Most changes that look risky are safe because of a single fact, like "this parser only drops entries an older deploy wrote". If that fact holds, most of the risky cases clear at once. Spend your time there, not on a long list of maybes.
3. **Look where grep stops.** In this repository that means:
   - **Content-addressed bytes.** An edit to a hashed `/a/` asset re-mints every page that references it, and the page dictionaries with it (gotcha 35). Build, then grep `.build/` for the old URL to see the bill.
   - **Derived files.** `bun run derive:check` says what went stale. `src/worker/routes.ts` feeds `run_worker_first`, cache paths and write guards, so one new route row can move all three.
   - **Stored shapes.** KV values and D1 rows written by an older deploy still exist after this one ships. Find the parser that reads them (a `read...` function over `lib/parse.ts`) and check it drops an old shape instead of throwing.
   - **Wire formats readers outside this repo depend on.** These are `/api`, the MCP tool schemas, the Markdown twins, `/ledger.json` and the OpenAPI document. `LEAVES_OUT` in `lib/public-api.ts` says what the API skips on purpose.
   - **When things run.** A cron handler, `ctx.waitUntil` work after the response, module top level (gotcha 56), and the Workers Free caps: 50 subrequests per invocation, KV included (gotcha 36).
   - **Code that rebuilds a Response.** It must keep `encodeBody` (gotcha 13).
   - **Preview URLs.** They run production bindings. `lib/preview.ts` denies writes there by default.
   - **The library itself.** Read its source at the version `bun.lock` pins, including any local patch, before you trust its docs.
4. **Be honest about each risk.** Give it a real chance of happening and a real cost if it does. Keep the risks you confirmed, and list the ones you checked and cleared separately. Cite a real `path:line`. A search that finds nothing is still an answer, so say what you searched. Never make up a caller or an API.
5. **Prove the one fact.** Write the script or test, run it, and paste what happened. Then run its control: break the fact on purpose and show the proof fails. A check that has only ever agreed with a healthy tree hasn't shown it can fail.
6. **Get a second reader for a big or wide change.** Run `/code-review` at `high` or above, or hand the diff to the `codex:codex-rescue` agent, and merge what they find. Different models catch different real bugs.

## What to hand back

- **What it does.** What changed, including the part that isn't obvious.
- **The one fact it's safe because of.** State it, say which rung of the ladder you reached, and show the proof and its control. If you couldn't prove it, write "unproven".
- **Risks.** For each: how it breaks, `path:line`, how likely and how bad, and how to check.
- **Cleared.** What you checked and why it's fine.
- **Before you merge.** The cheapest test or reproduction that would catch the real bug, including any script you wrote. If it should outlive this review, offer it as a contract test.

Write it in the house voice from CLAUDE.md: no em dashes, straight quotes, no "X, not Y" negations. Strip anything private before it goes in a public PR comment.
