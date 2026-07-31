---
title: "aadhar.sh/garage/compression teardown"
description: "Shipping brotli q11 and zstd shared-dictionary deltas on this site: what the edge actually does with Accept-Encoding, the three platform limits that turned out innocent, the one-line bug that impersonated all of them, and why the deltas ship as dcz instead of dcb."
path: "/garage/compression"
section: "garage"
kind: "content"
updated: "2026-07-27"
source: "https://aadhar.sh/garage/compression"
---

> Site index: https://aadhar.sh/llms.txt
> Section index: https://aadhar.sh/garage/llms.txt
> This is the Markdown twin of a page on aadhar.sh. The HTML at the source
> URL below is the original, and is hand-written and unminified on purpose.

# Compression teardown

Putting a site behind a CDN is supposed to end the compression conversation. The edge negotiates, the edge compresses, you stop thinking about it. That held here for a year, and then I measured it: the edge was handing browsers **more** bytes than its own second choice would have, and compressing at roughly a third of the effort the same algorithm can reach offline.

Fixing that took four rounds, three of which I spent blaming the platform for a bug in my own code. This page keeps the wrong turns, because the wrong turns are the reusable part.

## What the edge was actually doing

Cloudflare prefers zstd when a browser offers everything. Reasonable default. On this site it lost to brotli on every asset I checked, because these are small text documents and brotli's static dictionary is tuned for exactly that:

| document | raw | what browsers got | brotli q11, offline | gap |
| --- | --- | --- | --- | --- |
| homepage | 47,399 | 13,264 zstd | 10,524 | 20.7% |
| /lens | 40,923 | 11,625 | 8,835 | 24.0% |
| nav.js | 46,268 | 15,909 | 13,047 | 18.0% |
| luna.css | 36,980 | 9,522 | 7,590 | 20.3% |

Two separate losses hide in that table. The edge picked the weaker algorithm, and it compressed at about quality 4, because it is compressing on the fly for everyone and cannot afford quality 11. Neither is a mistake on Cloudflare's part. Both are recoverable by a site small enough to compress its own bytes ahead of time.

## Three limits that turned out innocent

Serving my own pre-compressed bytes from a Worker produced brotli inside brotli: a body that decodes once into more compressed bytes, which no client can read. I diagnosed that three times and was wrong three times. Each suspect was a *real* behavior, which is what made them so convincing:

1. **A Worker cannot read the client's Accept-Encoding.** True, and worth knowing. Four requests sending `identity`, `br`, `gzip` and `br;q=0` all arrived at the Worker as `"gzip, br"`. The runtime normalizes it, so any `if (acceptsBrotli(request))` branch is dead code that always takes the true arm.
2. **The edge does not down-convert.** Also true. Hand it brotli, ask as a client that cannot decode brotli, and you get raw brotli anyway. So negotiation cannot be faked from behind either.
3. **The static-assets layer re-compresses.** False, and I built a whole parallel `/abr/` path to route around it before finding out.

What finally isolated it was deleting every variable: a 30-byte brotli constant, built in the Worker, touching no assets at all. It came back as 34 bytes in two layers. With no asset fetch in the path, the assets layer was exonerated and the bug had to be mine.

## The actual bug, which was one line long

Cloudflare's `encodeBody: "manual"` tells the runtime a body is already encoded, so leave it alone. It is **write-only** Response init. There is no getter. So this, which every response on the site passed through, silently discarded it:

```
return new Response(response.body, {
  status:     response.status,
  statusText: response.statusText,
  headers,          // encodeBody is gone, and content-encoding survives
});
```

The runtime then saw a `content-encoding: br` header on a body it believed was raw, and helpfully compressed it to match. Because a security-header wrapper rebuilt every response, `manual` had never worked anywhere on this site, and the symptom looked exactly like a platform that refuses to serve pre-compressed bodies. I had written that conclusion into the repo's own notes before disproving it.

The generalizable rule: **anything that rebuilds a Response must carry `encodeBody` forward.** Since there is no getter, the loss is invisible at the call site, and the damage surfaces one layer downstream wearing someone else's clothes.

## Deltas, and why they ship as dcz

With the emit path fixed, shared dictionaries became reachable. Every shell asset is served with `Use-As-Dictionary`, so a returning Chromium visitor sends back the SHA-256 of the copy it already holds, and the build has already computed the diff against it. A CSS change costs 116 bytes instead of 7,615.

RFC 9842 defines two encodings for this, and Cloudflare passes both through identically, so the choice is free and purely about engineering. Brotli is nominally smaller. zstd decodes about twice as fast:

| measure | dcb (brotli) | dcz (zstd) |
| --- | --- | --- |
| the real luna.css delta | 79 bytes | 80 bytes |
| source-level deltas, larger | 5-8% smaller | n/a |
| decode, bare 46KB asset | 0.094 ms | 0.046 ms |
| throughput | 471 MB/s | 954 MB/s |

I argued for brotli on bytes and got talked out of it, correctly. Bytes are a proxy; latency is the thing you actually want. And the byte case collapses on inspection: on the pair this site really ships, brotli wins by *one byte*. The 5-8% edge only appears on much larger deltas than a shell asset produces. Meanwhile the decode numbers came off a fast laptop, so the gap widens on the phones that need it most.

dcz's framing is the tidier of the two as a bonus. The dictionary hash rides in a Zstandard *skippable frame*, which is valid zstd, so any conforming decoder steps over it without special handling. dcb needs bespoke treatment of its 36-byte prefix.

Cloudflare runs a live demo of the mechanism at [canicompress.com](https://canicompress.com): a 94KB mock SPA bundle redeployed every minute, each version delivered as a delta against the one before. Running its curl recipe from this laptop gave 95,425 bytes raw, 21,702 through gzip, and **134 as dcz**. That is 162x under gzip, and it lands in the same couple of hundred bytes as a change to this site's far smaller stylesheet, because a delta is priced by what changed rather than by what the file weighs.

The two do the work in different places. Cloudflare's edge holds the dictionary and computes each delta on demand, so the encoder runs per request; here the build computes it once and the Worker only has to pick the right file. The demo lands on dcz too, which is some outside evidence for the call above.

## One more over-generalization

Dictionary compression is unreachable from Node's zlib, so the deltas started life as a workstation script with committed artifacts. That sentence is true of brotli. I applied it to zstd without checking, and `zstdCompressSync` takes a `dictionary` option. It also beats shelling out to the CLI: 116 bytes against 120.

So the deltas moved into the build, which removed the CLI dependency, the committed artifacts, a manual step, and the tripwire that existed to catch you forgetting the manual step. Four things deleted because one assumption got tested. The check that mattered was interop: the foreign `zstd -d -D` CLI decodes Node's output byte-exact, prefix included, because the real decoder is a browser and not Node.

## What shipped

| asset | before | every browser now | returning Chromium |
| --- | --- | --- | --- |
| nav.js | 15,909 zstd | 13,047 | delta on change |
| luna.css | 9,124 | 7,615 | 116 |
| lens.js | n/a | 16,491 | delta on change |
| icons.svg | n/a | 2,344 | delta on change |

Roughly 19% off the shell for everyone, and 65x off a CSS change for a returning Chromium visitor. An unplanned side effect: because the Worker now hands over its own brotli, a client offering `zstd, br, gzip` stops getting the zstd that started this whole investigation.

## The part that transfers

Every fact I gathered about the platform was correct. The conclusion I built out of them was wrong, and it survived three rounds because each new measurement kept confirming a real constraint that simply was not the constraint doing the damage. Accumulating true facts feels like converging on a cause.

What broke the loop was a test with none of my code in the path. That is the cheap move I should reach for first, and the honest version of "it's a platform limit" is a reproduction the platform owner could run. Until you have that, the call is coming from inside the house.

Source: https://aadhar.sh/garage/compression
