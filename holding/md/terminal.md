# Terminal

Three small programs that answer as terminal frames: 80 columns of box-drawing,
one complete screen per HTTP request. `curl` reads them, an agent reads them,
and a browser gets the same frames inside a Windows PowerShell window you can
type into.

**This twin describes the programs rather than mirroring one, because a frame is
per-query.** There is no fixed document at `/terminal` to publish here. Fetch a
frame directly instead: any of the URLs below returns `text/plain` unless you
ask for `text/html`.

## The programs

- **`/terminal/finger`** — who runs this host. Nine panes: overview, writing,
  reading, listening, photos, around, coffee, deploys, search. The one to start
  with, and the only one that is drivable in a meaningful way.
- **`/terminal/photos`** — the published photo archive, filterable by caption,
  film simulation, body, and lens. Opening a frame shows its exposure and the
  in-camera recipe the shot was made with.
- **`/terminal/ask`** — plain language in, real tool calls out. Takes `?q=`. It
  picks from the same seven tools listed at `/mcp`, calls them, and answers from
  what came back — and prints every call it made above the answer, along with
  the request you'd send to reproduce it without a model. Answers are grounded
  in tool results only; when the tools return nothing, it says the site does not
  answer that rather than guessing. Bounded at 240 characters in, 4 tool calls,
  2 model rounds, and 10 asks/min per address. The tools underneath are not
  limited by that — call `/mcp` directly if you want them without a model in the
  way. With no model configured it still answers, routing by keyword instead,
  and the frame says which mode produced it.
- **`/terminal/lens`** — inspect one public URL the way a machine does:
  readability, agent doors, and what a single scan of it costs to read. Takes
  `?url=`. Private, local, and non-HTTP targets are refused, and lookups are
  rate-limited to 30/min per address, shared with `/lens/fetch`.

## Reading somebody else's site

Point `ask` at another origin with `&at=` and it reads *their* agent doors the
same way it reads this one: `llms.txt`, the Markdown twin at the page's own URL,
the agent card, the API catalog, and a real `tools/list` against their MCP
server. Add a question and a model answers from what it found.

```
curl 'aadhar.sh/terminal/ask?at=https://example.com'
curl 'aadhar.sh/terminal/ask?at=https://example.com&q=what+do+they+offer'
```

Each door reports one of three states, and the third one matters: **open**,
**shut**, or **unread**. A 404 is a finding. A request that never completed is
not — reporting a failed check as a negative result is the one dishonesty a
reader like this cannot afford.

Their tool catalog is **listed, never called**. `tools/list` asks a server to
describe itself, which is what the endpoint is for; `tools/call` is execution on
somebody else's infrastructure, and nothing here can invoke it.

**One rule governs the rest: tool calling and untrusted text never share a
turn.** Third-party bytes can contain instructions, so the model turn that sees
them is issued with no tool catalog at all — a tool call is unrepresentable in
the reply rather than merely discouraged. The target comes from `at=` and is
validated before anything is fetched, so the model never selects an origin
either. Same-origin asks keep their tool loop, because this site's own content
is not hostile to this site.

Foreign reads share Lens's 30/min per-address budget, and at most 6,000
characters of third-party text ever reaches a model.

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
curl aadhar.sh/terminal/finger
curl 'aadhar.sh/terminal/finger?keys=2jj<cr>'
curl 'aadhar.sh/terminal/finger?pane=search&q=lattice'
curl 'aadhar.sh/terminal/photos?film=acros'
curl 'aadhar.sh/terminal/lens?url=https://example.com'
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

## The one exception: ask remembers

`ask` is the only program here with a Durable Object, and the rule that decides
it is about the **shape of the state**, not taste:

> Small and addressable stays in the URL. Growing and opaque gets a DO.

A pane and a cursor fit a query string forever. A transcript does not — the
practical ceiling is about 2KB, which holds a cursor and never holds a
three-turn exchange. So `ask` takes a `session` id (server-minted, returned in
the frame) and follow-ups continue the same conversation. The other three
programs are untouched and stay fully stateless.

**A transcript that has read a third party never gets tools again.** Once
`&at=` puts somebody else's text into the history, every later turn in that
session is downstream of instructions somebody else wrote — including an
innocent question about this site. Tools stay off for the life of that session,
and the frame says `TAINTED` rather than quietly answering without them. Start a
new session to get tools back. The rule is sticky and permanent on purpose: "no
tools on the next turn" is defeated by asking two harmless questions first.

Transcripts hold 12 messages or 24,000 characters, whichever comes first, and
expire 30 minutes after the last turn. Without the binding, `ask` is
single-shot — exactly what it was before conversations existed.

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
