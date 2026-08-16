# Around

A dashboard of the neighbourhood. A cron crawls a roster of crypto venture
homepages, identified as `AadharshBot/1.0 (+https://aadhar.sh/bot)`, and reports
what each one answered.

**This twin describes the surface rather than mirroring it, because the contents
change with every crawl.** The data already ships as JSON, so read that instead
of scraping the page:

- `https://aadhar.sh/around/json` is the current crawl
- `https://aadhar.sh/around/changes.json` is what moved since the last one

## What the JSON carries

The envelope names who fetched it, when, and what signed the requests:

```json
{
  "crawledBy": "AadharshBot/1.0 (+https://aadhar.sh/bot)",
  "crawledAt": "2026-08-12T20:30:20.022Z",
  "signedWith": "https://aadhar.sh/",
  "count": 20,
  "results": [ ... ]
}
```

Each result carries the site's name, the URL asked for, the URL that answered
after redirects, the HTTP status, and the title and description the page
published.

## The crawl is polite, and its gaps are real

Requests are signed per RFC 9421 and the Web Bot Auth draft, with the public key
at `https://aadhar.sh/.well-known/http-message-signatures-directory`. A site can
identify this crawler and decide.

**A site that disallows the crawler is skipped, and a skip is a legitimate
outcome rather than an error.** `count` is the roster size, so a result missing
from the list means that host was skipped or did not answer, not that it was
dropped quietly. Read `status` per entry before treating a title as current.

Nothing here is an endorsement, a ranking, or a portfolio. It is a list of
homepages fetched on a schedule.
