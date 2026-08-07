---
title: "Access"
description: "A plain inventory of the site's human and machine access paths, their authority, and their boundaries."
path: "/access"
section: "access"
kind: "page"
updated: "2026-08-07"
source: "https://aadhar.sh/access"
---

# Access

This site is deliberately usable without a privileged client. The visible
document is the source of truth; machine representations make the same public
material easier to retrieve and act on.

## Human access

- Every canonical page is server-rendered HTML with landmarks, headings, real
  links, and real forms.
- The site works with JavaScript disabled. The one optional image-comparison
  exercise uses a small route-scoped module and leaves its source data public.
- Layouts reflow at narrow widths and high zoom. Reduced motion, forced colors,
  keyboard navigation, and print each have explicit styles.
- No account or cookie is required to read the site.

## Machine access

- Requesting an authored page with `Accept: text/markdown` returns its Markdown
  representation where one exists. Explicit `.md` and `.txt` URLs are stable.
- `/llms.txt`, `/llms-full.txt`, `/search.json`, and the well-known discovery
  files describe the public corpus.
- `/mcp` is a stateless JSON-RPC endpoint. `tools/list` is the protocol truth;
  tool cards and catalogs are generated from the same registry.
- JSON endpoints expose photos, events, availability, request details, reading,
  listening, crawl results, and deploy history without requiring HTML parsing.

## Authority

Public tools are anonymous and read-only unless their name says otherwise.
Coffee booking and Webmention submission are the two public write paths. Both
validate bounded form input; preview hosts refuse writes by default.

No public surface grants infrastructure, deployment, secret, billing, mailbox,
or database-administration authority. Those remain outside the site's HTTP
contract.

## Trust boundary

Fetched URLs, submitted forms, and incoming mentions are untrusted. Remote URL
tools accept only public HTTP(S) destinations, reject private networks, follow a
bounded number of redirects, cap response bytes, and use deadlines. Webmentions
are verified and moderated. Booking claims are serialized by a Durable Object.

Source: https://aadhar.sh/access
