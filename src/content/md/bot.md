# AadharshBot

A small, transparent crawler operated by [aadhar.sh](https://aadhar.sh/). If you
see it in your access logs, this page tells you who it is, what it does, and how
to stop it from visiting if you don't want it to.

## Identity

- **User-Agent**: `AadharshBot/1.0 (+https://aadhar.sh/bot)`
- **Signature-Agent**: `https://aadhar.sh/`
- **JWKS**: <https://aadhar.sh/.well-known/http-message-signatures-directory>
- **Algorithm (`sig1`)**: Ed25519 (EdDSA), per RFC 9421 + the Web Bot Auth draft
- **Operator**: coffee@aadhar.sh

## What it does

It fetches small numbers of public homepages on demand, mostly out of curiosity.
The [/around](https://aadhar.sh/around) dashboard shows what it currently looks
at. It reads only what is publicly served, and it respects `robots.txt`. It does
not submit forms, log in, or scrape behind a login. Results are cached in
Cloudflare KV for at least an hour so it does not re-hit the same URL repeatedly.

## How to verify it is really AadharshBot

Every request carries `Signature-Agent`, `Signature-Input`, and `Signature`
headers per [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) with the Web Bot
Auth profile (`tag="web-bot-auth"`). Fetch the JWKS at the URL above, find the
key whose `kid` matches (the kid is the key's RFC 7638 thumbprint), and verify the Ed25519 signature over the canonical
components listed in `Signature-Input`. If verification fails, the request did
not come from this site.

## The second signature, retired

Between 2026-07-27 and 2026-08-15 every request carried a second label, `sig2`, a
post-quantum [ML-DSA-44](https://csrc.nist.gov/pubs/fips/204/final) signature over
the same covered components. It is gone, and its public key has been removed from
the JWKS, so a request from this bot now carries `sig1` alone.

It was removed for its CPU cost. Cloudflare's runtime has no ML-DSA in WebCrypto,
so signing ran in pure JavaScript at roughly 8.5ms per request, against a 10ms
per-invocation budget. One signature spent most of a request, and anything that
fans out spent several requests' worth: the playlist scrape signs once per track,
and the [/lens](https://aadhar.sh/lens) discovery pass signs 28 probes. Both were
failing because of it. Nothing on the internet verified `sig2`, so dropping it
costs no verifier anything. [/garage/pqc](https://aadhar.sh/garage/pqc) has the
measurements and the full argument.

## How to opt out

Add this to your `robots.txt`:

```
User-agent: AadharshBot
Disallow: /
```

Before the [/around](https://aadhar.sh/around) crawl fetches a site, AadharshBot
reads that site's `robots.txt` (cached briefly per origin) and skips any path
`Disallow`ed for `AadharshBot` or `*`. A site whose `robots.txt` it cannot read
is skipped that cycle rather than crawled. If you have a question or a complaint,
email coffee@aadhar.sh and I will reply by hand.
