# Comments

What a comment in this repo is for, and how to tell whether one earns its
place. The code says what happens; a comment says what the code can't.

## Who reads them

1. **The next session on this site**, a person or an agent, about to change
   the code. They have the file and none of the conversation that shaped it.
2. **Someone copying a piece of it.** This site is a proving ground: timbrado
   and halflight started as files here, and doors packages what the site does
   for agents. A copier needs to know what the code assumes about the site, so
   they know what to replace.
3. **A person reading the source to learn why.** The readable twins
   (`/nav.src.js` and the rest) ship because View Source is part of the site,
   and the repo is public.

A comment earns its place when one of them would make a worse change, or copy
the wrong thing, without it.

## Keep, or write

- **What the file is.** The first paragraph of every header, in a line or
  two. This is the comment most readers hit first.
- **A decision and its reason.** "Tried X, kept Y, because Z", with the number
  and the date when it was measured. A choice recorded without its evidence
  gets re-litigated, and a choice recorded without its date can't be
  re-checked. From `src/worker/dispatch.ts`:

  > Seven alternating 1000-request in-process harness trials on 2026-09-01
  > moved the median from 1674.83ms to 1594.44ms

- **A constraint the code can't show.** Platform, vendor, browser and RFC
  behavior; a limit like Workers Free's 50 subrequests; a contract another
  file or test depends on. From `src/worker/lib/const.ts`: Chromium sizes a
  registered dictionary's lifetime from the `stale-while-revalidate` window,
  so shortening it silently shortens the dcz tier.
- **What breaks if this changes, and what tells you.** Name the test, the
  check or the gotcha number. `gotcha 16` is a link: `docs/GOTCHAS.md` holds
  the story and the check that guards it.
- **What a copier must replace.** Hostnames, bindings, the account's plan, a
  sibling module this one leans on.

## Fix in place

- **Stale paths and names.** `_worker.js/`, `lib/assets.js` for a file that's
  `.ts` now, a function that was renamed. Correct the pointer rather than
  dropping the comment around it.
- **Claims the code contradicts.** A count that moved, a list that grew, a
  behavior that changed. Read the code or re-measure, then correct the
  claim. If you can't verify it, delete it rather than guess.
- **Dangling references.** "The reason above" or "that config" whose referent
  an earlier edit removed. Restore the referent or rewrite the sentence so it
  stands alone.

## Delete

- **Narration** that restates the next line.
- **History that no longer explains the code.** "This used to be X until
  #812." Keep it only when it says why X isn't the answer, and then write it
  as the decision.
- **Duplicates.** Say a thing once, beside the code it's about, and point to
  it from elsewhere.
- **Commented-out code, empty banners, and TODOs** with no owner or trigger.

When a rationale spans several files, or runs past a screen, it belongs in
`docs/` (or as a gotcha) with a one-line pointer from the code.

## How to write one

- Write for a reader who has the code but not the conversation: no "as
  discussed", no "the fix above" across commits, no session-relative dates.
- Absolute dates (2026-10-14), digits for numbers, units on every figure.
- The house voice applies: no em dashes, no AI filler, no "X, not Y".
  Existing headers that use `—` don't need churning; new prose shouldn't add
  more.
- A comment states what is true now. If it records a past state, it says so,
  with a date.

## Mechanics that bite

- **Some contract tests read comment text.** A test may pin a phrase in
  another file (`perf-budget.ts`'s baseline history is one). Run
  `bun run test` after any comment pass, and restore a pinned comment rather
  than weaken its test.
- **Comments inside template literals and strings are output.** A generator
  writes them into the page or file it produces.
- **Client comments ship.** `src/client/` comments appear in the readable
  twins, so they're written for a visitor as much as a maintainer.
- **Generated files** (`src/worker/lib/site-manifest.ts`,
  `src/worker/lib/desktop.ts`) get their comments from their generator. Edit
  the generator.
- **JSDoc type tags in `.mjs` tests are code.** `config/tsconfig.tools.json`
  typechecks them.
- **Prove a comment pass is comment-only.** Compare the code with comments
  stripped (`Bun.Transpiler` on both sides) and, for anything the build
  touches, diff the built bytes. A comment edit should never move an `/a/`
  hash.
