// lib/preview.ts: the guard that makes a Workers preview URL safe to hand out.
//
// A preview version runs production's bindings and secrets (the same KV, D1,
// R2 and RESEND_API_KEY); Cloudflare has no per-version override. So every
// preview response is marked noindex, and writes are refused: default-deny on
// unsafe methods, so a new POST route is blocked the day it is written. Reads
// stay open. Crons need no guard, since they fire on the active deployment only.

import { asText } from "./parse.ts";
import { GET_WRITES, PER_TOOL_WRITES } from "../routes.ts";

// Production has no workers.dev URL (`workersDev: false`), so the suffix is an
// exact test. Callers pass a parsed hostname, never the Host header, so a
// spoofed Host can't turn the guard off.
export function isPreviewHost(hostname) {
  return asText(hostname, "").toLowerCase().endsWith(".workers.dev");
}

// nofollow too: a preview's links are same-host, so one leaked URL would
// otherwise expose the whole duplicate tree.
export const PREVIEW_ROBOTS = "noindex, nofollow";

// /mcp admits POST so a preview can exercise the MCP server. Its writing tools
// are refused one layer down, by previewToolRefusal (`writes: "per-tool"`).
const SAFE_UNSAFE_METHODS = PER_TOOL_WRITES;

// GETs that write (/hit, the signed coffee and webmention decisions, the
// speculation beacon), declared on their routes as `writes: "get"` or
// `getWrites`. A contract test pins each entry against both route tables,
// because a stale path here protects nothing.
const UNSAFE_READS = GET_WRITES;

// For that contract test.
export const PREVIEW_GET_WRITES = UNSAFE_READS;

// Returns the 403 to serve, or null. Pure, so tests sweep the route table.
export function previewDenial(pathname, method) {
  const m = (method || "GET").toUpperCase();
  const safeMethod = m === "GET" || m === "HEAD";

  if (!safeMethod && !SAFE_UNSAFE_METHODS.has(pathname)) {
    return denial(`${m} is disabled on preview URLs.`);
  }
  if (safeMethod && UNSAFE_READS.has(pathname)) {
    return denial(`${pathname} writes production state and is disabled on preview URLs.`);
  }
  return null;
}

// Returns the refusal text for an MCP tool call, or null. It reads the tool's
// own `readOnlyHint: false` annotation, so a new writing tool is refused
// without an edit here. Both MCP servers call it.
export function previewToolRefusal(request, tools, name) {
  let hostname = "";
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return null;
  }
  if (!isPreviewHost(hostname)) return null;

  // An unknown name falls through to the dispatcher's -32602.
  const tool = (tools || []).find((t) => t && t.name === name);
  if (!tool || tool.annotations?.readOnlyHint !== false) return null;

  return (
    `${name} writes production state and is disabled on preview URLs. ` +
    "This is a Workers preview build of aadhar.sh, running against production " +
    "bindings and secrets. Read-only tools work."
  );
}

function denial(reason) {
  return new Response(
    `${reason}\n\n` +
      "This is a Workers preview build of aadhar.sh. It runs against production\n" +
      "bindings and secrets, so writes are refused here. Read-only routes work.\n",
    {
      status: 403,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": PREVIEW_ROBOTS,
      },
    },
  );
}
