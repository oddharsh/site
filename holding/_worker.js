// _worker.js — root-level pages worker. wrangler 4.x's `pages deploy`
// looks for this file explicitly (see `--no-bundle` flag in --help output)
// and uploads it as the project's Worker. all requests pass through here.
//
// routing: /whoareyou → the transparency function below
//          /rn        → 302 to the currently-active spotify playlist
//          anything else → fall through to static asset serving
//
// equivalent to functions/whoareyou.js but in the _worker.js style that
// the current wrangler unambiguously supports.

// ── /rn redirect target ─────────────────────────────────────────────
// the link on the site is static (/rn). the redirect target lives in KV
// under the key "playlist-id" (just the 22-char spotify id).
//
// updating after a rollover (desktop-friendly):
//   bookmark https://aadhar.sh/rn/admin?secret=<RN_BUST_SECRET>
//   click bookmark → paste new playlist URL → submit.
// updating from a shortcut / curl:
//   https://aadhar.sh/rn/set?secret=<RN_BUST_SECRET>&url=<new playlist url>
//
// required binding:  RN_KV (Pages → Functions → KV namespace bindings)
// required env:      RN_BUST_SECRET (Pages secret)
//
// if KV is empty (first deploy, or you deliberately cleared it), the
// redirect falls back to the playlist URL hardcoded below.
const RN_FALLBACK = "https://open.spotify.com/playlist/4IRq9W1N2tOWHhH0O3vXiF";

// security headers applied to every worker-generated response. mirrors
// what's set on static assets via _headers — without this wrapper, the
// worker-rendered pages (/whoareyou, /around, /bot, /rn/admin, etc.)
// would skip _headers entirely and ship without CSP / Permissions-Policy.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://i.scdn.co https://*.spotifycdn.com; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'; manifest-src 'self'; upgrade-insecure-requests",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), serial=(), bluetooth=(), midi=(), accelerometer=(), gyroscope=(), magnetometer=(), screen-wake-lock=(), hid=(), idle-detection=()",
  "x-frame-options":         "DENY",
  "x-content-type-options":  "nosniff",
  "referrer-policy":         "strict-origin-when-cross-origin",
};

function withSecurityHeaders(response) {
  // redirects don't need (and shouldn't carry) document-level headers
  if (response.status >= 300 && response.status < 400) return response;
  // R2 photo serves don't either — they're images, the policy doesn't apply
  const ct = response.headers.get("content-type") || "";
  if (ct.startsWith("image/")) return response;

  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });
}

// canonical-host enforcement: any request that lands on the project's
// auto-generated pages.dev subdomain (aadhar-sh.pages.dev or any deploy-
// hash variant like 60bcf749.aadhar-sh.pages.dev) gets 301'd to the
// equivalent path on aadhar.sh. eliminates the duplicate public footprint
// while preserving the ability to deploy + serve from Cloudflare Pages.
const CANONICAL_HOST = "aadhar.sh";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.hostname.endsWith(".pages.dev")) {
      const target = `https://${CANONICAL_HOST}${url.pathname}${url.search}`;
      return new Response(null, {
        status: 301,
        headers: {
          "location":      target,
          "cache-control": "public, max-age=3600",
        },
      });
    }

    // Workers Logs (observability): one compact structured line per request —
    // path / method / status / ms / country / bot — queryable + filterable in the
    // dashboard once observability is enabled on the Pages project. lean and fully
    // strippable: delete this wrapper (keep `return withSecurityHeaders(await
    // route(...))`) to revert. short keys keep each event tiny.
    const t0 = Date.now();
    const response = await route(request, env, ctx);
    try {
      console.log(JSON.stringify({
        p: url.pathname,
        m: request.method,
        s: response.status,
        ms: Date.now() - t0,
        co: request.cf?.country,
        bot: request.cf?.botManagement?.verifiedBot || undefined,
      }));
    } catch {}
    return withSecurityHeaders(response);
  }
};

async function route(request, env, ctx) {
    const url = new URL(request.url);

    // /favicon.ico — serve the inline traffic-cone SVG directly. without this,
    // legacy/bot probes for /favicon.ico SPA-fall-back to the full ~75KB homepage.
    // (modern browsers use the inline <link rel=icon> data-URI and never hit this.)
    if (url.pathname === "/favicon.ico") {
      return new Response(
        `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='4' y='25' width='24' height='3' rx='0.5' fill='#1a1a1a'/><path d='M 16 4 L 9 25 L 23 25 Z' fill='#ff6600'/><path d='M 11.3 18 L 20.7 18 L 21.7 21 L 10.3 21 Z' fill='#ffffff'/><path d='M 13.7 11 L 18.3 11 L 19 13 L 13 13 Z' fill='#ffffff'/></svg>`,
        { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=31536000, immutable" } }
      );
    }

    // agent-discovery docs (auth.md + the RFC 9727 api-catalog). these are
    // static files, but they're extensionless / iterated, and a long Cache-
    // Control once poisoned the read-through asset cache for the canonical URL
    // (a ?query bust returned fresh while the bare URL served a stale copy).
    // serve them through a per-request cache-bust so the canonical URL is
    // always the freshly-deployed bytes, with the right content-type + a short
    // edge cache. (the .json cards under /.well-known/ are extension-typed and
    // served straight from ASSETS.)
    if (url.pathname === "/auth.md") return serveFreshAsset(request, env, "text/markdown; charset=utf-8");
    if (url.pathname === "/.well-known/api-catalog") return serveFreshAsset(request, env, "application/linkset+json");

    if (url.pathname === "/whoareyou") {
      return handleWhoareyou(request);
    }

    // /writing — the Notepad-view writing index + per-post pages. The .txt + posts.json
    // static assets (paths with a dot) fall through to ASSETS untouched, so the raw
    // canonical text is always fetchable too.
    if (url.pathname === "/writing" || url.pathname === "/writing/") {
      return handleWritingIndex(env, ctx);
    }
    if (url.pathname.startsWith("/writing/")) {
      const slug = url.pathname.slice("/writing/".length);
      if (slug && slug.indexOf("/") === -1 && slug.indexOf(".") === -1) {
        return handleWritingPost(slug, env, ctx);
      }
    }

    if (url.pathname === "/rn") {
      return handleRn(request, env);
    }

    if (url.pathname === "/rn/tracks") {
      return handleRnTracks(request, env, ctx);
    }

    if (url.pathname === "/rn/admin") {
      return handleRnAdmin(request, env);
    }

    if (url.pathname === "/rn/set") {
      return handleRnSet(request, env);
    }

    if (url.pathname === "/bot") {
      return handleBotPage(request);
    }

    if (url.pathname === "/around") {
      return handleAround(request, env, ctx);
    }

    if (url.pathname === "/around/json") {
      return handleAroundJson(request, env, ctx);
    }

    // no-trailing-slash → with-slash for directory listings. without this,
    // relative links in the listing (href="01.jpg") resolve from the
    // document root and 404 back to home.
    if (url.pathname === "/images") {
      return Response.redirect(url.origin + "/images/" + url.search, 301);
    }
    if (url.pathname === "/images/full") {
      return Response.redirect(url.origin + "/images/full/" + url.search, 301);
    }

    // classic Apache-style directory listings (1999-vibe easter egg).
    // /images/      → enumerate thumbnails in the Pages static bundle
    // /images/full/ → enumerate R2 objects in the aadhar-photos bucket
    if (url.pathname === "/images/") {
      return handleImagesIndex(request, env, ctx);
    }
    if (url.pathname === "/images/full/") {
      return handleImagesFullIndex(request, env, ctx);
    }

    // manifest of available photos for the homepage grid. derived from
    // R2 keys (which preserve SOOC filenames). thumbnail names are
    // inferred by replacing the original extension with .avif / .jpg.
    if (url.pathname === "/images/manifest.json") {
      return handleImagesManifest(request, env, ctx);
    }

    // photo EXIF, generated locally by holding/scripts/extract-photo-metadata.sh
    // and committed as a static file. when absent, return empty JSON
    // rather than letting Pages SPA-fall back to index.html (which the
    // tooltip JS would then try to parse as JSON and fail).
    //
    // also overrides the cache-control: the /images/* rule in _headers
    // pins everything in that directory to 1-year immutable (correct for
    // content-addressed photos, wrong for this file which updates each
    // time photos are added/removed). short cache so changes propagate.
    if (url.pathname === "/images/metadata.json") {
      const res = await env.ASSETS.fetch(request);
      const ct  = res.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const headers = new Headers(res.headers);
        headers.set("cache-control", "public, max-age=60, s-maxage=60, must-revalidate");
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }
      try { await res.body?.cancel(); } catch {}
      return new Response("{}", {
        status: 200,
        headers: {
          "content-type":  "application/json; charset=utf-8",
          "cache-control": "public, max-age=60, s-maxage=60, must-revalidate",
        },
      });
    }

    // /images/meta/<stem>.json — per-photo EXIF for the hover tooltip.
    // same SPA-fallback hazard as metadata.json above, but worse: a
    // missing file would fall through to Pages' index.html fallback
    // (200 text/html) and the /images/* _headers rule would stamp it
    // 1-year immutable — poisoning that photo's tooltip in the browser
    // HTTP cache until META_V is bumped. guard: real JSON passes
    // through, anything else becomes an uncacheable 404.
    if (/^\/images\/meta\/[^/]+\.json$/i.test(url.pathname)) {
      const res = await env.ASSETS.fetch(request);
      const ct  = res.headers.get("content-type") || "";
      if (ct.includes("json")) return res;
      try { await res.body?.cancel(); } catch {}
      return new Response('{"error":"not found"}', {
        status: 404,
        headers: {
          "content-type":  "application/json; charset=utf-8",
          "cache-control": "public, max-age=0, must-revalidate",
        },
      });
    }

    // full-res photos live in R2 (aadhar-photos bucket, bound as
    // PHOTOS_R2). thumbnails stay inline in /images/ — they're tiny and
    // benefit from being on the same edge. only the chonky originals
    // get the R2 trip.
    if (url.pathname.startsWith("/images/full/")) {
      return servePhotoFromR2(request, env);
    }

    // /images/<stem>.<ext> thumbnail proxy. Cloudflare Pages's default
    // 404 response is `cache-control: max-age=14400`, which is fine for
    // truly-missing assets but catastrophic when a transient miss happens
    // during a deploy race — the edge then serves a stale 404 for 4 hours
    // even after the asset becomes available. We intercept here, pass to
    // Pages, and rewrite cache-control on any non-200 response so the
    // edge won't poison itself. Successful responses pass through with
    // Pages's normal long-cache (correct for content-addressed thumbs
    // because we bump THUMB_VERSION's `?v=N` on each deploy).
    if (/^\/images\/[^/]+\.(jpg|jpeg|avif|png|gif|heic|heif)$/i.test(url.pathname)) {
      const res = await env.ASSETS.fetch(request);
      if (!res.ok) {
        const headers = new Headers(res.headers);
        headers.set("cache-control", "public, max-age=0, must-revalidate");
        return new Response(res.body, {
          status: res.status, statusText: res.statusText, headers,
        });
      }
      return res;
    }

    // /images/<file>.<ext> for image extensions: must resolve to a real
    // image asset, not Cloudflare Pages' SPA fallback (which returns
    // index.html with text/html for any missing path). serve if real,
    // 404 if missing. (no more .jpg → .avif redirect — both formats now
    // exist again as siblings, so a missing .jpg is genuinely missing.)
    const thumbMatch = url.pathname.match(/^\/images\/([^/]+)\.(avif|jpe?g|png|gif|heic|heif|hif)$/i);
    if (thumbMatch) {
      const res = await env.ASSETS.fetch(request);
      const ct  = res.headers.get("content-type") || "";
      if (ct.startsWith("image/")) return res;
      try { await res.body?.cancel(); } catch {}
      return errorResp("not found", 404);
    }

    // markdown content negotiation: when an agent sends
    //   Accept: text/markdown
    // on the homepage, serve the hand-maintained index.md with
    //   Content-Type: text/markdown
    // and a rough x-markdown-tokens header. browsers asking for text/html
    // (or anything else) keep getting the HTML version as default —
    // with the music section pre-rendered for zero-flash arrival.
    // /index.html → / — the _headers no-store rule matches the literal "/"
    // path only, so serving the randomized homepage at this alias would let
    // browsers heuristically cache a page that's supposed to re-randomize
    // (and tick the counter) per visit. canonicalize instead.
    if (url.pathname === "/index.html") {
      url.pathname = "/";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/") {
      if (wantsMarkdown(request)) {
        return serveMarkdown(request, env);
      }
      return serveHomepageWithPrerenderedTracks(request, env, ctx);
    }

    // everything else: serve the static asset that lives at this path
    return env.ASSETS.fetch(request);
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
async function serveHomepageWithPrerenderedTracks(request, env, ctx) {
  // the page is no-store, so the worker runs on every visit. these reads
  // are mutually independent (the static asset, the tracks payload, the
  // photo manifest, the counter value), so fire them concurrently instead
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
        return await env.RN_KV.get(`tracks:${pid}`, "json");
      }
    } catch {}
    return null;
  })();
  const manifestP = getImagesManifest(env, ctx).then(
    arr => (Array.isArray(arr) && arr.length ? arr : null),
    () => null
  );
  // visitor counter source — prefer the Durable Object (atomic increment, 100k
  // writes/day) when its binding is present; else fall back to KV (eventually-
  // consistent, 1k writes/day). bot status is request-only, so compute it up front
  // and let the counter fetch ride the concurrent batch below — no serial round-trip
  // either way. humans bump the count; bots read it (DO: ?peek; KV: read-no-write).
  const counterUA = request.headers.get("user-agent") || "";
  const counterIsBot = request.cf?.botManagement?.verifiedBot === true ||
    /bot|crawl|spider|slurp|crawler|bingpreview|facebookexternalhit|embedly|slackbot|whatsapp|telegrambot|discordbot|redditbot|petalbot|gptbot|claudebot|ccbot|perplexity|bytespider|google-extended/i.test(counterUA);
  const counterP = env.COUNTER
    ? env.COUNTER.get(env.COUNTER.idFromName("homepage-visits"))
        .fetch(`https://do/${counterIsBot ? "?peek=1" : ""}`)
        .then((r) => r.json())
        .catch(() => null)
    : env.RN_KV
      ? env.RN_KV.get("counter:visits").catch(() => null)
      : Promise.resolve(null);

  const [res, tracksPayload, photos, counterData, altMap] = await Promise.all([
    env.ASSETS.fetch(request),
    tracksChain,
    manifestP,
    counterP,
    getAltMap(env),   // AI alt text; module-cached, so this is free on warm isolates
  ]);

  // honest classic-90s-counter behavior: counts every homepage GET, no session
  // dedup, no cookie. derive the footer pill from whichever backend answered:
  //   • DO  — counterData is { n }. humans already incremented atomically inside
  //     the DO (no read-modify-write race, no 1k/day write cap); bots peeked.
  //     on a transient DO error counterData is null → leave the pill null (the
  //     static "000042" placeholder shows) rather than touch KV, so an error
  //     can't clobber the migrated count. KV `counter:visits` (last value 891)
  //     stays frozen as a record; the DO is the source of truth once bound.
  //   • KV  — fallback until the COUNTER binding is added: counterData is the raw
  //     string; increment + fire-and-forget write, humans only. this site
  //     advertises to agents (DNS-AID + llms.txt), so counting crawlers would
  //     dominate the write budget and inflate the pill — bots read, don't bump.
  let counterStr = null;
  if (env.COUNTER) {
    if (counterData && typeof counterData.n === "number") {
      counterStr = String(counterData.n).padStart(6, "0");
    }
  } else if (env.RN_KV) {
    const cur  = parseInt(counterData || "0", 10) || 0;
    const next = counterIsBot ? cur : cur + 1;
    counterStr = String(next).padStart(6, "0");
    if (!counterIsBot) ctx.waitUntil(env.RN_KV.put("counter:visits", String(next)));
  }

  // footer "Last modified" → the most recently added photo (a real, datable
  // content change; the pool grows often). Pages assets are content-addressed
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
  if (!tracksPayload?.tracks?.length && !photos && !counterStr && !lastModStr) return res;

  const rewriter = new HTMLRewriter();
  let lcpAvif = null, lcpStem = null;  // first photo tile → responsive preload Link

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
  // pick 9 random photos via fisher-yates so the grid feels fresh each
  // visit. response carries Cache-Control: no-store via _headers (see
  // comment on / in _headers explaining the strong no-cache choice), so
  // CF/browser/intermediaries don't pin this selection across refreshes.
  // <picture> uses AVIF primary + JPG fallback; data-* attrs feed the
  // hover tooltip; target=_blank + rel=noopener on the anchor.
  if (photos) {
    const pick = pickRandom(photos, 12);   // ~12 fills the justified rows into a fuller rectangle
    lcpAvif = pick[0] && pick[0].thumb_avif ? pick[0].thumb_avif : null;
    lcpStem = pick[0] && pick[0].stem ? pick[0].stem : null;
    const slotsHtml = pick.map((p, i) => {
      const full     = p.full;
      // first tile: eager + high fetch priority. it's the topmost photo
      // and a candidate LCP element (the grid sits below the lede, so
      // it's a coin-flip with the text — but when the photo is LCP this
      // removes the lazy-load delay + bumps it from Low to High priority).
      // the other 8 stay lazy. fetchpriority: Chrome 102+/Safari 17.2+,
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
          (p.stem ? `<source type="image/avif" media="(max-width: 560px)" srcset="/images/${escAttr(p.stem)}-${THUMB_SMALL_PX}.avif?v=${THUMB_VERSION}">` : "") +
          (p.thumb_avif ? `<source type="image/avif" srcset="/images/${escAttr(p.thumb_avif)}">` : "") +
          `<img alt="${escAttr(altMap[p.stem] || "")}" ${imgLoad} decoding="async" src="/images/${escAttr(p.thumb_jpg)}">` +
        `</picture>` +
      `</a>`;
    }).join("");
    rewriter.on("section.photos", {
      element(el) { el.setInnerContent(slotsHtml, { html: true }); },
    });
  }

  // ── visitor counter → footer .counter pill ──────────────────────
  if (counterStr) {
    rewriter.on(".counter", {
      element(el) { el.setInnerContent(counterStr); },
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
      `<link rel="preload" as="image" type="image/avif" fetchpriority="high" media="(min-width: 561px)" href="/images/${escAttr(lcpAvif)}">` +
      (lcpStem ? `<link rel="preload" as="image" type="image/avif" fetchpriority="high" media="(max-width: 560px)" href="/images/${escAttr(lcpStem)}-${THUMB_SMALL_PX}.avif?v=${THUMB_VERSION}">` : "");
    rewriter.on("head", { element(el) { el.prepend(links, { html: true }); } });
  }
  return rewriter.transform(res);
}

// fisher-yates shuffle, return first N elements. doesn't mutate input.
function pickRandom(arr, n) {
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
function linkifyArtists(artists, fallbackText) {
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

function fmtDuration(ms) {
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

// ── /images/full/<key> → R2 ─────────────────────────────────────────
// proxies an R2 GET through the worker. supports If-None-Match (304s on
// cache hit), Range requests, and emits long cache headers since each
// upload is content-addressed by its filename. originals retain their
// SOOC filenames (IMG_1234.jpg, DSCF5678.heic, etc.), so the validation
// is permissive on stem but strict on extension and forbids any path
// traversal characters.
async function servePhotoFromR2(request, env) {
  if (!env.PHOTOS_R2) {
    return errorResp("R2 bucket not bound", 503);
  }

  const url = new URL(request.url);
  const key = url.pathname.replace(/^\/images\/full\//, "");
  // allow letters, digits, `_`, `-`, `.` in the stem; require a known
  // image extension. forbids `/`, `..`, and other escape characters.
  if (!/^[A-Za-z0-9_.-]+\.(?:jpe?g|png|heic|heif|hif|avif|gif)$/i.test(key)) {
    return errorResp("not found", 404);
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  const range       = request.headers.get("range");

  // R2's onlyIf conditional GET returns a body-less object when the etag
  // matches — translates directly to a 304 response.
  const getOpts = {};
  if (ifNoneMatch) getOpts.onlyIf = { etagDoesNotMatch: ifNoneMatch.replace(/^W\//, "").replace(/"/g, "") };
  if (range) {
    const m = range.match(/^bytes=(\d+)-(\d*)$/);
    if (m) {
      const offset = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : undefined;
      getOpts.range = end !== undefined
        ? { offset, length: end - offset + 1 }
        : { offset };
    }
  }

  const obj = await env.PHOTOS_R2.get(key, Object.keys(getOpts).length ? getOpts : undefined);
  if (obj === null) {
    // either the key doesn't exist, or onlyIf matched (so the response is
    // a 304). R2 returns the object metadata in both cases via head() —
    // we treat null as the 304-or-404 boundary by re-checking metadata.
    if (ifNoneMatch) {
      const head = await env.PHOTOS_R2.head(key);
      if (head) {
        return new Response(null, {
          status: 304,
          headers: { etag: head.httpEtag, "cache-control": "public, max-age=86400, immutable" },
        });
      }
    }
    return errorResp("not found", 404);
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("content-type",  obj.httpMetadata?.contentType || "image/jpeg");
  headers.set("etag",          obj.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("accept-ranges", "bytes");

  const isRange = !!getOpts.range && obj.range;
  if (isRange) {
    const start = obj.range.offset;
    const len   = obj.range.length;
    const end   = start + len - 1;
    headers.set("content-range",  `bytes ${start}-${end}/${obj.size}`);
    headers.set("content-length", String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}
function escAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── /writing — the Notepad view ───────────────────────────────────────────────
// Written content lives in plain .txt files under /writing/ + a posts.json registry.
// Each post renders as an XP Notepad window whose <textarea> is SSR-seeded with the
// canonical text: editable by nature, ephemeral by nature (no save → reload restores
// the canonical copy). The prose ships in the HTML, so it's readable/crawlable with
// JS off; notepad.js only adds the menus + Ln/Col status + the F5 date stamp.
const NOTEPAD_CSS = `
html{background:linear-gradient(180deg,oklch(56% 0.13 250) 0%,oklch(73% 0.10 236) 50%,oklch(88% 0.05 232) 60%,oklch(60% 0.16 140) 100%)}
body.np-page{margin:0;min-height:100vh;padding:16px 12px 54px;color:oklch(21% 0 0);font-family:var(--font-ui);font-size:12px;
background:linear-gradient(180deg,oklch(56% 0.13 250) 0%,oklch(73% 0.10 236) 50%,oklch(88% 0.05 232) 60%,oklch(60% 0.16 140) 100%)}
.np-window{max-width:860px;margin:0 auto;max-height:calc(100dvh - 78px);display:flex;flex-direction:column;background:oklch(100% 0 0);
border:2px solid #0831d9;border-right-color:#001ea0;border-bottom-color:#001ea0;border-top-left-radius:8px;border-top-right-radius:8px;overflow:hidden;
box-shadow:inset 1px 1px 0 #166aee,inset 2px 2px 0 #0855dd,inset -1px -1px 0 #00138c,inset -2px -2px 0 #003bda,4px 4px 0 rgba(0,30,160,.35)}
.np-titlebar{flex:0 0 auto;display:flex;align-items:center;gap:5px;padding:4px 6px 4px 7px;color:oklch(100% 0 0);
font-family:var(--font-caption);font-weight:bold;font-size:11px;text-shadow:1px 1px #0f1089;border-bottom:1px solid oklch(41.9% 0.096 250);
background:linear-gradient(180deg,oklch(70% 0.15 258) 0%,oklch(60% 0.20 261) 8%,oklch(51% 0.225 263) 18%,oklch(50% 0.225 263) 86%,oklch(58% 0.18 260) 100%)}
.np-ico{flex:0 0 auto;width:14px;height:15px;background:oklch(100% 0 0);border:1px solid oklch(45% 0 0);border-radius:1px;position:relative}
.np-ico::before{content:"";position:absolute;left:2px;right:3px;top:3px;height:1px;background:oklch(55% 0.16 258);box-shadow:0 3px 0 oklch(55% 0.16 258),0 6px 0 oklch(55% 0.16 258),0 9px 0 oklch(55% 0.16 258)}
.np-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.np-controls{display:flex;gap:2px}
/* canonical Luna caption buttons (design system): 21x21 glossy "gel" lozenges,
   min/max blue + close red, CSS-drawn white glyphs. matches .title-bar .controls
   site-wide; hex traced from the Luna .msstyles bitmap, kept hex on purpose. */
.np-controls .min,.np-controls .max,.np-controls .close{position:relative;box-sizing:border-box;width:21px;height:21px;padding:0;display:inline-block;overflow:hidden;font-size:0;color:transparent;text-decoration:none;cursor:pointer;border:1px solid #6696eb;border-radius:3px;background-color:#3e73f5;background-image:linear-gradient(180deg,#5f8cf7 0%,#3a71f5 22%,#3e73f5 55%,#2a70f2 82%,#1045be 100%);transition:filter 60ms ease-out}
.np-controls .min::after,.np-controls .max::after{content:"";position:absolute;left:0;right:0;top:0;height:45%;background:linear-gradient(180deg,rgba(255,255,255,.55) 0%,rgba(255,255,255,.12) 70%,rgba(255,255,255,0) 100%);pointer-events:none;border-radius:2px 2px 5px 5px}
.np-controls .min:hover,.np-controls .max:hover{border-color:#8fb4ff;background-color:#4fa4ff;background-image:linear-gradient(180deg,#689bff 0%,#468aff 22%,#4fa4ff 55%,#3990fc 82%,#1858c8 100%)}
.np-controls .min:active,.np-controls .max:active,.np-controls .close:active{filter:brightness(.9)}
.np-controls .min::before{content:"";position:absolute;left:5px;right:5px;bottom:5px;height:2px;background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.35)}
.np-controls .max::before{content:"";position:absolute;left:5px;top:5px;width:11px;height:9px;box-sizing:border-box;border:1px solid #fff;border-top-width:2px;filter:drop-shadow(0 1px 0 rgba(0,0,0,.35))}
.np-controls .close{border-color:#d8401c;background-color:#e45f3e;background-image:linear-gradient(180deg,#e8795f 0%,#e45f40 30%,#e45d3d 52%,#e2552a 80%,#ae3110 100%)}
.np-controls .close:hover{border-color:#ff7a66;background-color:#ff957c;background-image:linear-gradient(180deg,#ff8b7d 0%,#ff7463 26%,#ff957c 55%,#fd7e64 82%,#d34936 100%);box-shadow:0 0 4px rgba(255,120,96,.7)}
.np-controls .close::before,.np-controls .close::after{content:"";position:absolute;left:50%;top:50%;width:13px;height:2px;margin:-1px 0 0 -6.5px;background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.35)}
.np-controls .close::before{transform:rotate(45deg)}.np-controls .close::after{transform:rotate(-45deg)}
.np-menubar{flex:0 0 auto;display:flex;align-items:stretch;gap:0;padding:1px 2px;font-size:11px;position:relative;
background:oklch(93% 0.012 90);border-bottom:1px solid oklch(78% 0.02 90)}
.np-menu{border:0;background:none;font:11px var(--font-ui);color:oklch(20% 0 0);padding:3px 8px;cursor:pointer;border-radius:2px}
.np-menu:hover,.np-menu[aria-expanded=true]{background:oklch(50% 0.22 263);color:oklch(100% 0 0)}
.np-drop{position:absolute;top:100%;min-width:170px;z-index:50;background:oklch(98% 0.004 250);padding:2px;
border:1px solid oklch(45% 0 0);box-shadow:2px 2px 0 oklch(0% 0 0 / .25)}
.np-item{display:grid;grid-template-columns:18px 1fr auto;align-items:center;gap:8px;width:100%;border:0;background:none;cursor:pointer;
font:11px var(--font-ui);color:oklch(20% 0 0);padding:4px 8px 4px 2px;text-align:left}
.np-item:hover{background:oklch(50% 0.22 263);color:oklch(100% 0 0)}
.np-chk{text-align:center;font-size:10px}.np-acc{color:oklch(52% 0 0)}.np-item:hover .np-acc{color:oklch(90% 0.02 263)}
.np-sep{height:0;border-top:1px solid oklch(80% 0.01 90);margin:2px 1px}
.np-text{flex:0 1 auto;field-sizing:content;min-height:8em;max-height:calc(100dvh - 150px);width:100%;box-sizing:border-box;border:0;outline:none;resize:none;padding:9px 11px;background:oklch(100% 0 0);
color:oklch(16% 0 0);font-family:var(--font-mono);font-size:13px;line-height:1.55;white-space:pre-wrap;overflow:auto;tab-size:4}
.np-text.nowrap{white-space:pre;overflow:auto}
.np-status{flex:0 0 auto;display:flex;align-items:center;gap:4px;padding:2px 3px;font-size:11px;color:oklch(28% 0 0);
background:oklch(93% 0.012 90);border-top:1px solid oklch(80% 0.02 90)}
.np-status>span:not(.np-flex){padding:1px 8px;box-shadow:inset 1px 1px 0 oklch(78% 0.02 90),inset -1px -1px 0 oklch(100% 0 0)}
.np-flex{flex:1;box-shadow:none}
.np-edited{color:oklch(46% 0 0)}
/* a note opened as a popover — floats over the folder ("selecting menu"),
   clears the taskbar, and keeps the window chrome (drag/resize/scrollbar). */
.np-note[popover]{position:fixed;left:0;right:0;top:10px;margin:0 auto;width:min(720px,calc(100vw - 32px));max-height:calc(100dvh - 48px) !important}
.np-note[popover]::backdrop{background:transparent}
/* CRITICAL: our .np-window{display:flex} would otherwise beat the UA
   [popover]:not(:popover-open){display:none}, leaking closed notes into flow. */
.np-note:not(:popover-open){display:none !important}
/* folder index ("My Writing") */
.np-folder{height:auto;min-height:0;max-width:560px}
.np-folder-body{padding:14px 16px 6px}
.np-folder-intro{margin:0 0 12px;color:oklch(40% 0 0)}
.np-files{list-style:none;margin:0;padding:0;border:1px solid oklch(80% 0.02 250)}
.np-files li+li{border-top:1px solid oklch(92% 0.01 250)}
.np-files a{display:flex;align-items:center;gap:10px;padding:7px 10px;text-decoration:none;color:oklch(20% 0 0)}
.np-files a:hover{background:oklch(50% 0.22 263);color:oklch(100% 0 0)}
.np-files a:nth-child(odd){background:oklch(97.5% 0.006 255)}
.np-files a:hover{background:oklch(50% 0.22 263)}
.np-file-ico{flex:0 0 auto;width:18px;height:20px;background:oklch(100% 0 0);border:1px solid oklch(50% 0 0);border-radius:1px;position:relative}
.np-file-ico::before{content:"";position:absolute;left:3px;right:4px;top:4px;height:1px;background:oklch(58% 0.16 258);box-shadow:0 3px 0 oklch(58% 0.16 258),0 6px 0 oklch(58% 0.16 258),0 9px 0 oklch(58% 0.16 258)}
.np-file-name{font-weight:bold;color:inherit}.np-files a:hover .np-file-name{color:oklch(100% 0 0)}
.np-file-meta{margin-left:auto;color:oklch(52% 0 0);font-size:11px}.np-files a:hover .np-file-meta{color:oklch(90% 0.02 263)}
/* About dialog */
.np-modal-back{position:fixed;inset:0;z-index:100000}
.np-about{position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);z-index:100001;width:min(340px,calc(100vw - 24px));background:oklch(100% 0 0);
border:2px solid #0831d9;border-right-color:#001ea0;border-bottom-color:#001ea0;box-shadow:inset 1px 1px 0 #166aee,inset -1px -1px 0 #00138c,4px 4px 0 rgba(0,30,160,.35)}
.np-about-body{padding:12px 14px}.np-about-body p{margin:0 0 9px;line-height:1.45}
.np-about-btns{display:flex;justify-content:flex-end}
.np-btn{min-width:72px;padding:3px 12px;font:12px var(--font-ui);cursor:pointer;color:oklch(18% 0 0);border:1px solid oklch(50% 0.04 263);border-radius:3px;
background:linear-gradient(180deg,oklch(99% 0 0),oklch(92% 0.005 263));box-shadow:inset 1px 1px 0 oklch(100% 0 0),inset -1px -1px 0 oklch(84% 0.02 90)}
.np-btn:active{box-shadow:inset 1px 1px 0 oklch(84% 0.02 90),inset -1px -1px 0 oklch(100% 0 0)}
@media print{body.np-page{padding:0;background:none}#axp-taskbar,.np-titlebar,.np-menubar,.np-status{display:none}
.np-window{border:0;box-shadow:none;height:auto;max-width:none}.np-text{font-size:11pt;color:#000}}
`;

function writingShell(o) {
  return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>" + escHtml(o.title) + "</title>" +
    "<meta name=\"description\" content=\"" + escAttr(o.desc) + "\">" +
    "<link rel=\"canonical\" href=\"https://aadhar.sh" + escAttr(o.path) + "\">" +
    "<link rel=\"icon\" type=\"image/svg+xml\" href=\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect x='7' y='3' width='18' height='26' rx='1' fill='%23ffffff' stroke='%230855dd' stroke-width='2'/><rect x='10' y='9' width='12' height='1.6' fill='%23166aee'/><rect x='10' y='14' width='12' height='1.6' fill='%23166aee'/><rect x='10' y='19' width='8' height='1.6' fill='%23166aee'/></svg>\">" +
    "<style>:root{--font-caption:\"Trebuchet MS\",Verdana,Geneva,sans-serif;--font-ui:Tahoma,Verdana,Geneva,sans-serif;--font-mono:\"Courier New\",Courier,monospace}</style>" +
    "<style>" + NOTEPAD_CSS + "</style></head><body class=\"np-page\">" +
    o.body +
    "<script src=\"/notepad.js\" defer></script><script src=\"/nav.js\" defer></script></body></html>";
}

// popId (optional): render the window as an inline popover (id + popover="auto")
// so it can composite over the folder index instead of being its own page.
function notepadWindow(filename, text, closeHref, date, popId) {
  var open = popId
    ? "<div class=\"np-window np-note\" id=\"" + escAttr(popId) + "\" popover=\"manual\">"
    : "<div class=\"np-window\">";
  return open +
    "<div class=\"np-titlebar\"><span class=\"np-ico\" aria-hidden=\"true\"></span>" +
      "<span class=\"np-title\">" + escHtml(filename) + " — Notepad</span>" +
      "<span class=\"np-controls\"><span class=\"min\" aria-hidden=\"true\"></span><span class=\"max\" aria-hidden=\"true\"></span>" +
      "<a class=\"close\" href=\"" + escAttr(closeHref) + "\"" + (popId ? " data-pop" : "") + " title=\"back to writing\" aria-label=\"Close\">✕</a></span></div>" +
    "<div class=\"np-menubar\" role=\"menubar\" aria-label=\"menu\">" +
      "<span class=\"np-menu\">File</span><span class=\"np-menu\">Edit</span><span class=\"np-menu\">Format</span><span class=\"np-menu\">View</span><span class=\"np-menu\">Help</span></div>" +
    "<textarea class=\"np-text\" spellcheck=\"false\" aria-label=\"" + escAttr(filename) + "\">" + escHtml(text) + "</textarea>" +
    "<div class=\"np-status\"><span class=\"np-pos\">Ln 1, Col 1</span><span class=\"np-wc\"></span><span class=\"np-flex\"></span>" +
      (date ? "<span class=\"np-edited\">last changed " + escHtml(date) + "</span>" : "") + "</div></div>";
}

async function readPosts(env) {
  try {
    const r = await env.ASSETS.fetch("https://a/writing/posts.json");
    if (r.ok) { const j = await r.json(); if (Array.isArray(j)) return j; }
  } catch {}
  return [];
}

async function handleWritingPost(slug, env, ctx) {
  const safe = String(slug).replace(/[^a-z0-9-]/gi, "");
  const posts = await readPosts(env);
  const post = posts.find(function (p) { return p.slug === safe; });
  let text = null;
  if (post) {
    try { const r = await env.ASSETS.fetch("https://a/writing/" + safe + ".txt"); if (r.ok) text = await r.text(); } catch {}
  }
  if (!post || text == null) {
    const body = notepadWindow("(not found).txt", "This note doesn't exist — or it hasn't been written yet.\n\nThe index lives at /writing.", "/writing");
    return new Response(writingShell({ title: "aadhar.sh/writing/not found", path: "/writing/" + safe, desc: "No such note.", body: body }),
      { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30, must-revalidate" } });
  }
  const title = post.title || safe;
  const desc = text.replace(/\s+/g, " ").trim().slice(0, 155);
  const body = notepadWindow(title + ".txt", text, "/writing", post.date);
  return new Response(writingShell({ title: "aadhar.sh/writing/" + title + ".txt", path: "/writing/" + safe, desc: desc, body: body }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}

async function handleWritingIndex(env, ctx) {
  const posts = await readPosts(env);
  // fetch each note's .txt once: the same text feeds the char count shown in
  // the folder listing (so you see a file's size before you open it) AND the
  // inline popover Notepad window below. notes are tiny — cheap to inline.
  const fmtNum = function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); };
  const entries = await Promise.all(posts.map(async function (p) {
    const safe = String(p.slug).replace(/[^a-z0-9-]/gi, "");
    let text = "";
    try { const r = await env.ASSETS.fetch("https://a/writing/" + safe + ".txt"); if (r.ok) text = await r.text(); } catch {}
    return { p: p, safe: safe, text: text, chars: text.length };
  }));
  const files = entries.map(function (e) {
    const size = fmtNum(e.chars) + (e.chars === 1 ? " character" : " characters");
    return "<li><a href=\"/writing/" + escAttr(e.p.slug) + "\" data-note=\"" + escAttr(e.safe) + "\"><span class=\"np-file-ico\" aria-hidden=\"true\"></span>" +
      "<span class=\"np-file-name\">" + escHtml(e.p.title || e.p.slug) + ".txt</span>" +
      "<span class=\"np-file-meta\">Text Document · " + size + (e.p.date ? " · " + escHtml(e.p.date) : "") + "</span></a></li>";
  }).join("");
  // the list <a>'s real href is the no-JS / permalink path; opening one composites
  // its popover Notepad over the folder (the "selecting menu") with no navigation.
  const notes = entries.map(function (e) {
    return notepadWindow((e.p.title || e.safe) + ".txt", e.text, "/writing", e.p.date, "note-" + e.safe);
  }).join("");
  const body = "<div class=\"np-window np-folder\">" +
    "<div class=\"np-titlebar\"><span class=\"np-ico\" aria-hidden=\"true\"></span>" +
      "<span class=\"np-title\">aadhar.sh/writing</span>" +
      "<span class=\"np-controls\"><span class=\"min\" aria-hidden=\"true\"></span><span class=\"max\" aria-hidden=\"true\"></span>" +
      "<a class=\"close\" href=\"/\" title=\"back home\" aria-label=\"Close\">✕</a></span></div>" +
    "<div class=\"np-folder-body\"><p class=\"np-folder-intro\">Notes, in flux. Open one — it's a real text field you can edit, but it reverts to my canonical version on reload.</p>" +
      "<ul class=\"np-files\">" + (files || "<li><a><span class=\"np-file-name\">(nothing written yet)</span></a></li>") + "</ul></div>" +
    "<div class=\"np-status\"><span>" + posts.length + (posts.length === 1 ? " document" : " documents") + "</span>" +
      "<span>" + fmtNum(entries.reduce(function (a, e) { return a + e.chars; }, 0)) + " characters</span></div></div>" +
    notes;
  return new Response(writingShell({ title: "aadhar.sh/writing", path: "/writing", desc: "Notes in flux — an editable Notepad of writing that reverts to canonical on reload.", body: body }),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=120" } });
}

// read a bundled static asset bypassing the read-through asset cache (a unique
// query string forces a cache miss), then re-emit it under the canonical URL
// with the given content-type + a short, deploy-purgeable edge cache. used for
// the agent-discovery docs whose canonical URL a long Cache-Control had pinned.
async function serveFreshAsset(request, env, contentType) {
  const u = new URL(request.url);
  u.searchParams.set("__r", Date.now().toString(36));
  const res = await env.ASSETS.fetch(new Request(u.toString(), { headers: request.headers }));
  const headers = new Headers(res.headers);
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "public, max-age=0, must-revalidate, s-maxage=300");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// short-cache error response. matches the CF Cache Rule that pins edge
// TTL to 30s on 4xx/5xx — sending max-age=30 makes the browser cache
// honor the same window, so a transient 404 during a deploy race
// doesn't get pinned in either CF's edge OR the visitor's browser for
// CF Pages's default 4h. use everywhere we emit a 4xx/5xx ourselves.
function errorResp(body, status) {
  return new Response(body, {
    status,
    headers: {
      "content-type":  "text/plain; charset=utf-8",
      "cache-control": "public, max-age=30, must-revalidate",
    },
  });
}

// ── 1990s-style directory listings ──────────────────────────────────
// the 1999 web had these everywhere — Apache's mod_autoindex was the
// canonical implementation. Cloudflare Pages doesn't auto-generate them
// (the request 404s without an index file), so we hand-render in that
// visual style: bracketed icons, DD-MMM-YYYY HH:MM dates, K/M sizes,
// parent directory link. honest about the source though — the signature
// at the bottom reads "handwritten worker at aadhar.sh" rather than
// pretending to be Apache.

// the photo manifest is the single source of truth for which photos
// exist. derived from R2 keys (each upload preserves its SOOC filename;
// thumbnails share that filename stem with .avif as the primary modern
// format and .jpg as the universal fallback). cached in KV for an hour.
//
// dedup: when a stem has multiple R2 objects (e.g. HIF + JPG sibling
// because we generated a JPG export of a HIF original), pick the one
// most browser-friendly for click-through. JPG/JPEG > PNG/WebP/GIF >
// HEIF/HEIC/HIF. HIFs trigger Chrome's download dialog instead of
// rendering, so we always prefer a JPG counterpart when one exists.
const R2_EXT_PRIORITY = {
  jpg: 5, jpeg: 5,
  png: 3, webp: 3, gif: 3,
  heif: 1, heic: 1, hif: 1,
};

// bump to bust all `/images/<stem>.{avif,jpg}` edge-cache entries at
// once. used as a `?v=<N>` suffix in the manifest's thumb URLs. Cloudflare
// includes the query string in the cache key by default, so changing this
// produces a fresh cache lookup that doesn't see prior stale 404s.
// (10 dropped WebP; 11 grid thumbs 1200px → 500px; 12 AVIF re-encoded at
// higher quality (CQ30 → -q63); 13 the 3 grayscale Leica thumbs re-encoded
// as true monochrome (yuv420 → yuv400). same filenames each time, so the
// ?v= bump is what busts the edge cache for the new bytes.)
const THUMB_VERSION = 18;
// stems removed from the pool — excluded from the rebuilt manifest even if their
// original still lingers in R2's eventually-consistent list(). prune once R2
// list() drops them (and the entry here is harmless to keep as a record).
const REMOVED_STEMS = new Set(["XT509360"]);
// small mobile AVIF tier (stem-400.avif), served via <source media> at <=560px.
const THUMB_SMALL_PX = 400;

// AI alt text (cf-garage Workers AI, ?mode=alt) generated offline into the static
// asset /images/alt.json {stem: alt}. loaded once per isolate and cached in a module
// var — deliberately NOT folded into the hot-path manifest (which is JSON-parsed on
// every no-store homepage hit; alt would bloat it). only the alt strings for the ~12
// rendered slots ship per page. strippable: delete alt.json + these lookups to revert.
let _altMap;
// the Spotify playlist id (KV "playlist-id") changes ~never; module-cached so
// the homepage tracks lookup is one KV read on warm isolates instead of two.
let _playlistId;
async function getAltMap(env) {
  if (_altMap) return _altMap;
  try {
    const r = await env.ASSETS.fetch("https://assets.local/images/alt.json");
    _altMap = r.ok ? await r.json() : {};
  } catch { _altMap = {}; }
  return _altMap;
}

async function getImagesManifest(env, ctx) {
  // two-key stale-while-revalidate: the manifest itself is stored WITHOUT a
  // TTL (persistent), and a tiny sentinel key carries the 1h freshness TTL.
  // when the sentinel lapses, the visitor on the hot path gets the stale
  // manifest immediately and the R2 list() rebuild rides ctx.waitUntil in
  // the background — nobody pays the rebuild inline except the true first
  // run (or after `wrangler kv key delete "manifest:images"`, which is
  // still the documented manual cache-bust and still forces a rebuild).
  if (env.RN_KV) {
    let manifest = null, fresh = null;
    try {
      [manifest, fresh] = await Promise.all([
        env.RN_KV.get("manifest:images", "json"),
        env.RN_KV.get("manifest:images:fresh"),
      ]);
    } catch {}
    if (manifest) {
      if (!fresh && ctx) {
        ctx.waitUntil(
          buildImagesManifest(env)
            .then(m => m && storeImagesManifest(env, m))
            .catch(() => {})
        );
      }
      return manifest;
    }
  }
  // no cached manifest at all — build inline (first run / manual bust)
  const manifest = await buildImagesManifest(env);
  if (!manifest) return [];
  if (env.RN_KV && ctx) ctx.waitUntil(storeImagesManifest(env, manifest));
  return manifest;
}

async function storeImagesManifest(env, manifest) {
  await Promise.all([
    env.RN_KV.put("manifest:images", JSON.stringify(manifest)),
    env.RN_KV.put("manifest:images:fresh", "1", { expirationTtl: 3600 }),
  ]);
}

async function buildImagesManifest(env) {
  {
    if (!env.PHOTOS_R2) return null;
    const list = await env.PHOTOS_R2.list({ limit: 1000 });

    // collapse R2 objects to one-per-stem, prefer browser-renderable extensions
    const byStem = new Map();
    for (const o of list.objects || []) {
      const stem = o.key.replace(/\.[^.]+$/, "");
      if (REMOVED_STEMS.has(stem)) continue;  // tombstoned (R2 list() is eventually
                                              // consistent, so a deleted original can
                                              // linger in list() for a while)
      const ext  = (o.key.split(".").pop() || "").toLowerCase();
      const prio = R2_EXT_PRIORITY[ext] || 0;
      const existing = byStem.get(stem);
      if (!existing || prio > existing._prio) {
        byStem.set(stem, { ...o, _prio: prio });
      }
    }

    // EXIF metadata, keyed by stem. read once from the static asset
    // /images/metadata.json (generated by extract-photo-metadata.sh) and
    // bust stale edge-cached 404s. appending a `?v=N` to thumb URLs
    // forces a fresh cache lookup (CF includes the query in the cache
    // key by default). incrementing THUMB_VERSION is the supported way
    // to invalidate all thumbnail caches at once.
    //
    // dual-source: thumb_avif is the <picture> primary; thumb_jpg is
    // the universal <img src> fallback. NB: <picture> type-fallback only
    // catches "format not supported" — it does NOT catch DECODE failures.
    // AVIF decode failures historically caused broken images here; if
    // they recur, the fix is to demote AVIF entirely, not add fallbacks.
    // slim hot-path manifest: ONLY the fields the SSR slot-builder reads.
    // EXIF used to be merged in here (and shipped inline per slot) — the
    // manifest is read + JSON-parsed by the worker on EVERY no-store homepage
    // hit, and the EXIF was the bulk of the blob. the tooltip now lazy-fetches
    // /images/meta/<stem>.json per photo on first hover (histogram computed
    // client-side), so none of it needs to ride the hot path.
    const v = THUMB_VERSION;
    return [...byStem.entries()].map(([stem, o]) => ({
      full:       o.key,                     // R2 key, e.g. "XT507333.JPG"
      thumb_avif: `${stem}.avif?v=${v}`,     // Pages static AVIF (primary)
      thumb_jpg:  `${stem}.jpg?v=${v}`,      // Pages static JPG (fallback)
      stem,
      size:       o.size,                    // R2 object size in bytes
      uploaded:   o.uploaded ? new Date(o.uploaded).toISOString() : null,
    })).sort((a, b) => a.full.localeCompare(b.full));
  }
}

async function handleImagesManifest(request, env, ctx) {
  const photos = await getImagesManifest(env, ctx);
  return jsonResp({ photos, count: photos.length });
}

async function handleImagesIndex(request, env, ctx) {
  // probe the static asset layer for each known thumbnail. cache the
  // result in KV for an hour. uses GET (not HEAD) because env.ASSETS
  // doesn't reliably populate Content-Length, then reads the body via
  // arrayBuffer to count bytes.
  let entries = null;
  if (env.RN_KV) {
    try { entries = await env.RN_KV.get("idx:images", "json"); } catch {}
  }
  if (!entries) {
    // derive thumbnail filenames from the photo manifest. picks up new
    // uploads automatically (no POOL_COUNT bump needed). manifest stores
    // thumb URLs with a `?v=N` cache-bust suffix; strip it for the
    // human-readable directory listing (the probe still resolves the
    // underlying static asset regardless of the query string).
    const manifest = await getImagesManifest(env, ctx);
    const stripVer = (s) => String(s || "").replace(/\?.*$/, "");
    const names = manifest.flatMap(p => [
      stripVer(p.thumb_avif),
      stripVer(p.thumb_jpg),
    ]).filter(Boolean);
    entries = await Promise.all(names.map(async (name) => {
      try {
        const probeUrl = new URL(`/images/${name}`, request.url).toString();
        const res = await env.ASSETS.fetch(probeUrl);
        if (!res.ok) return null;
        // env.ASSETS doesn't populate Content-Length on its responses
        // (likely chunked internally), so read the body to count bytes.
        // expensive once per cache miss (~7MB across 68 files); harmless
        // since we cache the listing in KV for an hour afterward.
        let size = parseInt(res.headers.get("content-length") || "0", 10);
        if (!size && res.body) {
          const buf = await res.arrayBuffer();
          size = buf.byteLength;
        }
        return {
          name,
          size,
          lastModified: res.headers.get("last-modified") || null,
        };
      } catch {
        return null;
      }
    }));
    entries = entries.filter(Boolean);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    // prepend the full/ subdirectory entry
    entries = [{ name: "full/", size: null, lastModified: null, isDir: true }, ...entries];
    if (env.RN_KV) {
      ctx.waitUntil(env.RN_KV.put("idx:images", JSON.stringify(entries), { expirationTtl: 3600 }));
    }
  }

  return apacheIndexResponse("/images", entries);
}

async function handleImagesFullIndex(request, env, ctx) {
  if (!env.PHOTOS_R2) {
    return errorResp("R2 not bound", 503);
  }
  // R2 lists are cheap; cache 5 min so it's snappy without going too stale.
  let entries = null;
  if (env.RN_KV) {
    try { entries = await env.RN_KV.get("idx:imagesfull", "json"); } catch {}
  }
  if (!entries) {
    const list = await env.PHOTOS_R2.list({ limit: 1000 });
    entries = (list.objects || [])
      .map(o => ({
        name:         o.key,
        size:         o.size,
        lastModified: o.uploaded ? new Date(o.uploaded).toUTCString() : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (env.RN_KV) {
      ctx.waitUntil(env.RN_KV.put("idx:imagesfull", JSON.stringify(entries), { expirationTtl: 300 }));
    }
  }

  return apacheIndexResponse("/images/full", entries);
}

function apacheIndexResponse(path, entries) {
  const fmtSize = (b) => {
    if (b === null || b === undefined) return "-";
    if (b < 1024)            return String(b);
    if (b < 1024 * 1024)     return `${Math.round(b / 1024)}K`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}M`;
    return `${(b / 1024 / 1024 / 1024).toFixed(1)}G`;
  };
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const pad = (n) => String(n).padStart(2, "0");
  const fmtDate = (s) => {
    if (!s) return "                 -";
    const d = new Date(s);
    if (isNaN(d)) return "                 -";
    return `${pad(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  };
  const iconFor = (e) => {
    if (e.isDir) return "[DIR]";
    const ext = e.name.split(".").pop().toLowerCase();
    if (["jpg","jpeg","png","gif","avif","webp","heic","heif","bmp","tiff"].includes(ext)) return "[IMG]";
    if (["txt","md","xml","json","csv"].includes(ext)) return "[TXT]";
    if (["mp3","wav","flac","ogg"].includes(ext)) return "[SND]";
    if (["mp4","mov","webm","avi"].includes(ext)) return "[VID]";
    return "[   ]";
  };

  // parent directory link — one level up. an empty join produces an
  // empty string, which would yield "//" if we naively appended "/". so:
  // build the path explicitly and reuse "/" as the root case.
  const parts = path.split("/").filter(Boolean);
  const parentParts = parts.slice(0, -1);
  const parentHref = parts.length === 0
    ? null
    : parentParts.length === 0 ? "/" : "/" + parentParts.join("/") + "/";

  const formatRow = (icon, nameHtml, dateStr, sizeStr) => {
    // padded to look like the classic Apache <pre>-formatted listing
    const namePart  = nameHtml.padEnd(31, " ");
    const datePart  = dateStr.padEnd(17, " ");
    const sizePart  = sizeStr.padStart(5, " ");
    return `${icon} <a href="${nameHtml.replace(/<[^>]+>/g, "")}">${nameHtml}</a>${" ".repeat(Math.max(0, 30 - nameHtml.replace(/<[^>]+>/g, "").length))}  ${datePart}  ${sizePart}`;
  };

  let rows = "";
  if (parentHref) {
    rows += `[DIR] <a href="${parentHref}">Parent Directory</a>                                   -\n`;
  }
  for (const e of entries) {
    const icon = iconFor(e);
    const displayName = e.isDir ? e.name : e.name;
    const linkHref = e.isDir ? displayName : encodeURIComponent(displayName).replace(/%2F/g, "/");
    const padded = displayName.length > 28 ? displayName.slice(0, 25) + ".." : displayName;
    const namePad = " ".repeat(Math.max(0, 30 - padded.length));
    rows += `${icon} <a href="${linkHref}">${escHtml(padded)}</a>${namePad}  ${fmtDate(e.lastModified)}  ${fmtSize(e.size).padStart(6, " ")}\n`;
  }

  const html = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">
<html>
 <head>
  <title>Index of ${escHtml(path)}</title>
  <style>
    body { background: #ffffff; color: #000000; font-family: monospace; padding: 12px; }
    h1 { font-family: Helvetica, Arial, sans-serif; font-weight: bold; font-size: 14pt; margin: 0 0 12px; }
    pre { font-family: "Courier New", Courier, monospace; font-size: 10pt; line-height: 1.5; margin: 0; }
    a { color: #0000ee; text-decoration: underline; }
    a:visited { color: #551a8b; }
    hr { border: 0; border-top: 1px solid #000000; margin: 8px 0; }
    address { font-family: Helvetica, Arial, sans-serif; font-size: 9pt; font-style: italic; color: #000000; }
  </style>
 </head>
 <body>
<h1>Index of ${escHtml(path)}</h1>
<hr>
<pre>      Name                            Last modified      Size
<hr>${rows}<hr></pre>
<address>handwritten worker at aadhar.sh</address>
<script src="/nav.js" defer></script>
 </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "content-type":  "text/html; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300",
    },
  });
}

// ── markdown negotiation ────────────────────────────────────────────
// returns true iff the client's Accept header explicitly prefers text/markdown
// over text/html (or includes only text/markdown). browsers send
// `text/html,application/xhtml+xml,...` so they fall through.
function wantsMarkdown(request) {
  const accept = (request.headers.get("accept") || "").toLowerCase();
  if (!accept.includes("text/markdown")) return false;
  // if the client lists both, treat markdown as the requested representation
  // (the q-value parsing would be more precise but this matches every real
  // agent that asks for markdown today).
  return true;
}

async function serveMarkdown(request, env) {
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
      "cache-control":    "public, max-age=300, s-maxage=600",
      "vary":             "accept",
      "x-content-type-options": "nosniff",
    },
  });
}

// ── /rn handler ─────────────────────────────────────────────────────
async function handleRn(request, env) {
  let playlistId = null;
  if (env.RN_KV) {
    try { playlistId = await env.RN_KV.get("playlist-id"); } catch {}
  }
  const target = (playlistId && /^[0-9A-Za-z]{22}$/.test(playlistId))
    ? `https://open.spotify.com/playlist/${playlistId}`
    : RN_FALLBACK;
  return new Response(null, {
    status: 302,
    headers: {
      "location":        target,
      "cache-control":   "no-store, must-revalidate",
      "referrer-policy": "no-referrer",
    },
  });
}

// ── /rn/tracks handler ──────────────────────────────────────────────
// returns the current "rn" playlist's track list as JSON. data is pulled
// from spotify's public embed pages — three tiers of scrape:
//
//   1. playlist embed → gives the ordered track list (IDs, titles, durations,
//      explicit flag, audio preview URLs)
//   2. track embed    → gives the album cover URL + the artist list with
//      stable Spotify URIs (the playlist embed only has a joined "Artist A,
//      Artist B" subtitle string with no IDs)
//   3. artist embed   → gives the artist's profile picture
//
// the artist payload is cached in KV under `artist:<id>` with a long TTL
// since artist photos rarely change; subsequent playlist refreshes don't
// re-scrape known artists. tracks themselves are cached under
// `tracks:<playlist-id>` for 1 hour so per-page-load cost is zero.
//
// shape returned:
//   { playlist_id, playlist_name,
//     tracks: [{ id, title, artists_text, artists: [{id, name, spotify_url,
//                image_url}], image_url, song_link_url, spotify_url,
//                duration_ms, preview_url, is_explicit }] }
//
// force-refresh with /rn/tracks?bust=<RN_BUST_SECRET>.
// Spotify scrape identifies itself as AadharshBot (see ── AadharshBot ──
// section below). prior versions sent a fake Chrome UA; switching to the
// branded UA keeps Spotify's logs honest about who's hitting their public
// embed pages, and matches the policy used by the /around crawler. the
// embed pages are public + cacheable, so UA shouldn't affect what's served.
const RN_TRACKS_TTL  = 3600;            // 1h: playlist tracks payload
const ARTIST_KV_TTL  = 30 * 86400;      // 30d: artist profile (rarely changes)

async function handleRnTracks(request, env, ctx) {
  const url = new URL(request.url);

  if (!env.RN_KV) {
    return jsonResp({ error: "no kv binding" }, 500);
  }
  const playlistId = await env.RN_KV.get("playlist-id");
  if (!playlistId || !/^[0-9A-Za-z]{22}$/.test(playlistId)) {
    return jsonResp({ error: "no playlist set", tracks: [] });
  }

  const cacheKey = `tracks:${playlistId}`;

  // optional bust
  if (env.RN_BUST_SECRET && url.searchParams.get("bust") === env.RN_BUST_SECRET) {
    await env.RN_KV.delete(cacheKey);
  }

  // serve from cache
  const cached = await env.RN_KV.get(cacheKey, "json");
  if (cached) return jsonResp(cached);

  // fetch + parse
  let payload;
  try {
    payload = await scrapePlaylistTracks(playlistId, env, ctx);
  } catch (e) {
    return jsonResp({ error: "scrape failed", message: String(e), tracks: [] }, 502);
  }

  // fire-and-forget cache write
  ctx.waitUntil(env.RN_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: RN_TRACKS_TTL }));

  return jsonResp(payload);
}

async function scrapePlaylistTracks(playlistId, env, ctx) {
  // tier 1: playlist embed → ordered track list
  const playlistEntity = await scrapeSpotifyEmbed(`playlist/${playlistId}`);
  const trackList = Array.isArray(playlistEntity.trackList) ? playlistEntity.trackList : [];

  const baseTracks = trackList
    .filter(t => t && typeof t.uri === "string" && t.uri.startsWith("spotify:track:"))
    .map(t => {
      const id = t.uri.slice("spotify:track:".length);
      return {
        id,
        title:         t.title    || "",
        artists_text:  t.subtitle || "",   // raw "A, B" string kept for back-compat
        spotify_url:   `https://open.spotify.com/track/${id}`,
        song_link_url: `https://song.link/s/${id}`,
        duration_ms:   typeof t.duration === "number" ? t.duration : null,
        preview_url:   t.audioPreview?.url || null,
        is_explicit:   !!t.isExplicit,
      };
    });

  // tier 2: per-track embed → cover image URL + structured artist list.
  // ONE fetch per track replaces the prior playlist-embed + oEmbed pair
  // (oEmbed only returned the cover; the track embed returns cover + the
  // artist URIs we need for the artist-hover feature).
  const enriched = await Promise.all(baseTracks.map(async t => {
    try {
      const e = await scrapeSpotifyEmbed(`track/${t.id}`);
      const image_url = e?.visualIdentity?.image?.[0]?.url || null;
      const artists = Array.isArray(e?.artists)
        ? e.artists
            .filter(a => a && typeof a.uri === "string" && a.uri.startsWith("spotify:artist:"))
            .map(a => {
              const id = a.uri.slice("spotify:artist:".length);
              return {
                id,
                name:        a.name || "",
                spotify_url: `https://open.spotify.com/artist/${id}`,
                image_url:   null,    // filled in tier 3 below
              };
            })
        : [];
      return { ...t, image_url, artists };
    } catch {
      return { ...t, image_url: null, artists: [] };
    }
  }));

  // tier 3: per-unique-artist embed → profile picture. cached in KV
  // under `artist:<id>` for ARTIST_KV_TTL because artist photos rarely
  // change. cache hit → no network. cache miss → scrape + write back.
  const uniqueArtists = new Map();
  for (const t of enriched) {
    for (const a of (t.artists || [])) {
      if (!uniqueArtists.has(a.id)) uniqueArtists.set(a.id, a);
    }
  }
  await Promise.all([...uniqueArtists.values()].map(async a => {
    const cacheKey = `artist:${a.id}`;
    if (env?.RN_KV) {
      const hit = await env.RN_KV.get(cacheKey, "json");
      if (hit && typeof hit === "object") {
        a.image_url = hit.image_url || null;
        if (hit.name && !a.name) a.name = hit.name;
        return;
      }
    }
    try {
      const e = await scrapeSpotifyEmbed(`artist/${a.id}`);
      // pick the 320px variant: tooltip renders at 180×180, so 320 source
      // gives a crisp retina-ready image without paying the 640px hero
      // weight. fall through to whatever's first if no 320 variant exists.
      const imgs = Array.isArray(e?.visualIdentity?.image) ? e.visualIdentity.image : [];
      const pick = imgs.find(i => i.maxWidth === 320) || imgs.find(i => i.maxWidth === 160) || imgs[0] || null;
      a.image_url = pick?.url || null;
      if (e?.name && !a.name) a.name = e.name;
      if (env?.RN_KV && ctx) {
        ctx.waitUntil(env.RN_KV.put(cacheKey, JSON.stringify({
          name: a.name, image_url: a.image_url
        }), { expirationTtl: ARTIST_KV_TTL }));
      }
    } catch {
      a.image_url = null;
    }
  }));

  // copy enriched artist data back onto every track (the per-track .artists
  // arrays share Map references but Promise.all parallelism means we need
  // to re-derive image_url after the artist loop resolves)
  for (const t of enriched) {
    t.artists = (t.artists || []).map(a => ({
      ...a,
      image_url: uniqueArtists.get(a.id)?.image_url || null,
      name:      uniqueArtists.get(a.id)?.name || a.name,
    }));
  }

  return {
    playlist_id:   playlistId,
    playlist_name: playlistEntity.name || "rn",
    tracks:        enriched,
    fetched_at:    new Date().toISOString(),
  };
}

// shared Spotify embed scraper. fetches https://open.spotify.com/embed/<kind>/<id>
// where kind is "playlist" | "track" | "artist", parses the SSR'd __NEXT_DATA__
// blob, and returns the top-level entity. used by tiers 1-3 above.
// cf.cacheTtl gives us automatic Cloudflare edge caching per URL so concurrent
// playlist refreshes don't multiply the upstream load.
//
// retry behavior: a small fraction of track embeds were returning HTML that
// parses but lacks visualIdentity/artists (Spotify treating CF egress IPs
// differently? regional A/B test? unclear). worse, the bad response gets
// cached at the CF edge for 24h because of cacheEverything+cacheTtl above,
// so the bad state sticks across worker invocations. on a failed extraction
// (parse error OR missing both visualIdentity and artists), retry once
// with cacheTtl: 0 + a cache-busting query param to force a fresh fetch.
async function scrapeSpotifyEmbed(kindAndId) {
  const tryOnce = async (bustCache) => {
    const qs = bustCache ? `?_t=${Date.now()}` : "";
    const res = await fetch(`https://open.spotify.com/embed/${kindAndId}${qs}`, {
      headers: {
        "user-agent":      BOT_UA,        // honest: identifies as AadharshBot
        "accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
      cf: bustCache
        ? { cacheTtl: 0, cacheEverything: false }     // bypass CF cache
        : { cacheTtl: 86400, cacheEverything: true }, // 24h CF edge cache (normal path)
    });
    if (!res.ok) throw new Error(`embed ${kindAndId}: ${res.status}`);
    const html = await res.text();
    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error(`no __NEXT_DATA__ in ${kindAndId}`);
    const data = JSON.parse(m[1]);
    return data?.props?.pageProps?.state?.data?.entity || {};
  };

  // first attempt: normal CF-cached path
  let entity = null;
  try {
    entity = await tryOnce(false);
  } catch (_e) {
    // fall through to retry
  }

  // if the entity is empty-ish on a track / artist fetch (no name AND no
  // visualIdentity), it's almost certainly a bad cached response — retry
  // once bypassing CF's edge cache. cheap to test, expensive to be wrong.
  const looksEmpty = !entity || (
    !entity.name &&
    !entity.visualIdentity &&
    !(Array.isArray(entity.artists) && entity.artists.length) &&
    !(Array.isArray(entity.trackList) && entity.trackList.length)
  );
  if (looksEmpty) {
    entity = await tryOnce(true);
  }
  return entity || {};
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type":  "application/json; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=600",
      "access-control-allow-origin": "*",
    },
  });
}

// ── AadharshBot ─────────────────────────────────────────────────────
// branded crawler. uses our own UA + signs every outbound request per
// RFC 9421 (HTTP Message Signatures), profile per the Web Bot Auth IETF
// draft. signatures cover @authority + signature-agent; receiving sites
// can fetch the JWKS at https://aadhar.sh/.well-known/http-message-signatures-directory
// and verify against the published Ed25519 public key.

const BOT_NAME    = "AadharshBot";
const BOT_VERSION = "1.0";
const BOT_UA      = `${BOT_NAME}/${BOT_VERSION} (+https://aadhar.sh/bot)`;
const SIG_AGENT   = "https://aadhar.sh/";  // Signature-Agent value (RFC 8941 string)

// the neighborhood — crypto-VC homepages worth checking in on. just funds
// whose work i follow; the dashboard is mostly an excuse to point a branded
// crawler at something interesting.
const NEIGHBORS = [
  { name: "Paradigm",                url: "https://www.paradigm.xyz/" },
  { name: "a16z crypto",             url: "https://a16zcrypto.com/" },
  { name: "Polychain Capital",       url: "https://polychain.capital/" },
  { name: "Multicoin Capital",       url: "https://multicoin.capital/" },
  { name: "Variant Fund",            url: "https://variant.fund/" },
  { name: "Dragonfly",               url: "https://www.dragonfly.xyz/" },
  { name: "Electric Capital",        url: "https://www.electriccapital.com/" },
  { name: "1confirmation",           url: "https://1confirmation.com/" },
  { name: "Standard Crypto",         url: "https://standardcrypto.vc/" },
  { name: "Union Square Ventures",   url: "https://www.usv.com/" },
  { name: "Archetype",               url: "https://www.archetype.fund/" },
  { name: "Pace Capital",            url: "https://pacecapital.com/" },
  { name: "Thrive Capital",          url: "https://thrivecap.com/" },
  { name: "Sequoia Capital",         url: "https://www.sequoiacap.com/" },
  { name: "Founders Fund",           url: "https://foundersfund.com/" },
  { name: "Hummingbird",             url: "https://www.hummingbird.vc/" },
  { name: "Benchmark",               url: "https://www.benchmark.com/" },
  { name: "Index Ventures",          url: "https://www.indexventures.com/" },
  { name: "Ribbit Capital",          url: "https://ribbitcap.com/" },
  { name: "Topology",                url: "https://www.topology.vc/" },
];

// signed outbound fetch. always sets our UA. signs when the private key is
// available; falls back to UA-only fetch if signing fails (better to crawl
// unsigned than to silently break).
async function signedFetch(targetUrl, env, opts = {}) {
  const headers = new Headers(opts.headers || {});
  headers.set("user-agent", BOT_UA);
  if (!headers.has("accept")) {
    headers.set("accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  }
  if (!headers.has("accept-language")) {
    headers.set("accept-language", "en-US,en;q=0.9");
  }

  if (env.RN_SIGNING_KEY_JWK) {
    try {
      const sig = await signRequestForWebBotAuth(targetUrl, env);
      headers.set("Signature-Agent", `"${SIG_AGENT}"`);
      headers.set("Signature-Input", `sig1=${sig.params}`);
      headers.set("Signature", `sig1=:${sig.b64}:`);
    } catch (_e) {
      // keep going; recipient just won't be able to verify
    }
  }

  return fetch(targetUrl, {
    method: opts.method || "GET",
    headers,
    redirect: opts.redirect || "follow",
    cf: { cacheTtl: 0 },  // we cache at the application layer
  });
}

// build + sign a Web Bot Auth signature over (@authority, signature-agent).
async function signRequestForWebBotAuth(targetUrl, env) {
  const u = new URL(targetUrl);
  const jwk = JSON.parse(env.RN_SIGNING_KEY_JWK);
  const keyId = jwk.kid || "rn";
  const cryptoKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "Ed25519" }, false, ["sign"]
  );

  const created = Math.floor(Date.now() / 1000);
  const params  = `("@authority" "signature-agent");created=${created};keyid="${keyId}";alg="ed25519";tag="web-bot-auth"`;

  // RFC 9421 signature base: one component per line, then @signature-params.
  const base = [
    `"@authority": ${u.host}`,
    `"signature-agent": "${SIG_AGENT}"`,
    `"@signature-params": ${params}`,
  ].join("\n");

  const sigBytes = new Uint8Array(await crypto.subtle.sign(
    "Ed25519", cryptoKey, new TextEncoder().encode(base)
  ));
  // structured-fields binary content: base64 (with padding), wrapped in colons by caller
  let bin = "";
  for (let i = 0; i < sigBytes.length; i++) bin += String.fromCharCode(sigBytes[i]);
  const b64 = btoa(bin);

  return { params, b64 };
}

// ── /around ─────────────────────────────────────────────────────────
// what's going on in the crypto-VC neighborhood. each homepage fetched live
// by AadharshBot (or served from a 1hr KV cache). curious, not competitive.
async function handleAround(request, env, ctx) {
  const report = await getOrBuildAroundReport(request, env, ctx);
  return new Response(renderAroundHtml(report), {
    headers: {
      "content-type":  "text/html; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300",
      "x-robots-tag":  "noindex",
    },
  });
}
async function handleAroundJson(request, env, ctx) {
  const report = await getOrBuildAroundReport(request, env, ctx);
  return new Response(JSON.stringify(report, null, 2), {
    headers: {
      "content-type":  "application/json; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300",
      "x-robots-tag":  "noindex",
    },
  });
}

async function getOrBuildAroundReport(request, env, ctx) {
  const CACHE_KEY = "around:report";
  const url = new URL(request.url);

  // optional bust for force-refresh
  if (env.RN_BUST_SECRET && url.searchParams.get("bust") === env.RN_BUST_SECRET) {
    if (env.RN_KV) await env.RN_KV.delete(CACHE_KEY);
  }

  if (env.RN_KV) {
    const cached = await env.RN_KV.get(CACHE_KEY, "json");
    if (cached) return cached;
  }

  const report = await runAround(env);
  if (env.RN_KV) {
    ctx.waitUntil(env.RN_KV.put(CACHE_KEY, JSON.stringify(report), { expirationTtl: 3600 }));
  }
  return report;
}

async function runAround(env) {
  const results = await Promise.all(NEIGHBORS.map(async ({ name, url }) => {
    const t0 = Date.now();
    try {
      const res = await signedFetch(url, env, {});
      // some sites return 100MB+ — cap the body we read.
      const reader = res.body?.getReader();
      let body = "";
      let received = 0;
      const CAP = 200 * 1024;  // 200 KB plenty for <head>
      if (reader) {
        const dec = new TextDecoder();
        while (received < CAP) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          body += dec.decode(value, { stream: true });
        }
        try { await reader.cancel(); } catch {}
      }
      const elapsed = Date.now() - t0;
      return {
        name, url,
        status:        res.status,
        title:         extractTitle(body),
        description:   extractMeta(body, "description") || extractMeta(body, "og:description") || "",
        ogImage:       extractMeta(body, "og:image") || "",
        server:        res.headers.get("server") || "",
        lastModified:  res.headers.get("last-modified") || "",
        contentType:   res.headers.get("content-type") || "",
        elapsedMs:     elapsed,
      };
    } catch (e) {
      return { name, url, error: String(e?.message || e), elapsedMs: Date.now() - t0 };
    }
  }));
  // sort fastest → slowest; errors (no latency or huge values) fall to the
  // bottom so the table reads as a leaderboard.
  results.sort((a, b) => {
    const an = a.error ? Infinity : (a.elapsedMs ?? Infinity);
    const bn = b.error ? Infinity : (b.elapsedMs ?? Infinity);
    return an - bn;
  });
  return {
    crawledBy: BOT_UA,
    crawledAt: new Date().toISOString(),
    signedWith: SIG_AGENT,
    count:     results.length,
    results,
  };
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].trim()).slice(0, 200) : "";
}
function extractMeta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re);
  return m ? decodeEntities(m[1].trim()).slice(0, 240) : "";
}
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

// shared XP window chrome for the server-rendered pages (/around, /bot,
// /whoareyou, /rn/set). these four used to each carry their own copy of
// the body gradient + window panel + title-bar + traffic-cone icon +
// boxed controls + content padding — identical declarations save for the
// window max-width. a chrome tweak meant editing four places (which is
// how the /whoareyou and /bot h2 rules drifted apart earlier). this is
// the one shared source; page-specific rules (h1 sizes, tables, field
// grids, the whoareyou title-text + control spacing) stay inline per
// page after the call. only max-width is parameterized.
function xpChromeCss(maxWidth) {
  return `
  * { box-sizing: border-box; }
  /* first-paint background is the Bliss desktop tone on the ROOT (html) too —
     the cross-document View-Transition freezes the root group, so if html were
     white you'd get a frame of white flash before nav.js paints the real desktop.
     matching html+body to the Bliss gradient kills that flash. */
  html, body {
    background: linear-gradient(180deg, oklch(56% 0.13 250) 0%, oklch(73% 0.10 236) 50%, oklch(88% 0.05 232) 60%, oklch(60% 0.16 140) 100%);
  }
  body {
    font-family: Tahoma, Verdana, Geneva, sans-serif;
    font-size: 10.5pt; line-height: 1.5; color: oklch(21.78% 0 0);
    margin: 0; padding: 24px 12px 60px; min-height: 100vh;
  }
  .window {
    max-width: ${maxWidth}px; margin: 0 auto; background: oklch(100.00% 0 0);
    border: 1px solid oklch(61.14% 0.0611 253.60); box-shadow: 4px 4px 0 oklch(61.14% 0.0611 253.60 / 0.35);
  }
  .title-bar {
    background: linear-gradient(180deg, oklch(70% 0.15 258) 0%, oklch(60% 0.20 261) 8%, oklch(51% 0.225 263) 18%, oklch(50% 0.225 263) 86%, oklch(58% 0.18 260) 100%);
    color: oklch(100.00% 0 0); font-family: "Trebuchet MS", Verdana, Geneva, sans-serif;
    font-size: 10pt; font-weight: bold; padding: 4px 8px;
    border-bottom: 1px solid oklch(41.92% 0.0962 250.51); display: flex;
    align-items: center; justify-content: space-between;
    text-box-trim: trim-both; text-box-edge: cap alphabetic;
  }
  .title-bar .icon { display: inline-block; width: 16px; height: 16px; margin-right: 6px; background: oklch(69.58% 0.2043 43.49); position: relative; flex-shrink: 0; }
  .title-bar .icon::before { content: ""; position: absolute; inset: 2px 4px; background: oklch(87.82% 0.0877 66.27); clip-path: polygon(50% 0, 100% 100%, 0 100%); }
  .title-bar .controls { display: flex; align-items: center; gap: 2px; letter-spacing: 0; }
/* authentic Luna caption buttons: 21x21 glossy "gel" lozenges with a top specular
   highlight + CSS-drawn white glyphs (no text, no images). min/max are blue, CLOSE
   is RED at rest. CLASS-BASED (.min/.max/.close) so decorative demo windows that use
   <span class="close"> get the identical skin as a real <a class="close">. sRGB hex
   traced from the Luna .msstyles bitmap, kept as hex on purpose. */
.title-bar .controls .min,
.title-bar .controls .max,
.title-bar .controls .close {
  position: relative; box-sizing: border-box;
  width: 21px; height: 21px; padding: 0; margin: 0;
  display: inline-block; overflow: hidden; font-size: 0; color: transparent;
  border: 1px solid #6696eb; border-radius: 3px;
  text-decoration: none; cursor: pointer;
  background-color: #3e73f5;
  background-image: linear-gradient(180deg, #5f8cf7 0%, #3a71f5 22%, #3e73f5 55%, #2a70f2 82%, #1045be 100%);
  transition: filter 60ms ease-out;
}
/* "wet plastic" gloss band over the top ~45% (close uses ::after for its X stroke) */
.title-bar .controls .min::after,
.title-bar .controls .max::after {
  content: ""; position: absolute; left: 0; right: 0; top: 0; height: 45%;
  background: linear-gradient(180deg, rgba(255,255,255,.55) 0%, rgba(255,255,255,.12) 70%, rgba(255,255,255,0) 100%);
  pointer-events: none; border-radius: 2px 2px 5px 5px;
}
.title-bar .controls .min:hover, .title-bar .controls .min:focus-visible,
.title-bar .controls .max:hover, .title-bar .controls .max:focus-visible {
  border-color: #8fb4ff; background-color: #4fa4ff;
  background-image: linear-gradient(180deg, #689bff 0%, #468aff 22%, #4fa4ff 55%, #3990fc 82%, #1858c8 100%);
  outline: none;
}
/* CLOSE = red at rest */
.title-bar .controls .close {
  border-color: #d8401c; background-color: #e45f3e;
  background-image: linear-gradient(180deg, #e8795f 0%, #e45f40 30%, #e45d3d 52%, #e2552a 80%, #ae3110 100%);
}
.title-bar .controls .close:hover, .title-bar .controls .close:focus-visible {
  border-color: #ff7a66; background-color: #ff957c;
  background-image: linear-gradient(180deg, #ff8b7d 0%, #ff7463 26%, #ff957c 55%, #fd7e64 82%, #d34936 100%);
  box-shadow: 0 0 4px rgba(255,120,96,.7); outline: none;
}
.title-bar .controls .min:active,
.title-bar .controls .max:active,
.title-bar .controls .close:active { filter: brightness(.9); }
/* white glyphs drawn with pseudo-elements */
.title-bar .controls .min::before {
  content: ""; position: absolute; left: 5px; right: 5px; bottom: 5px; height: 2px;
  background: #fff; box-shadow: 0 1px 0 rgba(0,0,0,.35);
}
.title-bar .controls .max::before {
  content: ""; position: absolute; left: 5px; top: 5px; width: 11px; height: 9px;
  box-sizing: border-box; border: 1px solid #fff; border-top-width: 2px;
  filter: drop-shadow(0 1px 0 rgba(0,0,0,.35));
}
.title-bar .controls .close::before,
.title-bar .controls .close::after {
  content: ""; position: absolute; left: 50%; top: 50%;
  width: 13px; height: 2px; margin: -1px 0 0 -6.5px; background: #fff;
  box-shadow: 0 1px 0 rgba(0,0,0,.35);
}
.title-bar .controls .close::before { transform: rotate(45deg); }
.title-bar .controls .close::after  { transform: rotate(-45deg); }
/* --- Luna polish: caption text shadow + rounded top corners + 3px window frame --- */
.title-bar { text-shadow: 1px 1px #0f1089; border-top-left-radius: 8px; border-top-right-radius: 8px; }
.window {
  border: 2px solid #0831d9; border-right-color: #001ea0; border-bottom-color: #001ea0;
  border-top-left-radius: 8px; border-top-right-radius: 8px; overflow: hidden;
  box-shadow: inset 1px 1px 0 #166aee, inset 2px 2px 0 #0855dd,
              inset -1px -1px 0 #00138c, inset -2px -2px 0 #003bda,
              4px 4px 0 rgba(0,30,160,.35);
}
/* reusable Luna command button + sunken field (used by the /rn form) */
.xp-button {
  display: inline-block; min-width: 75px; padding: 3px 12px;
  font: 8pt/1.4 Tahoma, Verdana, Geneva, sans-serif; color: #000;
  text-align: center; text-decoration: none; cursor: pointer; user-select: none;
  border: 1px solid #8e9dad; border-radius: 3px;
  background: linear-gradient(180deg, #ffffff 0%, #fdfdfd 45%, #f4f3ee 55%, #eceae0 100%);
  box-shadow: inset 0 0 0 1px #ffffff, 0 0 0 1px rgba(255,255,255,.4);
}
.xp-button:hover { border-color: #e9994a; box-shadow: inset 0 0 0 1px #fdd78b, 0 0 3px 1px rgba(255,199,60,.55); }
.xp-button.default, .xp-button:focus-visible {
  border-color: #003c74; outline: none;
  box-shadow: inset 0 0 0 1px #ffffff, 0 0 0 1px #2c628b, 0 0 3px 1px rgba(44,98,139,.45);
}
.xp-button:active {
  background: linear-gradient(180deg, #e1e1d8 0%, #e9e8e0 50%, #f0efe8 100%);
  border-color: #7b9ebd; padding: 4px 11px 2px 13px;
  box-shadow: inset 1px 1px 2px rgba(181,178,164,.9), inset -1px -1px 0 rgba(255,255,255,.5);
}
.xp-input {
  box-sizing: border-box; width: 100%;
  font-family: Tahoma, Verdana, Geneva, sans-serif; font-size: 10.5pt;
  color: #181818; background: #ffffff; padding: 3px 6px; border-radius: 0;
  border: 1px solid #7f9db9; box-shadow: inset 1px 1px 0 rgba(0,0,0,.20), inset -1px -1px 0 #ffffff;
}
.xp-input:focus { outline: none; border-color: #316ac5; box-shadow: inset 1px 1px 0 rgba(0,0,0,.20), inset -1px -1px 0 #ffffff, 0 0 0 1px #316ac5; }
  html { scrollbar-color: oklch(62% 0.14 255) oklch(91% 0.02 248); }
  .content { padding: 12px 16px 16px; }
`;
}

function renderAroundHtml(report) {
  const rows = report.results.map((r, i) => {
    const ok = !r.error && r.status >= 200 && r.status < 400;
    const status = r.error
      ? `<span class="bad">error</span>`
      : ok
        ? `<span class="ok">${r.status}</span>`
        : `<span class="warn">${r.status}</span>`;
    const titleCol = r.error ? esc(r.error) : (esc(r.title) || "<span class=dim>—</span>");
    const desc = r.description ? `<div class="desc">${esc(r.description)}</div>` : "";
    return `
      <tr>
        <td class="firm">${esc(r.name)}<div class="host">${esc(new URL(r.url).host)}</div></td>
        <td class="status">${status}</td>
        <td class="title">${titleCol}${desc}</td>
        <td class="latency">${r.elapsedMs}ms</td>
        <td class="link"><a href="${esc(r.url)}" target="_blank" rel="noopener">↗</a></td>
      </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aadhar.sh/around</title>
<meta name="description" content="Snapshot of crypto VC homepages I keep tabs on, crawled live by AadharshBot.">
<meta name="robots" content="noindex">
<style>
${xpChromeCss(820)}
  h1 {
    font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; color: oklch(41.92% 0.0962 250.51);
    font-size: 18pt; margin: 0 0 4px; font-weight: bold;
  }
  .lede { margin: 0 0 14px; color: oklch(38.67% 0 0); font-size: 10.5pt; }
  .lede code { font-family: "Courier New", Courier, monospace; background: oklch(96.72% 0 0); border: 1px solid oklch(88.22% 0 0); padding: 0 3px; font-size: 10pt; }
  table.scout {
    width: 100%; border-collapse: collapse; margin: 8px 0 12px;
    border: 1px solid oklch(61.14% 0.0611 253.60); border-top-color: oklch(47.12% 0.0555 253.58); border-left-color: oklch(47.12% 0.0555 253.58);
    background: oklch(100.00% 0 0); font-size: 10pt;
  }
  table.scout thead th {
    background: oklch(94.66% 0.0114 252.09); color: oklch(41.92% 0.0962 250.51); font-weight: bold;
    padding: 5px 8px; text-align: left;
    border-bottom: 1px solid oklch(61.14% 0.0611 253.60);
    font-family: "Trebuchet MS", Verdana, Geneva, sans-serif;
  }
  table.scout tbody td { padding: 6px 8px; border-bottom: 1px solid oklch(92.73% 0.0139 247.98); vertical-align: top; }
  table.scout tbody tr:nth-child(even) td { background: oklch(97.50% 0.0062 255.47); }
  table.scout .firm { font-weight: bold; color: oklch(41.92% 0.0962 250.51); width: 22%; }
  table.scout .host { font-family: "Courier New", Courier, monospace; color: oklch(62.68% 0 0); font-size: 9pt; font-weight: normal; }
  table.scout .status { font-family: "Courier New", Courier, monospace; width: 8%; text-align: center; }
  table.scout .ok   { color: oklch(49.32% 0.1678 142.50); font-weight: bold; }
  table.scout .warn { color: oklch(54.44% 0.1504 47.10); font-weight: bold; }
  table.scout .bad  { color: oklch(46.34% 0.1902 29.23); font-weight: bold; }
  table.scout .title { color: oklch(21.78% 0 0); }
  table.scout .desc { color: oklch(51.03% 0 0); font-size: 9.5pt; margin-top: 3px; }
  table.scout .latency { font-family: "Courier New", Courier, monospace; color: oklch(38.67% 0 0); width: 9%; text-align: right; }
  table.scout .link { width: 5%; text-align: center; }
  table.scout .link a { color: oklch(42.61% 0.2353 263.74); text-decoration: none; font-weight: bold; }
  table.scout .link a:hover { color: oklch(62.80% 0.2577 29.23); text-decoration: underline; }
  .meta {
    font-size: 9.5pt; color: oklch(51.03% 0 0);
    border: 1px solid oklch(61.14% 0.0611 253.60); background: oklch(98.81% 0.0263 99.90);
    padding: 6px 10px; margin: 12px 0;
  }
  .meta code { font-family: "Courier New", Courier, monospace; background: oklch(100.00% 0 0); border: 1px solid oklch(89.75% 0 0); padding: 0 3px; }
  footer { text-align: center; font-size: 9pt; color: oklch(44.95% 0 0); margin-top: 14px; padding-top: 10px; border-top: 1px solid oklch(86.67% 0.0294 259.59); }
  a { color: oklch(42.61% 0.2353 263.74); }
  .dim { color: oklch(62.68% 0 0); }
  hr { border: 0; border-top: 2px groove oklch(86.67% 0.0294 259.59); margin: 12px 0; height: 0; }
</style>
</head><body>
<div class="window">
  <div class="title-bar">
    <span><span class="icon"></span>aadhar.sh/around</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="/" title="back to aadhar.sh" aria-label="back to aadhar.sh"></a></span>
  </div>
  <div class="content">
    <h1>Around the Neighborhood</h1>
    <p class="lede">
      A peek at what folks in crypto VC are up to. Each homepage fetched live
      by <code>${esc(BOT_UA)}</code> — the small branded crawler I run from
      this site — and laid out as a tiny neighborhood window. Mostly an excuse
      to play with signed outbound requests per
      <a href="https://datatracker.ietf.org/wg/webbotauth/about/" target="_blank" rel="noopener">Web Bot Auth</a>;
      the shortlist is just funds whose work I follow. Receiving sites can
      verify the signatures against
      <a href="/.well-known/http-message-signatures-directory">our JWKS</a>.
    </p>
    <div class="meta">
      <strong>Last crawl:</strong> ${esc(report.crawledAt)} &middot;
      <strong>UA:</strong> <code>${esc(BOT_UA)}</code> &middot;
      <strong>Signature-Agent:</strong> <code>${esc(SIG_AGENT)}</code> &middot;
      <strong>Cache:</strong> 1 hour
    </div>
    <table class="scout">
      <thead>
        <tr><th>Firm</th><th>Status</th><th>Title / description</th><th>Latency</th><th>↗</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <hr>
    <p class="dim" style="font-size:9pt">
      Also available as JSON: <a href="/around/json">/around/json</a>.
      Bot methodology and ethics: <a href="/bot">/bot</a>.
    </p>
    <footer>
      &larr; <a href="/">aadhar.sh</a> &middot; crawled by <a href="/bot">${esc(BOT_NAME)}</a>
    </footer>
  </div>
</div>
  <script src="/nav.js" defer></script>
</body></html>`;
}

// ── /bot info page ──────────────────────────────────────────────────
function handleBotPage(request) {
  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aadhar.sh/bot</title>
<meta name="description" content="Identity and behavior of AadharshBot, the crawler operated by aadhar.sh.">
<style>
${xpChromeCss(660)}
  h1 { font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; font-size: 14pt; color: oklch(41.92% 0.0962 250.51); margin: 0 0 4px; font-weight: bold; }
  h2 { font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; font-size: 12pt; color: oklch(41.92% 0.0962 250.51); margin: 16px 0 6px; font-weight: bold; line-height: 1.3; }
  h2::after { content: ""; display: block; height: 1px; background: oklch(86.67% 0.0294 259.59); margin-top: 8px; }
  a:link { color: oklch(42.61% 0.2353 263.74); text-decoration: underline; } a:visited { color: oklch(42.09% 0.1935 328.36); } a:hover { color: oklch(62.80% 0.2577 29.23); }
  code { font-family: "Courier New", Courier, monospace; background: oklch(96.72% 0 0); border: 1px solid oklch(88.22% 0 0); padding: 0 3px; }
  .lede { color: oklch(38.67% 0 0); font-size: 10.5pt; margin: 0 0 12px; }
  dl.fields { display: grid; grid-template-columns: 11em 1fr; gap: 1px; margin: 4px 0 14px; background: oklch(85.04% 0.0283 248.16); border: 1px solid oklch(61.14% 0.0611 253.60); border-top-color: oklch(47.12% 0.0555 253.58); border-left-color: oklch(47.12% 0.0555 253.58); font-size: 10pt; }
  dl.fields dt { background: oklch(94.66% 0.0114 252.09); color: oklch(41.92% 0.0962 250.51); font-weight: bold; padding: 4px 8px; }
  dl.fields dd { background: oklch(100.00% 0 0); margin: 0; padding: 4px 8px; font-family: "Courier New", Courier, monospace; font-size: 9.5pt; word-break: break-all; }
  footer { text-align: center; font-size: 9pt; color: oklch(44.95% 0 0); margin-top: 16px; padding-top: 10px; border-top: 1px solid oklch(86.67% 0.0294 259.59); }
</style>
</head><body>
<div class="window">
  <div class="title-bar">
    <span><span class="icon"></span>${BOT_NAME}</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="/" title="back to aadhar.sh" aria-label="back to aadhar.sh"></a></span>
  </div>
  <div class="content">
    <h1>${BOT_NAME}</h1>
    <p class="lede">
      A small, transparent crawler operated by <a href="/">aadhar.sh</a>. If you see it
      in your access logs, this page tells you who it is, what it does, and how to
      stop it from visiting if you don't want it to.
    </p>

    <h2>Identity</h2>
    <dl class="fields">
      <dt>User-Agent</dt><dd>${esc(BOT_UA)}</dd>
      <dt>Signature-Agent</dt><dd>${esc(SIG_AGENT)}</dd>
      <dt>JWKS</dt><dd><a href="/.well-known/http-message-signatures-directory">/.well-known/http-message-signatures-directory</a></dd>
      <dt>Algorithm</dt><dd>Ed25519 (EdDSA), per RFC 9421 + Web Bot Auth draft</dd>
      <dt>Operator</dt><dd><!--email_off--><a href="mailto:coffee@aadhar.sh">coffee@aadhar.sh</a><!--/email_off--></dd>
    </dl>

    <h2>What it does</h2>
    <p>
      Fetches small numbers of public homepages on demand, mostly for personal
      curiosity — see the <a href="/around">/around</a> dashboard for what it
      currently looks at.
      Reads only what's publicly served. Respects <code>robots.txt</code>. Does not
      submit forms, log in, or scrape behind authentication. Caches results in
      Cloudflare KV for at least an hour so it doesn't re-hit the same URL repeatedly.
    </p>

    <h2>How to verify it's really ${BOT_NAME}</h2>
    <p>
      Every request includes <code>Signature-Agent</code>, <code>Signature-Input</code>,
      and <code>Signature</code> headers per
      <a href="https://www.rfc-editor.org/rfc/rfc9421" target="_blank" rel="noopener">RFC 9421</a>
      with the Web Bot Auth profile (<code>tag="web-bot-auth"</code>). Fetch the JWKS
      at the URL above, find the key with the matching <code>kid</code>, and verify the
      Ed25519 signature over the canonical components listed in <code>Signature-Input</code>.
      If the verification fails, the request is not from this site.
    </p>

    <h2>How to opt out</h2>
    <p>Add to your <code>robots.txt</code>:</p>
    <pre><code>User-agent: ${BOT_NAME}
Disallow: /</code></pre>
    <p>
      ${BOT_NAME} reads <code>robots.txt</code> on every cold cache hit and obeys
      <code>Disallow</code> rules. If you have a question or a complaint, email
      <!--email_off--><a href="mailto:coffee@aadhar.sh">coffee@aadhar.sh</a><!--/email_off--> and I'll reply by hand.
    </p>

    <footer>
      &larr; <a href="/">aadhar.sh</a> &middot;
      see it in action: <a href="/around">/around</a> &middot;
      &copy; 2026 Aadharsh Pannirselvam
    </footer>
  </div>
</div>
  <script src="/nav.js" defer></script>
</body></html>`;

  return new Response(html, {
    headers: {
      "content-type":  "text/html; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  });
}

// ── /rn/admin handler ───────────────────────────────────────────────
// renders the bookmark-friendly form. requires ?secret=<RN_BUST_SECRET>.
// the form posts to /rn/set so the actual write logic stays in one place.
async function handleRnAdmin(request, env) {
  const url = new URL(request.url);
  const secret = url.searchParams.get("secret") || "";

  if (!env.RN_BUST_SECRET || !timingSafeEqual(secret, env.RN_BUST_SECRET)) {
    return setPage(403, "denied", "wrong secret. check the bookmark.");
  }

  // show current target so you can tell at a glance what /rn points to.
  let current = "(empty — using fallback)";
  if (env.RN_KV) {
    const id = await env.RN_KV.get("playlist-id");
    if (id) current = `<a href="https://open.spotify.com/playlist/${esc(id)}" target="_blank" rel="noopener">open.spotify.com/playlist/${esc(id)}</a>`;
  }

  const body = `
    <p><strong>Currently:</strong><br>${current}</p>
    <form method="POST" action="/rn/set" autocomplete="off" style="margin-top:14px">
      <input type="hidden" name="secret" value="${esc(secret)}">
      <label for="u" style="display:block;font-weight:bold;color:oklch(41.92% 0.0962 250.51);margin-bottom:4px">New playlist URL:</label>
      <input id="u" name="url" type="text" placeholder="https://open.spotify.com/playlist/..." autofocus class="xp-input" style="font-family:'Courier New',monospace">
      <p style="margin-top:10px">
        <button type="submit" class="xp-button default">
          Update /rn
        </button>
      </p>
    </form>
    <p style="margin-top:18px;color:oklch(51.03% 0 0);font-size:9.5pt">
      <em>Tip:</em> on Spotify desktop, right-click the playlist &rarr; Share &rarr;
      Copy link to playlist, then paste here.
    </p>`;
  return setPage(200, "update /rn", body);
}

// ── /rn/set handler ─────────────────────────────────────────────────
// the actual write endpoint. accepts inputs from three places:
//   GET  /rn/set?secret=...&url=...   (shortcuts, bookmarks, curl)
//   POST /rn/set  with secret+url in form-encoded body  (the admin form)
//   POST /rn/set  with secret+url as JSON               (programmatic)
// returns the same tiny period-correct confirmation page in all cases.
async function handleRnSet(request, env) {
  const url = new URL(request.url);
  const params = await readParams(request, url);
  const secret = params.get("secret") || "";
  const target = params.get("url")    || "";

  if (!env.RN_BUST_SECRET || !timingSafeEqual(secret, env.RN_BUST_SECRET)) {
    return setPage(403, "denied", "wrong secret. check the bookmark.");
  }

  // accept either a full open.spotify.com URL, a spotify: URI, or a bare id.
  const m =
    target.match(/^spotify:playlist:([0-9A-Za-z]{22})$/) ||
    target.match(/open\.spotify\.com\/playlist\/([0-9A-Za-z]{22})/) ||
    target.match(/^([0-9A-Za-z]{22})$/);
  if (!m) {
    return setPage(400, "bad url",
      "couldn't find a 22-character playlist id in <code>" + esc(target) + "</code>.");
  }
  const id = m[1];

  if (!env.RN_KV) {
    return setPage(500, "no kv binding", "the worker can't see RN_KV — bind it in Pages settings.");
  }
  await env.RN_KV.put("playlist-id", id);

  return setPage(200, "updated",
    `<code>/rn</code> now points to <a href="https://open.spotify.com/playlist/${esc(id)}" target="_blank" rel="noopener">open.spotify.com/playlist/${esc(id)}</a>.<br>` +
    `<small><a href="/rn/admin?secret=${esc(secret)}">&larr; back to admin</a></small>`);
}

// gather params from query string, form body, or JSON body — query wins ties.
async function readParams(request, url) {
  const out = new URLSearchParams(url.searchParams);
  if (request.method === "POST") {
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    try {
      if (ct.startsWith("application/x-www-form-urlencoded")) {
        const body = await request.text();
        for (const [k, v] of new URLSearchParams(body)) {
          if (!out.has(k)) out.set(k, v);
        }
      } else if (ct.startsWith("application/json")) {
        const data = await request.json();
        for (const k of Object.keys(data || {})) {
          if (!out.has(k)) out.set(k, String(data[k]));
        }
      }
    } catch {}
  }
  return out;
}

// ── tiny period-correct confirmation page ───────────────────────────
function setPage(status, title, bodyHtml) {
  const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>aadhar.sh/rn/set/${esc(title)}</title>
<meta name="robots" content="noindex">
<style>
${xpChromeCss(520)}
  h1 {
    font-family: "Trebuchet MS", Verdana, Geneva, sans-serif; color: oklch(41.92% 0.0962 250.51);
    font-size: 16pt; margin: 0 0 8px;
  }
  a:link    { color: oklch(42.61% 0.2353 263.74); text-decoration: underline; }
  a:visited { color: oklch(42.09% 0.1935 328.36); }
  a:hover   { color: oklch(62.80% 0.2577 29.23); }
  code { font-family: "Courier New", Courier, monospace; background: oklch(96.72% 0 0); padding: 0 3px; border: 1px solid oklch(88.22% 0 0); }
</style></head><body>
<div class="window">
  <div class="title-bar">aadhar.sh/rn/set/${esc(title)}</div>
  <div class="content">
    <h1>${esc(title)}</h1>
    <p>${bodyHtml}</p>
    <p><small>&larr; <a href="/">aadhar.sh</a></small></p>
  </div>
</div><script src="/nav.js" defer></script></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type":  "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag":  "noindex",
    },
  });
}

// constant-time string compare so we don't leak the secret via timing.
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ── /whoareyou handler ───────────────────────────────────────────────
// shows the visitor what their HTTP request revealed. no logging, no
// storage. one server-side outbound call to ARIN's RDAP service to
// enrich the IP with its registration metadata (network name, owner,
// CIDR) — the visitor's browser never speaks to a third party. RDAP
// results are CF-edge-cached by URL for 24h so visitors from the same
// IP block don't re-hit ARIN.

// RDAP returns the registered owner of the IP block — often more
// specific than the ASN's operator (e.g. "Columbia University" rather
// than the upstream ISP). ARIN's endpoint handles IANA-bootstrap
// redirects to whichever RIR is authoritative for the queried IP, so
// one URL works for all five RIRs as long as we follow redirects.
async function fetchRdap(ip) {
  if (!ip || ip === "—") return null;
  // basic shape check to avoid sending garbage to ARIN
  if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  try {
    const res = await fetch(`https://rdap.arin.net/registry/ip/${encodeURIComponent(ip)}`, {
      headers: {
        "user-agent": BOT_UA,                 // identifies as AadharshBot
        "accept":     "application/rdap+json",
      },
      redirect: "follow",
      cf: { cacheTtl: 86400, cacheEverything: true },  // 24h CF edge cache, keyed by URL
    });
    if (!res.ok) return null;
    const data = await res.json();

    // network name — short identifier for the allocated block (e.g.
    // "COMCAST-1", "COLUMBIA-UNIV"). `handle` falls back to ARIN's
    // internal NET- handle if `name` isn't populated.
    const networkName = data.name || data.handle || null;

    // CIDR — prefer the structured cidr0_cidrs[0]; otherwise compose
    // from startAddress/endAddress (less precise but always present).
    let cidr = null;
    const c = Array.isArray(data.cidr0_cidrs) ? data.cidr0_cidrs[0] : null;
    if (c) {
      const prefix = c.v4prefix || c.v6prefix;
      if (prefix && typeof c.length === "number") cidr = `${prefix}/${c.length}`;
    }
    if (!cidr && data.startAddress && data.endAddress) {
      cidr = `${data.startAddress} – ${data.endAddress}`;
    }

    // registered owner — pulled from the entity with role "registrant".
    // RDAP encodes entity contact info as a vCard 4.0 jCard structure;
    // the "fn" (formatted name) property is the human-readable owner.
    let owner = null;
    const registrant = (data.entities || []).find(e =>
      Array.isArray(e.roles) && e.roles.includes("registrant")
    );
    const vcard = registrant?.vcardArray;
    if (Array.isArray(vcard) && Array.isArray(vcard[1])) {
      const fn = vcard[1].find(v => Array.isArray(v) && v[0] === "fn");
      if (fn && typeof fn[3] === "string") owner = fn[3];
    }

    // events — registration date + last changed are most interesting.
    const events = Array.isArray(data.events) ? data.events : [];
    const regEvent = events.find(e => e.eventAction === "registration");
    const lastChanged = events.find(e => e.eventAction === "last changed");

    // allocation type — "DIRECT ASSIGNMENT", "REASSIGNED", "ALLOCATED PORTABLE", etc.
    const allocType = data.type || null;

    return {
      networkName,
      owner,
      cidr,
      allocType,
      registered:  regEvent?.eventDate || null,
      lastChanged: lastChanged?.eventDate || null,
    };
  } catch (_e) {
    return null;
  }
}

async function handleWhoareyou(request) {
  const cf = request.cf || {};
  const h  = request.headers;

  const bm = cf.botManagement || {};
  const data = {
    ip:             h.get("cf-connecting-ip") || "—",
    asn:            cf.asn || "—",
    asOrg:          cf.asOrganization || "—",
    country:        cf.country || "??",
    continent:      cf.continent || "—",
    isEU:           cf.isEUCountry === "1" || cf.isEUCountry === true,
    region:         cf.region || "—",
    city:           cf.city || "—",
    postalCode:     cf.postalCode || "—",
    latitude:       cf.latitude || null,
    longitude:      cf.longitude || null,
    timezone:       cf.timezone || "—",
    colo:           cf.colo || "—",
    clientTcpRtt:   cf.clientTcpRtt ?? null,
    httpProtocol:   cf.httpProtocol || "—",
    tlsVersion:     cf.tlsVersion || "—",
    tlsCipher:      cf.tlsCipher || "—",
    acceptEncoding: h.get("accept-encoding") || "—",
    userAgent:      h.get("user-agent") || "—",
    acceptLanguage: h.get("accept-language") || "—",
    dnt:            h.get("dnt") === "1" ? "set (1)" : "not set",
    referer:        h.get("referer") || "(none)",
    cookies:        h.get("cookie") ? "present" : "none",
    botScore:       bm.score ?? null,
    verifiedBot:    bm.verifiedBot ?? false,
    detectionIds:   bm.detectionIds || null,
    corporateProxy: bm.corporateProxy ?? null,
    ja3Hash:        bm.ja3Hash || null,
    ja4:            bm.ja4 || null,
    when:           new Date().toISOString(),
  };

  const ua = parseUA(data.userAgent);

  // RDAP enrichment — server-side only, never blocks rendering if it
  // fails or times out (the page renders fine without these fields).
  const rdap = await fetchRdap(data.ip);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aadhar.sh/whoareyou</title>
<meta name="description" content="what one HTTP request to aadhar.sh reveals about you. read-only, never stored.">
<meta name="robots" content="noindex">
<style>
/* ─── /whoareyou, circa 2003 ──────────────────────────────────────────
   matches the holding page chrome: light-blue gradient body, white
   window panel, fake XP title bar, verdana body, trebuchet headings,
   beveled data tables that feel like a Windows properties dialog.
   ────────────────────────────────────────────────────────────────── */

${xpChromeCss(720)}
/* whoareyou-specific title-bar extras: the title text flexes to fill,
   and the boxed _ □ × controls get a touch more letter-spacing. */
.title-bar .title-text { flex: 1; padding-left: 4px; }
.title-bar .controls { letter-spacing: 2px; font-family: Tahoma, Verdana, Geneva, sans-serif; font-size: 9pt; }

h1 {
  font-family: "Trebuchet MS", Verdana, Geneva, sans-serif;
  font-size: 14pt;
  color: oklch(41.92% 0.0962 250.51);
  margin: 0 0 4px;
  font-weight: bold;
  letter-spacing: -0.01em;
}
h2 {
  font-family: "Trebuchet MS", Verdana, Geneva, sans-serif;
  font-size: 12pt;
  color: oklch(41.92% 0.0962 250.51);
  margin: 18px 0 6px;
  font-weight: bold;
  line-height: 1.3;
  /* the rule lives on a ::after pseudo with an explicit margin-top
     rather than border-bottom + padding-bottom. Safari's font-metric
     rounding leaves Trebuchet's "g"/"y" descenders kissing the rule
     even at 6-8px padding; a block-level pseudo with margin-top sits
     a fixed distance below the line-box and is immune to that. */
}
h2::after {
  content: "";
  display: block;
  height: 1px;
  background: oklch(86.67% 0.0294 259.59);
  margin-top: 8px;
}

.lede { margin: 0 0 14px; color: oklch(38.67% 0 0); font-size: 10.5pt; }
p { margin: 0 0 12px; }
ul { margin: 0 0 12px 22px; padding: 0; }
li { margin-bottom: 4px; }

a:link    { color: oklch(42.61% 0.2353 263.74); text-decoration: underline; }
a:visited { color: oklch(42.09% 0.1935 328.36); }
a:hover   { color: oklch(62.80% 0.2577 29.23); }
a:active  { color: oklch(62.80% 0.2577 29.23); }

hr {
  border: 0;
  border-top: 2px groove oklch(86.67% 0.0294 259.59);
  margin: 16px 0;
  height: 0;
}

code, .mono {
  font-family: "Courier New", Courier, monospace;
  font-size: 10pt;
  background: oklch(96.72% 0 0);
  border: 1px solid oklch(88.22% 0 0);
  padding: 0 3px;
}

/* properties-dialog field grid — inset bevel like a Windows form */
.field-grid {
  display: grid;
  grid-template-columns: 14em 1fr;
  gap: 1px;
  margin: 4px 0 14px;
  background: oklch(85.04% 0.0283 248.16);
  border: 1px solid oklch(61.14% 0.0611 253.60);
  border-top-color: oklch(47.12% 0.0555 253.58);
  border-left-color: oklch(47.12% 0.0555 253.58);
  font-size: 10pt;
}
.field-grid dt {
  background: oklch(94.66% 0.0114 252.09);
  color: oklch(41.92% 0.0962 250.51);
  font-weight: bold;
  padding: 4px 8px;
  font-family: Tahoma, Verdana, Geneva, sans-serif;
}
.field-grid dd {
  background: oklch(100.00% 0 0);
  margin: 0;
  padding: 4px 8px;
  font-family: "Courier New", Courier, monospace;
  font-size: 9.5pt;
  word-break: break-all;
  color: oklch(21.78% 0 0);
}
.field-grid dd .dim { color: oklch(62.68% 0 0); font-family: Tahoma, Verdana, Geneva, sans-serif; font-size: 9pt; }
.field-grid dd.muted { color: oklch(44.95% 0 0); }

/* little raised "pill" — looks like a tiny 3D button */
.pill {
  display: inline-block;
  padding: 0 5px;
  border: 1px solid oklch(61.14% 0.0611 253.60);
  background: oklch(94.66% 0.0114 252.09);
  color: oklch(41.92% 0.0962 250.51);
  font-family: Tahoma, Verdana, Geneva, sans-serif;
  font-size: 8.5pt;
  font-weight: bold;
  margin-right: 4px;
  border-radius: 2px;
}

/* info callout — beveled like a Windows information dialog */
.callout {
  border: 1px solid oklch(61.14% 0.0611 253.60);
  background: oklch(98.81% 0.0263 99.90);
  padding: 8px 12px;
  margin: 14px 0;
  font-size: 10pt;
  box-shadow: 1px 1px 0 oklch(61.14% 0.0611 253.60 / 0.3);
}
.callout::before {
  content: "ⓘ ";
  color: oklch(41.92% 0.0962 250.51);
  font-weight: bold;
}

/* footer */
footer {
  text-align: center;
  font-family: Tahoma, Verdana, Geneva, sans-serif;
  font-size: 9pt;
  color: oklch(44.95% 0 0);
  margin: 18px 0 0;
  padding-top: 14px;
  border-top: 1px solid oklch(86.67% 0.0294 259.59);
}
footer .signature { font-style: italic; margin-top: 4px; }
footer .signature small { color: oklch(56.93% 0 0); }
</style>
</head>
<body>

<div class="window">

  <div class="title-bar" aria-hidden="true">
    <span class="title-text"><span class="icon"></span>whoareyou</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="/" title="back to aadhar.sh" aria-label="back to aadhar.sh"></a></span>
  </div>

  <div class="content">

    <h1>whoareyou</h1>
    <p class="lede">
      This is what one HTTP request from your browser revealed to this site.
      None of it is logged. None of it is stored. Close this tab and it&rsquo;s gone.
    </p>

    <hr>

    <h2>Your Network</h2>
    <dl class="field-grid">
      <dt>IP address</dt>           <dd>${esc(data.ip)}</dd>
      <dt>ISP / ASN</dt>            <dd>${esc(data.asOrg)} (AS${esc(data.asn)})</dd>
      ${rdap?.owner ? `<dt>Registered to</dt>       <dd>${esc(rdap.owner)} <span class="dim">(per RDAP — often more specific than the ASN operator)</span></dd>` : ""}
      ${rdap?.networkName ? `<dt>Network name</dt>        <dd>${esc(rdap.networkName)}${rdap.allocType ? ` <span class="dim">(${esc(rdap.allocType.toLowerCase())})</span>` : ""}</dd>` : ""}
      ${rdap?.cidr ? `<dt>Allocated range</dt>     <dd>${esc(rdap.cidr)}</dd>` : ""}
      ${rdap?.registered ? `<dt>Block registered</dt>    <dd>${esc(rdap.registered.slice(0, 10))}${rdap.lastChanged && rdap.lastChanged.slice(0,10) !== rdap.registered.slice(0,10) ? ` <span class="dim">(last changed ${esc(rdap.lastChanged.slice(0, 10))})</span>` : ""}</dd>` : ""}
      <dt>Country</dt>              <dd>${esc(data.country)}${data.continent !== "—" ? ` <span class="dim">(${esc(data.continent)}${data.isEU ? ", EU" : ""})</span>` : ""}</dd>
      <dt>Region</dt>               <dd>${esc(data.region)}</dd>
      <dt>City</dt>                 <dd>${esc(data.city)} ${data.postalCode !== "—" ? `(${esc(data.postalCode)})` : ""}</dd>
      <dt>Timezone</dt>             <dd>${esc(data.timezone)}</dd>
      ${data.latitude ? `<dt>Approx. coords</dt><dd>${esc(data.latitude)}, ${esc(data.longitude)} <a href="https://www.openstreetmap.org/?mlat=${data.latitude}&mlon=${data.longitude}&zoom=10" target="_blank" rel="noopener">(see on map)</a></dd>` : ""}
      <dt>Cloudflare colo</dt>      <dd>${esc(data.colo)} <span class="dim">(nearest CF data center serving you)</span></dd>
      ${data.clientTcpRtt !== null ? `<dt>TCP round-trip</dt><dd>${esc(data.clientTcpRtt)} ms</dd>` : ""}
    </dl>

    <h2>Your Transport</h2>
    <dl class="field-grid">
      <dt>HTTP version</dt>         <dd>${esc(data.httpProtocol)} ${data.httpProtocol === "HTTP/3" ? `<span class="pill">over QUIC</span>` : ""}</dd>
      <dt>TLS version</dt>          <dd>${esc(data.tlsVersion)}</dd>
      <dt>TLS cipher</dt>           <dd>${esc(data.tlsCipher)}</dd>
      <dt>Accept-Encoding</dt>      <dd>${esc(data.acceptEncoding)}</dd>
      ${data.ja3Hash ? `<dt>JA3 fingerprint</dt><dd>${esc(data.ja3Hash)} <span class="dim">(TLS ClientHello hash)</span></dd>` : ""}
      ${data.ja4 ? `<dt>JA4 fingerprint</dt><dd>${esc(data.ja4)}</dd>` : ""}
    </dl>

    <h2>Your Browser</h2>
    <dl class="field-grid">
      <dt>Best guess</dt>           <dd>${esc(ua.browser)} on ${esc(ua.os)} ${esc(ua.device)}</dd>
      <dt>User agent</dt>           <dd class="muted">${esc(data.userAgent)}</dd>
      <dt>Languages</dt>            <dd>${esc(data.acceptLanguage)}</dd>
      <dt>Do-not-track</dt>         <dd>${esc(data.dnt)}</dd>
    </dl>

    <h2>The Request Itself</h2>
    <dl class="field-grid">
      <dt>Received at</dt>          <dd>${esc(data.when)}</dd>
      <dt>Referrer</dt>             <dd>${esc(data.referer)}</dd>
      <dt>Cookies sent</dt>         <dd>${esc(data.cookies)}</dd>
      ${data.botScore !== null ? `<dt>CF bot score</dt><dd>${esc(data.botScore)} / 99 <span class="dim">(higher = more human-like)</span></dd>` : ""}
      ${data.detectionIds ? `<dt>Bot detection IDs</dt><dd class="muted">${esc(JSON.stringify(data.detectionIds))}</dd>` : ""}
      ${data.corporateProxy ? `<dt>Corporate proxy</dt><dd>detected</dd>` : ""}
      ${data.verifiedBot ? `<dt>Verified bot</dt><dd>yes <span class="pill">CF-signed</span></dd>` : ""}
    </dl>

    <hr>

    <h2>What I Can&rsquo;t See</h2>
    <ul>
      <li><strong>Your DNS resolver / protocol.</strong> Name resolution happens before the request reaches this site; I only see the IP that connected. HTTP/3 implies a modern network stack that <em>probably</em> uses DoH, but that&rsquo;s inference, not measurement.</li>
      <li><strong>Your real identity</strong> unless you&rsquo;ve told me. An IP isn&rsquo;t a name.</li>
      <li><strong>The rest of your browsing.</strong> I see this one request, nothing else.</li>
      <li><strong>The contents of any encrypted data</strong> outside this HTTP session. TLS is doing its job.</li>
    </ul>

    <h2>Want This To Leak Less?</h2>
    <ul>
      <li><strong>Use a VPN or Tor.</strong> Changes IP/ASN/geo. Tor anonymizes most fingerprintable details.</li>
      <li><strong>Use a private browsing window.</strong> Drops cookies and language hints (somewhat).</li>
      <li><strong>Set <code>DNT: 1</code></strong> or use a browser that does. ~No servers honor it, but it&rsquo;s a signal.</li>
      <li><strong>Strip the user-agent.</strong> Some browsers / extensions let you fake or hide it; reduces fingerprinting surface.</li>
    </ul>

    <div class="callout">
      <strong>About this page:</strong> Rendered at the Cloudflare edge. Your
      browser never speaks to a third party — the only outbound call is one
      server-side RDAP lookup to your IP&rsquo;s registry (cached at the edge for
      24h so visitors from the same block don&rsquo;t re-hit ARIN). No analytics. The
      data above exists for the lifetime of one HTTP request and is never written
      to storage. View-source if you want; it&rsquo;s a single JavaScript file
      you can read end-to-end.
    </div>

    <footer>
      <p>
        &larr; Back to <a href="/">aadhar.sh</a>
        &middot; Built as a Cloudflare Pages worker
      </p>
      <p class="signature">
        <small>&copy; 2026 Aadharsh Pannirselvam &middot; Best viewed in any browser made since 2001.</small>
      </p>
    </footer>

  </div>
</div>

  <script src="/nav.js" defer></script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type":    "text/html; charset=utf-8",
      "cache-control":   "no-store, must-revalidate",
      "x-robots-tag":    "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

// ── helpers ──────────────────────────────────────────────────────────

function parseUA(ua) {
  const browser =
    /Edg\//.test(ua)             ? "Edge"    :
    /OPR\//.test(ua)             ? "Opera"   :
    /Firefox\//.test(ua)         ? "Firefox" :
    /Chrome\//.test(ua)          ? "Chrome"  :
    /Safari\//.test(ua)          ? "Safari"  :
    /curl/.test(ua)              ? "curl"    :
    /bot|spider|crawl/i.test(ua) ? "a bot"   : "an unknown browser";
  const os =
    /iPhone|iPad/.test(ua)       ? "iOS"     :
    /Android/.test(ua)           ? "Android" :
    /Mac OS X/.test(ua)          ? "macOS"   :
    /Windows/.test(ua)           ? "Windows" :
    /Linux/.test(ua)             ? "Linux"   : "an unknown OS";
  const device =
    /iPhone/.test(ua)            ? "(iPhone)" :
    /iPad/.test(ua)              ? "(iPad)"   :
    /Mobile/.test(ua)            ? "(mobile)" : "";
  return { browser, os, device };
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
