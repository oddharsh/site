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
- **`/terminal/lens`** — inspect one public URL the way a machine does:
  readability, agent doors, and what a single scan of it costs to read. Takes
  `?url=`. Private, local, and non-HTTP targets are refused, and lookups are
  rate-limited to 30/min per address, shared with `/lens/fetch`.

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

Three things follow, and they are the reason it was built this way rather than
around a server-side session: there is no round trip to a session store on any
keypress, two callers can explore from the same frame without colliding, and a
state from last week still resolves because it was never a live object anybody
had to keep holding.

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
