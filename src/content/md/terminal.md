# Terminal

Three small programs that answer as terminal frames: 80 columns of box-drawing,
one complete screen per HTTP request. `curl` reads them, an agent reads them,
and a browser gets the same frames inside a Windows PowerShell window you can
type into.

**This twin describes the programs rather than mirroring one, because a frame is
per-query.** There is no fixed document at `/terminal` to publish here. Fetch a
frame directly instead: any of the URLs below returns `text/plain` unless you
ask for `text/html`.

## The console is an MCP client

Typing `dict https://example.com/app.js` into the console at `/terminal` sends
**the same JSON-RPC call an agent pointed at this origin would send**. Not a
parallel API dressed up to look like one — one `POST /mcp`, `tools/call`, the
tool named by the command. The console prints the request before it makes it, so
you can copy it into curl.

That is deliberate and it is the whole point of the surface. If the console had
its own private endpoints, watching it would tell you nothing about what an agent
gets, and the two could drift without anyone noticing. Sharing one door means a
regression in the agent path breaks the console in front of you.

**The MCP tool name is the route name.** What you type, what you curl, and what
an agent calls are the same word:

```
finger  photos  lens  radar  dict  cache
```

A contract test asserts every tool with a route is reachable over MCP. `dict`
and `cache` shipped for two commits with HTTP routes and no MCP entry, which
made them invisible to exactly the caller this site is built for.

## encode — what did your encoder actually do?

`/encode?url=…` reads a JPEG or AVIF **container** and reports the encode:
chroma subsampling, baseline versus progressive and the scan count, an estimated
quality, AVIF bit depth, and whether ICC/EXIF/XMP is riding along on something
that should be a thumbnail.

**No pixels are decoded**, which is the only reason it can run in a Worker.
Cloudflare Images cannot take HEIC without Enterprise and cannot take RAW at all,
and a Worker has no decoder — but none of the interesting questions about an
encode need pixels. They live in quantization tables, the scan script, the
component sampling factors, the `av1C` record. The blocker was never "images are
hard", it was "decoding is hard", and those are different problems.

Quality is an **estimate** and says so: there is no quality number in a JPEG,
only quantization tables, and every tool that prints one is inferring it. The
method and its deviation from the IJG Annex K table are both shown, so a custom
table (mozjpeg, jpegli, zenjpeg) reads as custom rather than as a confident wrong
number.

## agent-ready — the scorecard, pointed at anyone including us

`/agent-ready` grades how much of an origin a machine can actually use: an
`llms.txt`, a Markdown twin, an agent card, an API catalog, and a real
`tools/list` against its MCP server.

**Doors are counted, never scored.** Each is open, shut, or **unread**, and the
third is the one most graders get wrong — a check that could not run is not a
failure. Collapsing those into a single number would invent a precision the
observation cannot support.

Called with no `url` it audits **this** origin and prints what building all of
it cost, capability by capability, in files and lines. A scorecard that can only
flatter its author is marketing, so it grades anyone; and the bill is shown only
for the origin whose source tree it has.

The headline from that table: baseline agent compatibility — an MCP server, an
`llms.txt`, and the discovery files — is under a thousand lines. That part is a
weekend. The cost hides in drift-proofing and in the tools themselves.

## Where the tools live

Each tool is a **top-level utility**, next to `/lens` and `/photos` and
`/coffee`, because that is where this site puts utilities and only content
nests. `/terminal` is not their parent; it is a console that drives them.

Every tool answers three ways from one URL, the same contract as the Markdown
twins:

| request | you get |
|---|---|
| `Accept: text/html` | the page |
| anything else (curl, agents) | the frame |
| `<tool>.txt` | the frame, explicitly |

`/photos` and `/lens` already own HTML pages, so they gain only the frame
representation at `/photos.txt` and `/lens.txt`.

## The programs

- **`/finger`** — who runs this host. Nine panes: overview, writing,
  reading, listening, photos, around, coffee, deploys, search. The one to start
  with, and the only one that is drivable in a meaningful way.
- **`/photos`** — the published photo archive, filterable by caption,
  film simulation, body, and lens. Opening a frame shows its exposure and the
  in-camera recipe the shot was made with.

- **`/lens`** — inspect one public URL the way a machine does:
  readability, agent doors, and what a single scan of it costs to read. Takes
  `?url=`. Private, local, and non-HTTP targets are refused, and lookups are
  rate-limited to 30/min per address, shared with `/lens/fetch`.

## Reading somebody else's site

`/lens?url=…&doors=1` reads what is actually *behind* another origin's agent
doors, rather than only reporting that they exist: `llms.txt`, the Markdown twin
at the page's own URL, the agent card, the API catalog, and a real `tools/list`
against their MCP server.

Each door reports one of three states, and the third matters: **open**, **shut**,
or **unread**. A 404 is a finding. A request that never completed is not.

Their tool catalog is **listed, never called**. `tools/list` asks a server to
describe itself, which is what the endpoint is for; `tools/call` is execution on
somebody else's infrastructure, and nothing here can invoke it.


## radar — an instrument with no antenna

A server has no antenna. Neither does an agent talking to one. Browsers expose
no wifi RSSI at all, and Web Bluetooth scanning is flag-gated — which is why
[findphone](https://github.com/ben-z/findphone), the thing this is modelled on,
is a native macOS CLI.

So `/radar` does not sense anything. **You bring the signal; it brings
the display.** POST readings you have already measured and it draws them:

```
node tools/photos/radar-sample.mjs --at https://aadhar.sh --anonymize
curl -X POST aadhar.sh/radar -d '{"samples":[{"name":"AP","rssi":-58}]}'
```

Each sample needs a `name` and an `rssi` in dBm (negative). `kind` and `history`
are optional; history draws the trend, which is the half that matters when you
are walking around looking for something. Bands are findphone's field
calibration: **-45 arm's reach, -60 same table, -72 same room.**

**The angles mean nothing.** RSSI is a scalar — it carries distance-ish
information and no bearing. The rings are real; each source's angle is a hash of
its name, stable so nothing jumps between frames, and decorative. A sweeping
radar arm would imply a direction the data cannot support.

Nothing is stored, so post the whole set each time. That also means device names
travel in the request body — `--anonymize` hashes them before anything leaves
your machine, and you keep the radar, the bands, and the hunt without the labels.

It is also an MCP tool, `terminal_radar`, for an agent that has a shell and
therefore an antenna.

## dict — will a browser ever use your compression dictionary?

Compression dictionaries fail in total silence. Chromium declines to register a
perfectly good one because of a cache directive on it, and nothing tells you: no
console warning, no header, no failed request. The site just serves full
responses forever while you believe it is serving deltas.

```
curl 'aadhar.sh/dict?url=https://example.com/app.js'
```

Vetoes, each measured rather than inferred: **`must-revalidate`** and
**`no-cache`** each kill registration outright, which surprises people because
neither means "do not store" anywhere else in HTTP. `no-store` kills it for the
obvious reason. **The dictionary's usable life is the `stale-while-revalidate`
window, not `max-age`** — a year of max-age with no SWR is usable for zero
seconds past freshness, which reads as "it worked yesterday". `s-maxage` is a
shared-cache directive and buys a browser nothing.

It checks the other half of the handshake too: a response serving
`content-encoding: dcz` without `vary: available-dictionary` lets a shared cache
hand that delta to a client with no dictionary. That is not a slow page, it is
`ERR_CONTENT_DECODING_FAILED`.

**There is deliberately no delta calculator.** workerd's `node:zlib` has
`zstdCompressSync` and silently ignores its `dictionary` option — measured
2026-08-05, byte-identical output with the correct dictionary, a deliberately
wrong one, and none at all. A delta computed there would be plain zstd reporting
a saving that does not exist, with no error to catch.

## Driving one

Send keys with `?k=` (one key) or `?keys=` (a sequence, up to 32). Named keys
are `<cr>`, `<esc>`, `<tab>`, and `<sp>`, because a control character is not
something you can put in a query string.

| key | does |
|---|---|
| `1`–`9` | jump to a pane |
| `j` / `k` | move the cursor down / up |
| `g` / `G` | first / last row |
| `<cr>` | open the row under the cursor |
| `h` | back out of an opened row |
| `/` | the search pane (add `&q=`) |
| `?` | the help screen |
| `q` | quit |

```
curl aadhar.sh/finger
curl 'aadhar.sh/finger?keys=2jj<cr>'
curl 'aadhar.sh/finger?pane=search&q=lattice'
curl 'aadhar.sh/photos?film=acros'
curl 'aadhar.sh/lens?url=https://example.com'
```

## State is a URL, not a session

Nothing is stored. Every frame prints, in its status bar, the URL that produced
it, labelled `state`. Send that URL back to continue from where you were.

Four things follow, and they are the reason it was built this way rather than
around a server-side session: there is no round trip to a session store on any
keypress, two callers can explore from the same frame without colliding, a state
from last week still resolves because it was never a live object anybody had to
keep holding, and any machine can serve any frame because there is no affinity
to preserve.

That last one is the same argument MCP's 2026-07-28 revision made when it
dropped server-side sessions — no session id to mint, no session table, and
nothing to route back to the same backend. This origin already speaks that
revision at `/mcp`. The terminal applies it one layer up: MCP made a single tool
*call* stateless, and this makes a whole *session* over those tools stateless
too.


## Colour, and the other doors

Frames carry ANSI colour over HTTP by default, since the usual caller of a
`text/plain` route from a terminal is a terminal. Add `?plain=1` to drop it.

The same three programs are MCP tools on this origin's server at
<https://aadhar.sh/mcp> — `terminal_finger`, `terminal_photos`, `terminal_lens`
— and frames are never coloured there, because an escape sequence in a model's
context window is noise it then has to be robust to. If you want fields rather
than a frame, `search_site`, `photo_query`, and `lens_inspect` are the
structured tools beside them, over the same data.

Responses are `no-store` and `noindex`. A frame is per-query and several of them
are live, so there is no canonical document here for a cache or a crawler to
hold.
