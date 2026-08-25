// lib/agent-webmcp.js — the tools a page hands an agent once it RUNS.
//
// /lens has read agent tool catalogs since the Tools tab shipped, and that tab
// reads `/mcp`: a SERVER catalog, fetched over HTTP, available to anything that
// can POST. This module reads the other one.
//
// WebMCP tools exist only inside a document. A page registers them into
// `document.modelContext` with its own JavaScript, so nothing you can fetch will
// ever tell you they are there, and an origin whose entire agent surface is
// browser-local reads as having no tools at all over HTTP. Getting at them
// requires actually running the page, which is why this rides the CDP session
// /lens/wire already opens rather than being a route of its own: no extra
// browser instance, no extra minute against the 10-a-day account ceiling.
//
// ── the split this reports, and why it is the interesting number ──────────
// Chrome carries exactly ONE of MCP's five tool annotations across registration
// (`readOnlyHint`; `destructiveHint`, `idempotentHint`, `openWorldHint` and
// `title` are all discarded, and an `untrustedContentHint` that is in no MCP
// spec is added). Measured on Chrome 152, 2026-08-25.
//
// So "3 read, 7 write" is the most a visitor can be told about what a stranger's
// page will let an agent do, and a tool that states nothing is a THIRD state
// rather than a safe one. `unstated` is reported separately for that reason: an
// absent hint means the page never said, and folding it into either column
// would invent a claim the page did not make.
//
// ── it never calls anything ───────────────────────────────────────────────
// The probe reads `getTools()` and stops. Executing a stranger's tool from a
// render this site initiated would be exactly the remote-code-execution proxy
// lens-recipes.ts refuses to become, one layer further in, and the tool being
// named `delete_document` would not stop it. A contract test asserts the string
// `executeTool` never appears in this file.

// Caps. A catalog is a stranger's data and lands in a JSON payload this site
// serves, so every axis is bounded rather than trusted.
import { asList, asNumber, asRecord } from "./parse.ts";

export const WEBMCP_LIMITS = { tools: 40, description: 300, params: 12, name: 80 };

// Read as ONE expression, evaluated with awaitPromise: true, because
// `getTools()` is async. That async-ness is the reason this cannot be an
// addScriptTag recipe like the /lens/browser ones: those are synchronous by
// construction and the capture does not wait for a promise.
export const WEBMCP_PROBE = `(async () => {
  try {
    var mc = document.modelContext;
    if (!mc || typeof mc.getTools !== "function") return JSON.stringify({ present: false });
    var tools = await mc.getTools();
    if (!Array.isArray(tools)) return JSON.stringify({ present: true, count: 0, tools: [] });
    var cap = ${WEBMCP_LIMITS.tools}, dcap = ${WEBMCP_LIMITS.description}, pcap = ${WEBMCP_LIMITS.params};
    var hint = function (t) {
      var a = t && t.annotations;
      return a && typeof a.readOnlyHint === "boolean" ? a.readOnlyHint : null;
    };
    var params = function (t) {
      // inputSchema reads back as a JSON STRING even though registration
      // requires an object. Parsing it is the only way to name the arguments.
      try {
        var s = typeof t.inputSchema === "string" ? JSON.parse(t.inputSchema) : t.inputSchema;
        var p = s && s.properties;
        if (!p) return null;
        var keys = Object.keys(p).slice(0, pcap);
        var req = Array.isArray(s.required) ? s.required : [];
        return keys.map(function (k) { return { name: String(k).slice(0, 60), required: req.indexOf(k) >= 0 }; });
      } catch (e) { return null; }
    };
    var origins = {};
    tools.forEach(function (t) { if (t && t.origin) origins[String(t.origin).slice(0, 200)] = 1; });
    return JSON.stringify({
      present: true,
      count: tools.length,
      read: tools.filter(function (t) { return hint(t) === true; }).length,
      write: tools.filter(function (t) { return hint(t) === false; }).length,
      unstated: tools.filter(function (t) { return hint(t) === null; }).length,
      origins: Object.keys(origins),
      truncated: tools.length > cap,
      tools: tools.slice(0, cap).map(function (t) {
        return {
          name: String((t && t.name) || "").slice(0, ${WEBMCP_LIMITS.name}),
          title: String((t && t.title) || "").slice(0, ${WEBMCP_LIMITS.name}) || undefined,
          description: String((t && t.description) || "").slice(0, dcap),
          readOnly: hint(t),
          untrustedContent: t && t.annotations && typeof t.annotations.untrustedContentHint === "boolean"
            ? t.annotations.untrustedContentHint : null,
          origin: t && t.origin ? String(t.origin).slice(0, 200) : null,
          params: params(t),
        };
      }),
    });
  } catch (e) {
    return JSON.stringify({ probeError: String((e && e.message) || e).slice(0, 160) });
  }
})()`;

/**
 * Normalize what the probe returned. Anything unexpected becomes null rather
 * than a partial object, on this surface's standing rule: a check that did not
 * run is reported as absent, never as a negative result.
 * @param {unknown} raw
 */
export function readWebmcpProbe(raw) {
  const r = asRecord(raw);
  if (!r) return null;
  if (r.probeError) return { present: null, error: String(r.probeError).slice(0, 160) };
  if (r.present !== true) return { present: false, count: 0, tools: [] };
  const tools = asList(r.tools);
  const count = (value, fallback) => asNumber(value, fallback) ?? fallback;
  return {
    present: true,
    count: count(r.count, tools.length),
    read: count(r.read, 0),
    write: count(r.write, 0),
    unstated: count(r.unstated, 0),
    origins: asList(r.origins).slice(0, 8),
    truncated: r.truncated === true,
    tools,
  };
}
