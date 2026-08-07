---
title: "Who are you"
description: "What one request reveals to this site, rendered ephemerally for the sender."
path: "/whoareyou"
section: "identity"
kind: "page"
updated: "2026-08-07"
source: "https://aadhar.sh/whoareyou"
---

# Who are you

This page shows the metadata already attached to the HTTP request that fetched
it. The Worker renders the values into this response and does not write them to
KV, D1, R2, logs owned by this application, or a browser cookie.

## What the request can reveal

- the connecting IP address;
- Cloudflare's coarse country, region, city, timezone, network, ASN, and colo;
- the negotiated HTTP and TLS versions;
- User-Agent, accepted languages, accepted encodings, referrer, and DNT;
- whether the request included any cookie; and
- the serving Worker version.

The same fields are available as JSON at `/whoareyou.json`. That response and
this page use `no-store` and `noindex` because their contents are request-specific.

## What it does not reveal

An IP address is not a verified identity. The request does not reveal unrelated
browsing, local files, precise location, the DNS resolver, or data outside this
TLS connection. Header values such as User-Agent are claims made by the client
and can be absent or false.

No browser-side fingerprinting script, edge-injected application script, RDAP
lookup, or analytics call is part of this page.

Source: https://aadhar.sh/whoareyou
