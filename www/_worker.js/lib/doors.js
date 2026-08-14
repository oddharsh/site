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
// Everything goes through lensFetch/lensProbe, so every request inherits the
// SSRF guards (http(s) only, no localhost/private/link-local/169.254.169.254,
// ports 80/443), the 8s timeout, the byte cap, and the AadharshBot signature.
// This module adds no new way to reach the network.
import { botHeaders } from "./botauth.js";
import { CANONICAL_HOST } from "./const.js";
import { MCP_MODERN, META_PROTOCOL, META_CLIENT_CAPS } from "./mcp-protocol.js";
import { lensProbe, originDiscovery } from "../lens.js";

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
  if (!schema || typeof schema !== "object") return { schema: null };
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
export async function foreignMcpTools(origin, env, opts = {}) {
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
  try {
    const headers = await botHeaders(url, env, {
      headers: {
        "content-type": "application/json",
        // Both framings, because the server picks. DeepWiki refuses a
        // JSON-only Accept outright (406, "Client must accept both") rather
        // than downgrading to the one framing we said we could read.
        accept: "application/json, text/event-stream",
        "mcp-method": LIST_METHOD,
      },
      method: "POST",
      sign: !isSelf,
    });
    const selfReq = isSelf ? new Request(url, { method: "POST", headers, body }) : null;
    const res = isSelf
      ? await (env.SELF_FETCH ? env.SELF_FETCH(selfReq) : env.ASSETS.fetch(selfReq))
      : await fetch(url, { method: "POST", headers, body, redirect: "follow", signal: controller.signal, cf: { cacheTtl: 0 } });
    const parsed = parseMcpBody(await res.text(), res.headers.get("content-type"));
    if (!parsed.ok) return { ok: false, detail: parsed.detail };
    const payload = parsed.payload;
    // The RPC error is read BEFORE the status, because the interesting refusals
    // arrive on a 400: -32020 (header mismatch) and -32022 (unsupported
    // revision) both carry the one sentence that says what to fix, and "HTTP
    // 400" would throw it away.
    if (payload?.error) return { ok: false, detail: `${payload.error.code}: ${String(payload.error.message).slice(0, 80)}` };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const tools = Array.isArray(payload?.result?.tools) ? payload.result.tools : [];
    return {
      ok: true,
      count: tools.length,
      tools: tools.slice(0, DOOR_LIMITS.tools).map((tool) => {
        const row = {
          name: String(tool?.name || "").slice(0, 60),
          description: trim(tool?.description, DOOR_LIMITS.toolDesc),
        };
        if (!opts.schemas) return row;
        const capped = capSchema(tool?.inputSchema);
        row.inputSchema = capped.schema;
        if (capped.oversize) row.schemaOversize = capped.bytes;
        if (tool?.title) row.title = String(tool.title).slice(0, 80);
        // Annotations are forwarded as the server WROTE them, including the
        // absence of any. The pane labels them as claims; normalising a missing
        // set into a default here would manufacture a claim nobody made.
        if (tool?.annotations && typeof tool.annotations === "object") row.annotations = tool.annotations;
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

