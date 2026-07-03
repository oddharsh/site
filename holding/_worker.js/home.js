// home.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { THUMB_VERSION } from "./lib/const.js";
import { escAttr, escHtml, wantsMarkdown } from "./lib/http.js";
import { HOMEPAGE_DISCOVERY_LINK, withHomepageDiscoveryHeaders } from "./lib/security.js";
import { THUMB_SMALL_PX, absThumb, getAltMap, getImagesManifest } from "./photos.js";
import { getTracksSWR } from "./rn.js";

export function homepageHeadResponse(request) {
  const markdown = wantsMarkdown(request);
  return new Response(null, {
    status: 200,
    headers: {
      "content-type": markdown
        ? "text/markdown; charset=utf-8"
        : "text/html; charset=utf-8",
      // HTML mirrors the GET path's bfcache-friendly policy (see _headers "/"):
      // private + no-cache keeps every real fetch fresh while leaving the page
      // eligible for the browser's back/forward cache. markdown rep stays no-store
      // (it is a content-negotiated representation, never a back/forward target).
      "cache-control": markdown
        ? "no-store, must-revalidate"
        : "private, no-cache, must-revalidate",
      "vary": "accept",
      "link": HOMEPAGE_DISCOVERY_LINK,
      "x-content-type-options": "nosniff",
    },
  });
}

// ── homepage pre-render ─────────────────────────────────────────────
// reads cached data from KV/manifest and uses Cloudflare's HTMLRewriter
// to inject it into the static HTML before it leaves the worker. result:
// the music section *and* the photo grid arrive populated on the first
// HTML response — no client-side fetch round-trip, no loading flicker,
// no layout shift when JS fills the slots. if any pre-render step fails,
// we fall through to the static HTML and let the existing inline JS take
// over (the client-side scripts detect pre-rendered state via "already
// has href?" / "already populated?" checks and bail early).
export async function serveHomepageWithPrerenderedTracks(request, env, ctx) {
  // the page is private,no-cache, so the worker runs on every visit. these reads
  // are mutually independent (the static asset, the tracks payload, the
  // photo manifest, the alt map), so fire them concurrently instead
  // of awaiting each in turn — collapses ~3 serial KV round-trips + the
  // ASSETS fetch into roughly one wall-clock read. the tracks lookup needs
  // tracks:<pid> keyed off playlist-id, but the id changes ~never — so it's
  // cached in a module var (like _altMap) and the chain costs two serial KV
  // reads only on a cold isolate; warm isolates do a single read.
  const tracksChain = (async () => {
    if (!env.RN_KV) return null;
    try {
      const pid = _playlistId ??
        (_playlistId = await env.RN_KV.get("playlist-id"));
      if (pid && /^[0-9A-Za-z]{22}$/.test(pid)) {
        return await getTracksSWR(env, ctx, pid);
      }
    } catch {}
    return null;
  })();
  const manifestP = getImagesManifest(env, ctx).then(
    arr => (Array.isArray(arr) && arr.length ? arr : null),
    () => null
  );
  // the visit count is displayed as SSR'd text via a READ-ONLY DO peek:
  // rendering never mutates, so homepage GETs stay pure and prerender-safe.
  // The actual tick is the /hit.svg?tick=1 beacon (plus a <noscript> pixel)
  // in index.html. Fired now, awaited inside the footer .counter rewriter,
  // so the read overlaps the whole page stream and never gates first byte.
  const counterPeek = env.COUNTER
    ? env.COUNTER.get(env.COUNTER.idFromName("homepage-visits"))
        .fetch("https://do/?peek=1")
        .then((r) => r.json())
        .catch(() => null)
    : Promise.resolve(null);
  ctx.waitUntil(counterPeek.catch(() => {}));

  const [res, tracksPayload, photos, altMap] = await Promise.all([
    env.ASSETS.fetch(request),
    tracksChain,
    manifestP,
    getAltMap(env),   // AI alt text; module-cached, so this is free on warm isolates
  ]);

  // footer "Last modified" → the most recently added photo (a real, datable
  // content change; the pool grows often). Static assets are content-addressed
  // (ETag, no Last-Modified) and there's no build step, so this is the cleanest
  // auto-advancing source. floored by the hardcoded date in index.html (so a
  // copy-only edit can still bump it by hand). null → hardcoded date stays.
  let lastModStr = null, lastModISO = null;
  if (photos && photos.length) {
    let newest = 0;
    for (const p of photos) { const t = p.uploaded ? Date.parse(p.uploaded) : NaN; if (!isNaN(t) && t > newest) newest = t; }
    if (newest > 0) {
      const d = new Date(newest);
      lastModISO = d.toISOString().slice(0, 10);
      lastModStr = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    }
  }

  // bail if no dynamic data is available — the static HTML's inline
  // JS will pick up the slack on the client (and the hardcoded "000042"
  // stays in the footer as a graceful fallback).
  if (!tracksPayload?.tracks?.length && !photos && !env.COUNTER && !lastModStr) return withHomepageDiscoveryHeaders(res);

  const rewriter = new HTMLRewriter();
  let lcpAvif = null, lcpSmall = null;  // first photo tile → responsive preload links

  // ── /rn/tracks → np-list ────────────────────────────────────────
  if (tracksPayload?.tracks?.length) {
    const itemsHtml = tracksPayload.tracks.map(t => {
      const dur = t.duration_ms ? fmtDuration(t.duration_ms) : "";
      const artistsText = t.artists_text || (t.artists || []).map(a => a.name).join(", ");
      const dataAttrs =
        ` data-track-title="${escAttr(t.title)}"` +
        ` data-track-artists="${escAttr(artistsText)}"` +
        (t.image_url   ? ` data-track-image="${escAttr(t.image_url)}"` : "") +
        (t.duration_ms ? ` data-track-duration="${dur}"`               : "") +
        (t.is_explicit ? ` data-track-explicit="1"`                    : "");
      return `<li${dataAttrs}>
        <a href="${escAttr(t.song_link_url)}" target="_blank" rel="noopener">${
          dur ? `<span class="np-duration">${dur}</span>` : ""
        }<span class="np-title">${escHtml(t.title)}</span><span class="np-sep">&mdash;</span><span class="np-artist">${linkifyArtists(t.artists, artistsText)}</span>${
          t.is_explicit ? '<span class="np-explicit">E</span>' : ""
        }</a>
      </li>`;
    }).join("");
    rewriter.on("#np-list", {
      element(el) { el.setInnerContent(itemsHtml, { html: true }); },
    });
  }

  // ── photo grid → section.photos ─────────────────────────────────
  // pick 12 random photos via fisher-yates so the grid feels fresh each
  // visit. response carries Cache-Control: no-store via _headers (see
  // comment on / in _headers explaining the strong no-cache choice), so
  // CF/browser/intermediaries don't pin this selection across refreshes.
  // <picture> uses AVIF primary + JPG fallback; data-* attrs feed the
  // hover tooltip; target=_blank + rel=noopener on the anchor.
  // 400px-tier URL for a manifest entry, tolerant of the pre-hash shape
  const smallOf = (p) => p.thumb_small
    ? absThumb(p.thumb_small)
    : (p.stem ? `/images/${p.stem}-${THUMB_SMALL_PX}.avif?v=${THUMB_VERSION}` : null);

  if (photos) {
    const pick = pickRandom(photos, 12);   // ~12 fills the justified rows into a fuller rectangle
    lcpAvif = pick[0] && pick[0].thumb_avif ? absThumb(pick[0].thumb_avif) : null;
    lcpSmall = pick[0] ? smallOf(pick[0]) : null;
    const slotsHtml = pick.map((p, i) => {
      const full     = p.full;
      // first tile: eager + high fetch priority. it's the topmost photo
      // and a candidate LCP element (the grid sits below the lede, so
      // it's a coin-flip with the text — but when the photo is LCP this
      // removes the lazy-load delay + bumps it from Low to High priority).
      // the other 11 stay lazy. fetchpriority: Chrome 102+/Safari 17.2+,
      // ignored harmlessly elsewhere.
      const imgLoad = i === 0
        ? `loading="eager" fetchpriority="high"`
        : `loading="lazy"`;
      const sizeAttr = (typeof p.size === "number" && p.size > 0)
        ? ` data-size="${p.size}"` : "";
      const upAttr   = p.uploaded
        ? ` data-uploaded="${escAttr(p.uploaded)}"` : "";
      // EXIF is NOT inlined. the tooltip lazy-fetches /images/meta/<stem>.json
      // (per-photo EXIF; histogram is computed client-side) on first photo
      // hover, keyed by stem (derivable from data-full). inlining it
      // shipped ~14KB raw of EXIF on every no-store visit for a hover most
      // visitors never make — lazy keeps the hot path lean. (the grid is a
      // square 3-col CSS grid via aspect-ratio:1, so no per-tile --ar needed.)
      return `<a href="/images/full/${encodeURI(full)}"` +
             ` target="_blank" rel="noopener"` +
             ` data-full="${escAttr(full)}"${sizeAttr}${upAttr}>` +
        `<picture>` +
          // mobile (<=560px) gets the 400px tile — at the ~100px mobile box that's
          // the same density 800px gives the ~197px desktop box, at ~1/3 the bytes.
          // ordered first: <picture> uses the first source whose media matches.
          // URLs come from the manifest verbatim (absThumb tolerates a stale
          // pre-hash manifest during the cutover window).
          (smallOf(p) ? `<source type="image/avif" media="(max-width: 560px)" srcset="${escAttr(smallOf(p))}">` : "") +
          (p.thumb_avif ? `<source type="image/avif" srcset="${escAttr(absThumb(p.thumb_avif))}">` : "") +
          `<img alt="${escAttr(altMap[p.stem] || "")}" width="600" height="600" ${imgLoad} decoding="async" src="${escAttr(absThumb(p.thumb_jpg))}">` +
        `</picture>` +
      `</a>`;
    }).join("");
    rewriter.on("section.photos", {
      element(el) { el.setInnerContent(slotsHtml, { html: true }); },
    });
  }

  // ── visitor count → footer .counter (read-only peek; the beacon ticks) ──
  // the rewriter reaches .counter at the very end of <body>, so awaiting the
  // peek here rides the full page stream. on a null read the static
  // placeholder stays put, never a misleading number.
  if (env.COUNTER) {
    rewriter.on(".counter", {
      async element(el) {
        const data = await counterPeek;
        if (data && typeof data.n === "number") {
          el.setInnerContent(String(data.n).padStart(6, "0"));
        }
      },
    });
  }

  // ── footer "Last modified" → newest photo, floored by the hardcoded date ──
  if (lastModStr) {
    rewriter.on("footer time", {
      element(el) {
        const floor = el.getAttribute("datetime") || "";   // hardcoded date in index.html
        if (lastModISO >= floor) { el.setAttribute("datetime", lastModISO); el.setInnerContent(lastModStr); }
      },
    });
  }

  // preload the LCP photo tile (slot 0) as an in-document <link rel=preload> in
  // <head> — deliberately NOT an HTTP `Link:` header. The grid is random + the
  // response is no-store, so a Link header gets harvested by Cloudflare Early
  // Hints and replayed as a stale 103 on the NEXT visitor — always one pick
  // behind, so it preloads a photo that isn't on the page (~26-52KB wasted every
  // visit) while the real hero goes un-preloaded. CF Early Hints only collects
  // HTTP Link headers, never HTML <link> elements, so an injected head preload is
  // correct per-response AND immune to the cross-request staleness. The preload
  // scanner finds it at parse start, ~as early as the old 200 Link header would
  // arrive. Responsive: desktop the 800 tile, mobile the 400 (media-gated); the
  // type=image/avif hint makes non-AVIF browsers skip it (they use the JPG).
  if (lcpAvif) {
    const links =
      `<link rel="preload" as="image" type="image/avif" fetchpriority="high" media="(min-width: 561px)" href="${escAttr(lcpAvif)}">` +
      (lcpSmall ? `<link rel="preload" as="image" type="image/avif" fetchpriority="high" media="(max-width: 560px)" href="${escAttr(lcpSmall)}">` : "");
    rewriter.on("head", { element(el) { el.prepend(links, { html: true }); } });
  }
  return withHomepageDiscoveryHeaders(rewriter.transform(res));
}

// fisher-yates shuffle, return first N elements. doesn't mutate input.
export function pickRandom(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// per-artist nav targets that open spotify's artist page. emitted as
// spans (not <a>) because the wrapping row is an <a> and nested anchors
// are invalid HTML — the inline script on index.html intercepts clicks
// on .np-artist-link, stopPropagation, and opens the data-href. role+
// tabindex keep them keyboard- and screen-reader-accessible.
//
// each span also carries data-artist-name and (when known) data-artist-image
// so the XP hover-tooltip can show a profile pic + name on hover. when we
// have structured `artists` from the scraper we link straight to the
// artist's spotify URL (precise); otherwise we fall back to a name-based
// search URL and skip the image.
export function linkifyArtists(artists, fallbackText) {
  // structured case: [{id, name, spotify_url, image_url}, ...]
  if (Array.isArray(artists) && artists.length) {
    return artists.map(a => {
      const href = a.spotify_url ||
        `https://open.spotify.com/search/${encodeURIComponent(a.name)}/artists`;
      const img  = a.image_url ? ` data-artist-image="${escAttr(a.image_url)}"` : "";
      return `<span class="np-artist-link"` +
             ` data-href="${escAttr(href)}"` +
             ` data-artist-name="${escAttr(a.name)}"` +
             img +
             ` role="link" tabindex="0">${escHtml(a.name)}</span>`;
    }).join(", ");
  }
  // fallback (no structured data, just the joined "A, B" string)
  const raw = fallbackText || (typeof artists === "string" ? artists : "");
  if (!raw) return "";
  return String(raw).split(/,\s*/).filter(Boolean).map(name => {
    const href = `https://open.spotify.com/search/${encodeURIComponent(name)}/artists`;
    return `<span class="np-artist-link"` +
           ` data-href="${escAttr(href)}"` +
           ` data-artist-name="${escAttr(name)}"` +
           ` role="link" tabindex="0">${escHtml(name)}</span>`;
  }).join(", ");
}

export function fmtDuration(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// the Spotify playlist id (KV "playlist-id") changes ~never; module-cached so
// the homepage tracks lookup is one KV read on warm isolates instead of two.
export let _playlistId;

export async function serveMarkdown(request, env) {
  // ask the static assets layer for /index.md
  const mdUrl = new URL("/index.md", request.url);
  const mdRes = await env.ASSETS.fetch(new Request(mdUrl.toString(), request));
  if (!mdRes.ok) {
    // markdown not available — fall back to HTML
    return env.ASSETS.fetch(request);
  }
  const body = await mdRes.text();
  // rough token estimate: ~4 chars per token. honest approximation; agents
  // that care about exact counts can run their own tokenizer.
  const tokens = Math.ceil(body.length / 4);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type":     "text/markdown; charset=utf-8",
      "x-markdown-tokens": String(tokens),
      // Cloudflare's edge can serve a cached negotiated root variant to clients
      // with a different Accept header. /index.md remains the cacheable Markdown
      // resource; negotiated "/" Markdown must stay uncacheable.
      "cache-control":    "no-store, must-revalidate",
      "vary":             "accept",
      "link":             HOMEPAGE_DISCOVERY_LINK,
      "x-content-type-options": "nosniff",
    },
  });
}
