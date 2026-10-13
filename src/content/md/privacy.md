# Privacy

What a visit to this site leaves behind, read from its code on 2026-10-13.
There are no ads, no analytics scripts and no third-party trackers, and
nothing here is sold or shared for marketing.

## Every request

When the site's Worker answers a request, it writes one log line: the path
(without the query string), the method, the status, how long it took, the
deployed version, your country, the HTTP protocol, the name of a verified bot
when Cloudflare identified one, and the client name an MCP connection
declares. It does not write your IP address, user agent or cookies. Static
files served straight from Cloudflare's edge do not produce this line.

The site runs on Cloudflare, with Workers Logs and Traces on for every
request. Cloudflare's own records of a request can hold more than the line
above, such as the full URL and your user agent. Workers Logs keep 3 days of
history on this plan. Your IP address is also used, without being stored, to
apply per-minute rate limits and to keep you on one deployed version during a
release.

## Counters

Three counters in Cloudflare Analytics Engine record no IP address and no user
agent string: visits by identified AI crawlers (the crawler's name and the
page path), pages that answered 404 (the path, and a coarse caller class such
as `browser` or `http-tool`), and browser prefetches of a page (the path).
[/ledger](https://aadhar.sh/ledger) publishes the first one. The homepage
visit counter stores a single number.

## Cookies and browser storage

The site sets one cookie, `serendipity-uid`, and only on
[/serendipity](https://aadhar.sh/serendipity) pages when you open an event or
contribute one. It is a random id, `HttpOnly`, scoped to `/serendipity`, and
lasts two years. Some pages keep your preferences in your browser's own
storage (sound on or off, tooltips, the Lens view, quiz scores, scroll
position). That never leaves your device. Pages load scripts, styles, fonts
and images from this site only, so your browser talks to no third party while
you read.

## When you send something

- **A coffee booking** ([/coffee](https://aadhar.sh/coffee)): your name,
  email, topic, optional neighborhood and the slot. It is stored for 90 days
  after its last change and emailed, through Resend, to me and to you.
- **A webmention**: the source and target URLs, the author's name and URL, the
  title and an excerpt. Cloudflare Workers AI checks it for spam, and it is
  emailed to me. It is deleted when I decline it or the source stops linking
  here.
- **A question** to [/ask](https://aadhar.sh/ask) or an
  [/lwe](https://aadhar.sh/lwe) explainer: it goes to Cloudflare Workers AI
  through Cloudflare AI Gateway, which logs requests. Answers to explainer
  questions are cached for 24 hours.
- **A URL scanned with [/lens](https://aadhar.sh/lens)**: the target's host is
  recorded in traces, results are cached for up to 6 hours, and the Cloudflare
  readiness score sends the URL to isitagentready.com. In your browser, Lens
  frames the page you scanned, so that site sees your visit like any page you
  open.
- **A representation capture** (an MCP tool): the URL and its normalized
  response headers, never the body, with no record of who asked.
- **[/whoareyou](https://aadhar.sh/whoareyou)**: to name your network, the
  server sends your IP address to ARIN's public RDAP service, and Cloudflare
  caches that answer for 24 hours.

## Serendipity

[/serendipity](https://aadhar.sh/serendipity) is a pool of events and who is
going. A person who contributes an event lends the site their Luma session,
and the stored cookies are used to re-read that event's guest list every six
hours. Contributors choose a label that is shown publicly. Guests' names,
short bios, avatars and social handles from those Luma lists are shown on
event pages, and their email addresses are stored but never shown. Code also
exists to look up a guest's public profile through Exa or Parallel, and
neither service is configured.

## Removal and questions

To have a booking, a webmention, a contributed event or a guest listing
removed, or to ask anything about this page, write to coffee@aadhar.sh.
