// lib/photo-grid.js — the homepage photo grid's markup, in ONE place.
//
// Two callers render this, and they must not drift:
//   - build.mjs bakes a DETERMINISTIC twelve into the staged index.html, which
//     is what makes the document byte-stable enough to carry a dcz delta and
//     answer a 304. Those tiles are also the whole grid for a visitor without
//     JavaScript, via the <noscript> twin beside each one.
//   - /photos/grid.html renders a fresh RANDOM twelve per request, which the
//     inline hydrator swaps in over the baked set.
//
// Same function, same tiles, so "what the crawler sees" and "what the visitor
// sees" differ only in WHICH photos and in whether the URLs are live yet (the
// `deferred` option below, which exists for one reason: only the baked set is
// ever thrown away). This module deliberately imports nothing that touches a
// Worker global, so Node can import it straight out of the staged tree at
// build time.
import { escAttr } from "./http.js";

// Pool URLs are already absolute /i/ form; this is the last-resort shim for a
// pool entry that predates that (kept identical to photos.js's absThumb).
const abs = (u) => (u && u.startsWith("/") ? u : `/images/${u}`);

// WHICH tiles carry a real `src` depends on which caller is rendering, and the
// reason is the same one in both directions: a URL should only be in the markup
// when it is a URL the visitor is actually going to use.
//
//   deferred: true  — the BAKED twelve. These are a fallback the hydrator is
//     about to replace, so a real `src` here fetches a thumbnail that is
//     discarded milliseconds later. URLs stay in data-* and the <noscript> twin
//     carries the script-off path. This is the double-download #156 removed.
//
//   deferred: false — the /photos/grid.html fragment. These tiles ARE the grid.
//     Nothing is going to replace them, so they carry real URLs and start
//     immediately on innerHTML. No <noscript> twin: the fragment only ever
//     arrives via fetch(), which means script is running by definition.
//
// The IntersectionObserver that used to gate the fragment came out on
// 2026-07-29. Measured on production at 1280x720 before removing it: 9 of 12
// tiles fetched, 102.1 KB total, every one of them complete 48ms after the
// first started. The three it withheld were row 4 (top 1033px against a 640px
// .content scroller plus a 190px margin), so the first scroll landed on white
// squares — the same failure the margin was added to fix, moved down one row.
// Loading all twelve costs ~34 KB more and removes the white squares, the
// observer, and the rootMargin tuning that has now been wrong twice.
//
// PRIORITY IS SPLIT WITHIN THE GRID, and the CEILING from #156 has not moved:
// the introductory prose is the LCP element at 390px and 1280px alike, so no
// tile may be raised to fetchpriority=high and none is. What changed is the
// FLOOR. Every tile used to be low, which is ONE urgency bucket, and one bucket
// is what makes the edge round-robin all twelve. Measured on production
// 2026-08-10: the twelve issue in the same millisecond and then complete spread
// over 334ms (303ms to 637ms), with completion order uncorrelated to size (a
// 4.5KB tile landed 9th, a 34.8KB tile 11th). That is fair-share interleave,
// and it is the wrong schedule here because the tiles are AVIF, which has no
// progressive mode: a half-delivered tile paints nothing, so the interleave
// costs everything and returns nothing.
//
// So the first six carry NO fetchpriority (the default) and the last six stay
// low, giving the edge two buckets to order by. Cloudflare honours the
// separation. Twenty same-tier /i/ thumbnails fetched at once with priorities
// ALTERNATING by issue order, on confirmed `cf-cache-status: HIT`, gave mean
// completion ranks of 6.2/12.8, 6.2/12.8, 5.7/13.3 and 8.5/10.5 over four
// trials, where perfect separation is 4.5/14.5 and none is 9.5/9.5; the
// all-equal control sat at exactly 9.5 every run.
//
// The probe METHOD is the part worth keeping. Run it against cache-BUSTED URLs
// and 2 of 6 trials come back flat at 9.5/9.5, because miss latency swamps the
// scheduler. A probe that busts cache is measuring a path production never
// takes and reads as "priority does nothing." Warm the edge first, assert the
// HIT, then measure.
//
// Six is a PREFIX rather than a row count: .photos is `repeat(auto-fill, 184px)`
// with justify-content:center, so the column count moves with the window. Six is
// the first two rows at three across (the default window) and still inside the
// first two at four across. In DOM order a prefix is always the topmost tiles,
// whatever the wrap, which is the property that makes this safe to hardcode.
const PRIORITISED_TILES = 6;

export function renderPhotoSlots(pick, altMap = {}, { deferred = true } = {}) {
  return pick.map((p, index) => {
    // Omitted rather than spelled `auto` because they mean the same thing to the
    // browser and one of them costs bytes on every tile.
    const pri = index < PRIORITISED_TILES ? "" : ` fetchpriority="low"`;
    const small = p.thumb_small ? abs(p.thumb_small) : null;
    const large = p.thumb_avif ? abs(p.thumb_avif) : null;
    const jpg = abs(p.thumb_jpg);
    // Fall back to the stem rather than alt="": the tile IS the link, so an
    // empty alt makes the <a> nameless for screen readers and agents.
    const alt = escAttr(altMap[p.stem] || p.stem);
    const sizeAttr = (typeof p.size === "number" && p.size > 0) ? ` data-size="${p.size}"` : "";
    const upAttr = p.uploaded ? ` data-uploaded="${escAttr(p.uploaded)}"` : "";

    // Mobile (<=560px) pins the 400px tier; the tile renders 174px there, so
    // 400px is already 2x-dense. Desktop is responsive: 400w/600w + sizes:174px
    // lands 400px on DPR1/DPR2 and 600px only on DPR3. Descriptor use stays
    // uniform across a picture's sources, which is what the HTML spec wants and
    // what Nu flags when it is mixed.
    const sources = (attr) =>
      (small ? `<source type="image/avif" media="(max-width: 560px)" ${attr}="${escAttr(small)} 400w" sizes="174px">` : "") +
      (large
        ? (small
            ? `<source type="image/avif" ${attr}="${escAttr(small)} 400w, ${escAttr(large)} 600w" sizes="174px">`
            : `<source type="image/avif" ${attr}="${escAttr(large)}">`)
        : "");

    // In a scripting browser <noscript> is inert text, so these real URLs never
    // enter the preload scanner and cannot undo the deferral above. Without JS
    // they are the entire grid, which is why the baked set has to be real
    // photos rather than empty frames. The fragment needs no twin — reaching it
    // at all required fetch().
    const noScript = deferred
      ? `<noscript><picture>` + sources("srcset") +
          `<img alt="${alt}" width="600" height="600" src="${escAttr(jpg)}" loading="lazy"${pri} decoding="async">` +
        `</picture></noscript>`
      : "";

    const picture = deferred
      ? `<picture data-photo-deferred>` + sources("data-srcset") +
          `<img alt="${alt}" width="600" height="600" data-src="${escAttr(jpg)}" loading="eager"${pri} decoding="async">` +
        `</picture>`
      : `<picture>` + sources("srcset") +
          `<img alt="${alt}" width="600" height="600" src="${escAttr(jpg)}" loading="eager"${pri} decoding="async">` +
        `</picture>`;

    return `<a href="/images/full/${encodeURI(p.full)}" target="_blank" rel="noopener"` +
           ` data-full="${escAttr(p.full)}"${sizeAttr}${upAttr}>` +
      picture + noScript +
    `</a>`;
  }).join("");
}

// The deterministic twelve for the baked fallback. Sorting by stem makes the
// choice a pure function of the committed pool, so the staged index.html only
// changes when the pool does — which is the property the dcz delta and the 304
// both rest on. Adding a photo reshuffles this set and mints a new document;
// that is correct, and it is exactly as often as the page changes anyway.
export function deterministicTwelve(pool) {
  return [...pool].sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)).slice(0, 12);
}
