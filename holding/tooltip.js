// tooltip.js — the rich hover island for photos, tracks, artists, and car links.
// Loaded after first paint and prefetched during idle so the first intentional
// tooltip gets the same interaction path as every later one.

export function start(initial) {
      const tip = document.getElementById("xp-tooltip");
      if (!tip) return;

      // hover-only feature: long-press on touch devices fires synthetic
      // mouseover/mouseout events and was causing tooltips to appear
      // mid-scroll on mobile. opt out entirely when the device doesn't
      // have a real hover-capable pointer. (`(hover: none)` is the
      // touch-only signal; combined with `(any-hover: none)` to cover
      // hybrid devices where the primary pointer is touch.)
      if (window.matchMedia &&
          (window.matchMedia("(hover: none)").matches ||
           window.matchMedia("(pointer: coarse)").matches)) {
        return;
      }

      let activeSlot = null;

      // lazy DNS-prefetch for Spotify's image CDNs. these hosts only
      // matter when the user hovers a track or artist row (to load the
      // album cover or profile photo). shipping the hints in every page
      // load is wasteful for visitors who never hover. inject on demand,
      // exactly once per session.
      let spotifyHintsInjected = false;
      const injectSpotifyHints = () => {
        if (spotifyHintsInjected) return;
        spotifyHintsInjected = true;
        const hosts = [
          "https://image-cdn-ak.spotifycdn.com",
          "https://image-cdn-fa.spotifycdn.com",
          "https://i.scdn.co",
        ];
        for (const h of hosts) {
          const link = document.createElement("link");
          link.rel  = "dns-prefetch";
          link.href = h;
          document.head.appendChild(link);
        }
      };

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
            if (typeof Temporal !== "undefined") {
              const z = Temporal.Instant.from(s).toZonedDateTimeISO(Temporal.Now.timeZoneId());
              return `${p2(z.month)}-${p2(z.day)}-${z.year}, ${p2(z.hour)}:${p2(z.minute)}`;
            }
          } catch (e) {}
          const d = new Date(s);
          if (isNaN(d)) return "";
          return `${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${d.getFullYear()}, ${p2(d.getHours())}:${p2(d.getMinutes())}`;
        }
        try {
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
      // histogram bins are BAKED at photo-add time (photo-histograms.py measures
      // the shipped JPG twin, so the bars stay tied to the published thumbnail)
      // and ride the same meta/<stem>.json as the EXIF. The old decode → canvas
      // → getImageData → main-thread binning pipeline is gone; renderHistogramSvg
      // draws the prebuilt SVG data from meta.hist.
      const histFor = (stem) => (metaMap[stem] && metaMap[stem].hist) || null;
      // EXIF is NOT inlined on the uncacheable homepage, and not shipped as one big
      // index either — it's fetched PER PHOTO from /images/meta/<stem>.json after
      // page settle (with first-hover fetch as fallback). The tiny files are edge
      // and browser cached, busted by ?mv, so the warm-up covers only the current
      // selection rather than the whole pool; repeat hovers and repeat visits are
      // served from the browser's HTTP cache with no network at all. The baked
      // histogram rides the same file, so bars + EXIF land together in one fetch.
      const metaMap = Object.create(null);   // stem → exif object | null (fetched, none) | absent (not fetched)
      const META_V = "mv=4";                 // bump when metadata is regenerated (4: histograms baked in)
      const fetchMeta = (stem) => {
        if (stem in metaMap) return;         // already in hand, or a fetch is in flight
        metaMap[stem] = null;                // in-flight sentinel (renders as "no exif yet")
        fetch(`/images/meta/${encodeURIComponent(stem)}.json?${META_V}`)
          .then(r => {
            // non-200, SPA-fallback html, or a transient bot-challenge → treat as a
            // failure and fall to .catch (which clears the sentinel so we can retry).
            if (!r.ok || !(r.headers.get("content-type") || "").includes("json")) throw 0;
            return r.json();
          })
          .then(m => {
            if (!m || typeof m !== "object") throw 0;
            metaMap[stem] = m;
            // re-render if this photo's tip is still the open one
            if (activeSlot && activeSlot.matches?.(".photos a") &&
                (activeSlot.dataset.full || "").replace(/\.[^.]+$/, "") === stem) showTipFor(activeSlot);
          })
          // CRUCIAL: drop the sentinel on failure so a later hover RE-FETCHES rather
          // than the photo being stuck empty for the whole session. self-healing.
          .catch(() => { delete metaMap[stem]; });
      };
      // EXIF/histogram is idle-prefetched for the current photo selection after
      // page settle (see warmPhotoMeta below). A first-hover fetch remains the
      // fallback for a busy page or a client-rendered grid. The warm-up costs a
      // small burst for the visible slots, never the full photo library, and
      // repeat visits are served from the browser/edge cache.

      const photoStem = (slot) => {
        const filename = slot.dataset.full || decodeURIComponent((slot.href || "").split("/").pop());
        return filename.replace(/\.[^.]+$/, "");
      };
      const warmPhotoMeta = () => {
        const stems = new Set();
        document.querySelectorAll(".photos a[data-full]").forEach((slot) => {
          const stem = photoStem(slot);
          if (stem) stems.add(stem);
        });
        stems.forEach(fetchMeta);
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
        if (t.matches(".car-link"))   return buildCarContent(t);
        if (t.matches(".np-artist-link")) {
          injectSpotifyHints();
          return buildArtistContent(t);
        }
        if (t.matches(".photos a"))   return buildPhotoContent(t);
        if (t.matches(".np-list li")) {
          injectSpotifyHints();
          return buildTrackContent(t);
        }
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
              `<img src="${esc(jpg || avif)}" alt="" loading="lazy" decoding="async" width="240" height="160">` +
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
        const img  = slot.querySelector("img");
        fetchMeta(stem);                           // per-photo lazy fetch (no-op if already in hand)
        const exif = metaMap[stem] || {};

        // exposure trio
        const aper = exif.aperture ? (String(exif.aperture).startsWith("f/") ? exif.aperture : "f/" + exif.aperture) : "";
        const expo = [exif.shutter, aper, exif.iso ? "ISO " + exif.iso : ""].filter(Boolean).join(" ");

        // EV · dimensions · size strip
        // real EXIF dims only — a square thumbnail's naturalWidth is just 600, not
        // the photo's size, so the old fallback flashed "600 × 600" before EXIF landed.
        const w = exif.width, h = exif.height;
        const dims = (w && h) ? `${w} × ${h}` : "";
        const evStr = (typeof exif.ev === "number" && exif.ev !== 0) ? ((exif.ev > 0 ? "+" : "") + exif.ev + " EV") : "";
        const metaStrip = [evStr, dims, slot.dataset.size ? fmtBytes(slot.dataset.size) : ""].filter(Boolean).join(" · ");

        // Fuji recipe rows — only the populated/non-default ones
        const isOn = v => v && !/^off$/i.test(String(v));
        const trimTone = t => (t && t !== "0 (normal)") ? t.replace(/\s*\(.*\)$/, "") : "";
        const chromeParts = [];
        if (isOn(exif.chrome))      chromeParts.push(exif.chrome);
        if (isOn(exif.chrome_blue)) chromeParts.push("blue " + exif.chrome_blue);
        const grainVal = isOn(exif.grain) ? (exif.grain + (isOn(exif.grain_size) ? " " + exif.grain_size : "")) : "";
        const toneVal = (trimTone(exif.highlight_tone) || trimTone(exif.shadow_tone))
          ? `H ${trimTone(exif.highlight_tone) || "0"}  S ${trimTone(exif.shadow_tone) || "0"}` : "";
        // Fuji stores B&W film sims (Acros / Monochrome, optionally with a Ye/R/G
        // contrast filter) in the Saturation EXIF tag and leaves FilmMode blank — so
        // "Acros Green Filter" is the FILM, not a color setting. route it to the Film
        // row and drop the Color row for B&W frames; color shots keep "+3" etc.
        const bwSim    = !!exif.saturation && /\b(acros|monochrome|b\s*&\s*w|bw|sepia)\b/i.test(String(exif.saturation));
        const filmVal  = exif.film || (bwSim ? exif.saturation : "");
        const colorVal = bwSim ? "" : trimTone(exif.saturation);
        const recipe = [
          ["Body",       exif.camera],
          ["Lens",       [exif.lens, fmtFocal(exif.focal)].filter(Boolean).join(" · ")],
          ["Film",       filmVal],
          ["Dyn range",  exif.dr],
          ["White bal",  exif.white_balance === "Kelvin" && exif.color_temp ? exif.color_temp + "K" : exif.white_balance],
          ["Chrome FX",  chromeParts.join(" · ")],
          ["Grain",      grainVal],
          ["Tones",      toneVal],
          ["Color",      colorVal],
        ].filter(([, v]) => v && v !== "undefined")
         .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");

        const hist = histFor(stem);
        const histSvg = hist ? renderHistogramSvg(hist) : "";
        const dateStr = fmtDate(exif.date) || (slot.dataset.uploaded ? "up " + fmtDate(slot.dataset.uploaded) : "");

        return `<div class="cam">` +
            `<div class="header"><span>${esc(stem)}.jpg</span>${flashBolt(exif.flash)}</div>` +
            `<div class="histogram-frame">${histSvg}</div>` +
            `<div class="body">` +
              (expo ? `<div class="exposure">${esc(expo)}</div>` : "") +
              (metaStrip ? `<div class="meta-strip">${esc(metaStrip)}</div>` : "") +
              (recipe ? `<dl class="recipe-rows">${recipe}</dl>` : "") +
            `</div>` +
            `<div class="footer"><span>${esc(dateStr)}</span></div>` +
          `</div>`;
      }

      // artist tooltip: just the profile photo in an XP-frame border.
      // mirrors the album-popover treatment — the name is already in the
      // row, so the popover is purely visual. graceful: if image_url is
      // missing, no tooltip at all (mouseover handler suppresses empty).
      function buildArtistContent(span) {
        const image = span.dataset.artistImage || "";
        if (!image) return "";
        return (
          `<div class="album-pop">` +
            `<img class="cover album" src="${esc(image)}" alt="" loading="lazy" decoding="async" width="120" height="120">` +
          `</div>`
        );
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
        if (image) {
          return (
            `<div class="album-pop">` +
              `<img class="cover album" src="${esc(image)}" alt="" loading="lazy" decoding="async" width="120" height="120">` +
            `</div>`
          );
        }
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

      // lightweight cursor tracking: JS writes --x/--y (the cursor's
      // clientX/Y in px); CSS positions the tooltip via translate(clamp())
      // with a hard snap, zero lag. no rAF, no getBoundingClientRect, no
      // resize listener — edge-clamping uses the element's own size in CSS,
      // so it stays correct as a cover image sizes the box. lastX/lastY are
      // kept only for scroll re-evaluation (elementFromPoint).
      let lastX = 0, lastY = 0;
      const place = (e) => {
        lastX = e.clientX; lastY = e.clientY;
        tip.style.setProperty("--x", lastX + "px");
        tip.style.setProperty("--y", lastY + "px");
      };
      // show/hide via the Popover API (top layer — no z-index juggling,
      // and it unlocks the @starting-style fade). guard the calls because
      // showPopover()/hidePopover() throw if the element is already in the
      // target state. on engines without popover support (below the modern
      // target), fall back to a plain display toggle so nothing breaks.
      const supportsPopover = "popover" in HTMLElement.prototype;
      const isOpen = () => supportsPopover
        ? tip.matches(":popover-open")
        : tip.style.display === "block";
      // will-change is an "earn it" hint, not a permanent set (see the gotcha
      // log): leaving it on while the tooltip is display:none would pin a
      // compositor layer for an invisible element. so we promote it to its own
      // layer ONLY while open — that makes the per-pointermove translate a pure
      // compositor transform (off the main thread, no box repaint), which is
      // what keeps tracking smooth on ProMotion / Low-Power VRR displays — then
      // release the layer the instant it closes.
      const openTip = () => {
        tip.style.willChange = "transform";
        if (supportsPopover) { if (!tip.matches(":popover-open")) tip.showPopover(); }
        else tip.style.display = "block";
      };
      const closeTip = () => {
        if (supportsPopover) { if (tip.matches(":popover-open")) tip.hidePopover(); }
        else tip.style.display = "none";
        tip.style.willChange = "auto";
      };
      // anchoredEl tracks the element a keyboard-focus tooltip is tethered to
      // (via CSS anchor positioning) so we can release its anchor-name on hide.
      let anchoredEl = null;
      const dropAnchor = () => {
        if (anchoredEl) { anchoredEl.style.removeProperty("anchor-name"); anchoredEl = null; }
        tip.classList.remove("anchored");
      };
      const hideTip = () => {
        closeTip();
        dropAnchor();
        activeSlot = null;
      };
      // dismissal is deferred by a hair (TIP_DISMISS_MS) so hopping from one hover
      // target straight across the small gap to the NEXT one doesn't flash the
      // tooltip off-then-on. a fresh pointerover cancels the pending hide; if the
      // cursor instead comes to rest in the gap, the tooltip still clears after the
      // delay, so the dead space between entries shows nothing. shared by every
      // hover target here (photos, tracks, artists, car links) — one tooltip engine.
      const TIP_DISMISS_MS = 50;
      let hideTimer = 0;
      // keyboard tips anchor via CSS anchor positioning where supported;
      // pointer tips ALWAYS follow the cursor (owner re-ruling 2026-07-03:
      // the anchored-hover experiment shipped and was rolled back the same
      // day — gliding the album art with the cursor is part of the site's
      // identity, same as the photo camera-back, and the 500ms cold-hover
      // delay read as lag, not authenticity).
      const ANCHOR_OK = window.CSS && CSS.supports &&
        (CSS.supports("position-area: bottom") || CSS.supports("inset-area: bottom"));
      // while the content is actively scrolling (and a hair after it settles) we
      // suppress tooltips entirely — scrolling shouldn't trip a popover just
      // because the cursor happens to pass over a photo or track. tooltips return
      // on the next intentional hover-move.
      let scrolling = false, scrollIdle = 0;
      const cancelHide   = () => { clearTimeout(hideTimer); hideTimer = 0; };
      const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hideTip, TIP_DISMISS_MS); };
      const showTipFor = (target, e) => {
        if (scrolling) return;               // don't pop a tooltip mid-scroll
        cancelHide();                        // a fresh show cancels any pending gap-dismissal
        dropAnchor();                        // pointer entry always uses cursor-follow
        activeSlot = target;
        const html = buildContent(target);
        if (!html) { hideTip(); return; }   // e.g. track with no cover yet
        tip.innerHTML = html;
        if (e) place(e);                     // position before showing (no glide-in)
        openTip();
      };
      // keyboard-only anchored show (pointer never routes here anymore)
      const showAnchored = (target) => {
        if (scrolling) return;
        cancelHide();
        const html = buildContent(target);
        if (!html) { hideTip(); return; }
        dropAnchor();
        activeSlot = target;
        tip.innerHTML = html;
        target.style.setProperty("anchor-name", "--xp-tip");
        anchoredEl = target;
        tip.classList.add("anchored");
        openTip();
      };

      document.addEventListener("pointerover", (e) => {
        const target = findTarget(e.target);
        if (!target) return;
        cancelHide();                        // re-entered a target (same or next) → keep it up
        if (target === activeSlot) return;   // same target already shown
        showTipFor(target, e);
      }, { passive: true });

      // passive: lets the browser dispatch pointermove without waiting on
      // our handler. the work is two CSS custom-property writes.
      document.addEventListener("pointermove", (e) => {
        if (isOpen()) place(e);
      }, { passive: true });

      document.addEventListener("pointerout", (e) => {
        const fromTarget = findTarget(e.target);
        if (!fromTarget) return;
        const toTarget = findTarget(e.relatedTarget);
        // still inside the same target? ignore.
        if (toTarget === fromTarget) return;
        // moving to a *different* valid target (row → artist link, artist →
        // adjacent artist)? let the next pointerover swap content without an
        // intermediate hide+show flicker.
        if (toTarget) return;
        scheduleHide();                      // left to a gap — defer the hide briefly (TIP_DISMISS_MS)
      }, { passive: true });

      // scroll handling. any scroll (the window's internal content scroller
      // bubbles to here in the capture phase) hides the tooltip and suppresses
      // new ones WHILE scrolling — so you can wheel over the photo grid /
      // tracklist freely without tooltip noise as rows fly past.
      //
      // the moment scrolling settles we re-show instantly. two reasons the old
      // 120ms timer felt laggy on desktop: (1) the window itself, and (2) the
      // tooltip is position:fixed — a wheel/trackpad scroll leaves the cursor
      // dead still, so NO pointerover fires when a new photo slides under it,
      // and the tooltip only came back if you jiggled the mouse. so on settle
      // we actively re-target: elementFromPoint(lastX,lastY) → findTarget →
      // show. position needs no update (cursor didn't move; --x/--y are already
      // correct from the last place()), so we pass no event and only swap
      // content. SCROLL_SETTLE_MS is just long enough to ride out trackpad
      // momentum (events keep firing ~every frame until it fully stops) without
      // flashing the tooltip back mid-decel — short enough to read as instant.
      const SCROLL_SETTLE_MS = 60;
      const reshowUnderCursor = () => {
        if (!lastX && !lastY) return;            // pointer never moved → nothing to re-target
        const target = findTarget(document.elementFromPoint(lastX, lastY));
        if (target) showTipFor(target);          // no event: reuse the existing --x/--y
      };
      document.addEventListener("scroll", () => {
        scrolling = true;
        if (isOpen()) hideTip();
        clearTimeout(scrollIdle);
        scrollIdle = setTimeout(() => { scrolling = false; reshowUnderCursor(); }, SCROLL_SETTLE_MS);
      }, { capture: true, passive: true });

      // ── keyboard-focus fallback ────────────────────────────────────────
      // mouse users get the cursor-following tooltip above; keyboard users
      // get the same content tethered to the focused element via CSS anchor
      // positioning (no pointer to track). only fires for :focus-visible so
      // a mouse click that happens to focus a link doesn't double-trigger.
      if (ANCHOR_OK) {
        document.addEventListener("focusin", (e) => {
          const target = findTarget(e.target);
          if (!target) return;
          try { if (!target.matches(":focus-visible")) return; } catch (_) {}
          showAnchored(target);   // keyboard focus is deliberate: no cold delay
        });
        document.addEventListener("focusout", (e) => {
          if (anchoredEl && findTarget(e.target) === anchoredEl) hideTip();
        });
      }
      if (initial && initial.focus && ANCHOR_OK) showAnchored(initial.target);
      else if (initial && initial.target) showTipFor(initial.target, initial);
}
