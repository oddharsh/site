# holding/

The live **aadhar.sh** homepage — a resto-mod Windows-XP / Luna personal
site on Cloudflare Pages, server-enhanced by `_worker.js`. This directory is
the deploy root (not a placeholder; there is no separate `site/` build).

```bash
# deploy
wrangler pages deploy holding --project-name aadhar-sh --branch holding --commit-dirty=true
```

Recurring chores (add photos, swap the playlist, bust caches, version bumps,
what every script in `scripts/` does) live in the ops runbook:
[../MAINTENANCE.md](../MAINTENANCE.md).

## what's here

- `index.html` — the whole homepage in one file (inline CSS + JS): an XP
  window over a Bliss-style desktop, a photo grid, and a "now playing"
  tracklist.
- `_worker.js` — Pages-Worker hybrid: routing, R2 photo serving + manifest,
  Spotify scrape, AadharshBot crawler, `/around` + `/whoareyou` + `/bot`,
  and the `/writing` Notepad pages.
- `nav.js` — the shared desktop shell injected on every page: taskbar (with
  per-section app icons), Start → Run palette, desktop shortcut icons,
  draggable/resizable windows, the custom XP scrollbar, and per-route
  favicons. One external asset, deferred + SW-cached.
- `notepad.js` — behavior for the `/writing` Notepad view (menus, status
  bar, F5 stamp), incl. opening notes as popovers over the folder.
- `sw.js` — service worker (cache-first images, SWR for static text).
- `writing/` — `.txt` notes + `posts.json`; rendered as Notepad windows.
- `images/` — dual-encoded AVIF+JPG thumbnails + `metadata.json` EXIF index.
- `scripts/` — the photo pipeline (resize → rotate → jpegli/avif → R2).
- `llms.txt`, `sitemap.xml`, `robots.txt`, `.well-known/` — discovery + SEO.

See the repo-root `CLAUDE.md` for the full architecture, the photo pipeline,
and the hard-won gotchas.
