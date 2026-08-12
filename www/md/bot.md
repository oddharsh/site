# AadharshBot

A small, transparent crawler operated by [aadhar.sh](https://aadhar.sh/). If you
see it in your access logs, this page tells you who it is, what it does, and how
to stop it from visiting if you don't want it to.

## Identity

- **User-Agent**: `AadharshBot/1.0 (+https://aadhar.sh/bot)`
- **Signature-Agent**: `https://aadhar.sh/`
- **JWKS**: <https://aadhar.sh/.well-known/http-message-signatures-directory>
- **Algorithm (`sig1`)**: Ed25519 (EdDSA), per RFC 9421 + the Web Bot Auth draft
- **Algorithm (`sig2`)**: ML-DSA-44 (FIPS 204), provisional. See below.
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
key whose `kid` matches, and verify the Ed25519 signature over the canonical
components listed in `Signature-Input`. If verification fails, the request did
not come from this site.

## The second signature

Both header fields are structured-fields Dictionaries, so every request carries
two labels over the same covered components. `sig1` is the Ed25519 signature
described above. `sig2` is a post-quantum
[ML-DSA-44](https://csrc.nist.gov/pubs/fips/204/final) signature whose public key
is the `AKP` entry in the same JWKS, formatted per
[RFC 9964](https://www.rfc-editor.org/rfc/rfc9964.html).

**Verify `sig1`, not `sig2`.** The [IANA HTTP Signature Algorithms
registry](https://www.iana.org/assignments/http-message-signature/http-message-signature.xhtml)
holds six entries and none of them are post-quantum, so `alg="ml-dsa-44"` is this
site's spelling rather than a registered codepoint. It is here because the
migration is cheap now and awkward later, and because a running example is worth
more than a writeup. Treat it as provisional: if a real registration lands with a
different token, this one changes. Ignoring `sig2` entirely costs you nothing,
which is the point. [/garage/pqc](https://aadhar.sh/garage/pqc) has the
measurements and the reasoning.

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
