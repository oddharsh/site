// lib/agent-webmcp.ts — the tools a page hands an agent once it RUNS.
//
// Chrome carries exactly ONE of MCP's five tool annotations across registration
// (`readOnlyHint`; `destructiveHint`, `idempotentHint`, `openWorldHint` and
// `title` are all discarded, and an `untrustedContentHint` that is in no MCP
// spec is added). Measured on Chrome 152, 2026-08-25.

import { asList, asNumber, asRecord, asScalarText, asText } from "./parse.ts";

export const WEBMCP_LIMITS = { tools: 40, description: 300, params: 12, name: 80 };

export const WEBMCP_PROBE = `(async () => {
  try {
    var mc = document.modelContext;
    // THE ENGINE IS A CONTROL. An engine with no WebMCP cannot see a catalogue,
    // so "no tools" from one is a fact about the instrument and not about the
    // page, and reporting the two the same way is exactly the false negative the
    // bot-view controls exist to prevent one tier down.
    if (!mc || typeof mc.getTools !== "function") return JSON.stringify({ supported: false });
    var tools = await mc.getTools();
    if (!Array.isArray(tools)) return JSON.stringify({ supported: true, present: true, count: 0, tools: [] });
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
      supported: true,
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

export type WebmcpReading = {
  supported?: boolean;
  present: boolean | null;
  error?: string;
  engine?: string;
  count?: number;
  read?: number;
  write?: number;
  unstated?: number;
  origins?: string[];
  truncated?: boolean;
  tools?: unknown[];
};

export function readWebmcpProbe(raw: unknown): WebmcpReading | null {
  const r = asRecord(raw);
  if (!r) return null;
  if (r.probeError) return { present: null, error: asScalarText(r.probeError).slice(0, 160) };
  if (r.supported === false) {
    return { supported: false, present: null, count: 0, tools: [] };
  }
  if (r.present !== true) return { supported: true, present: false, count: 0, tools: [] };
  const tools = asList(r.tools);
  const count = (value, fallback) => asNumber(value, fallback) ?? fallback;
  return {
    supported: true,
    present: true,
    count: count(r.count, tools.length),
    read: count(r.read, 0),
    write: count(r.write, 0),
    unstated: count(r.unstated, 0),
    origins: asList(r.origins).flatMap((raw) => { const origin = asText(raw); return origin ? [origin] : []; }).slice(0, 8),
    truncated: r.truncated === true,
    tools,
  };
}
