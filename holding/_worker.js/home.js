// home.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { escAttr, wantsMarkdown } from "./lib/http.js";
import { HOMEPAGE_DISCOVERY_LINK, withHomepageDiscoveryHeaders } from "./lib/security.js";
import { absThumb, getAltMap, getImagesManifest } from "./photos.js";
import { getTracksSWR, renderTrackListHtml } from "./rn.js";

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
  // Server-Timing: measure the TTFB-gating reads so the KV-shape experiments the
  // perf plan calls for run on real numbers, not guesses. Date.now() in Workers
  // advances only across I/O, so these spans are meaningful for the KV/R2/asset
  // reads (all I/O) even though pure-compute reads as 0. The visit counter is
  // deliberately absent: it overlaps the body stream and never gates first byte.
  const t0 = Date.now();
  const timings = {};
  const timed = (name, p) => {
    const s = Date.now();
    return Promise.resolve(p).then(
      (v) => { timings[name] = Date.now() - s; return v; },
      (e) => { timings[name] = Date.now() - s; throw e; },
    );
  };
  const serverTiming = () => {
    timings.total = Date.now() - t0;
    return Object.entries(timings).map(([k, v]) => `${k};dur=${v}`).join(", ");
  };
  // the page is private,no-cache, so the worker runs on every visit. these reads
  // are mutually independent (the static asset, the tracks payload, the
  // photo manifest, the alt map), so fire them concurrently instead
  // of awaiting each in turn — collapses ~3 serial KV round-trips + the
  // ASSETS fetch into roughly one wall-clock read. The tracks lookup needs
  // tracks:<pid> keyed off playlist-id, read FRESH each render: it used to be
  // cached in a module var, which meant /rn/set could swap the playlist while
  // warm isolates kept SSRing the old id's tracks indefinitely (a module var
  // can't be busted cross-isolate). The id read is a tiny KV get and it rides in
  // this same Promise.all, so freshness costs nothing measurable.
  const tracksChain = (async () => {
    if (!env.RN_KV) return null;
    try {
      const pid = await env.RN_KV.get("playlist-id");
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
    timed("assets", env.ASSETS.fetch(request)),
    timed("tracks", tracksChain),
    timed("manifest", manifestP),
    timed("alt", getAltMap(env)),   // AI alt text; module-cached, so this is free on warm isolates
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
  if (!tracksPayload?.tracks?.length && !photos && !env.COUNTER && !lastModStr) {
    const out = withHomepageDiscoveryHeaders(res);
    out.headers.set("server-timing", serverTiming());
    return out;
  }

  const rewriter = new HTMLRewriter();
  let lcpAvif = null, lcpSmall = null;  // first photo tile → responsive preload links

  // ── /rn/tracks → np-list ────────────────────────────────────────
  if (tracksPayload?.tracks?.length) {
    const itemsHtml = renderTrackListHtml(tracksPayload);
    rewriter.on("#np-list", {
      element(el) {
        el.setAttribute("data-ssr", "1");
        el.setInnerContent(itemsHtml, { html: true });
      },
    });
  }

  // ── photo grid → section.photos ─────────────────────────────────
  // pick 12 random photos via fisher-yates so the grid feels fresh each
  // visit. response carries Cache-Control: no-store via _headers (see
  // comment on / in _headers explaining the strong no-cache choice), so
  // CF/browser/intermediaries don't pin this selection across refreshes.
  // <picture> uses AVIF primary + JPG fallback; data-* attrs feed the
  // hover tooltip; target=_blank + rel=noopener on the anchor.
  // 400px-tier URL, straight from the manifest (absThumb tolerates a stale
  // pre-hash KV manifest; unhashed stems never reach here, they're skipped
  // at manifest-build time)
  const smallOf = (p) => (p.thumb_small ? absThumb(p.thumb_small) : null);

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
      // dual-tier AVIF from the manifest: a 400px small tile + a 600px large.
      // mobile (<=560px) is pinned to 400px (its box is ~100px, so 400px is
      // already 2x-dense even on DPR3). desktop is responsive: the tile renders
      // 174px (184px column − 4px padding − 1px frame, both sides), so a
      // 400w/600w srcset + sizes:174px lands 400px on DPR1/DPR2 and 600px only
      // on DPR3 — the old 600px-everywhere source shipped ~10-15KB of unseen
      // detail to every DPR2 desktop tile. small missing → single 600px source.
      // ordered first: <picture> uses the first source whose media matches.
      // URLs come from the manifest verbatim (absThumb tolerates a stale
      // pre-hash manifest during the cutover window).
      const small = smallOf(p);
      const large = p.thumb_avif ? absThumb(p.thumb_avif) : null;
      const desktopSrc = large
        ? (small
            ? `<source type="image/avif" srcset="${escAttr(small)} 400w, ${escAttr(large)} 600w" sizes="174px">`
            : `<source type="image/avif" srcset="${escAttr(large)}">`)
        : "";
      return `<a href="/images/full/${encodeURI(full)}"` +
             ` target="_blank" rel="noopener"` +
             ` data-full="${escAttr(full)}"${sizeAttr}${upAttr}>` +
        `<picture>` +
          (small ? `<source type="image/avif" media="(max-width: 560px)" srcset="${escAttr(small)}">` : "") +
          desktopSrc +
          `<img alt="${escAttr(altMap[p.stem] || "")}" width="600" height="600" ${imgLoad} decoding="async" src="${escAttr(absThumb(p.thumb_jpg))}">` +
        `</picture>` +
      `</a>`;
    }).join("");
    rewriter.on("section.photos", {
      element(el) {
        el.setAttribute("data-ssr", "1");
        el.setInnerContent(slotsHtml, { html: true });
      },
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
    // desktop preload must match the tile's responsive selection or it fetches
    // the wrong tier and the hero double-downloads: imagesrcset+imagesizes
    // mirror the <source> srcset/sizes (400px on DPR1/2, 600px on DPR3), with
    // href=600px as the legacy fallback (ignored where imagesrcset is honored).
    const desktopPreload = lcpSmall
      ? `<link rel="preload" as="image" type="image/avif" fetchpriority="high" media="(min-width: 561px)" imagesrcset="${escAttr(lcpSmall)} 400w, ${escAttr(lcpAvif)} 600w" imagesizes="174px" href="${escAttr(lcpAvif)}">`
      : `<link rel="preload" as="image" type="image/avif" fetchpriority="high" media="(min-width: 561px)" href="${escAttr(lcpAvif)}">`;
    const links =
      desktopPreload +
      (lcpSmall ? `<link rel="preload" as="image" type="image/avif" fetchpriority="high" media="(max-width: 560px)" href="${escAttr(lcpSmall)}">` : "");
    rewriter.on("head", { element(el) { el.prepend(links, { html: true }); } });
  }
  const out = withHomepageDiscoveryHeaders(rewriter.transform(res));
  out.headers.set("server-timing", serverTiming());
  return out;
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
