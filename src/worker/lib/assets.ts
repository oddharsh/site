import { wantsMarkdown } from "./http.ts";
import { notModifiedIfFresh } from "./cache.ts";
import { pageDeltaPaths, parseFamilyDictionary, shellDeltaPath, tagFromAvailableDictionary } from "./dictionary-names.ts";

type AssetOptions = {
  notFoundBody?: BodyInit | null;
  notFoundType?: string;
  headers?: Record<string, string>;
};
export async function serveFreshAsset(request, env, contentType) {
  const u = new URL(request.url);
  u.searchParams.set("__r", Date.now().toString(36));
  const res = await env.ASSETS.fetch(new Request(u.toString(), { headers: request.headers }));
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

// Strip the body, keep every header. Not `new Response(null, res)`: Response init
// is read as a plain object there, so status/headers survive but anything carried
// out-of-band does not — the same write-only-init trap that made encodeBody a
// silent no-op site-wide (docs/GOTCHAS.md gotcha 13). Spelled out so it stays visible.
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
  return request.method === "HEAD" ? bodiless(negotiated) : negotiated;
}

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

const SHELL_TYPES = {
  js:  "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  json: "application/json; charset=utf-8",
  dict: "application/octet-stream",
};

// One /a/ json is not plain JSON by CONTRACT: the speculation ruleset every HTML
// response names in its Speculation-Rules header (lib/security.ts). Chrome
// applies a header-delivered ruleset only when it arrives as
// application/speculationrules+json and silently ignores it otherwise, so the
// ordinary json type here would be a working file that speculates nothing.
// Named by path because the extension is shared with the other /a/ json.
const SPECULATION_RULES_FILE = /^\/a\/speculation\.[0-9a-f]{8}\.json$/;
const SPECULATION_RULES_TYPE = "application/speculationrules+json";
const shellType = (pathname: string, ext: string) =>
  SPECULATION_RULES_FILE.test(pathname) ? SPECULATION_RULES_TYPE : SHELL_TYPES[ext];
const identityOpts = (pathname: string): AssetOptions =>
  SPECULATION_RULES_FILE.test(pathname) ? { headers: { "content-type": SPECULATION_RULES_TYPE } } : {};

// json is on /a/ and OFF this map, and that is a measurement rather than caution.
// The one hashed json (the /pixel-peeper trial manifest, 1,860 B at q11) changed
// in 5 of the 200 releases to 2026-09-30, and its delta against the previous
// version is 148 B, so the tier would save about 1.7 KB on one visit in forty
// while adding a content type to the path gotcha 14 had to earn svg back onto.
// The path WOULD work: Chrome 154 sends Available-Dictionary on a fetch() whose
// URL matches a registration made by an earlier fetch(), with no match-dest or
// with match-dest=("") (a fetch's destination is the empty string), and not
// with match-dest=("script"). Measured locally on 2026-09-30, over
// http://localhost rather than production's h2/h3 through Cloudflare, so a json
// entry here would still owe the canary svg got. The number to revisit is a
// hashed json that changes most releases with a small delta.
const DICTIONARY_TYPES = { js: 1, css: 1, svg: 1 };

// Offer the shell's own bytes as a compression dictionary for future /a/ requests
// (RFC 9842). This is what makes a Chromium client send `Available-Dictionary` back, which
// is the whole basis of the delta path. Purely additive: a client may ignore the offer, and
// a server may ignore the resulting header. match="/a/*" scopes it to the content-hashed
// shell, so the next deploy's /a/nav.<newhash>.js is exactly the request that arrives
// carrying the OLD bytes' hash.
// match-dest scopes the offer to the fetch destinations we will actually answer with a
// delta. RFC 9842 makes it optional and DEFAULTS IT TO EVERY DESTINATION, so the earlier
// bare `match="/a/*"` told Chromium these bytes were a dictionary for any /a/ request —
// including the icon sprite, fetched as an `image`, back when the worker refused to answer
// an svg with a dcz. The offer promised more than the server honoured: the client stored
// state and sent Available-Dictionary on requests we ignored.
const SHELL_DESTS = { js: '("script")', css: '("style")', svg: '("image")' };
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
export const PAGE_FAMILY_MATCH = "/:sitewide_html_dictionary_preferred_over_uncaptured_exact_page_snapshots*/*";
const pageFamilyOffer = (pathname) =>
  pathname.startsWith("/a/") && parseFamilyDictionary(pathname.slice("/a/".length))
    ? `match="${PAGE_FAMILY_MATCH}", match-dest=("document")`
    : null;
const pageOffer = (pathname) => pathname.length < PAGE_FAMILY_MATCH.length
  ? `match="${pathname}", match-dest=("document")`
  : null;

// Re-measured 2026-09-23 in Chrome 152, because every must-revalidate row above pairs it
// with max-age=0 and so could not separate "vetoes" from "leaves no lifetime":
//
//   max-age=3600, must-revalidate                                 REGISTERED, for the max-age
//   max-age=3600, no-cache                                        no
//   max-age=3600, no-store                                        no
//
// That is RFC 9842 section 2.2.1 exactly: a dictionary "MUST be either fresh or allowed
// to be served stale". So the lifetime is max-age plus the stale-while-revalidate window,
// the RFC 5861 permission to serve stale. must-revalidate is the explicit withdrawal of
// that permission, so it cancels the swr window and leaves max-age standing; it only
// reads as a veto when max-age is 0. no-cache and no-store veto outright, whatever else
// the header says, because no-cache bars reuse without revalidation. s-maxage is
// invisible to this decision: a browser is a private cache.
const canRegisterAsDictionary = (cacheControl) => {
  const cc = (cacheControl || "").toLowerCase();
  if (/\b(?:no-store|no-cache)\b/.test(cc)) return false;
  const seconds = (name) => Number(cc.match(new RegExp(`\\b${name}=(\\d+)`))?.[1] || 0);
  const stale = /\bmust-revalidate\b/.test(cc) ? 0 : seconds("stale-while-revalidate");
  return seconds("max-age") + stale > 0;
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
// code. docs/GOTCHAS.md gotchas 13 and 14 record how to rebuild them if a regression ever needs
// bisecting.

const dictionaryTag = (request) => tagFromAvailableDictionary(request.headers.get("available-dictionary"));

async function serveDictionaryDelta(url, ext, request, env) {
  const tag = dictionaryTag(request);
  if (!tag) return null;

  const deltaPath = shellDeltaPath(url.pathname, tag);
  if (!deltaPath) return null;
  let res;
  try {
    res = await env.ASSETS.fetch(new Request(`${url.origin}${deltaPath}`, {
      headers: { "accept-encoding": "identity" },
    }));
  } catch { return null; }
  if (!res.ok) { try { await res.body?.cancel(); } catch {} return null; }

  const headers = new Headers(res.headers);
  headers.set("content-type", SHELL_TYPES[ext]);
  headers.set("content-encoding", "dcz");
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("vary", "accept-encoding, available-dictionary");
  headers.set("use-as-dictionary", shellOffer(url.pathname, ext));
  headers.delete("etag");
  return new Response(res.body, { status: 200, headers, encodeBody: "manual" });
}

// encodeBody: "manual" is LOAD-BEARING. The Workers runtime compresses response
// bodies to match `content-encoding` on its own; without "manual" it would brotli
// these already-brotli bytes and ship br-in-br, which every client fails to decode.
export async function servePrecompressedShell(request, env) {
  const url = new URL(request.url);
  const ext = url.pathname.split(".").pop().toLowerCase();

  if (request.method !== "GET" || !SHELL_TYPES[ext] || env.IDENTITY_BODY) {
    return serveAssetWith404Clamp(request, env, identityOpts(url.pathname));
  }

  const onDictionaryPath = Boolean(DICTIONARY_TYPES[ext]);
  if (onDictionaryPath) {
    const delta = await serveDictionaryDelta(url, ext, request, env);
    if (delta) return delta;
  }

  let br;
  try {
    const sub = new Request(`${url.origin}${url.pathname}.br`, {
      headers: { "accept-encoding": "identity" },
    });
    br = await env.ASSETS.fetch(sub);
  } catch {
    return serveAssetWith404Clamp(request, env, identityOpts(url.pathname));
  }

  if (!br.ok || br.headers.get("content-encoding")) {
    try { await br.body?.cancel(); } catch {}
    return serveAssetWith404Clamp(request, env, identityOpts(url.pathname));
  }

  const headers = new Headers(br.headers);
  headers.set("content-type", shellType(url.pathname, ext));
  headers.set("content-encoding", "br");
  if (ext === "dict") headers.set("priority", "u=7");
  if (onDictionaryPath) {
    headers.set("use-as-dictionary", shellOffer(url.pathname, ext));
  } else {
    const familyOffer = pageFamilyOffer(url.pathname);
    if (familyOffer) headers.set("use-as-dictionary", familyOffer);
    else headers.delete("use-as-dictionary");
  }
  headers.append("vary", "accept-encoding");
  const etag = headers.get("etag");
  if (etag) headers.set("etag", `W/${etag.replace(/^W\//, "").replace(/"$/, "-br\"")}`);

  return new Response(br.body, {
    status: 200,
    headers,
    encodeBody: "manual",
  });
}

const TEXT_TWIN_TYPES = new Set(["md", "json", "txt", "xml", "svg", "js", "css"]);
const SOURCE_TWIN = /\.src\.html$/i;

export function hasTextTwin(pathname: string): boolean {
  const ext = (pathname.split(".").pop() ?? "").toLowerCase();
  return TEXT_TWIN_TYPES.has(ext) || SOURCE_TWIN.test(pathname);
}

export async function servePrecompressedText(request, env, opts: AssetOptions = {}) {
  const url = new URL(request.url);
  if (request.method !== "GET" || !hasTextTwin(url.pathname) || env.IDENTITY_BODY) {
    return serveAssetWith404Clamp(request, env, opts);
  }

  const identity = { headers: { "accept-encoding": "identity" } };
  const [plain, twin] = await Promise.all([
    env.ASSETS.fetch(new Request(url.toString(), identity)).catch(() => null),
    env.ASSETS.fetch(new Request(`${url.origin}${url.pathname}.br`, identity)).catch(() => null),
  ]);
  const drop = async (r) => { try { await r?.body?.cancel(); } catch {} };
  if (!plain?.ok || !twin?.ok || twin.headers.get("content-encoding")) {
    await Promise.all([drop(plain), drop(twin)]);
    return serveAssetWith404Clamp(request, env, opts);
  }
  await drop(plain);

  const headers = new Headers(plain.headers);
  headers.set("content-encoding", "br");
  const twinLength = twin.headers.get("content-length");
  if (twinLength) headers.set("content-length", twinLength);
  else headers.delete("content-length");
  headers.append("vary", "accept-encoding");
  const encoded = variantEtag(headers.get("etag"), "br");
  if (encoded) headers.set("etag", encoded);
  for (const [name, value] of Object.entries(opts.headers || {})) headers.set(name, value);

  const res = new Response(twin.body, { status: 200, headers, encodeBody: "manual" });
  return notModifiedIfFresh(request, res);
}

export function twinPolicy(headers: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key === "cache-control") continue;
    if (key === "link") {
      const kept = value.split(/,\s*(?=<)/).filter((entry) => !/;\s*rel="?preload"?/i.test(entry)).join(", ");
      if (kept) out[name] = kept;
      continue;
    }
    out[name] = value;
  }
  return out;
}

export async function serveStaticPage(request, env, opts: AssetOptions = {}) {
  const url = new URL(request.url);
  const head = request.method === "HEAD";
  if (!head && request.method !== "GET") return serveAssetWith404Clamp(request, env, opts);
  const applyExtraHeaders = (headers) => {
    for (const [name, value] of Object.entries(opts.headers || {})) headers.set(name, value);
    return headers;
  };
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

  const rel = url.pathname === "/"
    ? "index"
    : url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (rel !== "index" && url.pathname.endsWith("/")) return serveAssetWith404Clamp(request, env);

  if (!rel || rel.includes("..") || /\.[a-z0-9]+$/i.test(rel)) {
    if (!rel.includes("..") && hasTextTwin(rel)) {
      return servePrecompressedText(request, env);
    }
    return serveAssetWith404Clamp(request, env);
  }
  if (wantsMarkdown(request)) {
    const md = await serveMarkdownTwin(request, env, `/${rel}.md`, twinPolicy(opts.headers));
    if (md) return md;
  }
  if (head) return serveAssetWith404Clamp(request, env, opts);

  const bases = [rel, `${rel}/index`];

  const findDelta = async () => {
    const tag = dictionaryTag(request);
    if (!tag) return null;
    for (const deltaPath of pageDeltaPaths(rel, tag)) {
      try {
        const d = await env.ASSETS.fetch(new Request(`${url.origin}${deltaPath}`, {
          headers: { "accept-encoding": "identity" },
        }));
        if (d.ok) {
          const h = new Headers(d.headers);
          h.set("content-type", "text/html; charset=utf-8");
          h.set("content-encoding", "dcz");
          h.set("vary", "accept-encoding, available-dictionary");
          h.delete("etag");
          applyExtraHeaders(h);
          offerIfStorable(h);
          return new Response(d.body, { status: 200, headers: h, encodeBody: "manual" });
        }
        try { await d.body?.cancel(); } catch {}
      } catch {}
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
      } catch {}
    }
    return null;
  };

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
      for (const name of ["etag", "cache-control", "link", "last-modified"]) {
        const value = br.headers.get(name);
        if (value) delta.headers.set(name, value);
      }
      const encoded = variantEtag(br.headers.get("etag"), "dcz");
      if (encoded) delta.headers.set("etag", encoded);
      try { await br.body?.cancel(); } catch {}
    }
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
