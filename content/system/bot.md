---
title: "AadharshBot"
description: "The site's transparent, bounded crawler: identity, purpose, signatures, and opt-out."
path: "/bot"
section: "identity"
kind: "page"
updated: "2026-08-07"
source: "https://aadhar.sh/bot"
---

# AadharshBot

AadharshBot is a small crawler operated by aadhar.sh. It refreshes the public
neighborhood shown at `/around`; it does not submit forms, log in, or attempt to
cross an authorization boundary.

## Identity

- User-Agent: `AadharshBot/2.0 (+https://aadhar.sh/bot)`
- Signature-Agent: `https://aadhar.sh/`
- Public key directory:
  `/.well-known/http-message-signatures-directory`
- Operator: `coffee@aadhar.sh`

When the signing key is configured, requests carry RFC 9421
`Signature-Agent`, `Signature-Input`, and `Signature` headers using Ed25519 and
the `web-bot-auth` tag. A request with a missing or invalid signature should not
be trusted merely because it copied the User-Agent.

## Crawl policy

The scheduled crawl visits a bounded registry of public HTTP(S) pages. It
checks `robots.txt`, caps redirects and bytes, normalizes the text it retains,
and keeps only the small derived record used by `/around`. A failed robots
check fails closed for that refresh.

To opt out:

```text
User-agent: AadharshBot
Disallow: /
```

Questions or complaints go to `coffee@aadhar.sh` and are answered by a person.

Source: https://aadhar.sh/bot
