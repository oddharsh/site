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
// Every tile stays fetchpriority=low. That is unchanged and still load-bearing:
// #156 measured the introductory prose as the LCP element at 390px and 1280px
// alike, so no photo is on the critical path and none of them should compete
// with one.
export function renderPhotoSlots(pick, altMap = {}, { deferred = true } = {}) {
  return pick.map((p) => {
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
          `<img alt="${alt}" width="600" height="600" src="${escAttr(jpg)}" loading="lazy" fetchpriority="low" decoding="async">` +
        `</picture></noscript>`
      : "";

    const picture = deferred
      ? `<picture data-photo-deferred>` + sources("data-srcset") +
          `<img alt="${alt}" width="600" height="600" data-src="${escAttr(jpg)}" loading="eager" fetchpriority="low" decoding="async">` +
        `</picture>`
      : `<picture>` + sources("srcset") +
          `<img alt="${alt}" width="600" height="600" src="${escAttr(jpg)}" loading="eager" fetchpriority="low" decoding="async">` +
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
