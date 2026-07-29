// home.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { COUNT_KEY, seedCountMirror } from "./counter.js";
import { deadline } from "./lib/cache.js";
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
// uses Cloudflare's HTMLRewriter to inject dynamic data into the static HTML
// before it leaves the worker. result: the music section *and* the photo grid
// arrive populated on the first HTML response — no client-side fetch
// round-trip, no loading flicker, no layout shift when JS fills the slots.
//
// what feeds it, and what each source may cost the response:
//   - the photo pool: module memory (photos.js bundles photo-index.json +
//     hashes.json at build). 0ms, cannot fail, cannot gate anything.
//   - tracks + visit count: KV, behind a hard SSR_DEADLINE_MS budget. KV's
//     per-colo cache is a shared LRU, so a key can read 100-200ms cold at any
//     moment regardless of cacheTtl (eviction, not expiry — observed 2026-07-27/28).
//     When the budget lapses the page ships without that section: tracks keeps
//     its static markup (data-ssr="0") and a small inline script in index.html
//     refills it from /rn/tracks.html, the same fragment this SSR would have
//     injected; the counter keeps its static placeholder. The timed-out read
//     itself keeps running and warms the colo for the next visitor.
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
  // deadlined spans carry `;desc=deadline` so a curl can tell "read was fast"
  // from "read blew its budget and the page shipped without it" — the
  // distinction this file's whole diagnosis history has hinged on.
  const deadlined = new Set();
  const serverTiming = () => {
    timings.total = Date.now() - t0;
    return Object.entries(timings)
      .map(([k, v]) => `${k};dur=${v}${deadlined.has(k) ? ";desc=deadline" : ""}`)
      .join(", ");
  };
  // finalize a homepage response: drop the static index.html's ETag/Last-Modified
  // (the body is dynamic — a fresh random grid + live tracks — so a stable
  // validator is a lie that would let a no-cache revalidation 304 and freeze the
  // grid), then stamp Server-Timing. no-cache (not no-store) keeps bfcache.
  const finish = (out) => {
    out.headers.delete("etag");
    out.headers.delete("last-modified");
    out.headers.set("server-timing", serverTiming());
    return out;
  };
  // the page is private,no-cache, so the worker runs on every visit. these reads
  // are mutually independent (the static asset, the tracks payload, the alt
  // map, the visit count), so fire them concurrently instead of awaiting each
  // in turn. The tracks lookup needs tracks:<pid> keyed off playlist-id, read
  // FRESH each render: it used to be cached in a module var, which meant
  // /rn/set could swap the playlist while warm isolates kept SSRing the old
  // id's tracks indefinitely (a module var can't be busted cross-isolate). The
  // id read is a tiny KV get and it rides in this same Promise.all, so
  // freshness costs nothing measurable.
  const tracksChain = (async () => {
    if (!env.RN_KV) return null;
    try {
      // cacheTtl 300: this get is SERIAL in front of getTracksSWR, so a cold read
      // here is additive on the homepage's slowest span (204ms on 2026-07-27 was
      // two cold round trips stacked, against 126-149ms for the single-hop reads
      // beside it). 300 keeps a /rn/set rollover visible within 5 minutes, which
      // is the price of not caching it for the hour the key's write rate invites.
      const pid = await env.RN_KV.get("playlist-id", { cacheTtl: 300 });
      if (pid && /^[0-9A-Za-z]{22}$/.test(pid)) {
        return await getTracksSWR(env, ctx, pid);
      }
    } catch {}
    return null;
  })();
  // the photo pool: bundled module data behind a kept-async signature, so this
  // "read" resolves on the microtask queue. No span for it in Server-Timing —
  // Date.now() only advances across I/O, and there is none here to see.
  const manifestP = getImagesManifest(env, ctx).then(
    arr => (Array.isArray(arr) && arr.length ? arr : null),
    () => null
  );
  // the visit count is displayed as SSR'd text, read from the KV mirror rather
  // than from the Durable Object: rendering never mutates, so homepage GETs stay
  // pure and prerender-safe. The actual tick is the /hit beacon (plus a <noscript>
  // pixel) in index.html, and that tick is what refreshes the mirror.
  //
  // This USED TO peek the DO directly and await it inside the footer `.counter`
  // rewriter, on the theory that a read started here would overlap the page
  // stream. It doesn't. The stream reaches the footer in ~130ms while the DO peek
  // takes 185-308ms from SJC, so the rewriter sat on a half-sent document: a
  // devtools trace on 2026-07-27 caught the parser idle from 635ms to 901ms, a
  // 399ms tail on a 13KB body the worker assembles in 8-13ms. First byte and FCP
  // were fine (FCP landed at 635ms, mid-stream); everything downstream of DCL was
  // not, because nav.js and the entire desktop shell queue behind the last chunk.
  // A KV read is colo-local at 5-8ms and rides the Promise.all below, so the count
  // now costs the render nothing and the stream never suspends.
  //
  // cacheTtl 300 because "colo-local at 5-8ms" only describes a WARM read: cold,
  // this one measured 149ms on 2026-07-27. The mirror already trails real time by
  // up to MIRROR_TTL (60s) by design, so the honest statement of the trade is that
  // the odometer can now sit ~6 minutes behind instead of ~1. Still not a number
  // anyone audits, and the /hit beacon remains the thing that actually counts.
  const counterP = env.RN_KV
    ? env.RN_KV.get(COUNT_KEY, { type: "text", cacheTtl: 300 }).then(
        (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; },
        () => null,
      )
    : Promise.resolve(null);

  // fetch the static shell WITHOUT the visitor's conditional headers. index.html
  // carries a stable content ETag, but the page we build from it is different
  // every visit (a fresh random 12-photo grid + live tracks). Forwarding the
  // browser's If-None-Match let ASSETS answer 304, which the worker propagated —
  // so a no-cache revalidation reused the cached page and the "random" grid
  // FROZE on whatever 12 first loaded. Strip the validators so ASSETS always
  // hands back the full body to enhance; `finish()` below then drops the stale
  // ETag off the dynamic response so no later revalidation can 304 it either.
  const assetRequest = new Request(request.url, {
    method: "GET",
    headers: (() => {
      const h = new Headers(request.headers);
      h.delete("if-none-match");
      h.delete("if-modified-since");
      return h;
    })(),
  });

  // SSR_DEADLINE_MS is the budget a KV-backed section gets before the page
  // ships without it. Warm reads land in 3-10ms so the race is normally a
  // spectator; it exists for the eviction tail, where a read that would have
  // taken 200ms instead costs the response at most this. 25ms sits above every
  // warm reading observed in production (max 22ms, a cold-isolate alt fetch)
  // and far below the tail it's fencing off.
  //
  // Distinct fallbacks on purpose: tracks → null (indistinguishable from "no
  // playlist", both leave data-ssr="0" for the client refill); counter →
  // undefined, because null means MISSING and triggers the out-of-band mirror
  // reseed below — a slow read must not be mistaken for a lost mirror, or every
  // deadline would fire a pointless DO peek.
  const SSR_DEADLINE_MS = 25;
  const [res, tracksPayload, photos, altMap, visitCount] = await Promise.all([
    timed("assets", env.ASSETS.fetch(assetRequest)),
    timed("tracks", deadline(tracksChain, SSR_DEADLINE_MS, null, () => deadlined.add("tracks"))),
    manifestP,
    timed("alt", getAltMap(env)),   // AI alt text; module-cached, so this is free on warm isolates
    timed("counter", deadline(counterP, SSR_DEADLINE_MS, undefined, () => deadlined.add("counter"))),
  ]);

  // a cold mirror (first render after this shipped, or a KV eviction) shows the
  // static placeholder and reseeds itself out-of-band, so the next visitor gets a
  // real number. never awaited: a missing mirror must not put the DO back on the
  // render path, which is the entire point of the mirror. `=== null` and not
  // `== null`: undefined is the deadline sentinel (mirror probably fine, just
  // slow), and reseeding on it would peek the DO for nothing.
  if (visitCount === null && env.COUNTER && env.RN_KV) ctx.waitUntil(seedCountMirror(env));

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

  // bail if no dynamic data is available — the static markup keeps its honest
  // empty states (the tracks refill script may still fill that one section
  // client-side, and the hardcoded "000042" stays in the footer). With the pool
  // bundled, `photos` is null only if the committed index is empty, so this
  // path is one bad build away from dead rather than one slow read away.
  if (!tracksPayload?.tracks?.length && !photos && visitCount == null && !lastModStr) {
    return finish(withHomepageDiscoveryHeaders(res));
  }

  const rewriter = new HTMLRewriter();

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
  // visit. response carries private,no-cache (see finish() above), so every
  // reload reaches the worker for a new selection while remaining bfcache-safe.
  // <picture> uses AVIF primary + JPG fallback; data-* attrs feed the
  // hover tooltip; target=_blank + rel=noopener on the anchor.
  // 400px-tier URL, straight from the pool (unhashed stems never reach here;
  // derivePhotoPool skips them and check-photo-pipeline.mjs fails CI on them)
  const smallOf = (p) => (p.thumb_small ? absThumb(p.thumb_small) : null);

  if (photos) {
    const pick = pickRandom(photos, 12);   // ~12 fills the justified rows into a fuller rectangle
    const slotsHtml = pick.map((p, i) => {
      const full     = p.full;
      // The introductory prose is the LCP element at every representative
      // viewport (390px mobile and 1280px desktop in the 2026-07-28 traces):
      // its rendered block is larger than one fixed 184px photo tile. The old
      // "hero" preload therefore spent the critical connection on a non-LCP
      // image. Worse, HTMLRewriter prepended it before the viewport meta tag;
      // mobile first matched the 600px desktop preload at its default 980px
      // layout width, then fetched the 400px source after parsing the viewport
      // meta — a measured 14.7KB duplicate on one Slow-4G load.
      //
      // Slot 0 stays directly discoverable because it is visible at load. The
      // other eleven keep their URLs in data-* until the tiny observer beside
      // the static grid sees them in (or just ahead of) the .content scroller.
      // Native loading=lazy fetched eight of twelve at 390px because Chrome's
      // distance threshold extends far past this internal scrollport. Explicit
      // observation keeps the random twelve in the document while transferring
      // only thumbnails the visitor is close to seeing. Every photo is low
      // priority: none is LCP, and the shell/text must win a cold connection.
      const deferred = i > 0;
      const sizeAttr = (typeof p.size === "number" && p.size > 0)
        ? ` data-size="${p.size}"` : "";
      const upAttr   = p.uploaded
        ? ` data-uploaded="${escAttr(p.uploaded)}"` : "";
      // EXIF is NOT inlined. the tooltip idle-prefetches /images/meta/<stem>.json
      // after page settle (with first-hover fetch as fallback), keyed by stem
      // (derivable from data-full). inlining it shipped ~14KB raw of EXIF on
      // every no-store visit for a hover most visitors never make — keeping it
      // per-photo preserves the lean HTML path. (the grid is a
      // square 3-col CSS grid via aspect-ratio:1, so no per-tile --ar needed.)
      // dual-tier AVIF from the manifest: a 400px small tile + a 600px large.
      // mobile (<=560px) is pinned to the 400px tier (the tile renders 174px
      // there too, so 400px is already 2x-dense). desktop is responsive: the
      // tile renders 174px (184px column − 4px padding − 1px frame, both
      // sides), so a 400w/600w srcset + sizes:174px lands 400px on DPR1/DPR2
      // and 600px only on DPR3 — the old 600px-everywhere source shipped
      // ~10-15KB of unseen detail to every DPR2 desktop tile. the mobile
      // source carries the same 400w + sizes shape (not a bare URL): the HTML
      // spec wants descriptor use to be uniform across a picture's sources,
      // and Nu flags the mixed form. small missing → single 600px source.
      // ordered first: <picture> uses the first source whose media matches.
      // URLs come from the pool verbatim (always absolute /i/ form).
      const small = smallOf(p);
      const large = p.thumb_avif ? absThumb(p.thumb_avif) : null;
      const sourceAttr = deferred ? "data-srcset" : "srcset";
      const desktopSrc = large
        ? (small
            ? `<source type="image/avif" ${sourceAttr}="${escAttr(small)} 400w, ${escAttr(large)} 600w" sizes="174px">`
            : `<source type="image/avif" ${sourceAttr}="${escAttr(large)}">`)
        : "";
      const alt = escAttr(altMap[p.stem] || p.stem);
      const mobileSrc = small
        ? `<source type="image/avif" media="(max-width: 560px)" ${sourceAttr}="${escAttr(small)} 400w" sizes="174px">`
        : "";
      const img = deferred
        ? `<img alt="${alt}" width="600" height="600" data-src="${escAttr(absThumb(p.thumb_jpg))}" loading="eager" fetchpriority="low" decoding="async">`
        : `<img alt="${alt}" width="600" height="600" src="${escAttr(absThumb(p.thumb_jpg))}" loading="eager" fetchpriority="low" decoding="async">`;
      // Script-off visitors keep the previous native-lazy behavior. In a
      // scripting browser <noscript> is inert text, so these fallback URLs do
      // not enter the preload scanner and do not undo the transfer saving.
      const noScript = deferred
        ? `<noscript><picture>` +
            (small ? `<source type="image/avif" media="(max-width: 560px)" srcset="${escAttr(small)} 400w" sizes="174px">` : "") +
            (large
              ? (small
                  ? `<source type="image/avif" srcset="${escAttr(small)} 400w, ${escAttr(large)} 600w" sizes="174px">`
                  : `<source type="image/avif" srcset="${escAttr(large)}">`)
              : "") +
            `<img alt="${alt}" width="600" height="600" src="${escAttr(absThumb(p.thumb_jpg))}" loading="lazy" fetchpriority="low" decoding="async">` +
          `</picture></noscript>`
        : "";
      return `<a href="/images/full/${encodeURI(full)}"` +
             ` target="_blank" rel="noopener"` +
             ` data-full="${escAttr(full)}"${sizeAttr}${upAttr}>` +
        `<picture${deferred ? ` data-photo-deferred` : ""}>` +
          mobileSrc +
          desktopSrc +
          // fall back to the stem (matching photos.js) rather than alt="": the
          // grid tile IS the link, so an empty alt makes the <a> nameless for
          // screen readers and agents. 12 of 158 stems have no alt.json caption
          // yet, and the homepage draws 12 at random, so a nameless link showed
          // up intermittently (Lighthouse link-name + agent-accessibility-tree).
          img +
        `</picture>` +
        noScript +
      `</a>`;
    }).join("");
    rewriter.on("section.photos", {
      element(el) {
        el.setAttribute("data-ssr", "1");
        el.setInnerContent(slotsHtml, { html: true });
      },
    });
  }

  // ── visitor count → footer .counter (KV mirror; the /hit beacon ticks) ──
  // the value is already resolved by the fan-out above, so this handler is
  // SYNCHRONOUS and cannot suspend the output stream. Keep it that way: an
  // `async element()` here blocks the HTML tail, and the footer is the worst
  // place on the page to do that (see the counterP comment above). on a null
  // read the static placeholder stays put, never a misleading number.
  if (visitCount != null) {
    rewriter.on(".counter", {
      element(el) { el.setInnerContent(String(visitCount).padStart(6, "0")); },
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

  return finish(withHomepageDiscoveryHeaders(rewriter.transform(res)));
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
