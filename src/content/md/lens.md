# The Other Web

A scanner that shows any URL the way a machine gets it. Paste a URL and it
fetches once, server-side, identified as
`AadharshBot/1.0 (+https://aadhar.sh/bot)`, then reports what a person sees, what
a machine receives instead, and what the difference costs.

**This twin describes the tool rather than mirroring a page, because there is no
fixed document at `/lens`.** Every scan is per-URL. What follows is the shape of
what a scan returns, so an agent can decide whether to run one.

## The panes

Three, and a scan fills them from one fetch.

- **Human** embeds the target in a live cross-origin iframe when the target
  allows framing, and falls back to a server-side screenshot or a readable-text
  reader when it does not. Framability is read from the target's own
  `X-Frame-Options` and `Content-Security-Policy: frame-ancestors`, so this
  costs no extra probe.
- **Machine** is the raw response and the eight lenses below.
- **Browser** renders the page after JavaScript and reports the word gap against
  the HTTP response.

`Delta` and `Compare` are the two synthesis views. Compare scans two URLs
head-to-head against one rubric.

## The eight lenses

Each is phrased as the question it answers rather than as a practitioner noun.

| lens | the question |
|---|---|
| Raw response | what did the server actually send? |
| Reader's guess | what does a reader-mode extractor throw away? |
| What it costs | every request the page makes, and who owns the bytes |
| What it claims | structured data, JSON-LD, metadata |
| Model cost | what reading this page costs a language model |
| Who's allowed | robots.txt, AI rules, terms |
| Agent doors | MCP, OAuth, API catalog, agent cards |
| Agent-ready? | the readiness score, and the rubric behind it |

**Reader's guess runs a third-party extractor and reports the gap between what
it keeps and what the server sent.** Anyone who wants to read a page can open it. What no other surface
shows is that an extractor is GUESSING which part of a document is the article,
and how badly that goes on a page that is not one.

**What it costs opens a real browser** and records the request waterfall, so it
reports requests, transfer bytes, distinct hosts, and the third-party share of
the weight.

## The readiness score

`Agent-ready?` scores the target across six categories. Five of them audit what a
site DECLARES: discoverability, content accessibility, bot access control, API
and auth and MCP discovery, and commerce. The sixth, **Execution**, asks what an
agent browser actually did with the page, which is the half a declaration cannot
answer: whether the page's own JavaScript survived the engine, and whether the
engine could decode the images the page served.

**Execution checks stay neutral until a render has actually happened.** They are
shown and excluded from the score. A render is rate-limited and capped
account-wide, so most scans will never hold that evidence. Marking a site down
because our browser budget was spent would make the number dishonest. Run
the wire lens on a target to fill them in.

The published scoring note travels with every result and states the rule.

## What a site needs

The rubric above weighs every declaration the same, so a blog that serves its
readers perfectly still loses points for OAuth it has no use for. **What this
site needs** reweighs the same evidence by applicability, after
[Is Agentic](https://is-agentic.com/methodology):

- **Essential, 80 points**, for every public URL: words in the raw HTML,
  agents let in, robots.txt admitting the agents a person sent, no sign-in
  wall, clean redirects, and a canonical URL with lang and Open Graph.
- **Recommended, 20 points**, switched on per surface the scan found: an API
  must be described with callable operation names, an MCP server must be
  findable, an auth flow must publish protected-resource metadata, and a store
  must offer a machine payment protocol. Markdown counts here only when the
  page's HTML costs at least 5x its markdown and more than 8K tokens.
- **Emerging doors, at most 5 points** between them, however many there are.

Refusing a training crawler costs nothing. Refusing ChatGPT-User or Claude-User
refuses someone who asked for the page, and it does cost points.

**Past need** lists the mirror's failures this site has no reason to fix (OAuth
discovery with no API behind it, an MCP server card with no server) and the
doors it built that buy little. aadhar.sh is the specimen: it publishes about a
dozen emerging doors, and between them they're worth 5 points.

Lens files every check in Is Agentic's catalog once. Some it scores, some it
counts as a bonus, and it declines the rest with a reason. It leaves out search
rank and directory listings (they measure fame), SDKs and pricing pages
(business calls), and API design advice past "can an agent call it by name".
It also leaves out anything needing an MCP session or a crawl, and serving
agents a separate page by User-Agent, which it treats as cloaking.

## Limits, and what the scanner will not do

Requests are rate-limited per visitor: 30 scans a minute, 3 screenshots, 4
comparisons, 3 browser renders, 2 wire traces. Browser work also bills against
one shared account ceiling, so a refused render is reported as our own spent
budget rather than as the target failing.

Every fetch is guarded: `http` and `https` only, ports 80 and 443 only, no
localhost, no private or link-local hosts, an 8 second timeout and a 2 MB cap.

The scanner identifies honestly on every request. A page that wants to refuse
AadharshBot can see that it is AadharshBot.

Scans are not logged.
