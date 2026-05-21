# holding/

A single-page "under construction" placeholder for aadhar.sh while the
full `site/` build is in progress. Deploy this directory to Cloudflare
Pages first; swap to `site/` when ready.

## what you need to do

1. Drop 4–8 photos into `img/holding/` named `01.jpg` through `08.jpg`
   (any subset works — the page hides missing ones via `onerror`)
2. Cloudflare Pages → create a project pointed at this directory
3. Custom domain → `aadhar.sh`
4. Done

## file budget

- `index.html` — 5KB, self-contained (inline CSS, inline JS)
- `_headers` — short cache so swapping in the real site is fast
- `img/holding/` — your photos

That's it.

## swapping to the real site later

When `site/` is ready:

1. Cloudflare Pages → project settings → change build output directory from `holding` to `site`
2. Redeploy
3. The holding page is replaced atomically

Or just leave `holding/` in the repo as a fallback you can flip back to
if anything goes wrong with the main site.

## what's intentional in the design

- **Hazard-yellow construction stripe at top** — a one-line nod to the
  1960s theme's signature element. Tells visitors "yes this is intentional,
  yes the rest is coming."
- **Dark mode only** — no theme switcher here. Visitors land, get the
  message, leave (or send a coffee request). Theme work belongs in the
  real site.
- **Coffee CTA front and center** — the one path that already works
  (cal.com routes are live). Bookings can keep flowing while the rest
  of the site builds.
- **Photo grid that gracefully degrades** — if you don't have photos to
  drop in yet, the grid hides itself. Ship the page even with zero photos.
