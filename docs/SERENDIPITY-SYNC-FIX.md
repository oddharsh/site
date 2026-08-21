# Serendipity sync: three failures and the fix

> **Status.** Part 1 is built on `fix/serendipity-sweep-budget`. Parts 2 and 3
> are still proposals. Part 1f (clearing the seven parked markers) is a
> production D1 write and is deliberately left until the branch is deployed,
> since clearing them against the old code just re-parks them on the next tick.

Written 2026-08-21 after a query against the Corgi Cafe roster came back with
1 of 1,928 attendees carrying a role or company. The roster turned out to be
fine. Two other things were broken, and a third was what kept both of them
quiet for months.

Every number below was measured against production D1 and the deployed Worker
on 2026-08-21. Nothing here is inferred from reading the code alone.

---

## What is actually wrong

### P0. The guest sweep exceeds the subrequest cap, and events park on it

`settings` holds one sync marker per event. Seven of them read:

```
error:Too many subrequests by single Worker invocation.
```

Last written **2026-08-21 12:24:07**, which is today's 12:23 tick. The seven:

| event | starts | last attempt |
|---|---|---|
| Solana Community Ecosystem Summit @ ETH Denver | 2025-02-26 | 2026-08-21 12:24 |
| Story House | 2025-02-25 | 2026-08-21 12:24 |
| Monad Cards Summer Soiree | 2026-08-06 | 2026-08-21 12:24 |
| Black Forest Labs x Nous Research | 2026-08-01 | 2026-08-21 12:24 |
| Solana Snapshot, ETHDenver 2025 | 2025-02-27 | 2026-08-20 18:25 |
| AI Hype(r)House by Hyperbolic + EigenLayer | 2025-02-28 | 2026-08-20 06:24 |
| Agentic Crypto Day | 2025-02-28 | 2026-08-20 06:24 |

All seven are past events, so they sit in the `past` backfill queue. That query
selects on `gs.value NOT LIKE 'ok:%'`, so a failed event returns every tick,
spends budget, fails again, and drops to the back. They cycle without ever
completing.

**Root cause is one unguarded loop.** `fetchEventGuests` paginates
`while (true)` at `pagination_limit: 100` with no page cap and no budget. The
Corgi event alone is 1,932 guests, so that single call costs **21 fetches**.
Add `fetchMyEvents` at up to 10 pages, seven more events in the sweep, and up to
10 description fetches, and a tick can ask for 50 or more.

The asymmetry is the tell. `fetchMyEvents` caps its pages at 6 future and 4 past
and carries a comment saying why:

> page caps kept low: Cloudflare limits subrequests (fetch calls) per Worker
> invocation. Ten fetches total stays well under the cap.

`fetchEventGuests` sits a few hundred lines away, has the same hazard, and has
no cap. One was guarded and the other was missed.

Per gotcha 36 the account is on Workers Free, where the ceiling is 50 per
invocation. Worth noting the runtime error itself never states the number, so
confirm the plan before tuning any constant against it.

### P1. Enrichment has never run automatically, and cannot run now

| | |
|---|---|
| attendees in pool | 16,839 |
| carrying an enrichment row | **86 (0.5%)** |
| last enrichment | **2026-05-31** (82 days) |

Two independent causes, and fixing either one alone changes nothing.

**It was never on the cron.** `cronSerendipity` runs `syncEvents`, then
`syncGuests` over a bounded batch, then `syncDescriptions`, and returns. There
is no enrichment step and there never was. The only door is
`POST /serendipity/enrich`, which a human has to call.

**`EXA_API_KEY` is not set on the Worker.** The deployed secret list holds 12
names and that is not among them. So `handleEnrich` answers
`400 EXA_API_KEY not set` today, and inside any future cron path `enrichViaExa`
returns `{outcome: "not_found", error: "EXA_NOT_CONFIGURED"}`, which is a quiet
degradation rather than a throw.

### P2. Nothing reports on any of this

`grep -c 'span(' serendipity/serendipity.js` returns **0**. The module imports
five things from `src/worker/lib/` already, so the direction is established and
`lib/trace.ts` is simply unused here.

The consequence is the reason this document exists. Enrichment was dead for 82
days and the guest sweep has been parking events on a platform limit for at
least two days, and both states are recorded in D1 where a person would have to
go looking. The existing note that serendipity sync health is unbuilt is now
measured rather than suspected.

---

## The fix

### Part 1: bound the sweep (do this first, it is breaking today)

The goal is that no single event can spend the whole budget, and that running
out of budget never writes an error marker.

**1a. Give the invocation a fetch budget.** A counter threaded through the
sweep, seeded well under the cap (40 leaves headroom for the D1 batches and the
description pass). `syncGuests` takes the remaining budget and returns what it
spent.

**1b. Make `fetchEventGuests` resumable rather than capped.** A plain page cap
truncates a 2,034-person roster silently, which reads downstream as 100 people
leaving the event. Instead, stop at the budget and hand back the cursor:

```js
return { guests, done: !hasMore, cursor: nextCursor, spent };
```

Store `partial:<n>@<cursor>` in the sync marker. That value fails
`LIKE 'ok:%'`, so the event stays in the queue and the next tick resumes from
the cursor instead of restarting. A big event completes across two or three
ticks and is never wrong in between.

**1c. Do not run the stale-row deletion on a partial pass.** This is the part
that will bite whoever implements 1b without reading `syncGuests`. After
fetching, it computes `staleGuestIds(existing, guests, selfId)` and deletes
every stored link absent from the response. On a partial fetch that response is
one page, so the delete would wipe the roster down to 100 people.

**Gating on `done === true` is NOT enough, which building it is what showed.**
A pass that RESUMED from a cursor also ends `done`, while holding only the tail
of the roster, so it would prune against the tail and delete everything the
earlier pages had stored. The condition is `done && !resumedFrom`: a walk that
covered the whole list inside one invocation. That predicate ships as the
exported `mayPruneRoster`, next to `staleGuestIds`, because between them they
are the destructive half.

The insert half is already safe to run per page, since it is upsert-only and the
function's own comment explains the ordering.

**1d. When the budget runs out, skip rather than mark.** An event the sweep
never reached should keep whatever marker it had. Writing an error for a
platform limit is what created the seven-event retry loop, because the marker
made a healthy event look permanently broken.

**1e. Spend the budget on upcoming events first.** The sweep already runs
`[...soon, ...past]` in that order, which is right. Make it explicit that `past`
gets the remainder, since past rosters are immutable backfill and nobody queries
them under time pressure.

**1f. Clear the seven stuck markers once deployed**, so they re-enter the queue
clean rather than carrying a diagnosis of a bug that no longer exists.

### Part 2: make enrichment run

**2a. Set the key.** This is yours to run, since it is a credential:

```bash
bun run wrangler versions secret put -c wrangler.jsonc EXA_API_KEY
```

That mints a version and moves no traffic, so it has to be ramped before the
live endpoint sees it. Gotcha 25 applies directly: do not ramp a production
version that predates the secret change, or the key goes back out.

**2b. Enrich the people you are about to meet, never the pool.** Enriching
16,839 attendees is an Exa bill with no occasion attached. The query this
system actually gets asked is "who is going to X tonight", so scope the
automation to attendees of upcoming `going` events, ordered by how often they
appear across your events, bounded per run. `handleEnrich` already implements
exactly that ordering and caps at 10 per call, so the batching logic exists.

**2c. Run it in its own invocation, not on the sync tick.** Two reasons. The
sync tick is the thing that is already out of budget, and enrichment is the
lower-priority half, so sharing an invocation means the roster loses. And
Workers Free caps an account at 5 cron triggers with 4 already spent, so
burning the last slot here is a real cost.

The cheap shape is a self-dispatch at the end of `cronSerendipity`: one `fetch`
to this Worker's own `/serendipity/enrich`, which costs 1 subrequest from the
cron and runs the work in a **fresh invocation with its own budget**. `/lens`
already self-dispatches, so the pattern is in the codebase.

If you would rather have it on its own schedule, that is the 5th trigger and it
is the last one.

### Part 3: make silence impossible

**3a. Spans.** Wrap the tick in `span("cron.serendipity", ...)` and hang
attributes off it: fetches spent, events synced, events skipped for budget,
events resumed from a cursor, enrichment attempted and succeeded. Follow the
existing rule that an undefined attribute is skipped rather than coerced to 0.
The single most valuable attribute is `budget_exhausted`, because that is the
state that has been invisible.

**3b. A staleness check.** `bun run serendipity:check`, in the idiom of
`dcz:check`: read production, assert that the newest `synced_at` is inside two
tick intervals, that no event carries a subrequest error, and that the newest
enrichment is inside some window. Keep it **advisory**, the way the `infra:check`
edge tier is, since it reads production and a required check that reads
production deadlocks the release that would fix it.

---

## What this deliberately does not propose

**Raising the page cap or paying for a higher subrequest limit.** The sweep
should be correct at 50. Resumable pagination makes the cap a pacing question
instead of a failure, and that holds whatever the ceiling turns out to be.

**Backfilling enrichment across the pool.** 16,839 attendees against a
per-attendee paid API, for a surface that gets queried a few times a week about
one event at a time.

**Retiring the 56 `GUEST_LIST_RESTRICTED` markers.** Those are honest. Luma
restricts some guest lists and the sweep records that it was refused. They are
a different thing from the seven subrequest failures and should stay.

---

## Controls

Each part has a way to prove it worked, rather than a way to look like it did.

| part | control |
|---|---|
| 1a-1e | Force a tick with the Corgi event plus two more large rosters queued. No event may end on a subrequest error, and the partial ones must carry a cursor. |
| 1c | Run a partial sync against an event with a stored roster and assert the row count does not drop. This is the regression that would be silent. |
| 2a | `wrangler secret list` shows `EXA_API_KEY`, and `POST /serendipity/enrich?...&limit=1` returns a profile rather than a 400. |
| 2c | Confirm the enrich invocation is separate: its own request id in Workers Logs, and the sync tick's fetch count unchanged apart from the single self-dispatch. |
| 3a | The span carries `budget_exhausted` on a deliberately over-budget tick. |
| 3b | Point the check at the current state before deploying part 1. It must go red on the seven parked events and on the 82-day enrichment gap, because those are real today. A check that passes against today's database is measuring nothing. |

That last row is the one to run first. It is the cheapest way to find out
whether the health check would have caught any of this, and if it comes back
green then it is decoration.
