---
title: "aadhar.sh/garage/pqc: Post-quantum signatures, priced"
description: "This site's TLS key agreement is already post-quantum and its signatures are not. Measuring what ML-DSA-44 and the hash-based alternatives actually cost on the one signature a personal site controls: its own crawler's RFC 9421 request signing."
path: "/garage/pqc"
section: "garage"
kind: "content"
updated: "2026-07-27"
source: "https://aadhar.sh/garage/pqc"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Post-quantum signatures, priced

Half of this site's TLS handshake is already post-quantum and I did nothing to make that happen. The other half, authentication, moves on a completely different schedule, because signatures live in certificates and registries that a personal site does not control. So I went looking for the signature I *do* control, and measured what it would cost to migrate it.

## What is already done, and what it covers

Ask the live site what it negotiated:

```
$ openssl s_client -connect aadhar.sh:443 -groups X25519MLKEM768 -tls1_3

Negotiated TLS1.3 group: X25519MLKEM768
Peer signature type:     ecdsa_secp256r1_sha256
Certificate:             ecdsa-with-SHA256, P-256
```

The key agreement is post-quantum. The certificate and the handshake signature are classical, and they will stay that way for a while: no public CA issues ML-DSA certificates into the WebPKI, and Cloudflare's own position is that ML-DSA chains add roughly 14KB per handshake, which is why they are pushing [Merkle Tree Certificates](https://blog.cloudflare.com/ml-dsa-will-have-to-do/) instead.

That split matters more than it looks. Key agreement is where **harvest now, decrypt later** bites: an attacker recording today's ciphertext can decrypt it whenever a quantum computer arrives, so the migration had to happen years early. A signature has no such property. Forging a 2026 signature in 2035 proves nothing about 2026, because by then the request is long over and nobody is still trusting it. The urgency argument for key agreement simply does not transfer.

## Three tiers of signature, and only one is mine

| Surface | Algorithm | Whose problem |
| --- | --- | --- |
| TLS to visitors | ECDSA P-256 | The CA and browser ecosystem |
| DNSSEC on the zone | ECDSA P-256 SHA-256 | The registry, plus DNS response sizes |
| Booking links, cover URLs | HMAC-SHA256 | Already fine. Symmetric, so Grover halves it to 128-bit |
| AadharshBot request signing | Ed25519 | **Mine.** About 30 lines in one file |

[AadharshBot](https://aadhar.sh/bot) signs every outbound request per [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421) using the Web Bot Auth profile, so receiving sites can check that a request really came from here. That signature is the only asymmetric one this site owns end to end. The whole post-quantum question collapses to it.

## What the candidates actually cost

Cloudflare's runtime has no post-quantum algorithm in WebCrypto. I checked the shipping binary rather than the docs: `workerd` 1.20260722 contains the strings `Ed25519`, `X25519`, and `ECDSA`, and no `ML-DSA` at any parameter size. So this is pure JavaScript, via [@noble/post-quantum](https://github.com/paulmillr/noble-post-quantum), signing the site's real signature base on an M3 Max under Node 26.

Cost of one signature

Flip the toggle before you read on and predict where each bar lands. The point of the exercise is that the ordering *changes*. SLH-DSA-128s has the smallest public key of anything here at 32 bytes, and it takes two and a half seconds to produce one signature. Its sibling 128f signs in 132ms and spends 22KB of header doing it. There is no row that is small on both axes, which is the actual state of post-quantum signatures rather than a quirk of this library.

### How much of that 8.58ms is the algorithm?

Less than it looks, and the panel above will prove it on your own hardware if it can. Chrome ships ML-DSA in WebCrypto behind `chrome://flags/#webcrypto-pqc`, implementing the same [WICG proposal](https://wicg.github.io/webcrypto-modern-algos/) whose JWK shape this site already publishes. If that flag is on, the panel offers a button that generates an ML-DSA-44 key in your browser, signs this page's signature base 200 times natively, and drops the result in as a fifth bar next to the JavaScript number.

This matters for how you read the whole table. The 8.58ms is a *ceiling* set by running a lattice scheme in a JIT, and the byte counts underneath it are properties of FIPS 204 that no implementation will improve. Sizes are the permanent cost. Speed is the temporary one, and it goes away on its own when the runtimes catch up.

## Why the hash-based options lost

I wanted SLH-DSA to work. It rests on hash functions alone, so it survives even if lattices turn out to be broken, and its 32-byte public key is charming. It fails here twice over.

The header is the harder failure. A 128f signature is 22,784 bytes once base64'd into a structured-fields value, and most servers cap total request headers around 8KB, so the crawl would start collecting 431s instead of pages. The latency is the other one: 2.5 seconds of single-threaded work per signature is not something to put in front of an HTTP request, and a Worker bills CPU time.

Stateful hash-based signatures (LMS, XMSS) fix the size problem and introduce a worse one. Reusing a one-time index is total key compromise, and a Worker isolate is close to the worst place to keep a monotonic counter. I would need a Durable Object doing nothing but handing out indices, and a single replay would end the key. ML-DSA-44 is the only candidate that survives contact with the constraints.

## Shipping it without a codepoint

Here is the part that made this cheap. The [IANA HTTP Signature Algorithms registry](https://www.iana.org/assignments/http-message-signature/http-message-signature.xhtml) has exactly six entries, and every one of them is classical. Cloudflare's Web Bot Auth verifier accepts Ed25519 only and ignores other key types in your directory. An ML-DSA-only signature would be a header nobody on the internet checks.

But `Signature-Input` and `Signature` are structured-fields *Dictionaries*. A second label appends rather than replaces, so both signatures ride the same request over the same covered components:

```
Signature-Input: sig1=("@authority" "signature-agent");created=1785186311;
                   keyid="rn-2026-06-30";alg="ed25519";tag="web-bot-auth",
                 sig2=("@authority" "signature-agent");created=1785186311;
                   keyid="rn-mldsa-2026-07-27";alg="ml-dsa-44";tag="web-bot-auth"
```

A verifier that only knows Ed25519 reads `sig1` and skips the label it does not recognise. Nothing breaks, and the cost of ignoring `sig2` is zero. That property is what makes it defensible to ship an algorithm the registry has not blessed. The token `ml-dsa-44` is this site's spelling, chosen to match the registry's existing convention so it slots in if a real registration lands, and [/bot](https://aadhar.sh/bot) says plainly that you should verify `sig1` and ignore `sig2`.

The public key is published under the same JWKS as an `AKP` key per [RFC 9964](https://www.rfc-editor.org/rfc/rfc9964.html), which standardised ML-DSA for JOSE and COSE in May 2026. So the key format is a real standard even though the wire token is not:

Live, from this site's key directory

reading /.well-known/http-message-signatures-directory…

## What it costs in production

About 8.6ms of CPU and 3,228 bytes of request header per signed fetch, plus 11.96KB gzip of lattice code in the Worker bundle, which is the price of carrying an implementation the runtime should be providing. Zero bytes reach a browser, because this is a server-to-server signature and no page loads it. The [/around](https://aadhar.sh/around) crawl signs roughly 21 origins per refresh, so a full cycle gains around 180ms of CPU on a cached background path.

Two of those three costs are temporary. When `workerd` gains native ML-DSA, the bundle cost goes to zero and the signing cost drops to whatever the native bar in the panel above showed you. The 3,228 bytes of header stay forever. That asymmetry is the argument for migrating on the size budget now and letting the speed sort itself out.

One implementation detail worth stealing: ML-DSA-44 keygen expands a 32-byte seed into a 2,560-byte secret key and costs about 1.4ms. Worker isolates outlive a request, so the expanded key is derived once and cached in module scope, keyed by the raw secret so a rotation inside a live isolate re-derives instead of signing with a retired key.

## The objection I think is right

The strongest reading of this page is that it is theatre. Nothing verifies `sig2`. Signatures have no harvest-now-decrypt-later exposure, so there is no clock forcing the migration. By that argument the honest move was to write the analysis and ship nothing.

I mostly agree, and it is why `sig2` is second rather than first, why a missing key degrades to Ed25519 alone instead of failing the request, and why [/bot](https://aadhar.sh/bot) tells verifiers to ignore it. What I get in exchange is a migration already paid for and measured, on a surface where being wrong costs a crawl rather than a login. When the registry does land a codepoint, the remaining work is renaming a string.

What would change my mind: a receiving server rejecting requests because the extra 3.2KB pushes headers past its limit, or a verifier that chokes on a dictionary label it does not know. Either result would mean a second label is not free after all, and `sig2` would come straight back out. The crawl logs are where that would show up first.

shipped · the understanding check is part of the page, not a gate

Source: https://aadhar.sh/garage/pqc
