// lib/photo-grid.js — the homepage photo grid's markup, in ONE place.
//
// Two callers render this, and they must not drift:
//   - build.ts bakes a DETERMINISTIC twelve into the staged index.html, which
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
import { escAttr } from "./http.ts";
import { asNumber } from "./parse.ts";

// Pool URLs are already absolute /i/ form; this is the last-resort shim for a
// pool entry that predates that (kept identical to photos.js's absThumb).
const abs = (u) => (u && u.startsWith("/") ? u : `/images/${u}`);

// WHICH tiles carry a real `src` depends on which caller is rendering, and the
// reason is the same one in both directions: a URL should only be in the markup
// when it is a URL the visitor is actually going to use. Each tile names ONE
// FORMAT. The old <picture> named a selected AVIF plus a JPEG fallback; a
// Chromium hover capture on 2026-08-11 showed the fallback being instantiated
// again and again as the cursor crossed the grid (13 JPEG image loads for one
// tile, most from memory cache). Every browser this site targets decodes AVIF,
// so the canonical browser path is AVIF with no second format behind it.
//
// That paragraph used to end "one 400px AVIF URL", and the sentence before it
// read "the 400px tier is already more than 2x the 184px tile". Both were the
// format argument doing double duty as a SIZE argument, and the size half was
// wrong in both directions: 2x the tile is right for a DPR-2 display and 2.3x
// oversupply for DPR-1, while DPR-3 asks for 552px and was handed 400. The tile
// now names three SIZES of the one format through srcset, which is a different
// mechanism from <picture>'s type selection and measurably does not reproduce
// the re-instantiation above (see the control at the srcset construction below).
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

export function renderPhotoSlots(pick, altMap = {}, { deferred = true, histograms = {} } = {}) {
  return pick.map((p, index) => {
    // Omitted rather than spelled `auto` because they mean the same thing to the
    // browser and one of them costs bytes on every tile.
    const pri = index < PRIORITISED_TILES ? "" : ` fetchpriority="low"`;
    // Current photo artifacts always have thumb_small. The larger AVIF and then
    // JPEG are recovery paths for an old/incomplete manifest entry, not alternate
    // candidates emitted beside it: even that degraded row still names one URL.
    const thumb = abs(p.thumb_small || p.thumb_avif || p.thumb_jpg);
    // ONE FORMAT, THREE SIZES. The candidates are all AVIF, which is what makes
    // this different from the <picture> the note above removed: that raced two
    // FORMATS behind one element and the loser kept being instantiated on hover.
    // srcset resolves to a single candidate at layout and never touches the
    // others. Measured before writing this, 12 tiles and two full hover passes at
    // DPR 1 and DPR 2: 12 image loads on the page, 0 extra from hovering, byte
    // for byte the same count as the single-URL control.
    //
    // 184px is .photos' fixed column (repeat(auto-fill, 184px)), so `sizes` is a
    // constant rather than a guess: 184, 368 and 552 device pixels at DPR 1, 2
    // and 3, which is exactly what the three tiers cover. Before this the 400px
    // file went to everyone, 2.3x what a 1x display can show, while a DPR-3 phone
    // asked for 552 and got 400.
    const cands = [
      p.thumb_xs ? `${abs(p.thumb_xs)} 200w` : "",
      p.thumb_small ? `${abs(p.thumb_small)} 400w` : "",
      p.thumb_avif ? `${abs(p.thumb_avif)} 600w` : "",
    ].filter(Boolean);
    // One candidate is what `src` already says, so the attribute would be pure
    // bytes. This is also the degraded path for a stem the pipeline half-ran.
    const srcset = cands.length > 1
      ? ` srcset="${escAttr(cands.join(", "))}" sizes="184px"`
      : "";
    // Fall back to the stem rather than alt="": the tile IS the link, so an
    // empty alt makes the <a> nameless for screen readers and agents.
    const alt = escAttr(altMap[p.stem] || p.stem);
    // The tooltip's four histogram channels, packed to 256 bytes and base64'd,
    // riding with the tile that owns them. This used to arrive on the hover that
    // needed it, one /images/meta/<stem>.json per photo: measured on production
    // at 135ms and 117ms for the first two hovers, once per photo, with the bars
    // unable to draw until the file landed.
    //
    // It has to be in the MARKUP rather than warmed by tooltip.js, because
    // tooltip.js does not exist until the first hover happens (index.html's
    // loader is deliberate about that: "visitors who never hover transfer no
    // tooltip JavaScript"). Anything that module warms is by construction too
    // late for hover number one.
    //
    // One character per bin in ASCII 63..126, packed by
    // tools/photos/build-histogram-index.ts, which carries the reasoning. 256 chars a
    // tile against base64's 344, and 36% smaller after brotli because base64
    // destroys the byte alignment brotli exploits on smooth data.
    //
    // The range holds no character needing escaping, so escAttr is a no-op here
    // by construction rather than by luck. It DOES hold a backtick (96), one of
    // the characters that forces minify-html to keep the quotes: measured on the
    // staged document, 7 of 12 tiles quoted and 5 unquoted, all 12 intact at 256
    // characters. Both forms are spec-legal and dataset reads them identically;
    // noted because an attribute whose quoting varies per value looks like a bug
    // the first time you diff the output.
    //
    // Absent is a legal state and tooltip.js falls back to its per-photo fetch,
    // which is what a stem with no baked histogram gets.
    const hist = histograms[p.stem];
    const histAttr = hist ? ` data-hist="${escAttr(hist)}"` : "";
    const sizeAttr = (asNumber(p.size) > 0) ? ` data-size="${p.size}"` : "";
    const upAttr = p.uploaded ? ` data-uploaded="${escAttr(p.uploaded)}"` : "";

    // In a scripting browser <noscript> is inert text, so these real URLs never
    // enter the preload scanner and cannot undo the deferral above. Without JS
    // they are the entire grid, which is why the baked set has to be real
    // photos rather than empty frames. The fragment needs no twin — reaching it
    // at all required fetch().
    //
    // ONE url here too. A <picture> was tried on 2026-08-12 and reverted the
    // same day: it is SAFE in inert markup (nothing can instantiate a fallback,
    // and a no-JS AVIF browser would still pick the AVIF source), but it costs
    // 195 bytes a tile against 130 to serve a client that has to be no-JS AND
    // no-AVIF at once. Kitesurf runs JavaScript, so the engine this whole repair
    // exists for takes the onerror path in index.html and never reads this
    // block. Paying every visitor for a hypothetical one is the trade this file
    // already refuses everywhere else.
    // 184x184 rather than 600x600. The attributes exist to reserve layout, and
    // the ratio is what does that, so the old value was harmless and also
    // described a file that has not been served since the grid moved to the
    // 400px tier. With srcset it would be actively misleading: the intrinsic
    // size now depends on which candidate wins, and the tile is always 184.
    //
    // The noscript twin deliberately keeps ONE url and no srcset. It is inert
    // text in a scripting browser, and the note above already priced a second
    // representation there at 195 bytes a tile against 130 to serve a client
    // that must be no-JS AND no-AVIF at once.
    const noScript = deferred
      ? `<noscript><img alt="${alt}" width="184" height="184" src="${escAttr(thumb)}" loading="lazy"${pri} decoding="async"></noscript>`
      : "";

    // data-srcset rides with data-src for the deferred set, for the same reason
    // data-src does: a real srcset here starts a fetch the hydrator is about to
    // throw away, which is the double-download #156 removed.
    const image = deferred
      ? `<img data-photo-deferred alt="${alt}" width="184" height="184" data-src="${escAttr(thumb)}"${srcset.replace(" srcset=", " data-srcset=")} loading="eager"${pri} decoding="async">`
      : `<img alt="${alt}" width="184" height="184" src="${escAttr(thumb)}"${srcset} loading="eager"${pri} decoding="async">`;

    return `<a href="/images/full/${encodeURI(p.full)}" target="_blank" rel="noopener"` +
           ` data-full="${escAttr(p.full)}"${sizeAttr}${upAttr}${histAttr}>` +
      image + noScript +
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
