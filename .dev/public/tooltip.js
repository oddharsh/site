// tooltip.js — the rich hover island for photos, tracks, artists, and car links.
// Loaded on the first hover/focus and replayed against that initial target, so
// visitors who never ask for a tooltip transfer none of this interaction island.
//
// The hover ENGINE moved to hoist.js, shared with serendipity's event covers
// and nav.js's Run preview. What stays here is the part that is actually about
// this page's content: the EXIF meta fetch, the Spotify DNS hints, and the four
// content builders.

import { createHoist, hoverCapable, ANCHOR_OK } from "/hoist.js";

// The local parse layer. Client scripts here have no shared module graph, so
// they cannot import _worker.js/lib/parse.js; redeclaring a couple of
// coercions is the same trade these files already make for esc().
/* oxlint-disable anti-slop/no-runtime-typeof -- a hand-rolled parser is made
   of typeof; keeping the checks here rather than at each use is the point. */
function asNumber(v) { return typeof v === "number" && isFinite(v) ? v : null; }
function asRecord(v) { return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null; }
/* oxlint-enable anti-slop/no-runtime-typeof */

export function start(initial) {
      const tip = document.getElementById("xp-tooltip");
      if (!tip) return;

      // Bail before building any of the content machinery below. createHoist
      // would no-op on a coarse pointer anyway, but the fetches, formatters,
      // and builders are all dead weight for a surface that can never show.
      if (!hoverCapable()) return;


      // The lazy DNS-prefetch for Spotify's image CDNs is GONE, along with the
      // reason it existed. rn.js now re-hosts recognized art at /rn/art/…, so a
      // hover fetches from this origin, which the browser is already connected
      // to — there is no third-party handshake left to warm.
      //
      // Two shapes still resolve to Spotify: an art URL with no parseable hash,
      // and a fragment cached before this shipped (up to RN_TRACKS_TTL). Both
      // pay one cold DNS lookup on hover, which is what the hint was saving, and
      // neither is worth carrying a permanent hint plus its injection machinery
      // for. Same call the homepage made when it dropped its eight preconnects:
      // a hint for a host most visitors never reach is paid by everyone.
      //
      // If the fallback path ever becomes common rather than residual, the fix
      // is to find out WHY hashes are not parsing, not to re-add this.

      const fmtBytes = (n) => {
        if (!n) return "";
        const b = Number(n);
        if (b < 1024)       return `${b} B`;
        if (b < 1024*1024)  return `${(b/1024).toFixed(1)} KB`;
        if (b < 1024**3)    return `${(b/1024/1024).toFixed(1)} MB`;
        return `${(b/1024**3).toFixed(2)} GB`;
      };
      const fmtDate = (raw) => {
        // accept both ISO ("YYYY-MM-DDTHH:MM:SSZ" from R2 upload timestamps) and
        // Fuji EXIF format ("YYYY:MM:DD HH:MM:SS" from exiftool). output is the
        // site convention: MM-DD-YYYY, HH:MM.
        // EXIF capture time is a WALL CLOCK with no zone — `new Date()` would
        // reinterpret it in the viewer's timezone and shift it. So we use
        // Temporal.PlainDateTime (shows it exactly as recorded, everywhere), and
        // even the no-Temporal fallback parses the parts directly rather than via
        // Date. Upload timestamps ARE instants → shown in the viewer's local zone.
        if (!raw) return "";
        const s = String(raw).trim()
          .replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")
          .replace(" ", "T");
        const p2 = (n) => String(n).padStart(2, "0");
        const isInstant = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s);
        if (isInstant) {
          try {
    // Bare global, only typeof can ask.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
            if (typeof Temporal !== "undefined") {
              const z = Temporal.Instant.from(s).toZonedDateTimeISO(Temporal.Now.timeZoneId());
              return `${p2(z.month)}-${p2(z.day)}-${z.year}, ${p2(z.hour)}:${p2(z.minute)}`;
            }
          } catch (e) {}
          const d = new Date(s);
          if (isNaN(d.getTime())) return "";
          return `${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${d.getFullYear()}, ${p2(d.getHours())}:${p2(d.getMinutes())}`;
        }
        try {
    // Bare global, only typeof can ask.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
          if (typeof Temporal !== "undefined") {
            const t = Temporal.PlainDateTime.from(s);
            return `${p2(t.month)}-${p2(t.day)}-${t.year}, ${p2(t.hour)}:${p2(t.minute)}`;
          }
        } catch (e) {}
        const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
        return m ? `${m[2]}-${m[3]}-${m[1]}, ${m[4]}:${m[5]}` : "";
      };
      const esc = (s) => String(s ?? "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

      // ── camera-readout helpers (photo tooltip = XP camera-back review) ──
      const fmtFocal = (raw) => raw ? String(raw).replace(/\s+mm$/i, " mm") + " FF" : "";
      const flashBolt = (raw) => (raw && /\bFired\b|\bOn\b/i.test(raw))
        ? `<span class="flash-bolt" title="${esc(raw)}"><svg viewBox="0 0 12 16" width="11" height="14"><path d="M10 1 L4 1 L2 9 L6 9 L3 15 L11 7 L7 7 Z" fill="currentColor"/></svg></span>`
        : "";
      // RGB+luminance histogram → SVG. {l,r,g,b}, each 64 ints (0..100): luma
      // a filled polygon, R/G/B colored polylines (colors via CSS classes).
      const renderHistogramSvg = (h) => {
        if (!h || !Array.isArray(h.l) || !h.l.length) return "";
        const yFor = v => (32 - (Math.max(0, Math.min(100, v)) * 30) / 100).toFixed(1);
        const pts = a => a.map((v, i) => `${i},${yFor(v)}`).join(" ");
        const n = h.l.length;
        const luma = `<polygon class="luma" points="0,32 ${pts(h.l)} ${n - 1},32"/>`;
        const r = Array.isArray(h.r) ? `<polyline class="r" points="${pts(h.r)}"/>` : "";
        const g = Array.isArray(h.g) ? `<polyline class="g" points="${pts(h.g)}"/>` : "";
        const b = Array.isArray(h.b) ? `<polyline class="b" points="${pts(h.b)}"/>` : "";
        return `<svg class="hist-svg" viewBox="0 0 ${n - 1} 32" preserveAspectRatio="none">${luma}${r}${g}${b}</svg>`;
      };
      // histogram bins are BAKED at photo-add time (`zenc histogram` measures
      // the shipped JPG twin, so the bars stay tied to the published thumbnail)
      // and ride the same meta/<stem>.json as the EXIF. The old decode → canvas
      // → getImageData → main-thread binning pipeline is gone; renderHistogramSvg
      // draws the prebuilt SVG data from meta.hi.
      //
      // the per-photo files are the HOT PATH (one fetch per hover), so they use
      // SHORT keys and carry only what this tooltip renders. they are a render
      // cache, not the record: the full, self-documenting Fuji recipe (long key
      // names, fujixweekly-style card) lives in /images/metadata.json.
      // cm camera · ln lens · ap aperture · sp shutter · is iso · fl focal · ev ·
      // dt date · w · h · wb white-balance · ct color-temp · fs flash · fm film ·
      // dr · cc chrome · cb chrome-blue · gr grain · gs grain-size · ht highlight ·
      // st shadow · sa saturation · hi {l,r,g,b} histogram. nulls dropped.
      const histFor = (stem) => (metaMap[stem] && metaMap[stem].hi) || null;
      // EXIF is NOT inlined on the uncacheable homepage. It arrives in two tiers.
      //
      // TEXT: one shared /images/exif.json for all 158 photos, 2.6KB brotli,
      // immutable and busted by ?mv. This used to be 12 per-photo fetches warmed
      // for the current selection, on the reasoning that a repeat visit would
      // replay them from cache. The homepage draws a fresh RANDOM 12 of 158 per
      // request, so a given slot repeats about 7.6% of the time and that cache
      // almost never hit: a cache-off capture showed ~8.9KB across 12 cold
      // requests, and the next visit paid it again. The whole-library index is
      // smaller than that on the FIRST visit (11 fewer sets of response headers,
      // and 158 records compress against each other) and free on every visit
      // after, whatever the draw.
      //
      // BARS: the four 64-bin histogram channels stay PER PHOTO, because they are
      // 623 of a meta file's ~977 bytes and would take the index from 2.6KB to
      // 24KB for bars most visitors never see. So a hover renders its text
      // immediately from the index and fetches the one histogram it needs.
      const metaMap = Object.create(null);   // stem → exif object (may lack .hi) | absent
      const inFlight = new Set();            // stems with a per-photo fetch open
      const META_V = "mv=7";                 // bump when metadata is regenerated (7: empty lens is null, so `ln` is absent rather than "" on 11 frames)
      const fetchMeta = (stem, priority) => {
        const have = metaMap[stem];
        if (have && have.hi) return;         // text + bars both in hand
        if (inFlight.has(stem)) return;
        inFlight.add(stem);
        // A stem missing from the index (a photo added since the visitor cached
        // it) lands here too, and this fetch carries the text as well as the
        // bars, so a stale index self-heals instead of rendering blank.
        // warm-up fetches ride at low priority so the browser (and Lighthouse's
        // critical-request-chain audit) treats them as the idle filler they are;
        // a hover-triggered fetch keeps the default because someone is waiting.
        fetch(`/images/meta/${encodeURIComponent(stem)}.json?${META_V}`, priority ? { priority } : undefined)
          .then(r => {
            // non-200, SPA-fallback html, or a transient bot-challenge → treat as a
            // failure and fall to .catch (which frees the stem so we can retry).
            if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw 0;
            return r.json();
          })
          .then(m => {
            if (!asRecord(m)) throw 0;
            metaMap[stem] = m;   // superset of the index entry: EXIF plus .hi
            // re-render if this photo's tip is still the open one. `hoist` is
            // declared below but always initialized by the time this fetch
            // resolves, and hoist.active() is the live target.
            const open = hoist.active();
            if (open && open.matches?.(".photos a") &&
                (open.dataset.full || "").replace(/\.[^.]+$/, "") === stem) hoist.show(open);
          })
          // Deliberately does NOT drop metaMap[stem] on failure any more: the entry
          // is usually the index's EXIF, and discarding it would turn a missing
          // histogram into a blank tooltip. Clearing inFlight is what keeps a later
          // hover able to retry, which is the self-healing property that matters.
          .catch(() => {})
          .finally(() => { inFlight.delete(stem); });
      };

      // The shared index, fetched once during idle. Every stem it carries means a
      // hover that renders its text with no network at all, whichever 12 the
      // server drew. Failure is silent and harmless: fetchMeta's per-photo path
      // still covers every stem, which is exactly the pre-index behaviour.
      let indexRequested = false;
      const fetchExifIndex = () => {
        if (indexRequested) return;
        indexRequested = true;
        fetch(`/images/exif.json?${META_V}`, { priority: "low" })
          .then(r => {
            if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw 0;
            return r.json();
          })
          .then(all => {
            if (!asRecord(all)) throw 0;
            for (const stem of Object.keys(all)) {
              // never clobber a per-photo record already in hand: that one has .hi
              if (!metaMap[stem]) metaMap[stem] = all[stem];
            }
            const open = hoist.active();
            if (open && open.matches?.(".photos a")) hoist.show(open);
          })
          .catch(() => { indexRequested = false; });
      };

      const photoStem = (slot) => {
        const filename = slot.dataset.full || decodeURIComponent((slot.href || "").split("/").pop());
        return filename.replace(/\.[^.]+$/, "");
      };
      // One request instead of one per visible slot. The grid it is warming is a
      // random draw, so warming "just the current selection" was warming a set
      // nobody would see again; the index covers every draw and every later visit.
      // Histograms stay unwarmed on purpose and load on the hover that needs them.
      const warmPhotoMeta = () => {
        if (document.querySelector(".photos a[data-full]")) fetchExifIndex();
      };
      let metaWarmupQueued = false;
      const queuePhotoMetaWarmup = () => {
        if (metaWarmupQueued) return;
        metaWarmupQueued = true;
        const run = () => {
          metaWarmupQueued = false;
          warmPhotoMeta();
        };
        const idle = () => {
  // Capability probe on the browser, not a wire value: nothing to parse.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
          if (typeof window.requestIdleCallback === "function") {
            window.requestIdleCallback(run, { timeout: 2000 });
          } else {
            setTimeout(run, 0);
          }
        };
        // Let the initial page, eager image, and dynamic islands settle before
        // opening the metadata requests. The observer covers the fallback grid
        // if it finishes after this page-load boundary.
        if (document.readyState === "complete") setTimeout(idle, 750);
        else window.addEventListener("load", () => setTimeout(idle, 750), { once: true });
      };
      const photoGrid = document.querySelector("section.photos");
      if (photoGrid) {
        new MutationObserver(() => queuePhotoMetaWarmup()).observe(photoGrid, { childList: true });
      }
      queuePhotoMetaWarmup();

      // unified hover target → "what was hovered?" lookup. one tooltip
      // element, three content shapes: a photo slot (.photos a), a track
      // row (.np-list li[data-track-title]), or an artist link inside a
      // row (.np-artist-link). artist takes precedence over the row when
      // both match, so hovering an artist's name shows the artist card,
      // not the track card.
      const findTarget = (el) =>
        el?.closest?.(".np-artist-link, .photos a, .np-list li[data-track-title], .car-link") || null;

      function buildContent(t) {
        if (t.matches(".car-link"))       return buildCarContent(t);
        if (t.matches(".np-artist-link")) return buildArtistContent(t);
        if (t.matches(".photos a"))       return buildPhotoContent(t);
        if (t.matches(".np-list li"))     return buildTrackContent(t);
        return "";
      }

      // resto-mod car tooltip: a landscape photo of the car the link names,
      // in the paper-mat frame, with a small caption strip. graceful — if the
      // image attrs are missing the tooltip suppresses itself and the link
      // still click-throughs to its Google search.
      function buildCarContent(a) {
        const avif = a.dataset.carAvif || "";
        const jpg  = a.dataset.carJpg  || "";
        if (!avif && !jpg) return "";
        const cap = a.dataset.carCaption || "";
        const credit = a.dataset.carCredit || "";
        return (
          `<div class="car-pop">` +
            `<picture>` +
              (avif ? `<source type="image/avif" srcset="${esc(avif)}">` : ``) +
              `<img src="${esc(jpg || avif)}" alt="" decoding="async" width="240" height="160">` +
            `</picture>` +
            (cap || credit
              ? `<div class="car-cap">` +
                  (cap ? esc(cap) : ``) +
                  (credit ? `<span class="car-credit">${esc(credit)}</span>` : ``) +
                `</div>`
              : ``) +
          `</div>`
        );
      }

      // XP camera-back review readout: a Luna header strip (filename + flash),
      // a sunken histogram band, the exposure trio, the full Fuji recipe as
      // label/value rows, and a date footer. EXIF and the prebuilt histogram are
      // fetched per-photo from /images/meta/<stem>.json after page settle (see
      // fetchMeta and warmPhotoMeta); first hover may still render the shell for
      // a beat if warm-up has not run or a fetch is slow, then re-renders when
      // data lands.
      function buildPhotoContent(slot) {
        const stem = photoStem(slot);
        // Dead: queried on every photo hover and never read. Same reasoning as
    // nav.js: tooltip.js is content-hashed, so this costs a new /a/ URL to
    // remove. Worth taking on the next real edit, since it is a DOM query per
    // hover rather than only a dead binding.
    // oxlint-disable-next-line no-unused-vars
    const img  = slot.querySelector("img");
        fetchMeta(stem);                           // per-photo lazy fetch (no-op if already in hand)
        const exif = metaMap[stem] || {};

        // exposure trio
        const aper = exif.ap ? (String(exif.ap).startsWith("f/") ? exif.ap : "f/" + exif.ap) : "";
        const expo = [exif.sp, aper, exif.is ? "ISO " + exif.is : ""].filter(Boolean).join(" ");

        // EV · dimensions · size strip
        // real EXIF dims only — a square thumbnail's naturalWidth is just 600, not
        // the photo's size, so the old fallback flashed "600 × 600" before EXIF landed.
        const w = exif.w, h = exif.h;
        const dims = (w && h) ? `${w} × ${h}` : "";
        const evStr = (asNumber(exif.ev) !== null && exif.ev !== 0) ? ((exif.ev > 0 ? "+" : "") + exif.ev + " EV") : "";
        const metaStrip = [evStr, dims, slot.dataset.size ? fmtBytes(slot.dataset.size) : ""].filter(Boolean).join(" · ");

        // Fuji recipe rows — only the populated/non-default ones
        const isOn = v => v && !/^off$/i.test(String(v));
        const trimTone = t => (t && t !== "0 (normal)") ? t.replace(/\s*\(.*\)$/, "") : "";
        const chromeParts = [];
        if (isOn(exif.cc))      chromeParts.push(exif.cc);
        if (isOn(exif.cb)) chromeParts.push("blue " + exif.cb);
        const grainVal = isOn(exif.gr) ? (exif.gr + (isOn(exif.gs) ? " " + exif.gs : "")) : "";
        const toneVal = (trimTone(exif.ht) || trimTone(exif.st))
          ? `H ${trimTone(exif.ht) || "0"}  S ${trimTone(exif.st) || "0"}` : "";
        // Fuji stores B&W film sims (Acros / Monochrome, optionally with a Ye/R/G
        // contrast filter) in the Saturation EXIF tag and leaves FilmMode blank — so
        // "Acros Green Filter" is the FILM, not a color setting. route it to the Film
        // row and drop the Color row for B&W frames; color shots keep "+3" etc.
        const bwSim    = !!exif.sa && /\b(acros|monochrome|b\s*&\s*w|bw|sepia)\b/i.test(String(exif.sa));
        const filmVal  = exif.fm || (bwSim ? exif.sa : "");
        const colorVal = bwSim ? "" : trimTone(exif.sa);
        const recipe = [
          ["Body",       exif.cm],
          ["Lens",       [exif.ln, fmtFocal(exif.fl)].filter(Boolean).join(" · ")],
          ["Film",       filmVal],
          ["Dyn range",  exif.dr],
          ["White bal",  exif.wb === "Kelvin" && exif.ct ? exif.ct + "K" : exif.wb],
          ["Chrome FX",  chromeParts.join(" · ")],
          ["Grain",      grainVal],
          ["Tones",      toneVal],
          ["Color",      colorVal],
        ].filter(([, v]) => v && v !== "undefined")
         .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");

        const hist = histFor(stem);
        const histSvg = hist ? renderHistogramSvg(hist) : "";
        const dateStr = fmtDate(exif.dt) || (slot.dataset.uploaded ? "up " + fmtDate(slot.dataset.uploaded) : "");

        return `<div class="cam">` +
            `<div class="header"><span>${esc(stem)}.jpg</span>${flashBolt(exif.fs)}</div>` +
            `<div class="histogram-frame">${histSvg}</div>` +
            `<div class="body">` +
              (expo ? `<div class="exposure">${esc(expo)}</div>` : "") +
              (metaStrip ? `<div class="meta-strip">${esc(metaStrip)}</div>` : "") +
              (recipe ? `<dl class="recipe-rows">${recipe}</dl>` : "") +
            `</div>` +
            `<div class="footer"><span>${esc(dateStr)}</span></div>` +
          `</div>`;
      }

      // One cover, one URL. rn.js recognizes the Spotify hash, re-hosts the art,
      // and emits the already-warmed 240px AVIF tier. The old <picture> paired a
      // 120w/240w AVIF set with a JPEG fallback; recreating those nodes on hover
      // produced the repeating image rows captured on 2026-08-11. A fixed 240px
      // source is exactly 2x this 120px surface and has no competing fallback.
      // Art whose hash will not parse never gets here at all — rn.js emits no
      // image attribute for it, because img-src is 'self' data: and a URL the
      // policy blocks would be a broken frame where the text card belongs.
      //
      // No loading="lazy" on any hover surface. The attribute defers a fetch
      // until the image nears the viewport, and this node is built at the
      // moment it is shown, in the top layer, under the cursor — it is never
      // far from the viewport, so lazy has nothing to defer and can only add a
      // visibility check before the one fetch that was always going to happen.
      // The same holds for the car popover, the Run preview, and serendipity's
      // event covers: an image that exists only while visible is not lazy work.
      const coverHtml = (src) =>
        `<div class="album-pop"><img class="cover album" src="${esc(src)}" alt="" decoding="async" width="120" height="120"></div>`;

      // artist tooltip: just the profile photo in an XP-frame border.
      // mirrors the album-popover treatment — the name is already in the
      // row, so the popover is purely visual. graceful: if image_url is
      // missing, no tooltip at all (mouseover handler suppresses empty).
      function buildArtistContent(span) {
        const image = span.dataset.artistImage || "";
        if (!image) return "";
        return coverHtml(image);
      }

      // track tooltip: the album art with an XP-frame border when we have
      // it. when the cover URL is missing (Spotify embed scrape didn't
      // return one — happens for a small fraction of tracks), fall back
      // to a tiny text card so the row still has a hover affordance.
      // textual info is duplicated from the row by design — without the
      // cover, the only thing the tooltip can show IS the text, and
      // showing nothing makes the row feel broken next to its siblings.
      function buildTrackContent(li) {
        const image = li.dataset.trackImage || "";
        if (image) return coverHtml(image);
        // text fallback. title + artists + duration; flag explicit if it is.
        const title    = li.dataset.trackTitle    || "";
        const artists  = li.dataset.trackArtists  || "";
        const duration = li.dataset.trackDuration || "";
        const explicit = li.dataset.trackExplicit === "1";
        if (!title && !artists) return ""; // truly nothing to show
        const rows = [];
        if (artists) rows.push(artists);
        if (duration) rows.push(duration + (explicit ? " · explicit" : ""));
        else if (explicit) rows.push("explicit");
        return (
          `<div class="filename">${esc(title)}</div>` +
          rows.map(r => `<div class="row">${esc(r)}</div>`).join("")
        );
      }

      // The hover engine lives in hoist.js — top-layer hoist, cursor-follow vs
      // anchored placement, the gap-hop dismissal timer, the scroll model, and
      // the compositor-layer lifecycle. This module keeps only what is actually
      // about photos, tracks, artists, and car links: which elements are
      // targets, and what the tooltip says about one.
      const hoist = createHoist({
        node: tip,
        findTarget,
        contentFor: buildContent,
      });
      if (initial && initial.focus && ANCHOR_OK) hoist.showAnchored(initial.target);
      else if (initial && initial.target) hoist.show(initial.target, initial);
}
