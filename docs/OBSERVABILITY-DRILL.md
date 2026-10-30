# Observability drill

`bun run controls` (PR #1487) plants each guard's defect in a clone and fails
when the guard stays green, because guards here had gone blind for up to 60
days with nobody noticing. Production alerting has the same blind spot one
layer out. Nobody has shown that a real exception today becomes a GitHub
issue, or that spans and Analytics Engine rows still arrive. This document
designs the same control for that path: plant a known fault in production and
require every signal to report it.

It has two halves. The read-only half (`bun run observe:check`) ships now and
plants nothing. The planting half is a design, and nothing in it gets built or
deployed until the owner says yes.

## What the read-only half found (2026-10-30)

```text
observe:check, last 7 days to 2026-10-30T14:09:55Z
  FIRED      invocations           34178
  SILENT     exceptions            0 thrown; Issues also records caught errors and 5xx responses
  FIRED      workers logs          51430
  FIRED      workers issues        3, last 2026-10-30T12:43:55.950Z
  BROKEN     issues automation     0 configured, so 3 exception Issues went nowhere
  BROKEN     github workers-issue  0, after 3 exception Issues
  FIRED      span cron.home_probe  330 of 336 expected, 4 in the last 2h
  FIRED      ae PERF_PROBE         336 of 336 expected, 4 in the last 2h
  FIRED      ae BOT_LEDGER         6885, 735 in the last 24h
```

(The invocations row comes from a run a few minutes earlier; GraphQL's rate
limiter refused this one, and the row printed UNREADABLE as it should.)

1. **The break is the missing automation.** Workers Issues has recorded
   faults since #1062 turned it on (2026-09-30): 15 active Issues on
   aadhar-sh, 3 of them exceptions seen this week. The worst is "Too many
   subrequests by single Worker invocation" on `/rn/tracks.html`, 353
   occurrences since 2026-09-30, the latest at 12:43 UTC today. `cf
   observability issues automations list` answers `[]` for the account and
   for aadhar-sh. With nothing routing them, no Issue has ever reached the
   triage routine, which is why the `workers-issue` label has never been
   applied. Setup was a four-step runbook across two web UIs (#1081,
   2026-10-01). #1126 cut it out of CLAUDE.md three days later. It's back in
   `docs/MAINTENANCE.md` under "Route Workers Issues to GitHub".
2. **GraphQL undercounts faults.** It counts invocations that ended in a
   thrown exception: 13 in 30 days, all crons, the last on 2026-10-14. Issues
   also counts caught errors and 5xx responses, so it saw the subrequest bug
   353 times. The chain's upstream is Issues whenever Issues is readable.
3. **The cf login reads everything but GraphQL.** Under the `cf` CLI's login,
   the SQL API answers `logs.workersLogs`, `logs.traces` and the Analytics
   Engine datasets, and the Issues and automations APIs answer too. Under the
   wrangler login every `logs.*` dataset answers `403 Authorization error`,
   because no wrangler OAuth scope grants observability reads. `cf` has no
   GraphQL command, so invocations still read with `CLOUDFLARE_API_TOKEN` or
   the wrangler login. CI's `site-ci-read` token has neither.
4. **Analytics Engine and traces are healthy.** PERF_PROBE wrote 336 of the
   336 rows the :07/:37 cron should write in 7 days, and Traces holds 330
   `cron.home_probe` spans. Both had 4 in the last 2 hours, one per tick.

Read the numbers with three caveats:

- The SQL API weights `COUNT(*)` by sample interval. BOT_LEDGER reads 6,885
  for 7 days, where the Analytics Engine SQL API's unweighted `count()` read
  4,064 rows on 2026-10-29. The verdicts only compare a count to zero or to a floor,
  so either reading gives the same answer.
- A newest-timestamp read over a long window is wrong on traces. Over 7 days,
  `APPROX_MAX` and `ORDER BY startTime DESC LIMIT 1` both put the newest
  `cron.home_probe` span at 11:07, on three reads running. A 2-hour read
  listed spans at 11:37 through 14:07. Freshness is therefore a count over a
  short window, never a timestamp.
- Workers Logs and Traces keep 7 days, so `--days 30` reads 7 days of them.
  The span floor is capped at 7 days to match.

## The chain, link by link

The drill sends one request that throws a recognizable error inside a named
span. Every link below has to report that one fault, by its id, within a
deadline. The id is a UTC minute (`20261030T0300Z`), so each run is distinct
and can't collide with real error text.

### 1. Worker exception

- **Plant.** `POST /_drill/observe` with `x-drill-token: <DRILL_TOKEN>` and
  `x-drill-id: <id>`. The handler opens `span("drill.observe", ...)` with the id
  as an attribute and throws `new Error("observability-drill <id>")` inside it,
  uncaught. The gate is `secretMatches()` from `lib/http.ts`, which fails
  closed when the secret is unset, so the route answers 404 until the owner
  sets `DRILL_TOKEN`. The id must match `^\d{8}T\d{4}Z$` or the route answers
  400 and throws nothing.
- **Read back.** The drill runner's own response: HTTP 500.
- **Expected words.** Status `500`.
- **Cost.** 1 invocation, a few milliseconds of CPU.
- **Blast radius.** One 5xx in the error-rate graph. POST means
  `lib/preview.ts` refuses it on every preview URL, so a drill can only reach
  production. It writes no KV, D1, R2 or Analytics Engine row.

### 2. Workers Logs

- **Plant.** Nothing extra; the throw produces the exception log.
- **Read back.** `logs.workersLogs` through the SQL API:
  `scriptName = 'aadhar-sh' AND message LIKE '%observability-drill <id>%'`.
- **Expected words.** `observability-drill <id>` in `message` or `error`.
  Deadline 10 minutes.
- **Cost.** 2 to 3 events (the invocation log and the exception) against
  200,000 a day, about 0.0015%.
- **Blast radius.** None past the dashboard.

### 3. Workers Traces

- **Plant.** The `drill.observe` span from link 1. It goes through
  `lib/trace.ts` like every other span, so a drill that reads back proves the
  injected tracer is still installed, which is the failure `trace.ts`'s header
  worries about.
- **Read back.** `logs.traces`: `spanName = 'drill.observe'` with
  `attributes['drill.id'] = '<id>'` and a non-empty `error`.
- **Expected words.** `drill.observe`, the id, and `observability-drill <id>`
  in `error`. Deadline 10 minutes.
- **Cost.** 2 to 4 spans (handler, `route` span, `drill.observe`).
- **Blast radius.** None. Adding `drill.observe` to `span-vocabulary.ts` is the
  only type change.

### 4. Workers Issues

- **Plant.** Nothing extra. An uncaught exception and a 5xx are both
  occurrences by Cloudflare's definition.
- **Read back.** `logs.issues`: `errorMessage LIKE '%observability-drill <id>%'`.
- **Expected words.** `observability-drill <id>`. Deadline 15 minutes.
- **Cost.** 1 occurrence. Issues' price on Workers Free is undocumented
  (`cloudflare.config.ts` says the same), so the first drills double as a
  measurement: watch events/day on the Observability dashboard.
- **Blast radius.** One "observability-drill" issue in the Issues dashboard,
  grouped with every later drill.

### 5. Claude Code routine

- **Plant.** Nothing in the Worker. The routine prompt gets a step 0, written
  in `docs/routines/workers-issue-triage.md` first and pasted second:

  > If the error message starts with `observability-drill `, this is a drill.
  > Do not investigate. Find the one issue labelled `workers-issue-drill`, open
  > or closed; if none exists, open it titled "workers-issue drill receipts"
  > and close it. Add one comment: `drill <id> received <ISO time>`. Leave it
  > closed and stop.

- **Read back.** The routine's run log through the trigger API
  (`list_runs`, then `get_run_log`), when the routine id is known.
- **Expected words.** The comment text in the run's final result.
- **Cost.** 1 routine run per drill, a few minutes of a cloud session. It
  counts against the account's routine allowance.
- **Blast radius.** The step sits above dedup, so a drill can never reopen a
  real `workers-issue` as a "regression", and the closed receipts issue never
  shows in the open list.

### 6. GitHub issue

- **Read back.** `gh api repos/oddharsh/site/issues/<receipts>/comments`,
  searching for the id.
- **Expected words.** `drill <id> received`. Deadline 30 minutes.
- **Cost.** 1 comment. The owner gets one notification per drill until they
  unsubscribe from the receipts issue.
- **Blast radius.** One closed issue that grows a comment a week. No new issue
  per drill and nothing a human has to close.

### 7. Analytics Engine (PERF_PROBE, BOT_LEDGER): no plant

Planting a row here costs more than it proves. A drill row in BOT_LEDGER
would show up on `/ledger.json`'s public bill, and one in PERF_PROBE would
skew the latency series. Both datasets already carry a stronger signal.
PERF_PROBE must write 48 rows a day from the cron, and BOT_LEDGER takes
hundreds of organic writes a day. `observe:check` holds PERF_PROBE to half its
cadence plus a 2-hour staleness limit, and holds BOT_LEDGER to a row in the
last 24 hours. The same cadence rule covers the `cron.home_probe` span, so the
trace link gets a check that fires 48 times a day between drills.

## How a drill runs

`bun run observe:drill` from the workstation, the same way `bun run controls`
runs: it plants link 1, polls links 2, 3, 4 and 6 until each reads back or its
deadline passes, and prints one line per link. Each line says CAUGHT, BLIND
(deadline passed with nothing), or WRONG (something arrived without the id).
It exits 1 on anything but CAUGHT. It never polls faster than once a minute.
GraphQL's rate limiter refused this session's queries after about a dozen
reads in a few minutes. The SQL API answered about 25 reads in 10 minutes
through `cf` without refusing one, so the polling belongs there.

Every 8 days. #1081's runbook sets the automation to fire on the first
occurrence and again only after 7 quiet days, so a drill that reuses one
Issues fingerprint has to wait longer than that or the routine never sees it.
The longest guard blindness #1487 found lasted 60 days, and an 8-day cadence
catches that class of failure about seven times sooner. It needs no Workers
cron slot, and all five are taken. A GitHub Actions schedule could run it
later, once CI holds a token that can read observability data.

## Cost per drill and per year

| | per drill | per year (every 8 days) |
|---|---|---|
| Worker invocations | 1 | 46 |
| Observability events (logs + spans) | under 10 | under 460, against 200,000 a day |
| Issues occurrences | 1 | 46 |
| Routine runs | 1 | 46 |
| GitHub comments | 1 | 46 |
| Read-back queries | about 10 SQL, 1 GitHub | about 510 |

## Blast radius, worst case

- **The token leaks.** Anyone holding `DRILL_TOKEN` can make the Worker throw
  on demand. Each throw costs under 10 observability events and one routine
  run. A Rate Limiting binding on the route (1 per 10 minutes, the same
  mechanism as `LENS_RL_*`) caps that at 144 routine runs a day. Rotating the
  token stops it.
- **The routine misreads a real error as a drill.** The prefix
  `observability-drill ` followed by a 14-character id appears nowhere in this
  codebase's error text, and step 0 matches only at the start of the
  message.
- **The drill route breaks something else.** It owns one path, reads two
  headers and throws. The real cost is a `run_worker_first` row: 96 of the
  100 wrangler allows are in use (2026-10-29, gotcha 26), so this route would
  leave 3. Folding it under an existing wildcard would cost none, and the
  route list's fold rules say whether one fits.

## What the owner decides

1. **Configure the automation, before any drill.** The runbook in
   `docs/MAINTENANCE.md` has the steps. The drill can't prove a route that
   doesn't exist, and this break needs no drill to see: `observe:check` reads
   it today. `cf observability issues automations create` now exists, but it
   takes a `policy-id` for the destination, and the Claude Code destination
   with its routine token is still made in the dashboard.
2. **Decide what to do about vulnerability scans.** 12 of the 15 active Issues
   are scanner traffic (type `security`: wordpress, secret-files,
   source-control probes), and they recur daily. The automation API shows no
   type filter (2026-10-30). If the dashboard has none either, each scan Issue
   fires the routine once and opens a `workers-issue` about a scanner. A line
   in the routine prompt that closes `Potential vulnerability scan` Issues
   without investigating would cover it.
3. **Build the drill.** That means the route, `DRILL_TOKEN` (set with
   `bun run wrangler:site versions secret put`, then promoted), the routine's
   step 0, and `observe:drill`. The route ships through a normal PR and the
   release path. No drill runs before that PR merges and the owner says go.
   It reads back with the `cf` login, so it needs no new token. Running it
   from CI would need an observability read group on `site-ci-read`.

## Open questions the first drill answers

- Does Issues group every drill into one fingerprint? The id varies the
  message, but Issues may group on the stack. If it does, the 7-day recurrence
  rule above is what re-arms the routine, and the 8-day cadence holds. If
  each id makes a new fingerprint, every drill fires as a new issue and the
  cadence could shorten.
