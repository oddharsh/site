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

This is Aadharsh Pannirselvam's bot for [aadhar.sh](https://aadhar.sh/), running on
Cloudflare Workers. The [/around](https://aadhar.sh/around) dashboard checks a
small list of public homepages daily. The music and reading sections fetch
public playlist metadata and bookmarks. [/lens](https://aadhar.sh/lens) fetches
public pages and discovery documents when a visitor asks to inspect a URL, and
can read published MCP tool catalogues and NLWeb answers.

Content is used for linked references, metadata, and on-demand inspection.
It is not used to train or fine-tune AI models or build a search index.
Requests use bounded fan-outs and cached results. The bot does not log in to
third-party sites or read content behind a login.

Lens also compares responses to sample browser and crawler User-Agent strings.
Those diagnostic requests do not claim a Web Bot Auth identity for the sampled
bot, and still obey AadharshBot's robots.txt policy.

## How to verify it is really AadharshBot

Requests made as AadharshBot carry `Signature-Agent`, `Signature-Input`, and `Signature`
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

Before fetching third-party content, AadharshBot reads that origin's `robots.txt`
(cached for up to 12 hours). It skips paths disallowed for `AadharshBot` or `*`,
including redirect destinations. If the policy is unreachable, rate-limited,
or too large to read safely, the fetch is skipped. A positive `Crawl-delay`
also makes this bot skip the origin. These rules apply to scheduled crawls and
visitor-requested Lens HTTP reads. If you have a question or a complaint, email
coffee@aadhar.sh and I will reply by hand.
