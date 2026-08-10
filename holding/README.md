# holding/

The live **aadhar.sh** homepage — a resto-mod Windows-XP / Luna personal
site on a Cloudflare Worker with static assets, server-enhanced by
`_worker.js`. This directory is the asset source for the repository-root
Workers build.

```bash
# local fallback deploy; production uses merge -> CI promotion -> Workers Builds
pnpm run deploy:direct
```

Recurring chores (add photos, swap the playlist, bust caches, version bumps,
what every script in `scripts/` does) live in the ops runbook:
[../MAINTENANCE.md](../MAINTENANCE.md).

## what's here

- `index.html` — the whole homepage in one file (inline CSS + JS): an XP
  window over a Bliss-style desktop, a photo grid, and a "now playing"
  tracklist.
- `_worker.js` — module Worker: routing, R2 photo serving + manifest,
  Spotify scrape, AadharshBot crawler, `/around` + `/whoareyou` + `/bot`,
  and the `/writing` Notepad pages.
- `nav.js` — the shared desktop shell injected on every page: taskbar (with
  per-section app icons), Start → Run palette, desktop shortcut icons,
  draggable/resizable windows, the custom XP scrollbar, and per-route
  favicons. One external asset, deferred, served from an immutable
  content-hashed `/a/` URL.
- `notepad.js` — behavior for the `/writing` Notepad view (menus, status
  bar, F5 stamp), incl. opening notes as popovers over the folder.
- `tooltip.js` — the rich hover island for photos, tracks, artists, and car
  references. A tiny inline loader warms it during idle and replays a cold
  first hover; touch visitors never load it.
- `sw.js` — the retired service worker's unregister stub (v136): it deletes
  old caches and unregisters itself, and must keep serving 200 for a year+.
- `writing/` — `.txt` notes + `posts.json`; rendered as Notepad windows.
- `images/` + `i/` — full photo metadata plus content-addressed AVIF/JPG
  thumbnail tiers; per-photo metadata includes the baked histogram channels.
- `scripts/` — the photo pipeline (resize → rotate → zenc/avif → R2).
- `llms.txt`, `sitemap.xml`, `robots.txt`, `.well-known/` — discovery + SEO.

See the repo-root `CLAUDE.md` for the full architecture, the photo pipeline,
and the hard-won gotchas.
