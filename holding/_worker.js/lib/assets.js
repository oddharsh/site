// lib/assets.js: the two ways this worker hands out a static file when the
// default asset path would lie.
//
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

// serveAssetWith404Clamp: pass real assets through untouched; clamp only a 404
// to max-age=0, because a miss under /images/* would otherwise inherit the
// 1-year immutable rule and pin itself at the edge. This one clamp is all that
// survives of the Pages-era content sniffing; Workers 404s are honest now.
export async function serveAssetWith404Clamp(request, env, opts = {}) {
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
// Until that is settled against the real edge, this path is OFF by default. /a/ carries
// nav.js and luna.css, which are render-blocking: a mislabelled content-encoding here
// is a white screen, not a slow page. `?br=1` is the canary — it exercises the exact
// production path on one throwaway URL (the query busts the immutable cache) so the
// question can be answered with one deploy and no blast radius.
const SHELL_PRECOMPRESS_DEFAULT_ON = false;

function wantsPrecompressed(url) {
  return SHELL_PRECOMPRESS_DEFAULT_ON || url.searchParams.get("br") === "1";
}

// servePrecompressedShell: /a/<name>.<hash8>.<ext> from the worker, so the response
// can carry bytes the platform would not have produced.
//
// Cloudflare compresses on the fly at roughly brotli q4 and prefers zstd when a
// browser offers everything, which measured LARGER than its own brotli here. build.mjs
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
  if (request.method !== "GET" || !SHELL_TYPES[ext]) {
    return serveAssetWith404Clamp(request, env);
  }

  // ?br=probe — the one-deploy experiment behind gotcha 13. We measured that the
  // runtime rewrites Accept-Encoding to a constant before a worker sees it, which
  // kills compression negotiation here. Shared dictionaries need the worker to read
  // `Available-Dictionary`, an encoding-negotiation header of exactly the class the
  // runtime was just observed rewriting, so whether Worker-served dcb is possible AT
  // ALL is an open question that no local test can answer.
  //
  // This reports what actually arrived at the worker in production. Named headers
  // only, never a blanket reflection of the request: these four carry no credential
  // and no visitor identity, and echoing arbitrary headers would be a real smell.
  // REMOVE THIS once the dictionary question is settled — it is an experiment, not a
  // feature, and site-manifest.json deliberately does not list it as a surface.
  if (url.searchParams.get("br") === "probe") {
    return new Response(JSON.stringify({
      note: "encoding-negotiation headers as the Worker received them",
      "accept-encoding":     request.headers.get("accept-encoding"),
      "available-dictionary": request.headers.get("available-dictionary"),
      "dictionary-id":       request.headers.get("dictionary-id"),
      "cf-ray":              request.headers.get("cf-ray"),
    }, null, 2) + "\n", {
      headers: {
        "content-type":  "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  // The identity path, which is what everyone gets while the gate is off. It carries
  // one extra header: Use-As-Dictionary offers these bytes to the browser as a
  // compression dictionary for future /a/ requests (RFC 9842). That offer is what
  // makes a Chromium client start sending `Available-Dictionary` back, which is the
  // ONLY way ?br=probe above can answer whether the runtime lets that header through.
  //
  // Safe to serve unconditionally: it is purely additive. A client may ignore it, and
  // a server is always free to ignore the resulting Available-Dictionary — which we
  // do, since nothing here returns dcb yet. So the worst case is that Chromium stores
  // 13KB it already downloaded and adds a request header we don't read.
  //
  // match="/a/*" scopes it to the content-hashed shell, so a new deploy's
  // /a/nav.<newhash>.js is exactly the request that would carry the old bytes' hash.
  const DICTIONARY_OFFER = { "use-as-dictionary": 'match="/a/*"' };

  if (!wantsPrecompressed(url)) {
    return serveAssetWith404Clamp(request, env, { headers: DICTIONARY_OFFER });
  }

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
  headers.set("use-as-dictionary", DICTIONARY_OFFER["use-as-dictionary"]);
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
