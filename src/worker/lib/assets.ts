// lib/assets.js: the ways this worker hands out a static file when the default
// asset path would lie.
import { wantsMarkdown } from "./http.ts";
import { notModifiedIfFresh } from "./cache.ts";
//

type AssetOptions = {
  notFoundBody?: BodyInit | null;
  notFoundType?: string;
  headers?: Record<string, string>;
};
// serveFreshAsset: fetch the asset under a unique query (which busts the
// read-through asset cache), then re-emit it at the canonical URL with an honest
// content-type and a short edge TTL. Exists because a long Cache-Control once
// pinned a stale agent-discovery doc at its canonical URL while every ?query
// variant served fresh.
export async function serveFreshAsset(request, env, contentType) {
  const u = new URL(request.url);
  u.searchParams.set("__r", Date.now().toString(36));
  const res = await env.ASSETS.fetch(new Request(u.toString(), { headers: request.headers }));
  // A miss must not wear the success content-type or the 300s shared TTL: an agent
  // parsing /.well-known/agent-card.json deserves an honest 404 rather than a body
  // that says "not found" under `application/json`, and pinning that miss at the
  // edge for 5 minutes would outlive the deploy that restores the file. Same clamp
  // the serveAssetWith404Clamp sibling below applies.
  if (res.status === 404) {
    try { await res.body?.cancel(); } catch {}
    return new Response("not found", {
      status: 404,
      headers: {
        "content-type":  "text/plain; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
  }
  const headers = new Headers(res.headers);
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "public, max-age=0, must-revalidate, s-maxage=300");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// serveMarkdownTwin: answer `Accept: text/markdown` at a page's own URL with the
// .md twin build.ts generated for it. The twin also lives at a stable, cacheable
// URL of its own (/garage/encoding -> /garage/encoding.md), which is what
// llms.txt links and what an agent without a precise Accept header should use.
// This is the same-URL convenience layered on that, not a replacement for it.
//
// Returns null when no twin exists, so the caller falls through to HTML rather
// than 404ing. Negotiation is a courtesy and every one of these paths has a real
// page to serve; failing a navigation because a twin did not generate would be
// the worse trade.
// Strip the body, keep every header. Not `new Response(null, res)`: Response init
// is read as a plain object there, so status/headers survive but anything carried
// out-of-band does not — the same write-only-init trap that made encodeBody a
// silent no-op site-wide (CLAUDE.md gotcha 13). Spelled out so it stays visible.
function bodiless(res) {
  try { res.body?.cancel(); } catch {}
  return new Response(null, { status: res.status, headers: new Headers(res.headers) });
}

export async function serveMarkdownTwin(request, env, twinPath, extraHeaders = {}) {
  const u = new URL(request.url);
  u.pathname = twinPath;
  u.search = "";
  const res = await env.ASSETS.fetch(new Request(u.toString(), { headers: request.headers }));
  if (!res.ok) {
    try { await res.body?.cancel(); } catch {}
    return null;
  }
  const body = await res.text();
  const negotiated = new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      // rough estimate at ~4 chars/token, the same honest approximation the
      // homepage twin has always advertised
      "x-markdown-tokens": String(Math.ceil(body.length / 4)),
      // The edge caches per URL, not per Accept, so a cached negotiated response
      // here could later be handed to a client that asked for HTML. The .md URL
      // is the cacheable representation; this one must not be. Same reasoning as
      // the homepage's negotiated "/" in home.js.
      "cache-control": "no-store, must-revalidate",
      "vary": "accept",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
  // HEAD is answered HERE rather than by each caller, so every negotiated route
  // gets the same header set from one place. The body has already been read to
  // count tokens, so a HEAD carries x-markdown-tokens for the same work a GET
  // does — which is exactly what the homepage's own HEAD path used to get wrong.
  return request.method === "HEAD" ? bodiless(negotiated) : negotiated;
}

// serveAssetWith404Clamp: pass real assets through untouched; clamp only a 404
// to max-age=0, because a miss under /images/* would otherwise inherit the
// 1-year immutable rule and pin itself at the edge. This one clamp is all that
// survives of the Pages-era content sniffing; Workers 404s are honest now.
export async function serveAssetWith404Clamp(request, env, opts: AssetOptions = {}) {
  const res = await env.ASSETS.fetch(request);
  if (res.status === 404) {
    try { await res.body?.cancel(); } catch {}
    return new Response(opts.notFoundBody || "not found", {
      status: 404,
      headers: {
        "content-type": opts.notFoundType || "text/plain; charset=utf-8",
        "cache-control": "public, max-age=0, must-revalidate",
      },
    });
  }
  if (!opts.headers) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(opts.headers)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// content types for the /a/ shell, keyed by the real extension. The asset server
// gets this right on its own; we only need it because the bytes we hand back came
// from a `.br` file, whose extension would otherwise type the response as binary.
const SHELL_TYPES = {
  js:  "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  dict: "application/octet-stream",
};

// Which of those may travel the SHARED-DICTIONARY path (the `use-as-dictionary` offer
// and the dcz delta). Deliberately NOT svg.
//
// The icon sprite went onto /a/ as a <use> target, where a browser fetches it as a
// document. #114 turned it into an <img>, and the very next deploy the 12 taskbar and
// tray icons vanished in Chromium for anyone who had visited before it — a warm
// Chromium, the only engine that implements shared dictionaries, and the only client
// that gets the dcz instead of the plain brotli. A hard reload dropped
// Available-Dictionary and everything came back, which is the whole diagnosis: on a
// brand-new content-hashed URL nothing else about the client can differ.
//
// The delta itself is fine. It round-trips byte-exact under `zstd -d -D`, and
// luna.css shipped its own dcz in the same deploy and rendered normally. What broke is
// a dcz response consumed by the IMAGE loader rather than by the CSS or script loader,
// and that is not something any local test here can reproduce — reproducing it needs a
// Chromium that already holds the previous deploy's bytes.
//
// So the sprite keeps the q11 brotli twin (verified decoding in both engines from
// production) and steps off the dictionary path entirely. The cost is the ~2.1KB the
// delta saved, once per deploy, on a file cached for a year. Cheap next to blanking the
// site's most visible chrome for returning visitors. Re-extending this to images is
// fine later, behind the ?br= canary the rest of this file was built with, which is how
// this path is supposed to earn a default in the first place (gotcha 13).
const DICTIONARY_TYPES = { js: 1, css: 1 };

// Offer the shell's own bytes as a compression dictionary for future /a/ requests
// (RFC 9842). This is what makes a Chromium client send `Available-Dictionary` back, which
// is the whole basis of the delta path. Purely additive: a client may ignore the offer, and
// a server may ignore the resulting header. match="/a/*" scopes it to the content-hashed
// shell, so the next deploy's /a/nav.<newhash>.js is exactly the request that arrives
// carrying the OLD bytes' hash.
// match-dest scopes the offer to the fetch destinations we will actually answer with a
// delta. RFC 9842 makes it optional and DEFAULTS IT TO EVERY DESTINATION, so the earlier
// bare `match="/a/*"` told Chromium these bytes were a dictionary for any /a/ request —
// including the icon sprite, fetched as an `image`. Nothing broke, because DICTIONARY_TYPES
// stops the worker answering an svg with a dcz, but the offer promised more than the server
// honours: the client stored state and sent Available-Dictionary on requests we ignore.
//
// This is #119's lesson moved into the protocol instead of living only in a JS gate. The
// sprite stays out on purpose — see DICTIONARY_TYPES — and naming destinations is how the
// wire says so.
// PER-BASE, not a shared /a/* glob. Chrome DevTools reported "Found a matching dictionary,
// but the dictionary is not used for the response" on tooltip.js and hoist.js, and the
// pooled pattern is why: every js/css asset offered the SAME match, so Chromium keyed them
// all to one scope and, on a request for tooltip.js, could send the hash of nav.js. Delta
// filenames are per-base (/ad/<base>.<hash8>.<dicttag>.dcz), so a cross-base hash can never
// resolve — the client did its half correctly and we answered plain brotli.
//
// Scoping match to the asset family makes the dictionary Chromium sends the one we can
// actually diff against. match-dest narrows per type as well: a stylesheet is never fetched
// as a script, and neither is ever fetched as an image (the #119 rule, in the protocol).
const SHELL_DESTS = { js: '("script")', css: '("style")' };
const shellOffer = (pathname, ext) => {
  const base = pathname.slice("/a/".length).replace(/\.[0-9a-f]{8}\.(js|css|svg|dict)$/, "");
  return `match="/a/${base}.*", match-dest=${SHELL_DESTS[ext] || '("script" "style")'}`;
};
// RFC 9842 lets a client send exactly ONE matching dictionary and resolves ties in
// this order: matching destination, longest `match` string, newest fetch. That made
// the old `match="/*"` family offer lose to every exact per-page offer. When Chrome
// held an exact snapshot the build had not captured, it sent that unusable hash and
// the Worker had no way to ask for the family hash it also held, so the page fell all
// the way back to Brotli.
//
// This is a site-wide URLPattern without custom regexp groups. Its deliberately
// descriptive wildcard name makes the match string longer than any page path, so
// the broad, build-guaranteed family delta wins whenever the family dictionary is
// present. Exact page snapshots remain the high-ratio fallback while the family
// dictionary is not cached yet. If a future page path is longer than this pattern,
// pageOffer declines to register it rather than letting it shadow the family again.
// Tested against URLPattern in shipping Chrome: it matches `/` and nested paths and
// `hasRegExpGroups` is false, as RFC 9842 requires.
export const PAGE_FAMILY_MATCH = "/:sitewide_html_dictionary_preferred_over_uncaptured_exact_page_snapshots*/*";
const pageFamilyOffer = (pathname) =>
  /^\/a\/page-family\.[0-9a-f]{8}\.dict$/.test(pathname)
    ? `match="${PAGE_FAMILY_MATCH}", match-dest=("document")`
    : null;
const pageOffer = (pathname) => pathname.length < PAGE_FAMILY_MATCH.length
  ? `match="${pathname}", match-dest=("document")`
  : null;

// Can the BROWSER keep an offer made on a response with this cache-control?
//
// Chromium derives a registered dictionary's lifetime from the response's own freshness,
// so a response that is stale the moment it lands registers a dictionary that has already
// expired, and drops it. DevTools says so out loud: "The response can't be used as a
// dictionary because its freshness is expired." Until 2026-07-29 every page here offered
// itself anyway, which taught Chromium to store nothing and cost a console error per
// navigation.
//
// Measured in Chrome that day, one navigation per policy, watching for the
// Available-Dictionary the browser sends back only when it actually stored the offer:
//
//   max-age=3600                                                  REGISTERED (control)
//   max-age=0, stale-while-revalidate=604800                      REGISTERED
//   max-age=0, must-revalidate                                    no
//   max-age=0, must-revalidate, stale-while-revalidate=604800     no
//   private, no-cache, must-revalidate                 (this site's old /)      no
//   private, no-cache, stale-while-revalidate=604800                            no
//   public, max-age=0, must-revalidate, s-maxage=86400 (this site's old pages)  no
//   public, max-age=0, s-maxage=86400, swr=604800      (PAGE_CACHE_CONTROL)     REGISTERED
//
// That is RFC 9842 section 2.2.1 exactly — a dictionary "MUST be either fresh or allowed
// to be served stale". stale-while-revalidate is the RFC 5861 permission to serve stale;
// must-revalidate is the explicit withdrawal of it, and it wins wherever both appear.
// no-cache never qualifies, because it bars reuse without revalidation. s-maxage is
// invisible to this decision: a browser is a private cache.
//
// Gating the offer on the header, rather than deleting it, keeps the coupling honest in
// both directions, which is what makes the tier a POLICY decision rather than a code one.
// Both moves since were exactly that, neither touching this function: the pages took
// `stale-while-revalidate` without `must-revalidate` and lit their tier back up, and `/`
// dropped no-cache for PAGE_CACHE_CONTROL on 2026-07-31 and joined them. The immutable
// /a/page-family.<hash>.dict is preferred whenever it is cached. The exact page tier
// remains useful before that idle-loaded family dictionary arrives, so the two tiers
// stack without letting an uncaptured exact hash force an avoidable Brotli response.
const canRegisterAsDictionary = (cacheControl) => {
  const cc = (cacheControl || "").toLowerCase();
  if (/\b(?:no-store|no-cache|must-revalidate)\b/.test(cc)) return false;
  const seconds = (name) => Number(cc.match(new RegExp(`\\b${name}=(\\d+)`))?.[1] || 0);
  return seconds("max-age") > 0 || seconds("stale-while-revalidate") > 0;
};

const variantEtag = (etag, suffix) => {
  if (!etag) return null;
  const opaque = etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  const base = opaque.replace(/-(?:br|dcz)$/, "");
  return `W/"${base}-${suffix}"`;
};

// A WORKER CANNOT NEGOTIATE COMPRESSION. Measured in wrangler dev 2026-07-26: the
// runtime rewrites the request's Accept-Encoding to a constant before the worker sees
// it. Four probes sending `identity`, `br`, `gzip`, and `br;q=0, gzip` ALL arrived as
// "br, gzip". That value describes what the EDGE can handle, never what the client
// asked for, so any `if (acceptsBrotli(request))` branch in a worker is dead code that
// always takes the true arm.
//
// What that header is really saying is "the edge will re-encode for the client," which
// is the documented "serve Brotli from origin" contract: hand the edge br and it
// down-converts for a client that can't take it. wrangler dev does NOT emulate that
// layer, and its raw output is mangled three ways out of four (identity got raw brotli
// with the content-encoding stripped; br got brotli-in-brotli; gzip got gzip-of-brotli).
// So local testing can tell us the negotiation is impossible, but it CANNOT tell us
// whether production is correct.
//
// Both paths are ON, each verified in production on 2026-07-27 before its gate came out,
// and the canaries that proved them are gone now that the default paths exercise the same
// code. CLAUDE.md gotchas 13 and 14 record how to rebuild them if a regression ever needs
// bisecting.
//
//   precompression: /encoding-test returned 30 bytes in ONE brotli layer (34 in two before
//   the withSecurityHeaders fix), and the shell twin measured 13,047 decoding to 46,268
//   bytes of valid JS. About 19% under the edge's ~q4 fly-compression, for every browser.
//
//   dcz deltas: luna.css served as 116 bytes against its previous version, round-tripping
//   byte-exact. 65x under the plain response for a returning Chromium visitor.


// Available-Dictionary is a Structured Field Byte Sequence: `:<base64 sha256>:`. Returns
// the first 16 hex chars of that hash, which is the tag gen-shell-deltas.mjs put in the
// .dcb filename, or null if the header is absent or malformed.
//
// Deliberately strict. This value selects a file path, so anything unexpected must become
// null rather than something that could escape the /ad/ prefix: the base64 is length-
// checked to a 32-byte digest and the result is re-derived as hex, so only [0-9a-f] can
// ever reach the URL.
function dictionaryTag(request) {
  const raw = request.headers.get("available-dictionary");
  if (!raw) return null;
  const m = raw.trim().match(/^:([A-Za-z0-9+/=]+):$/);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    if (bin.length !== 32) return null;          // not a SHA-256 digest
    let hex = "";
    for (let i = 0; i < 16; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    return hex.slice(0, 16);
  } catch { return null; }
}

// serveDictionaryDelta: hand back the precomputed dcz for the dictionary this client
// says it holds, or null to let the caller fall through.
async function serveDictionaryDelta(url, ext, request, env) {
  const tag = dictionaryTag(request);
  if (!tag) return null;

  // /a/<base>.<hash8>.<ext> -> /ad/<base>.<hash8>.<tag>.dcb
  const stem = url.pathname.slice("/a/".length).replace(new RegExp(`\\.${ext}$`), "");
  let res;
  try {
    res = await env.ASSETS.fetch(new Request(`${url.origin}/ad/${stem}.${tag}.dcz`, {
      headers: { "accept-encoding": "identity" },
    }));
  } catch { return null; }
  if (!res.ok) { try { await res.body?.cancel(); } catch {} return null; }

  const headers = new Headers(res.headers);
  headers.set("content-type", SHELL_TYPES[ext]);
  headers.set("content-encoding", "dcz");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  // Both dimensions matter to a shared cache: the same URL now answers with identity, br,
  // or a dcb that is only decodable against ONE dictionary. Cloudflare varies its cache on
  // exactly these two for shared dictionaries.
  headers.set("vary", "accept-encoding, available-dictionary");
  // Keep offering the shell as a dictionary, so a client that just delta-updated adopts
  // the new bytes and the chain continues on the next deploy.
  headers.set("use-as-dictionary", shellOffer(url.pathname, ext));
  headers.delete("etag");   // described the .dcz file, not this resource
  return new Response(res.body, { status: 200, headers, encodeBody: "manual" });
}

// servePrecompressedShell: /a/<name>.<hash8>.<ext> from the worker, so the response
// can carry bytes the platform would not have produced.
//
// Cloudflare compresses on the fly at roughly brotli q4 and prefers zstd when a
// browser offers everything, which measured LARGER than its own brotli here. build.ts
// writes a q11 `.br` twin next to each shell asset; this hands that twin over when the
// request offers br, which is a measured ~19% off nav.js + luna.css on the wire.
//
// Every failure path lands on today's behavior rather than a broken response:
//   - client doesn't offer br            -> identity asset, untouched
//   - no .br twin (build step skipped)   -> identity asset, untouched
//   - .br fetch errors                   -> identity asset, untouched
//   - asset genuinely missing            -> the 404 clamp, so a miss under an
//                                           immutable rule can't pin itself
//
// encodeBody: "manual" is LOAD-BEARING. The Workers runtime compresses response
// bodies to match `content-encoding` on its own; without "manual" it would brotli
// these already-brotli bytes and ship br-in-br, which every client fails to decode.
export async function servePrecompressedShell(request, env) {
  const url = new URL(request.url);
  const ext = url.pathname.split(".").pop().toLowerCase();

  // Only the shell's own three text types, and only safe methods. Anything else
  // (a range request, a HEAD we'd have to length-match, an unexpected extension)
  // goes down the untouched path rather than through a hand-built response.
  //
  // env.IDENTITY_BODY joins that list: an in-process caller (SELF_FETCH, so /lens
  // scanning this host) has no transport to decode with and the runtime ships no
  // brotli decoder, so a precompressed body reaches it as mojibake. See the flag's
  // note in index.js. This is the only branch that can turn it off, so keep the
  // check at the top of the function rather than beside each emission below.
  if (request.method !== "GET" || !SHELL_TYPES[ext] || env.IDENTITY_BODY) {
    return serveAssetWith404Clamp(request, env);
  }

  // ── dcz: the delta path ────────────────────────────────────────────────────────
  // A Chromium client that accepted our Use-As-Dictionary offer sends back the SHA-256
  // of the shell bytes it already holds. tools/build.ts step 8 has precomputed
  // zstd-against-that-dictionary at deploy time, so serving the diff is a filename lookup:
  // /ad/<base>.<hash8>.<dicttag>.dcz. The first real one: luna.css in 115 bytes instead
  // of 7,615, a 98.5% cut, from an ordinary CSS change.
  //
  // dcz rather than dcb because Cloudflare passes both through identically on all plans,
  // so the choice is bytes vs decode time. zstd decodes ~2x faster (0.046ms vs 0.094ms on
  // a bare 46KB asset), and on the real shipping pair brotli was smaller by exactly ONE
  // byte (79 vs 80). Bytes are the proxy; latency is the goal, and the decode gap widens
  // on the slow phones that need it most.
  //
  // Any miss falls through to the br path below and then to identity, so a client whose
  // dictionary we have no delta for (skipped several deploys, or a hand-crafted header)
  // just gets the ordinary asset.
  // DICTIONARY_TYPES gates this: images sit it out, for the reason recorded there.
  if (DICTIONARY_TYPES[ext]) {
    const delta = await serveDictionaryDelta(url, ext, request, env);
    if (delta) return delta;
  }

  // No Available-Dictionary, or no delta for the dictionary this client holds: fall through
  // to the brotli q11 twin below, which carries the dictionary offer itself.

  let br;
  try {
    // Ask for identity on the SUBREQUEST. If the asset layer applied its own
    // content-encoding to the .br file we would be re-wrapping already-encoded
    // bytes and mislabelling the result as plain br.
    const sub = new Request(`${url.origin}${url.pathname}.br`, {
      headers: { "accept-encoding": "identity" },
    });
    br = await env.ASSETS.fetch(sub);
  } catch {
    return serveAssetWith404Clamp(request, env);
  }

  if (!br.ok || br.headers.get("content-encoding")) {
    try { await br.body?.cancel(); } catch {}
    return serveAssetWith404Clamp(request, env);
  }

  // Carry the asset layer's headers (so the _headers `/a/*` immutable rule still
  // applies — the .br twin matches that same glob), then correct the three things
  // that describe the encoded body rather than the file it came from.
  const headers = new Headers(br.headers);
  headers.set("content-type", SHELL_TYPES[ext]);
  headers.set("content-encoding", "br");
  // Only offer a type we are willing to answer with a delta. Offering the sprite would
  // teach Chromium to send Available-Dictionary for it and then get plain br anyway:
  // wasted storage on the client and a header we deliberately ignore.
  if (DICTIONARY_TYPES[ext]) headers.set("use-as-dictionary", shellOffer(url.pathname, ext));
  else {
    const familyOffer = pageFamilyOffer(url.pathname);
    if (familyOffer) headers.set("use-as-dictionary", familyOffer);
    else headers.delete("use-as-dictionary");
  }
  // The URL is content-addressed, so these bytes never change identity. Vary still
  // has to name accept-encoding: the same URL answers with br or identity depending
  // on the request, and a shared cache must not serve one to a client that asked for
  // the other.
  headers.append("vary", "accept-encoding");
  // The asset layer's ETag describes the .br file. Two encodings of one resource
  // must not share a strong validator, so weaken it and mark the encoding.
  const etag = headers.get("etag");
  if (etag) headers.set("etag", `W/${etag.replace(/^W\//, "").replace(/"$/, "-br\"")}`);

  return new Response(br.body, {
    status: 200,
    headers,
    encodeBody: "manual",
  });
}


// serveStaticPage: static and build-rendered HTML, with a dcz delta when the
// client holds either the preferred immutable family dictionary or a committed
// per-page snapshot, otherwise the brotli q11 twin, otherwise the plain asset.
//
// The family dictionary lives at an immutable /a/ URL with a one-year lifetime and
// is advertised by every HTML response. Static page responses also offer the page
// itself as a scoped document dictionary; committed snapshots let the next release
// answer that tag with the high-ratio per-page delta before the family dictionary has
// arrived. Once both exist, PAGE_FAMILY_MATCH deliberately wins RFC 9842's longest-
// match selection so an uncaptured exact snapshot cannot shadow a usable family delta.
// Dynamic Worker pages keep the family Link but never enter this precomputed route.
export async function serveStaticPage(request, env, opts: AssetOptions = {}) {
  const url = new URL(request.url);
  // HEAD walks the GET path far enough to answer with the SAME headers, then drops
  // the body. RFC 9110 asks a HEAD to carry the fields its GET would send, and
  // deciding those fields is this function's whole job, so bailing on the method
  // before the negotiation below made HEAD advertise text/html on a page whose GET
  // answers text/markdown. Measured on production 2026-07-31, after the cache fix:
  // GET /garage/encoding and GET /bot both returned text/markdown while HEAD on the
  // same URLs returned text/html. That is also a convincing false positive for the
  // #195 cache bug, since `curl -I` is the reflex probe, which is the second reason
  // to close it rather than document it.
  const head = request.method === "HEAD";
  if (!head && request.method !== "GET") return serveAssetWith404Clamp(request, env, opts);
  const applyExtraHeaders = (headers) => {
    for (const [name, value] of Object.entries(opts.headers || {})) headers.set(name, value);
    return headers;
  };
  // Offer the page as its own dictionary only when the cache-control it actually ships
  // lets a browser keep the offer (see canRegisterAsDictionary). Runs after the caller's
  // headers land, because the caller is what sets cache-control.
  const offerIfStorable = (headers) => {
    if (canRegisterAsDictionary(headers.get("cache-control"))) {
      const offer = pageOffer(url.pathname);
      if (offer) headers.set("use-as-dictionary", offer);
      else headers.delete("use-as-dictionary");
    } else {
      headers.delete("use-as-dictionary");
    }
    return headers;
  };

  // /garage/compression -> asset garage/compression.html, slug garage__compression.
  // html_handling drops the trailing slash, so the path never carries the extension.
  // A trailing slash is not canonical here — `html_handling: "drop-trailing-slash"`
  // makes /garage the one true spelling — so /garage/ must 301 rather than be
  // answered. Hand it to the asset layer, which issues that redirect. This has to
  // come BEFORE the /index fallback below: that fallback resolves /garage/ to the
  // same twin as /garage and would serve it a cheerful 200, leaving the page with
  // two live URLs. The route oracle caught exactly that.
  // The ROOT is canonical WITH its slash, so it must be answered rather than
  // redirected — the opposite of every other trailing slash here. It maps to
  // index.html, which build.ts bakes into a deterministic document precisely so
  // it can take this path. Has to come before the guard below, which would
  // otherwise hand `/` to the asset layer and skip the twin entirely.
  const rel = url.pathname === "/"
    ? "index"
    : url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (rel !== "index" && url.pathname.endsWith("/")) return serveAssetWith404Clamp(request, env);

  if (!rel || rel.includes("..") || /\.[a-z0-9]+$/i.test(rel)) {
    // Sub-resources under these prefixes (the garage's images, ask.js) are not pages and
    // have no twin; hand them straight to the asset layer untouched.
    return serveAssetWith404Clamp(request, env);
  }
  // Markdown negotiation runs before the dictionary/delta machinery below, which
  // is all about shipping the HTML cheaply. An agent asking for text/markdown is
  // not going to use a delta against an HTML dictionary it does not hold.
  if (wantsMarkdown(request)) {
    // serveMarkdownTwin drops the body for a HEAD itself, so the header set is
    // decided in one place for every negotiated route. It costs a HEAD one ASSETS
    // subrequest it used to skip; HEAD is rare enough here that an honest
    // content-type is the better side of that trade.
    const md = await serveMarkdownTwin(request, env, `/${rel}.md`);
    if (md) return md;
  }
  // Everything below hands back a precompressed BODY (a dcz delta or the q11 twin)
  // and sizes its headers to those bytes, which a HEAD must not claim. From here it
  // takes the asset layer's own HEAD handling, exactly as it did before this change.
  if (head) return serveAssetWith404Clamp(request, env, opts);

  // build.ts names both artifacts after the ASSET path; this function knows only the
  // REQUEST path, and `html_handling: "drop-trailing-slash"` makes those differ for
  // exactly one shape — a section index, where /garage is served by garage/index.html.
  // So /garage asked for garage.html.br and /pd/garage.<tag>.dcz while the build had
  // written garage/index.html.br and /pd/garage__index.<tag>.dcz. Both missed, both
  // silently, and the page fell through to on-the-fly edge compression.
  //
  // Measured 2026-07-28: /garage shipped 13,264 bytes against an 11,131-byte twin (16%
  // wasted), /lwe 6,197 against 5,171 (17%). Every sub-page was byte-exact for its own
  // twin, which is why this hid — the shape that broke is the only one with no sibling
  // to diff against, and a missing twin degrades to a correct, slightly larger page.
  //
  // Direct name first, so a sub-page still costs one lookup and only an index pays for
  // the second. An ASSETS miss is colo-local and cheap; an unserved twin is not.
  const bases = [rel, `${rel}/index`];

  const findDelta = async () => {
    const tag = dictionaryTag(request);
    if (!tag) return null;
    for (const base of bases) {
      try {
        const d = await env.ASSETS.fetch(new Request(`${url.origin}/pd/${base.replace(/\//g, "__")}.${tag}.dcz`, {
          headers: { "accept-encoding": "identity" },
        }));
        if (d.ok) {
          const h = new Headers(d.headers);
          h.set("content-type", "text/html; charset=utf-8");
          h.set("content-encoding", "dcz");
          h.set("vary", "accept-encoding, available-dictionary");
          h.delete("etag");                       // described the .dcz file, not this page
          applyExtraHeaders(h);
          // The self-offer is reconciled once more below, after this response borrows the
          // twin's cache-control; deciding it here would read a header about to change.
          offerIfStorable(h);
          return new Response(d.body, { status: 200, headers: h, encodeBody: "manual" });
        }
        try { await d.body?.cancel(); } catch {}
      } catch { /* fall through to the twin */ }
    }
    return null;
  };

  const findBrotli = async () => {
    for (const base of bases) {
      try {
        const br = await env.ASSETS.fetch(new Request(`${url.origin}/${base}.html.br`, {
          headers: { "accept-encoding": "identity" },
        }));
        if (br.ok && !br.headers.get("content-encoding")) {
          const h = new Headers(br.headers);
          h.set("content-type", "text/html; charset=utf-8");
          h.set("content-encoding", "br");
          h.set("vary", "accept-encoding, available-dictionary");
          const etag = h.get("etag");
          const encoded = variantEtag(etag, "br");
          if (encoded) h.set("etag", encoded);
          applyExtraHeaders(h);
          offerIfStorable(h);
          return new Response(br.body, { status: 200, headers: h, encodeBody: "manual" });
        }
        try { await br.body?.cancel(); } catch {}
      } catch { /* fall through to the plain asset */ }
    }
    return null;
  };

  // The current twin and the optional dictionary delta are independent colo-local
  // lookups, so do them in parallel. The twin supplies the validator even when the
  // response body is the delta: after applying it, the browser owns the CURRENT
  // page and can revalidate that representation with a 304 on its next visit.
  //
  // env.IDENTITY_BODY skips both lookups outright and falls through to the plain
  // asset below. An in-process caller (SELF_FETCH, i.e. /lens reading this host)
  // gets no transport decode and the runtime has no brotli decoder, so either of
  // these bodies would reach it as mojibake — see the flag's note in index.js.
  // Skipping is content-preserving here rather than a different answer: the twin
  // is a compression of the very asset `plain` returns, so the document is the
  // same one, and the two lookups it avoids are pure cost on this path.
  const [br, delta] = env.IDENTITY_BODY
    ? [null, null]
    : await Promise.all([findBrotli(), findDelta()]);
  if (br) {
    const fresh = notModifiedIfFresh(request, br);
    if (fresh.status === 304) {
      try { await delta?.body?.cancel(); } catch {}
      return fresh;
    }
  }
  if (delta) {
    if (br) {
      // The delta file physically lives under /pd/, but semantically represents
      // the requested page. Preserve the page URL's cache and discovery contract
      // from its current q11 twin; only the body encoding differs.
      for (const name of ["etag", "cache-control", "link", "last-modified"]) {
        const value = br.headers.get(name);
        if (value) delta.headers.set(name, value);
      }
      // The validator belongs to the representation on the wire. Reusing the
      // Brotli tag on a dcz body lets a cache/client validate the wrong encoding.
      const encoded = variantEtag(br.headers.get("etag"), "dcz");
      if (encoded) delta.headers.set("etag", encoded);
      try { await br.body?.cancel(); } catch {}
    }
    // cache-control just moved; the self-offer has to agree with the one that shipped.
    offerIfStorable(delta.headers);
    const fresh = notModifiedIfFresh(request, delta);
    if (fresh.status === 304) return fresh;
    return delta;
  }
  if (br) return br;

  const plain = await serveAssetWith404Clamp(request, env, {
    headers: {
      "vary": "accept-encoding, available-dictionary",
      ...opts.headers,
    },
  });
  plain.headers.delete("use-as-dictionary");
  return notModifiedIfFresh(request, plain);
}
