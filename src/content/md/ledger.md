# The Crawl Ledger

AI crawlers read this site all month and nobody pays. The ledger does the
arithmetic anyway: every identified crawler hit on a Worker-served route,
priced at the same one cent `/llms-full.txt` charges, over a trailing
30 days. It's the uncollected revenue of one small site on the open web,
itemized as an invoice.

**This twin describes the invoice rather than mirroring it, because the line
items change with every crawl.** The page is built once per deploy, and the
line items, the total and the cost line arrive after load from
`/ledger/lines.html`, an HTML fragment. The same numbers ship as JSON, so read
that instead of scraping the page:

- `https://aadhar.sh/ledger.json`: `{ ok, window_days, rate_usd, note,
  line_items, total_hits, total_usd, cost }`. Each line item carries `bot` (the
  user-agent name), `owner` (the operator), `kind` (`search`, `train` or
  `answers`), `hits` and `amountUsd`. The rate is $0.01 a page.

## Terms and honesty notes

- Only Worker-served requests are countable. Static files served straight from
  the edge never wake the Worker, so the true crawl count is higher than this.
- Identity is self-reported: a row is a user-agent claim rather than a verified
  signature. A bot that lies about its name bills to nobody.
- The rate is this site's posted price (the `/llms-full.txt` cent), and it
  isn't a market quote. Robots policy and Content Signals live in
  `https://aadhar.sh/robots.txt`. Reading here is welcome; the invoice is the
  point being made.
- The `cost` block is the only figure that changed hands, and it's
  account-wide: every product on this Cloudflare account over the same window.
  Billing lands daily with no per-request identity, so it's never split per bot.
  Coverage is whatever Cloudflare bills through that feed, which leaves out
  Analytics Engine, Browser Run and KV, so read it as a floor. When the billing
  read fails, `cost.available` is false and `cost.reason` says why.
