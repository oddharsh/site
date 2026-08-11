# System Properties

A transparency page. It shows what a single HTTP request from your client
reveals to this site. None of it is logged, none of it is stored. Close the tab
and it is gone.

**The page is per-request by nature, so this twin describes it rather than
mirrors it.** The live page fills each section from your own connection; there
are no fixed values to publish here. For the machine-readable form of exactly
what your request revealed, request
<https://aadhar.sh/whoareyou.json>, which returns the same fields as JSON.

## What the live page shows

- **Network adapter**: the IP that connected, its ASN and network operator, and
  the coarse geo the edge resolves it to. Enriched by one server-side RDAP
  lookup against your IP's registry.
- **Transport and security**: HTTP version, TLS version and cipher, and whether
  the connection was reused.
- **Edge Trace**: seven fields Cloudflare's edge knows about the connection that
  the Worker itself is never told. Your browser fetches these from
  `/cdn-cgi/trace` on this same origin.
- **Computer**: what the `User-Agent` and client hints claim about your device,
  operating system, and browser.
- **This session**: cookies, language hints, referrer, and `DNT`.

## What this site cannot see

- **Your DNS resolver or protocol.** Your resolver answers the name before the
  request reaches this site, so only the connecting IP is visible. HTTP/3 implies
  a modern network stack that probably speaks DoH, but that is an inference; the
  request never carries your resolver.
- **Your real identity**, unless you have said so. An IP is not a name.
- **The rest of your browsing.** One request is visible, nothing else.
- **The contents of any encrypted data outside this HTTP session.** TLS is doing
  its job.

## Making it leak less

- Use a VPN or Tor. Either changes your IP, ASN, and geo; Tor also anonymizes
  most fingerprintable details.
- Use a private browsing window. It drops cookies and language hints, somewhat.
- Send `DNT: 1`, or use a browser that does. Almost no servers honor it, but it
  is still a signal.
- Strip the user-agent. Some browsers and extensions let you fake or hide it,
  which shrinks your fingerprinting surface.

## About the page

The Cloudflare edge renders it, and your browser never speaks to a third party.
There are exactly two outbound calls: one server-side RDAP lookup to your IP's
registry, which the edge caches for 24h so visitors from the same block do not
re-hit ARIN, and the Edge Trace section's fetch of `/cdn-cgi/trace`, which your
own browser makes to this same origin. The data lives for as long
as it takes to render, then nothing writes it to storage.

One script on every page is not mine: since 2026-08-06 the Cloudflare edge injects
`<script type="module" src="/.webmcp/bridge.js">` into every HTML document here, after
this worker has finished with it. It is 47KB of Cloudflare's code, served from this
origin, and it is the reason View Source shows a tag no file in the repository
contains. What it does: if your browser implements `document.modelContext` (today that
means Chrome 146 with experimental web platform features on) it reads this site's own
`/mcp` server and registers those tools into the page, so an agent browsing here can
call them instead of scraping. Every other browser, which is nearly all of them,
downloads it, finds no such API, writes one warning to the console, and stops. So the
honest description is that most visitors pay 47KB for nothing, and the site is betting
that changes.

Analytics: none. No page loads a Web Analytics or RUM beacon, and this Worker exposes
no browser-timing collector. Page-load timings are not sent to Cloudflare.
