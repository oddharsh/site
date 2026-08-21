// lib/doors.js — read what is actually BEHIND another origin's agent doors.
//
// /lens knocks: it reports that a site has an llms.txt, that /mcp answers
// JSON-RPC, that the page negotiates Markdown. It never walks through. That is
// the right scope for an observatory — the verdict is the product — but it means
// nothing on this site has ever READ a third party the way it reads itself.
//
// This module walks through. Same doors the terminal uses on aadhar.sh, pointed
// somewhere else: llms.txt, the Markdown twin at the page's own URL, the agent
// card, the API catalog, and an MCP server's actual tools/list.
//
// ── what this deliberately does NOT do ────────────────────────────────────
// It never calls a foreign tool. tools/list is a READ — it asks a server to
// describe itself, which is what the endpoint is for. tools/call is execution on
// somebody else's infrastructure, and an agent that wanders the web invoking
// strangers' tools because a sentence suggested it is a different product with a
// different threat model. The catalog is rendered as information; nothing here
// can invoke it.
//
// The origin-level doors go through lensFetch/lensProbe, so those requests
// inherit the SSRF guards (http(s) only, no localhost/private/link-local/
// 169.254.169.254, ports 80/443), the 8s timeout, the byte cap, and the
// AadharshBot signature. tools/list is the one exception, because it needs a
// POST body that lensFetch cannot express, so it re-states each of those bounds
// itself rather than inheriting them, per-hop redirect validation included.
// This module adds no new way to reach the network.
import { botHeaders } from "./botauth.ts";
import { CANONICAL_HOST } from "./const.ts";
import { fetchFollowingPublicRedirects, readResponseCapped, validateLensTarget } from "./crawl.ts";
import { ERR_HEADER_MISMATCH, MCP_MODERN, META_PROTOCOL, META_CLIENT_CAPS } from "./mcp-protocol.ts";
import { lensProbe, originDiscovery } from "../lens.ts";
import { asRecord, asText } from "./parse.ts";

// Bounds. A door reader that follows whatever it finds is a crawler; these keep
// it to one hop and a readable amount of text.
export const DOOR_LIMITS = {
  corpus: 6000,     // characters of third-party text handed to a model
  tools: 24,        // foreign tools listed
  toolDesc: 160,    // characters per foreign tool description
  // Argument schemas, and only when a caller asks for them. A schema is
  // arbitrary third-party JSON of no stated size — mcp.context7.com ships tool
  // descriptions over a kilobyte on their own — so it is bounded like every
  // other foreign string here rather than trusted to be small.
  schemaBytes: 6000,
  // An /ask answer. Results are bounded because a foreign server chooses how
  // many to send, and each one carries a schema.org object of no stated size.
  askResults: 10,
  askText: 240,      // characters per foreign name/description
  askSchemaBytes: 4000,
};

/**
 * Keep a foreign inputSchema only when it is small enough to be worth carrying.
 *
 * Truncating JSON is not an option: half a schema is not a schema, and a form
 * built from one would silently describe the wrong contract. So this is
 * all-or-nothing and REPORTS the drop, which lets the pane say "this tool's
 * schema was too large to carry" instead of "this tool takes no arguments".
 * Those are opposite claims and the second one is a lie.
 */
function capSchema(schema) {
  if (!asRecord(schema) && !Array.isArray(schema)) return { schema: null };
  let encoded;
  try { encoded = JSON.stringify(schema); } catch { return { schema: null, oversize: false }; }
  if (encoded.length > DOOR_LIMITS.schemaBytes) return { schema: null, oversize: true, bytes: encoded.length };
  return { schema };
}

const trim = (text, max) => {
  const value = String(text || "").replace(/\r/g, "").trim();
  return value.length > max ? value.slice(0, max) + "\n…[truncated]" : value;
};

// The method travels in two places on a modern request, and a server is
// entitled to refuse a request whose header disagrees with its body (-32020 is
// exactly that check). One constant, so they cannot.
const LIST_METHOD = "tools/list";

// A catalogue is text a stranger controls, so it is read from the stream with a
// ceiling rather than buffered whole. 256 KB is roughly 9x the largest catalogue
// on hand: measured 2026-08-14, this site's own 24 tools are 28,471 bytes, and
// the four foreign servers in the tests run 1.5-7 KB. Big enough that no honest
// server trips it, small enough that a hostile or broken one cannot spend the
// isolate's memory.
const CATALOG_CAP = 256 * 1024;

/**
 * Render whatever a server put in `error` as one readable line.
 *
 * A JSON-RPC error is `{code, message}`. Plenty of things that answer an MCP
 * endpoint are not JSON-RPC and say so in their own dialect: an OAuth challenge
 * body is `{error: "invalid_token", error_description: "…"}`, and a vendor API
 * error is `{error: {type, message}}` with no code. Reading `.code`/`.message`
 * off those printed the literal string "undefined: undefined" into the frame,
 * which is worse than saying nothing — measured on eight live servers
 * (Notion, Sentry, Linear, PayPal, Neon, Webflow, Canva, Grafana) 2026-08-14.
 */
export function rpcErrorDetail(payload) {
  const error = payload && payload.error;
  const code = Number.isInteger(error && error.code) ? error.code : null;
  const message = String(
    (error && error.message)
    || (payload && payload.error_description)
    || asText(error, "")
    || "",
  ).trim();
  if (code !== null) return `${code}: ${message.slice(0, 80) || "no message"}`;
  if (message) return message.slice(0, 90);
  // Something was there and none of the known shapes fit. Say what it was
  // rather than inventing a verdict about it.
  try { return JSON.stringify(error).slice(0, 90); } catch { return "an error with no readable message"; }
}

// A version header some servers require and others refuse. See the call site.
const PROTOCOL_HEADER = "mcp-protocol-version";

/**
 * Did the server refuse us for want of the version HEADER specifically?
 *
 * Narrow on purpose. It matches the refusal that names the header, never a
 * generic -32020 and never an unsupported-version complaint, because those two
 * are answers rather than instructions: retrying either one sends the same
 * request and gets the same refusal, one round trip later.
 */
export function wantsProtocolHeader(payload) {
  const error = payload && payload.error;
  if (!error || error.code !== ERR_HEADER_MISMATCH) return false;
  return new RegExp(PROTOCOL_HEADER.replace(/-/g, "[- ]?"), "i").test(String(error.message || ""));
}

/**
 * A door that is there and locked.
 *
 * The scheme is read from WWW-Authenticate when the server sends one, because
 * "needs OAuth" tells a reader what to go and get while "HTTP 401" does not.
 */
export function gatedDoor(res): { ok: false; unreadable: true; gated: true; detail: string } {
  const challenge = String((res.headers && res.headers.get("www-authenticate")) || "").trim();
  const how = /oauth|resource_metadata/i.test(challenge)
    ? "OAuth"
    : challenge ? challenge.split(/[\s,;]/)[0] : "credentials";
  return { ok: false, unreadable: true, gated: true, detail: `needs ${how} (HTTP ${res.status})` };
}

/**
 * Read a Streamable HTTP answer, whichever framing the server chose.
 *
 * A server may answer one JSON object or an SSE stream, at its own discretion
 * and without announcing which in advance, so a client that only handles JSON
 * reports half the ecosystem as broken. mcp.deepwiki.com answers
 * text/event-stream, measured 2026-08-14.
 *
 * The content-type is a hint rather than the rule: a stream served under the
 * wrong type is still a stream, and a `data:` line is unambiguous. Pure and
 * exported because the framings are the whole behaviour worth testing here and
 * every live probe fails at signing before a test can reach one.
 */
export function parseMcpBody(text, contentType) {
  const type = String(contentType || "").toLowerCase();
  const body = String(text || "");
  if (type.includes("text/event-stream") || /^[ \t]*(?:event|data):/m.test(body)) {
    for (const line of body.split(/\r?\n/)) {
      const match = /^data:[ \t]?(.*)$/.exec(line);
      if (!match) continue;
      try {
        const value = JSON.parse(match[1]);
        // A stream carries comments, keep-alives and notifications alongside
        // the answer, so the first line that PARSES is not necessarily the
        // message. The `jsonrpc` member is what makes it one.
        if (value && value.jsonrpc) return { ok: true, payload: value, framing: "sse" };
      } catch { /* keep reading the stream */ }
    }
    return { ok: false, detail: "SSE stream carried no JSON-RPC message" };
  }
  try { return { ok: true, payload: JSON.parse(body), framing: "json" }; }
  catch { return { ok: false, detail: `answered ${type.split(";")[0] || "no content-type"}, not JSON` }; }
}

/**
 * tools/list against a foreign MCP server.
 *
 * A POST with a body, which signedFetch cannot express (it forwards `method` but
 * not `body`), so the signature headers are built directly and the fetch is made
 * here. The request is still signed and still identifies as AadharshBot — the
 * point of knocking on someone's endpoint under your own name.
 *
 * Stateless-revision shaped on purpose: one POST carrying `_meta`, no
 * initialize handshake, no session id to keep. A legacy server that demands the
 * handshake answers an error, and that error is reported rather than retried —
 * the retry would be a second round trip to learn something the frame can say in
 * a line.
 *
 * ── a permissive server does not license a lax client ─────────────────────
 * Our own /mcp validates `Mcp-Method` when present and never requires it,
 * because requiring it would reject every legacy client at the transport layer.
 * That is a dual-era SERVER's job. A client has the opposite one: the header
 * exists so an intermediary can route on the method without parsing the body,
 * and the strict half of the ecosystem enforces it. Measured 2026-08-14, both
 * mcp.context7.com and docs.mcp.cloudflare.com answer 400 -32020 without it and
 * 200 with it. Sending it is free; omitting it made three well-known live
 * servers read as broken doors.
 *
 * `opts.schemas` additionally carries each tool's inputSchema, title and
 * annotations. OFF by default, because the three existing callers render a
 * catalogue as prose and a schema would be dead weight in a terminal frame. The
 * Tools lens turns it on: a schema is the only thing a form can be built from.
 */
// The result is one of several shapes: a tool list, an unreadable door with a
// reason, or a GATED one carrying `gated: true` and the scheme. Declaring the
// open record is what lets a caller read `gated` without tsc picking one arm of
// the union and calling the others typos. The probe's whole job is reporting
// WHICH of those happened, so every caller reads a field some arm lacks.
export async function foreignMcpTools(origin, env, opts: { schemas?: boolean } = {}): Promise<Record<string, any>> {
  const url = origin.replace(/\/+$/, "") + "/mcp";
  // Both `_meta` keys are REQUIRED on a modern request. `clientCapabilities` is
  // empty because this probe reads a catalogue and offers the server nothing:
  // no roots, no sampling, no elicitation. Sending it matters twice over — a
  // strict foreign server is entitled to refuse us with -32602 without it, and
  // the self-scan below loops back into our own /mcp, which does exactly that.
  // The values come from the server module so this client cannot advertise a
  // revision the site itself has stopped speaking.
  const body = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: LIST_METHOD,
    params: { _meta: {
      [META_PROTOCOL]: MCP_MODERN,
      [META_CLIENT_CAPS]: {},
    } },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  // Pointing this at aadhar.sh is the first thing anybody will try, and over the
  // network that request loops back into this same Worker — which Cloudflare
  // kills with a 522, so a self-scan would report its own MCP server as down.
  // lensFetch already solves this by dispatching through SELF_FETCH; the POST
  // cannot reuse lensFetch (no body), so the same escape hatch is mirrored here.
  // Self-dispatch never leaves Cloudflare, so it needs no wire signature either,
  // which is also why a self-scan works in local dev without the signing key.
  let isSelf = false;
  try { isSelf = new URL(url).hostname.toLowerCase() === CANONICAL_HOST && !!(env.SELF_FETCH || env.ASSETS); } catch { /* not self */ }

  const send = async (extra) => {
    const headers = await botHeaders(url, env, {
      headers: {
        "content-type": "application/json",
        // Both framings, because the server picks. DeepWiki refuses a
        // JSON-only Accept outright (406, "Client must accept both") rather
        // than downgrading to the one framing we said we could read.
        accept: "application/json, text/event-stream",
        "mcp-method": LIST_METHOD,
        ...extra,
      },
      method: "POST",
      sign: !isSelf,
    });
    if (isSelf) {
      const selfReq = new Request(url, { method: "POST", headers, body });
      return { res: await (env.SELF_FETCH ? env.SELF_FETCH(selfReq) : env.ASSETS.fetch(selfReq)) };
    }
    // Per-hop validation, not redirect:"follow", for the reason lensFetch
    // already gives: the allowlist vetted the origin the visitor typed, and a
    // 302 from there is a NEW target nobody vetted. Under "follow" that hop
    // was taken and its body read, so a public host could hand this POST to
    // an address validateLensTarget exists to refuse. A refused hop reads as
    // an unreachable target, which is what it is.
    const followed = await fetchFollowingPublicRedirects(
      url,
      { method: "POST", headers, body, signal: controller.signal, cf: { cacheTtl: 0 } },
      (candidate) => validateLensTarget(candidate),
    );
    if (!followed.ok) return { blocked: true };
    return { res: followed.response };
  };

  const read = async (res) => {
    const got = await readResponseCapped(res, CATALOG_CAP);
    // OUR ceiling, so it is reported as ours. A truncated catalogue would fail
    // to parse and read out as "that is not JSON", which blames a server that
    // answered correctly at a length we declined to read — the same rule the
    // browser lens follows when it reports a spent render budget as our own
    // rather than as the target failing.
    if (got.truncated) return { over: true };
    return parseMcpBody(got.text, res.headers.get("content-type"));
  };

  try {
    let sent = await send(null);
    if (sent.blocked) return { ok: false, unreadable: true, detail: "redirected somewhere this reader will not follow" };
    let res = sent.res;

    // 401/403 is neither a broken server nor an absent one: the door is there
    // and it wants a key this reader does not have. lens already reports the
    // same status as an OAuth-protected server when it KNOCKS, and doors used
    // to contradict it one line later — Cloudflare's six servers answer an
    // empty-bodied 401 and read as "not JSON", while Notion, Sentry, Linear and
    // PayPal answer an OAuth challenge body and read as "undefined: undefined".
    // Eleven live servers, measured 2026-08-14. UNREADABLE rather than shut,
    // because we did not get to look, which is the whole distinction this
    // module exists to keep.
    if (res.status === 401 || res.status === 403) return gatedDoor(res);

    let parsed = await read(res);
    if ("over" in parsed) return { ok: false, unreadable: true, detail: `catalogue over ${CATALOG_CAP / 1024} KB — not read` };

    // Some servers require the revision as a HEADER as well as in `_meta` and
    // refuse without it (mcp.svelte.dev: -32020 "MCP-Protocol-Version is
    // required"). Sending it unconditionally is NOT the fix — mcp.deepwiki.com
    // and mcp.exa.ai serve happily WITHOUT it and refuse the byte-identical
    // request WITH it, because they validate the header against their own
    // supported list and neither speaks 2026-07-28. All three measured
    // 2026-08-14. So it goes only to a server that has just said it needs one,
    // which costs a round trip on nobody who works without it, and it carries
    // the version the body already declared because a header disagreeing with
    // the body is the other half of what -32020 refuses.
    if (parsed.ok && wantsProtocolHeader(parsed.payload)) {
      sent = await send({ [PROTOCOL_HEADER]: MCP_MODERN });
      if (sent.blocked) return { ok: false, unreadable: true, detail: "redirected somewhere this reader will not follow" };
      res = sent.res;
      if (res.status === 401 || res.status === 403) return gatedDoor(res);
      parsed = await read(res);
      if ("over" in parsed) return { ok: false, unreadable: true, detail: `catalogue over ${CATALOG_CAP / 1024} KB — not read` };
    }

    if (!parsed.ok) return { ok: false, detail: parsed.detail };
    const payload = parsed.payload;
    // The RPC error is read BEFORE the status, because the interesting refusals
    // arrive on a 400: -32020 (header mismatch) and -32022 (unsupported
    // revision) both carry the one sentence that says what to fix, and "HTTP
    // 400" would throw it away.
    if (payload?.error) return { ok: false, detail: rpcErrorDetail(payload) };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const tools = Array.isArray(payload?.result?.tools) ? payload.result.tools : [];
    return {
      ok: true,
      count: tools.length,
      tools: tools.slice(0, DOOR_LIMITS.tools).map((tool) => {
        const toolRecord = asRecord(tool) || {};
        const row: {
          name: string;
          description: string;
          inputSchema?: unknown;
          schemaOversize?: number;
          title?: string;
          annotations?: Record<string, unknown>;
        } = {
          name: String(toolRecord.name || "").slice(0, 60),
          description: trim(toolRecord.description, DOOR_LIMITS.toolDesc),
        };
        if (!opts.schemas) return row;
        const capped = capSchema(toolRecord.inputSchema);
        row.inputSchema = capped.schema;
        if (capped.oversize) row.schemaOversize = capped.bytes;
        if (toolRecord.title) row.title = String(toolRecord.title).slice(0, 80);
        // Annotations are forwarded as the server WROTE them, including the
        // absence of any. The pane labels them as claims; normalising a missing
        // set into a default here would manufacture a claim nobody made.
        const annotations = asRecord(toolRecord.annotations);
        if (annotations) row.annotations = annotations;
        return row;
      }),
    };
  } catch (error) {
    // Same distinction as readable() above: a thrown request never reached the
    // server, so it says nothing about whether that server exists. A body we
    // DID receive and could not parse is a finding about them, not about us,
    // and is reported as a shut door above rather than as an unreadable one.
    return { ok: false, unreadable: true, detail: String(error?.message || error).slice(0, 80) };
  } finally { clearTimeout(timer); }
}


// ── NLWeb: reading an /ask answer ───────────────────────────────────────────
// The catalogue read above asks an MCP server to DESCRIBE itself, which costs
// it a lookup in memory. This one asks a stranger's retrieval endpoint an
// actual question, and that is a materially different favour to ask: on an
// NLWeb instance backed by a vector store and an LLM, one call spends their
// embedding budget and possibly a model call.
//
// So three politenesses are structural rather than optional. `mode=list` is
// sent EXPLICITLY, because it is the one mode the spec defines as pure
// retrieval and the default could be reconfigured server-side. `streaming=0`
// asks for a single JSON body. And the route above this caches, so a public
// button cannot re-ask the same origin the same question on every click.
//
// What comes back is reported as SHAPE rather than as an answer. The interesting
// question about a foreign /ask is not what it said, it is whether what it said
// carries the six fields NLWeb's result contract names — a server can return
// beautiful prose and no `schema_object` at all, and then an agent has a
// paragraph where it was promised structured data.
const ASK_CAP = 512 * 1024;
const ASK_FIELDS = ["url", "name", "site", "score", "description", "schema_object"];

export type ForeignNlwebProbe =
  | { ok: false; unreadable?: boolean; gated?: boolean; detail: string }
  | {
      ok: true;
      total: number;
      framing: string;
      dialect: string;
      coverage: Record<string, number>;
      [field: string]: unknown;
    };

/**
 * Read one foreign origin's /ask endpoint.
 *
 * Returns the same three-state shape as foreignMcpTools, for the same reason:
 * shut (there is no endpoint), unreadable (we never got to look), or ok.
 */
export async function foreignNlwebAsk(origin, env, opts: { query?: string } = {}): Promise<ForeignNlwebProbe> {
  const base = origin.replace(/\/+$/, "") + "/ask";
  const query = String(opts.query || "").trim().slice(0, 200) || "what is this site about";
  const url = `${base}?query=${encodeURIComponent(query)}&streaming=0&mode=list`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  // Same loopback escape as the catalogue read: over the network a request to
  // our own hostname is killed with a 522, so a self-scan would report this
  // origin's own /ask as down.
  let isSelf = false;
  try { isSelf = new URL(url).hostname.toLowerCase() === CANONICAL_HOST && !!(env.SELF_FETCH || env.ASSETS); } catch { /* not self */ }

  try {
    // Both framings on Accept. A server is entitled to stream even when asked
    // not to, and one that does is answering rather than failing.
    const headers = await botHeaders(url, env, {
      headers: { accept: "application/json, text/event-stream" },
      method: "GET",
      sign: !isSelf,
    });

    let res;
    if (isSelf) {
      const selfReq = new Request(url, { method: "GET", headers });
      res = await (env.SELF_FETCH ? env.SELF_FETCH(selfReq) : env.ASSETS.fetch(selfReq));
    } else {
      const followed = await fetchFollowingPublicRedirects(
        url,
        { method: "GET", headers, signal: controller.signal, cf: { cacheTtl: 0 } },
        (candidate) => validateLensTarget(candidate),
      );
      if (!followed.ok) return { ok: false, unreadable: true, detail: "redirected somewhere this reader will not follow" };
      res = followed.response;
    }

    if (res.status === 401 || res.status === 403) return gatedDoor(res);
    if (res.status === 404) return { ok: false, detail: "no /ask" };

    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    // An /ask that answers HTML is a PAGE at that path, not an endpoint. This is
    // the single most common false positive in the door probe, and calling it a
    // shut door rather than a broken one is the honest reading.
    if (/text\/html/.test(contentType)) return { ok: false, detail: "HTML at /ask (a page, not an endpoint)" };

    const got = await readResponseCapped(res, ASK_CAP);
    if (got.truncated) return { ok: false, unreadable: true, detail: `answer over ${ASK_CAP / 1024} KB — not read` };

    const framing = /event-stream/.test(contentType) || /^\s*(event|data):/m.test(got.text) ? "sse" : "json";
    const parsed = framing === "sse" ? parseAskStream(got.text) : parseAskJson(got.text);
    if (!parsed.ok) {
      // A non-2xx that also failed to parse is reported by STATUS, because "not
      // JSON" describes an error page rather than the server's behaviour.
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      return { ok: false, detail: parsed.detail };
    }
    if (!res.ok && !parsed.results.length) return { ok: false, detail: `HTTP ${res.status}` };

    return { ok: true, endpoint: base, query, framing, dialect: parsed.dialect, ...gradeAskResults(parsed) };
  } catch (error) {
    return { ok: false, unreadable: true, detail: String(error?.message || error).slice(0, 80) };
  } finally { clearTimeout(timer); }
}

/** The single-body answer: `{query_id, ...attrs, results:[...]}`. */
function parseAskJson(text) {
  let payload;
  try { payload = JSON.parse(text); } catch { return { ok: false, detail: "that is not JSON" }; }
  const record = asRecord(payload);
  if (!record) return { ok: false, detail: "the answer is not a JSON object" };
  const results = Array.isArray(record.results) ? record.results
    // ItemList is the richer structure the spec says results are moving to, so
    // a server that has already moved is read rather than called malformed.
    : Array.isArray(record.itemListElement) ? record.itemListElement
      : null;
  if (!results) return { ok: false, detail: "no `results` array in the answer" };
  return { ok: true, dialect: "json", queryId: asText(record.query_id), results, attributes: Object.keys(record).filter((k) => k !== "results") };
}

/**
 * The streamed answer, in either of the two dialects the reference server
 * emits. They are genuinely different wire formats and which one arrives says
 * something real about the server, so the dialect is reported rather than
 * normalised away:
 *
 *   legacy  data: {"message_type":"result","content":[...]}
 *   v0.55   event: result\n data: {"index":0,"item":{...}}
 */
function parseAskStream(text) {
  const results = [];
  const seen = new Set();
  let queryId;
  let named = false;

  for (const block of text.split(/\n\n+/)) {
    const eventName = (block.match(/^event:\s*(.+)$/m) || [])[1]?.trim();
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!data) continue;
    let frame;
    try { frame = JSON.parse(data); } catch { continue; }
    const record = asRecord(frame);
    if (!record) continue;
    if (eventName) { named = true; seen.add(eventName); }
    const type = asText(record.message_type);
    if (type) seen.add(type);
    queryId = queryId || asText(record.query_id) || asText(record.conversation_id);
    if (eventName === "result" && asRecord(record.item)) results.push(record.item);
    else if (Array.isArray(record.content)) results.push(...record.content);
    else if (Array.isArray(record.results)) results.push(...record.results);
  }

  if (!results.length && !seen.size) return { ok: false, detail: "no readable SSE frames" };
  return { ok: true, dialect: named ? "v0.55" : "legacy", queryId, results, events: [...seen].slice(0, 12), attributes: [] };
}

/**
 * Grade the results against NLWeb's own contract, per field.
 *
 * Counting per FIELD rather than reporting a pass is the point: partial
 * conformance is the normal case, and "8 of 10 results carry a schema_object"
 * is the sentence an agent author actually needs.
 */
function gradeAskResults(parsed) {
  const coverage = Object.fromEntries(ASK_FIELDS.map((f) => [f, 0]));
  const types = new Map();
  let schemaBytes = 0;

  for (const raw of parsed.results) {
    const item = asRecord(raw) || {};
    for (const field of ASK_FIELDS) if (item[field] !== undefined && item[field] !== null && item[field] !== "") coverage[field] += 1;
    const schema = asRecord(item.schema_object);
    if (schema) {
      const t = schema["@type"] ?? schema.type;
      for (const name of (Array.isArray(t) ? t : [t]).filter(Boolean)) {
        const key = String(name).slice(0, 40);
        types.set(key, (types.get(key) || 0) + 1);
      }
      try { schemaBytes += JSON.stringify(schema).length; } catch { /* unserializable, counted as none */ }
    }
  }

  return {
    queryId: parsed.queryId,
    total: parsed.results.length,
    // The full set is graded; only a bounded slice is carried back, and the two
    // numbers are reported separately so a reader is never shown 10 of 10 for a
    // server that sent 400.
    shown: Math.min(parsed.results.length, DOOR_LIMITS.askResults),
    coverage,
    conformant: ASK_FIELDS.every((f) => coverage[f] === parsed.results.length) && parsed.results.length > 0,
    schemaTypes: [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
    schemaBytes,
    attributes: (parsed.attributes || []).slice(0, 12),
    events: parsed.events,
    results: parsed.results.slice(0, DOOR_LIMITS.askResults).map((raw) => {
      const item = asRecord(raw) || {};
      const row: {
        url?: string;
        name: string;
        site?: string;
        description: string;
        score?: number;
        schema_object?: Record<string, unknown>;
        schemaOversize?: number;
      } = {
        url: asText(item.url)?.slice(0, 300),
        name: trim(item.name, DOOR_LIMITS.askText),
        site: asText(item.site)?.slice(0, 80),
        description: trim(item.description, DOOR_LIMITS.askText),
      };
      const score = Number(item.score);
      if (Number.isFinite(score)) row.score = score;
      const schema = asRecord(item.schema_object);
      if (schema) {
        // All-or-nothing, exactly like capSchema above: half a schema.org object
        // describes something that does not exist.
        let json;
        try { json = JSON.stringify(schema); } catch { json = null; }
        if (json && json.length <= DOOR_LIMITS.askSchemaBytes) row.schema_object = schema;
        else row.schemaOversize = json ? json.length : 0;
      }
      return row;
    }),
  };
}

/**
 * Turn one probe into a door verdict. Pure, exported, and tested directly —
 * the three states it distinguishes are the whole honesty story of this module
 * and they are impossible to exercise through the network in a test, because
 * every external probe fails at signing before a stub can answer.
 *
 * SHUT and UNREADABLE are different answers and must never be merged. A 404
 * means the door is not there. A transport error means we never got to look —
 * locally that is the missing AadharshBot signing key, which fails EVERY
 * external probe, and reporting that as "not served" would have this thing
 * confidently announcing that well-known origins have no llms.txt. Reporting a
 * failed check as a negative result is the one dishonesty a reader like this
 * cannot afford.
 */
export function classifyDoor(probe, wanted) {
  if (probe?.error) return { ok: false, unreadable: true, why: String(probe.error).slice(0, 60) };
  if (!probe?.ok) return { ok: false, why: probe?.status ? `HTTP ${probe.status}` : "no answer" };
  if (!probe.body) return { ok: false, why: "empty" };
  const type = (probe.contentType || "").toLowerCase();
  // A 200 is not an answer either. Plenty of origins serve their SPA shell for
  // every unknown path, so an llms.txt request comes back 200 text/html, and
  // counting that as present would make this reader agree with every site that
  // has no agent surface at all.
  if (wanted && !type.includes(wanted)) return { ok: false, wrongType: type.split(";")[0] || "unknown type" };
  return { ok: true, text: trim(probe.body, DOOR_LIMITS.corpus), bytes: probe.body.length };
}

/**
 * Read every door on one target, in parallel.
 *
 * `target` must already have been through validateLensTarget — this module does
 * not re-derive the SSRF rules, it relies on the caller having applied them and
 * on lensFetch enforcing them again underneath.
 */
export async function readDoors(target, env) {
  const origin = new URL(target).origin;
  const hostname = new URL(target).hostname;
  // The origin-level doors come from lens's CACHED discovery rather than being
  // re-probed here. This module originally fetched llms.txt, the agent card and
  // the api-catalog itself, which duplicated four of lens's twenty-six probes —
  // wasteful, and worse, two surfaces on one site could disagree about the same
  // origin. One probe set, one answer, and a second read of the same host is now
  // free.
  //
  // tools/list stays separate because lens only ever KNOCKS on /mcp (it infers a
  // verdict from the status code); walking through and reading the catalog is
  // this module's whole reason to exist.
  const [markdown, disco, mcp] = await Promise.all([
    // The Markdown twin at the PAGE's own URL, not the origin's: negotiation is
    // per-document, and asking the front door about a deep link answers for the
    // front door. This is the one door whose answer is the page you asked for.
    lensProbe(target, env, "text/markdown"),
    originDiscovery(origin, hostname, env),
    foreignMcpTools(origin, env),
  ]);
  const { llms, agentCard, apiCatalog } = disco;

  // SHUT and UNREADABLE are different answers and the frame must not merge them.
  // A 404 means the door is not there. A transport error means we never got to
  // look — locally that is the missing AadharshBot signing key, which fails
  // EVERY external probe, and reporting that as "shut" would have this thing
  // confidently announcing that well-known origins serve no llms.txt. Reporting
  // a failed check as a negative result is the one dishonesty a tool like this
  // cannot afford.
  const readable = classifyDoor;

  return {
    origin,
    target,
    markdown: readable(markdown, "markdown"),
    llms: readable(llms, "text/plain"),
    agentCard: readable(agentCard, "json"),
    apiCatalog: readable(apiCatalog, "json"),
    mcp,
  };
}
