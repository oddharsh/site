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

// Offer the shell's own bytes as a compression dictionary for future /a/ requests
// (RFC 9842). This is what makes a Chromium client send `Available-Dictionary` back, which
// is the whole basis of the delta path. Purely additive: a client may ignore the offer, and
// a server may ignore the resulting header. match="/a/*" scopes it to the content-hashed
// shell, so the next deploy's /a/nav.<newhash>.js is exactly the request that arrives
// carrying the OLD bytes' hash.
const DICTIONARY_OFFER = { "use-as-dictionary": 'match="/a/*"' };

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
  headers.set("use-as-dictionary", 'match="/a/*"');
  headers.delete("etag");   // described the .dcz file, not this resource
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

  // ── dcz: the delta path ────────────────────────────────────────────────────────
  // A Chromium client that accepted our Use-As-Dictionary offer sends back the SHA-256
  // of the shell bytes it already holds. scripts/gen-shell-deltas.mjs has precomputed
  // zstd-against-that-dictionary offline, so serving the diff is a filename lookup:
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
  const delta = await serveDictionaryDelta(url, ext, request, env);
  if (delta) return delta;

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
