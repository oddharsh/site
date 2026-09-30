# The census

Every per-URL scan in The Other Web (`https://aadhar.sh/lens`) is a sample of
one. The census is the population over time: 16 representative sites,
re-scanned weekly, so the agentic web's movement shows up as a series rather
than as one reading.

**This twin describes the table rather than mirroring it, because the rows
change with every sweep.** The page is built once per deploy, and the table
arrives after load from `/lens/census/table.html`, an HTML fragment. The same
data ships as JSON, so read that instead of scraping the page:

- `https://aadhar.sh/lens/census.json`: `{ ok, roster, snapshots, firstYmd,
  lastYmd, sites }`. `roster` is how many sites the census tracks, `snapshots`
  how many sweeps it holds, and `firstYmd` and `lastYmd` the dates of the
  oldest and newest.
- Each site carries `host` and `url`, its latest `tier`, `score`, `level`,
  `doors` and `verdict`, a `delta` in score across the series, the discovery
  `surfaces` it published (llms.txt, a Markdown twin, an MCP server, an agent
  card, JSON-LD, Web Bot Auth), and `series`, one `{ ymd, score, tier, doors }`
  per sweep, oldest first.

Read `lastYmd` before treating a row as current: it's the date of the newest
sweep, and a sweep that didn't run leaves the previous one in place.

## What the columns mean

- **terms**: the spectrum tier, read from the site's published policy toward
  crawlers and AI use.
- **readiness** and **level**: the agent-readiness score out of 100 and the
  level it maps to. Either is null where a scan couldn't compute it.
- **doors**: how many agent doors (an MCP server, an llms.txt, a Markdown twin
  and the like) answered.

Every request is made by `AadharshBot`, identified and signed. A sweep that
can't read a site writes no row for it that day, so a series can have gaps.
