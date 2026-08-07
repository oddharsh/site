---
title: "Terminal"
description: "Plain-text views of the site's public utilities, addressed entirely by URL."
path: "/terminal"
section: "tui"
kind: "utility"
updated: "2026-08-07"
source: "https://aadhar.sh/terminal"
---

# Terminal

The terminal is a directory for small, 80-column text representations. It is
not a client-side terminal emulator and it keeps no server session.

```text
finger  photos  lens  radar  dict  cache  encode  agent-ready
```

Request a tool with `Accept: text/plain`, add `?plain=1`, or use its explicit
`.txt` URL. Browsers can use the ordinary HTML route. The route name is also the
public concept used by the MCP registry, so HTTP and agent discovery do not
invent parallel vocabularies.

## Examples

```sh
curl https://aadhar.sh/finger.txt
curl https://aadhar.sh/photos.txt
curl 'https://aadhar.sh/lens.txt?url=https://example.com'
node tools/radar-sample.mjs --at https://aadhar.sh --anonymize
```

`radar` accepts bounded signal readings; it has no antenna of its own. `dict`
checks compression-dictionary eligibility. `cache` performs behavioral ETag
revalidation. `encode` inspects JPEG or AVIF container structure without
decoding pixels. Remote URL tools share the public-network, redirect, byte, and
deadline limits described at `/security`.

Frames are `no-store` and `noindex`: a query result is a representation of
another resource, not another canonical page.

Source: https://aadhar.sh/terminal
