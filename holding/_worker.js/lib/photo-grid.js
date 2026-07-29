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
// Same function, same attributes, so "what the crawler sees" and "what the
// visitor sees" differ only in WHICH photos, never in how a tile is built.
// This module deliberately imports nothing that touches a Worker global, so
// Node can import it straight out of the staged tree at build time.
import { escAttr } from "./http.js";

// Pool URLs are already absolute /i/ form; this is the last-resort shim for a
// pool entry that predates that (kept identical to photos.js's absThumb).
const abs = (u) => (u && u.startsWith("/") ? u : `/images/${u}`);

// EVERY tile is deferred, including the first.
//
// #156 put slots 1-11 behind an IntersectionObserver and left slot 0 directly
// discoverable, because slot 0 is visible at load. That reasoning assumed the
// grid arrived in the document. It no longer does: the baked twelve are a
// fallback that the hydrator is about to replace, so a real `src` on slot 0
// would fetch a thumbnail that is discarded milliseconds later — the exact
// double-download #156 removed, reintroduced from the other side.
//
// The cost is one round trip before the first tile can start, and it is
// affordable for the reason #156 measured: the introductory prose is the LCP
// element at 390px and 1280px alike, so no photo is on the critical path.
// Every tile stays fetchpriority=low for the same reason.
export function renderPhotoSlots(pick, altMap = {}) {
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
    // photos rather than empty frames.
    const noScript =
      `<noscript><picture>` + sources("srcset") +
        `<img alt="${alt}" width="600" height="600" src="${escAttr(jpg)}" loading="lazy" fetchpriority="low" decoding="async">` +
      `</picture></noscript>`;

    return `<a href="/images/full/${encodeURI(p.full)}" target="_blank" rel="noopener"` +
           ` data-full="${escAttr(p.full)}"${sizeAttr}${upAttr}>` +
      `<picture data-photo-deferred>` + sources("data-srcset") +
        `<img alt="${alt}" width="600" height="600" data-src="${escAttr(jpg)}" loading="eager" fetchpriority="low" decoding="async">` +
      `</picture>` + noScript +
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
