// lib/mcp-protocol.js — the 2026-07-28 wire rules, shared by both MCP servers.
//
// This site publishes TWO MCP servers: `/mcp` (mcp.js, the site surface) and
// `/serendipity/mcp` (serendipity.js, the event pool). They expose completely
// different tools and share nothing about their data. What they do share is the
// PROTOCOL: version negotiation, the `_meta` key names, `resultType`, the cache
// hint fields, and the reserved error codes. That is exactly the kind of thing
// that must not be implemented twice, because two copies drift and the symptom
// is one server quietly speaking a dialect no client asked for.
//
// SHARING IS SAFE HERE, and it is worth saying why, because the near-identical
// trace helpers in `lib/trace.js` and `cal/src/trace.js` are duplicated ON
// PURPOSE and this looks like the same situation. It is not. cal is duplicated
// because its Vitest pool boots from `cal/src/index.js` alone, so a cal ->
// holding import would make cal untestable without the site tree. Serendipity
// has no such constraint and already imports `lib/desktop.js` and
// `lib/crawl.js`; the serendipity -> www/lib direction is established.
//
// Nothing here may import `cloudflare:workers` (gotcha 16): both importers are
// pulled into contract-tests.mjs under plain node.

// ── the revisions ───────────────────────────────────────────────────
// 2026-07-28 deleted the initialize handshake, deleted protocol-level sessions
// and Mcp-Session-Id, and moved protocol version, client identity and
// capabilities into per-request `_meta`. Both servers here are DUAL-ERA, which
// the spec sanctions: a request carrying modern `_meta` is served statelessly
// under the new revision, an `initialize` request selects legacy semantics.
//
// The legacy list stays because legacy clients have NO fall-forward mechanism.
// Pointed at a modern-only server they fail outright, with no diagnostic they
// can surface to a user.
export const MCP_MODERN = "2026-07-28";
export const MCP_LEGACY = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_SUPPORTED = [MCP_MODERN, ...MCP_LEGACY];
// What a legacy `initialize` gets when it asks for something we do not know.
// Deliberately the newest LEGACY revision and never MCP_MODERN: a client coming
// in through the legacy door cannot speak modern, so handing it 2026-07-28
// would be a negotiation it fails on its very next request.
export const MCP_LEGACY_DEFAULT = "2025-06-18";

// `_meta` keys are namespaced by the spec and the prefix is mandatory.
const META = "io.modelcontextprotocol/";
export const META_PROTOCOL = `${META}protocolVersion`;
export const META_CLIENT_CAPS = `${META}clientCapabilities`;
export const META_SERVER_INFO = `${META}serverInfo`;

// From the 2026-07-28 error-code allocation policy, which reserved
// -32020..-32099 for the spec and grandfathered existing SDK use of
// -32000..-32019. (Resource-not-found also moved -32002 -> -32602 in the same
// revision; both servers already used -32602, so nothing needed renumbering.)
export const ERR_HEADER_MISMATCH = -32020;
export const ERR_UNSUPPORTED_PROTOCOL = -32022;
// Plain JSON-RPC Invalid Params, NOT from the reserved range above. The spec
// pins the malformed-request case to this code rather than minting a new one.
export const ERR_INVALID_PARAMS = -32602;

// CacheableResult freshness hints, required on list and read results. These are
// hints that let a client cache instead of poll; they complement listChanged
// notifications rather than replacing them. `public` throughout because every
// surface on both servers is public: no auth, no per-caller view, nothing an
// intermediary would be wrong to share.
export const CACHE_STATIC = { ttlMs: 3_600_000,  cacheScope: "public" };  // changes at deploy
export const CACHE_LIVE   = { ttlMs:   300_000,  cacheScope: "public" };  // reads a live page
export const CACHE_EMPTY  = { ttlMs: 86_400_000, cacheScope: "public" };  // permanently empty

// ── per-request negotiation ─────────────────────────────────────────

// The version this request declares, or null for a legacy caller.
//
// `_meta` is the ONLY modern signal. The MCP-Protocol-Version header predates
// this revision (2025-06-18 introduced it for HTTP), so treating a header as
// proof of modernity would misclassify a legacy client and answer it in a
// dialect it cannot read.
//
// DELIBERATE DEVIATION, shared by both servers, and it is now HALF the size it
// used to be. 2026-07-28 marks both `protocolVersion` and `clientCapabilities`
// required on every modern request, and says a request missing either is
// malformed and MUST be refused with -32602 (and HTTP 400). The
// `clientCapabilities` half is enforced below. The `protocolVersion` half
// cannot be, and the asymmetry is the whole design:
//
// An absent `_meta` is precisely how a LEGACY client presents itself, so
// refusing on a missing `protocolVersion` would fail every pre-2026 caller at
// the gate: the "Legacy client, Modern server -> Fails" row a dual-era server
// exists to avoid. A dual-era server cannot both read absence as an era signal
// and call absence malformed. It has to pick one, and this one picks the era
// signal.
//
// What that leaves is a clean rule: `protocolVersion` is the SELF-DECLARATION
// of modernity, and everything else the modern revision requires is enforced
// against callers who made it. See missingRequiredMeta().
export function declaredVersion(msg) {
  const v = msg?.params?._meta?.[META_PROTOCOL];
  return typeof v === "string" && v ? v : null;
}

// The `_meta` field this MODERN request is missing, or null if it is fine.
//
// Only ever fires on a request that declared `protocolVersion`, which is what
// keeps the legacy door open (see the deviation above): a caller with no
// `_meta` at all is legacy, not malformed, and never reaches this.
//
// `clientCapabilities` must be an OBJECT. The spec types it as
// ClientCapabilities, and a client sending `true` or `"none"` has not declared
// capabilities in any readable sense; accepting the key's mere presence would
// make this a spelling check rather than a contract. An EMPTY object is valid
// and is the correct declaration for a client that supports no client features
// at all, which is what both of this repo's own MCP clients send.
export function missingRequiredMeta(msg) {
  if (!declaredVersion(msg)) return null;
  const caps = msg?.params?._meta?.[META_CLIENT_CAPS];
  const ok = caps !== null && typeof caps === "object" && !Array.isArray(caps);
  return ok ? null : META_CLIENT_CAPS;
}

// The refusal for that, which is a plain Invalid Params rather than anything
// from the reserved range. `data.missing` is not required by the spec and is
// there because "Invalid params" alone tells a client author nothing about
// WHICH param, and this is a field they have probably never heard of.
export function malformedRequest(id, missing) {
  return { jsonrpc: "2.0", id, error: {
    code: ERR_INVALID_PARAMS,
    message: `Missing required _meta field: ${missing}`,
    data: { missing: [missing] },
  } };
}

// The HTTP status one JSON-RPC response goes out with. The spec pins the
// malformed case to 400; everything else, including in-band JSON-RPC errors
// like an unknown tool, stays 200.
//
// SINGLE messages only. A batch has no one request whose status this could
// describe, and a batch of five where the third is malformed is not a bad
// batch. Those keep 200 and carry the per-message error in the array, which is
// how JSON-RPC batching works everywhere else.
export function mcpHttpStatus(payload) {
  return !Array.isArray(payload) && missingRequiredMeta(payload) ? 400 : 200;
}

// The refusal a client retries from. `data.supported` is the load-bearing part:
// without it the client has nothing to fall back to. This shape is ALSO how a
// dual-era client recognises a modern server at all, so it is a protocol
// feature rather than a courtesy.
export function unsupportedVersion(id, requested) {
  return { jsonrpc: "2.0", id, error: {
    code: ERR_UNSUPPORTED_PROTOCOL,
    message: "Unsupported protocol version",
    data: { supported: MCP_SUPPORTED, requested },
  } };
}

// 2026-07-28 requires Mcp-Method and Mcp-Name on Streamable HTTP POSTs so an
// intermediary can route and authorize without parsing a JSON-RPC body.
//
// DELIBERATE DEVIATION, shared by both servers: validated when present, never
// required. Requiring them would reject every legacy client at the transport
// layer, which is exactly the "Legacy client, Modern server -> Fails" row of the
// spec's own compatibility matrix — the row a dual-era server exists to avoid.
// A MISMATCH is still an error, because a header disagreeing with the body is
// the precise case the header exists to prevent: a proxy authorizing
// `tools/list` while the body calls a tool.
export function headerMismatch(msg, request) {
  const method = request.headers.get("mcp-method");
  if (method && msg?.method && method !== msg.method) {
    return `Mcp-Method header says ${method} but the body calls ${msg.method}`;
  }
  const name = request.headers.get("mcp-name");
  const target = msg?.params?.name || msg?.params?.uri;
  if (name && target && name !== target) {
    return `Mcp-Name header says ${name} but the body targets ${target}`;
  }
  return null;
}

// CORS headers both servers answer with. mcp-session-id stays allowed even
// though 2026-07-28 removed sessions and neither server ever had one: a legacy
// client may still send it, and failing its preflight over a header we intend
// to ignore would break it for no gain.
export function mcpCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, mcp-method, mcp-name, authorization",
    "access-control-max-age": "86400",
  };
}

// ── result construction ─────────────────────────────────────────────

// Binds the protocol helpers to one server's identity, so `serverInfo` is
// stated once per server instead of threaded through every call site.
//
// Results carry `resultType` and `_meta` serverInfo UNCONDITIONALLY, including
// to legacy callers. Safe in both directions: JSON-RPC clients ignore unknown
// result fields, and the spec tells modern clients to read a missing
// `resultType` as "complete" anyway. One code path beats two that must agree.
export function mcpServer({ serverInfo, capabilities, instructions }) {
  const result = (id, payload, cache) => ({ jsonrpc: "2.0", id, result: {
    resultType: "complete",
    ...payload,
    ...cache,
    _meta: { [META_SERVER_INFO]: serverInfo },
  } });

  return {
    serverInfo,
    capabilities,
    instructions,
    result,

    // `server/discover`, which the spec says servers MUST implement. Identity,
    // capabilities and supported versions in one round trip, so a client can
    // render what a server is without probing tools/list + resources/list +
    // prompts/list separately.
    discover: (id) => result(id, {
      supportedVersions: MCP_SUPPORTED,
      capabilities,
      instructions,
    }, CACHE_STATIC),

    // The legacy handshake. Kept because deleting it strands every pre-2026
    // client; answered in the legacy era only (see MCP_LEGACY_DEFAULT).
    initialize: (id, requested) => ({ jsonrpc: "2.0", id, result: {
      protocolVersion: MCP_LEGACY.includes(requested) ? requested : MCP_LEGACY_DEFAULT,
      capabilities,
      serverInfo,
      instructions,
    } }),
  };
}

// The gate every request passes before dispatch: version, then the required
// modern `_meta`, then headers. Returns a JSON-RPC error to send, or null to
// proceed. Shared so the two servers cannot diverge on which requests they
// refuse.
//
// Version goes FIRST so a caller on a version we do not speak is told that,
// rather than being told its `_meta` is malformed under a revision it was never
// claiming to follow. The two would be equally "correct" refusals and only one
// of them is actionable.
export function mcpGate(msg, request, id, hasId) {
  const declared = declaredVersion(msg);
  if (declared && !MCP_SUPPORTED.includes(declared)) {
    return hasId ? unsupportedVersion(id, declared) : null;
  }
  const missing = missingRequiredMeta(msg);
  if (missing) return hasId ? malformedRequest(id, missing) : null;
  const mismatch = headerMismatch(msg, request);
  if (mismatch) {
    return hasId
      ? { jsonrpc: "2.0", id, error: { code: ERR_HEADER_MISMATCH, message: mismatch } }
      : null;
  }
  return null;
}
