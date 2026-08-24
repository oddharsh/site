# aadhar.sh

The live **aadhar.sh** site: a resto-mod Windows-XP / Luna personal site on a
Cloudflare Worker with static assets, server-enhanced by the Worker in
`src/worker/`. This file is authored in `src/content/` and served at
`/README.md`.

```bash
# local fallback deploy; production uses merge -> CI promotion -> Workers Builds
bun run deploy:direct
```

Recurring chores (add photos, swap the playlist, bust caches, version bumps,
what every tool in `tools/` does) live in the ops runbook, `docs/MAINTENANCE.md`.

## what's here

- `src/pages/` holds every HTML document. `index.html` is the whole homepage in
  one file (inline CSS + JS): an XP window over a Bliss-style desktop, a photo
  grid, and a "now playing" tracklist.
- `src/content/` holds this file, plus `writing/` (`.txt` notes + `posts.json`,
  rendered as Notepad windows) and the hand-written Markdown twins in `md/`.
- `src/worker/` is the module Worker: routing, R2 photo serving + manifest,
  Spotify scrape, AadharshBot crawler, `/around` + `/whoareyou` + `/bot`, the
  `/mcp` server, and the `/writing` Notepad pages.
- `src/client/` holds the deferred islands, served from immutable
  content-hashed `/a/` URLs. `nav.js` is the shared desktop shell injected on
  every page: taskbar with per-section app icons, Start to Run palette, desktop
  shortcut icons, draggable/resizable windows, the custom XP scrollbar,
  per-route favicons. Beside it sit `notepad.js` (the `/writing` view's menus,
  status bar and F5 stamp), `tooltip.js` and `infotip.js` (the hover cards),
  `quiz.js`, the `lens*.js` set, and `sw.js`, the retired service worker's
  unregister stub, which must keep serving 200 for a year+.
- `public/` is the bytes a browser fetches unchanged: `images/` + `i/` (photo
  metadata plus the content-addressed AVIF/JPG thumbnail tiers, per-photo
  metadata including the baked histogram channels), `og/`, and the discovery and
  SEO files `llms.txt`, `sitemap.xml`, `robots.txt`, `.well-known/`.
- `tools/photos/` is the photo pipeline (resize, rotate, zenc/avif, R2).

See the repo-root `CLAUDE.md` for the full architecture, the photo pipeline, and
the hard-won gotchas.
