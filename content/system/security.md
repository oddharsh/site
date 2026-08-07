---
title: "Security Center"
description: "The current security and privacy boundaries of aadhar.sh."
path: "/security"
section: "status"
kind: "page"
updated: "2026-08-07"
source: "https://aadhar.sh/security"
---

# Security Center

This is the short, current version of what guards aadhar.sh. It describes the
implementation that serves the page, not an intended future state.

## Browser boundary

Documents use a default-deny Content Security Policy. Scripts, styles, images,
fonts, connections, forms, and base URLs are restricted to this origin; objects
and framing are disabled. Canonical pages load no third-party script, no web
font, and no analytics beacon. Most pages load no JavaScript at all.

The Worker also sends `Permissions-Policy`, `Referrer-Policy`,
`X-Content-Type-Options`, and `X-Frame-Options`. Preview hosts add `noindex` and
refuse unsafe methods plus known GET-shaped writes.

## Application boundary

- Remote URL tools accept only public HTTP(S) destinations and bound DNS,
  redirects, time, and bytes.
- Coffee booking validates fields, fails closed when availability cannot be
  established, and serializes slot claims in a Durable Object before notifying
  anyone.
- Webmentions are verified against their source, constrained to generated
  canonical targets, stored separately by moderation state, and never rendered
  as trusted HTML.
- Serendipity is public and read-only. Retired cookie and remote-sync mutation
  routes return `410 Gone`.
- Preview deployments are readable but cannot mutate production data.

## Data and identity

`/whoareyou` renders only request metadata Cloudflare supplies for the current
response and does not write it to storage. The site's own crawler can sign
outbound requests with Web Bot Auth; its public contract is at `/bot`.

Infrastructure changes, production traffic movement, secrets, and deployment
credentials are not reachable through public site routes.

Source: https://aadhar.sh/security
