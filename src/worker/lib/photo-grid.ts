// lib/photo-grid.ts: the homepage photo grid's markup, for both callers.
//
// build.ts bakes a deterministic twelve into index.html (the no-JS grid, and
// what keeps the document byte-stable for its dcz delta and 304).
// /photos/grid.html renders a random twelve per request, which the hydrator
// swaps in. Imports nothing that touches a Worker global, so build.ts can load
// it under Node.
import { EMPTY, html, joinHtml } from "./html.ts";
import type { Html } from "./html.ts";
import { asNumber } from "./parse.ts";

// Each tile names one format, AVIF. A <picture> with a JPEG fallback loaded the
// fallback 13 times for one tile as the cursor crossed the grid (Chromium,
// 2026-08-11).
//
// deferred: true is the baked twelve. The hydrator replaces them, so their
// URLs stay in data-* and a <noscript> twin carries the script-off path; a
// real src would download a thumbnail twice (#156).
// deferred: false is the fragment. Those tiles are the grid, so they carry
// real URLs and all twelve load at once. An IntersectionObserver gated them
// until 2026-07-29 and left row 4 white on the first scroll, to save 34 KB.
//
// No tile may take fetchpriority=high: the intro prose is the LCP element at
// 390px and 1280px (#156). The first six take the default and the last six
// take low, so the edge has two urgency buckets to order. With one bucket it
// interleaved all twelve over 334 ms, and a half-delivered AVIF paints nothing
// (production, 2026-08-10). Cloudflare honours the split: mean completion
// ranks 6.2 and 12.8 of 20 against 9.5 and 9.5 for the all-equal control.
// Re-measure on warm cache-HIT URLs only; cache-busted probes read flat.
//
// Six is a DOM prefix, which is the topmost tiles at any column count.
const PRIORITISED_TILES = 6;

// Returns Html because lib/island.ts's islandResponse takes nothing else.
export function renderPhotoSlots(pick, altMap = {}, { deferred = true, histograms = {} } = {}): Html {
  return joinHtml(
    pick.map((p, index) => {
      // No attribute means auto, and costs no bytes.
      const pri = index < PRIORITISED_TILES ? EMPTY : html` fetchpriority="low"`;
      // thumb_small always exists now; the other two recover an old manifest entry.
      const thumb = p.thumb_small || p.thumb_avif || p.thumb_jpg;
      // Three sizes of one format. srcset picks one candidate at layout, so
      // hovering loads nothing extra (12 loads over two hover passes at DPR 1
      // and 2). The column is a fixed 184px, so the tiers cover DPR 1, 2 and 3.
      const cands = [p.thumb_xs ? `${p.thumb_xs} 200w` : "", p.thumb_small ? `${p.thumb_small} 400w` : "", p.thumb_avif ? `${p.thumb_avif} 600w` : ""].filter(
        Boolean,
      );
      // A lone candidate repeats src, so it is left out.
      const srcsetValue = cands.length > 1 ? cands.join(", ") : "";
      // The tile is the link, so an empty alt would leave the <a> nameless.
      const alt = altMap[p.stem] || p.stem;
      // The tooltip's histogram, 256 characters packed by
      // tools/photos/build-histogram-index.ts. It rides in the markup because
      // tooltip.js loads on the first hover, too late to warm that hover; a
      // fetch per photo took 117 to 135 ms on production.
      //
      // Only the six default-priority fragment tiles carry it: 667 bytes smaller
      // at brotli q4 than all twelve (-25.9% over 10,000 random fragments). The
      // baked grid carries none, since no tooltip ever runs over it. Without
      // the attribute, tooltip.js fetches meta/<stem>.json.
      //
      // Its quoting varies per tile in the minified page (a backtick, ASCII 96,
      // forces quotes). Both forms are legal.
      const hist = !deferred && index < PRIORITISED_TILES ? histograms[p.stem] : null;
      const histAttr = hist ? html` data-hist="${hist}"` : EMPTY;
      const sizeAttr = asNumber(p.size) > 0 ? html` data-size="${p.size}"` : EMPTY;
      const upAttr = p.uploaded ? html` data-uploaded="${p.uploaded}"` : EMPTY;

      // <noscript> is inert under scripting, so these URLs never reach the
      // preload scanner. One URL here too: a <picture> cost 195 bytes a tile
      // against 130, for a client both no-JS and no-AVIF (tried and reverted
      // 2026-08-12). width and height reserve the fixed 184px tile.
      const noScript = deferred
        ? html`<noscript><img alt="${alt}" width="184" height="184" src="${thumb}" loading="lazy"${pri} decoding="async"></noscript>`
        : EMPTY;

      // data-srcset for the same reason as data-src: no fetch the hydrator discards.
      const image = deferred
        ? html`<img data-photo-deferred alt="${alt}" width="184" height="184" data-src="${thumb}"${srcsetValue ? html` data-srcset="${srcsetValue}" sizes="184px"` : EMPTY} loading="eager"${pri} decoding="async">`
        : html`<img alt="${alt}" width="184" height="184" src="${thumb}"${srcsetValue ? html` srcset="${srcsetValue}" sizes="184px"` : EMPTY} loading="eager"${pri} decoding="async">`;

      return html`<a href="/images/full/${encodeURI(p.full)}" target="_blank" rel="noopener" data-full="${p.full}"${sizeAttr}${upAttr}${histAttr}>${image}${noScript}</a>`;
    }),
  );
}

// Sorted by stem, so the baked twelve changes only when the photo pool does.
// The dcz delta and the 304 both rest on that.
export function deterministicTwelve(pool) {
  return [...pool].sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)).slice(0, 12);
}
