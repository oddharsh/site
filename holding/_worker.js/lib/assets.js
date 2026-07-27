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

// serveEncodingSelfTest: the decisive experiment, isolating WHERE the double
// compression comes from.
//
// Both failing canaries went through `env.ASSETS`, so "a worker cannot emit a
// pre-encoded body" may be too broad a conclusion: the static-assets layer is a real
// suspect, since it does its own content negotiation. Cloudflare's own shared-dictionary
// demo (canicompress.com) delta-compresses at the edge reading bytes from R2, never from
// static assets, which is consistent with the assets path being the problem.
//
// This response involves NO asset fetch at all. The body is a constant: brotli q11 of
// "ENCODING-TEST-OK " x64, 1088 plaintext bytes down to 30. Read the result as:
//
//   30 bytes  -> encodeBody: "manual" WORKS on a worker-built response. The wall is the
//                static-assets layer, and dcb/dcz from a worker is viable (which puts
//                the homepage's 13,264 -> ~870 back on the table).
//   34ish     -> brotli-in-brotli. No worker on this platform can emit a pre-encoded
//                body, and only Cloudflare's managed (Phase 2) mode can ever help.
//
// `?raw=1` omits encodeBody at the route. It WAS the control that proved this test
// sensitive: before the fix both arms returned 34 bytes in two brotli layers. Now both
// return 30 in one, because withSecurityHeaders re-applies `manual` for any response
// carrying a content-encoding, which is deliberately not overridable per-route. Kept
// only so the two arms can be compared again if this ever regresses.
const ENCODING_TEST_BR = "Gz8E+I3UWq04bGqQlicqWbQ0VYb0ViC4ZIxP794C";
const ENCODING_TEST_PLAIN_LEN = 1088;

export function serveEncodingSelfTest(request) {
  const url = new URL(request.url);
  const bytes = Uint8Array.from(atob(ENCODING_TEST_BR), (c) => c.charCodeAt(0));
  const init = {
    headers: {
      "content-type":     "text/plain; charset=utf-8",
      "content-encoding": "br",
      "cache-control":    "no-store",
      "x-test-br-bytes":  String(bytes.length),
      "x-test-plain-len": String(ENCODING_TEST_PLAIN_LEN),
    },
  };
  // the control arm deliberately omits encodeBody, so a reader can tell a working
  // passthrough from a test that simply never exercised the runtime's re-encoder.
  if (url.searchParams.get("raw") !== "1") init.encodeBody = "manual";
  return new Response(bytes, init);
}

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

// serveDictionaryDelta: hand back the precomputed dcb for the dictionary this client
// says it holds, or null to let the caller fall through.
async function serveDictionaryDelta(url, ext, request, env) {
  const tag = dictionaryTag(request);
  if (!tag) return null;

  // /a/<base>.<hash8>.<ext> -> /ad/<base>.<hash8>.<tag>.dcb
  const stem = url.pathname.slice("/a/".length).replace(new RegExp(`\\.${ext}$`), "");
  let res;
  try {
    res = await env.ASSETS.fetch(new Request(`${url.origin}/ad/${stem}.${tag}.dcb`, {
      headers: { "accept-encoding": "identity" },
    }));
  } catch { return null; }
  if (!res.ok) { try { await res.body?.cancel(); } catch {} return null; }

  const headers = new Headers(res.headers);
  headers.set("content-type", SHELL_TYPES[ext]);
  headers.set("content-encoding", "dcb");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  // Both dimensions matter to a shared cache: the same URL now answers with identity, br,
  // or a dcb that is only decodable against ONE dictionary. Cloudflare varies its cache on
  // exactly these two for shared dictionaries.
  headers.set("vary", "accept-encoding, available-dictionary");
  // Keep offering the shell as a dictionary, so a client that just delta-updated adopts
  // the new bytes and the chain continues on the next deploy.
  headers.set("use-as-dictionary", 'match="/a/*"');
  headers.delete("etag");   // described the .dcb file, not this resource
  return new Response(res.body, { status: 200, headers, encodeBody: "manual" });
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

  // ?br=2 — the second canary, testing the ONE hypothesis left standing after ?br=1
  // failed in production. ?br=1 fetches /a/<name>.<ext>.br and rebuilds the response
  // to fix its content-type; that rebuild is what appears to lose the runtime's
  // internal "this body is already encoded" state, so the body got compressed again
  // (13,051 bytes of brotli-in-brotli against 13,047 on disk).
  //
  // Here the asset layer supplies the whole envelope: /abr/<name>.<ext> holds the same
  // q11 bytes, and _headers gives that path both `Content-Encoding: br` and the correct
  // Content-Type. So this returns the subrequest response WITHOUT constructing a new
  // Response, which is the documented pass-through contract ("do not read the body,
  // keep the Content-Encoding intact"). Nothing is rebuilt, so there is no state to lose.
  //
  // If ?br=2 returns 13,047 bytes of valid JS, precompression is viable and the same
  // envelope trick carries dcb (Available-Dictionary already reaches the worker —
  // verified in production, cf-ray a2174bfc). If it returns 13,051 again, a worker on
  // this platform cannot emit a pre-encoded body at all, and both precompression and
  // Worker-served dictionaries are dead ends. That is the whole question.
  if (url.searchParams.get("br") === "2") {
    // accept-encoding: identity on the SUBREQUEST. There are two places a body can get
    // compressed, and they have to be separated: the asset layer compresses what it
    // serves when the caller accepts it, so forwarding the original request's
    // "br, gzip" makes IT produce the br-in-br. Asking for identity gets the file's raw
    // q11 bytes while _headers still supplies `Content-Encoding: br`, leaving exactly
    // one encoding on the response and nothing for the outbound side to redo.
    const passthrough = await env.ASSETS.fetch(new Request(`${url.origin}/abr${url.pathname.slice(2)}`, {
      headers: { "accept-encoding": "identity" },
    }));
    if (passthrough.ok) return passthrough;
    try { await passthrough.body?.cancel(); } catch {}
  }

  // ── dcb: the delta path ────────────────────────────────────────────────────────
  // A Chromium client that accepted our Use-As-Dictionary offer sends back the SHA-256
  // of the shell bytes it already holds. scripts/gen-shell-deltas.mjs has precomputed
  // brotli-against-that-dictionary offline, so serving the diff is a filename lookup:
  // /ad/<base>.<hash8>.<dicttag>.dcb. Measured 93-97% under plain brotli on a real
  // deploy-to-deploy change (luna.css 17,350 -> 489).
  //
  // dcb rather than dcz because Cloudflare passes both through identically on all plans,
  // so it is purely a ratio question, and brotli won every measurement by 5-8%.
  //
  // Any miss falls through to the br path below and then to identity, so a client whose
  // dictionary we have no delta for (skipped several deploys, or a hand-crafted header)
  // just gets the ordinary asset.
  if (wantsPrecompressed(url) || url.searchParams.get("br") === "dcb") {
    const dcb = await serveDictionaryDelta(url, ext, request, env);
    if (dcb) return dcb;
  }

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
