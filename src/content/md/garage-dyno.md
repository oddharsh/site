# Dyno

The site on the rollers. One row a night records what this site weighs on the
wire: the Worker bundle, the shared client assets, and the pages, each as the
compressed bytes a browser receives. The page charts that series so a slow
drift shows up as a slope rather than as a number nobody re-reads.

**This twin describes the chart rather than mirroring it, because the chart is
drawn from data at request time.** The data is the useful part for a machine
and it is served as JSON:

- `/garage/dyno.json`: `{ generated, source, count, points }`. `points` is the
  whole series, oldest first. A row carries `ts` (the date), `sha` (the commit
  measured) and `worker_gzip` (the Worker bundle in gzip bytes, the number
  wrangler reports). Rows taken by the nightly job also carry `worker_modules`,
  `assets_br` (the shared client assets in brotli bytes, summed) with `assets`
  (the same, per file), `pages_br` and `pages_n` (the documents in brotli bytes,
  summed, and how many), `dcz_n` and `dcz_b` (how many pages ship a
  shared-dictionary delta and what those deltas weigh together), and `dict_br`
  (the page-family dictionary itself in brotli bytes, or null before it
  existed). The earliest rows come from hand notes rather than the job, carry
  only the Worker figure, and say so in `source` and `note`.

## Why a nightly series and not the per-PR diff

Every pull request touching served code gets a wire-size diff against its merge
base, commented on the PR and gating nothing. That catches the STEP a change
makes. It structurally cannot see DRIFT, which is the failure this site actually
had: a byte budget that was breached for weeks while every check printed green,
because each check compared a number against a constant somebody had typed and
the constant had rotted. A series has no constant. Each night's row is compared
with the row before it, and a slope is visible whether or not anyone re-baselined.

## Where the rows live

On a machine-owned branch of the site's repository, `perf-history`, as one JSON
line per night appended by a scheduled job. A branch rather than a database
because the main branch takes no pushes from any workflow and the only database
credential is gated behind a human reviewer for releases; a branch outside both
rules is the one place a nightly job can write without weakening either. The
page only ever reads it, caches it for six hours, and keeps the last good copy
when the read fails, since the value of the chart is the part of the series that
already happened.

`/perf` and `/perf.json` are older names for the same two URLs and redirect here.
