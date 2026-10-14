// lib/preview.ts — the guard that makes a Workers preview URL safe to hand out.
//
// Preview URLs are how a branch gets a real, servable address before it is
// production (`previewUrls: true` in cloudflare.config.ts). The thing to understand
// about them, because it is not obvious and it is the whole reason this file
// exists: a preview version runs the SAME BINDINGS AND SECRETS as production.
// Not a copy, not a staging tier. The same RN_KV, the same BOOKINGS namespace,
// the same aadhar-photos bucket, the same three D1 databases, the same
// RESEND_API_KEY. Cloudflare offers no per-version binding override.
//
// Crons need no guard. A scheduled event fires against the ACTIVE DEPLOYMENT
// only, so a version that has never been deployed never runs the /around crawl,
// the census sweep, or the webmention pass, whatever this file says.

import { asText } from "./parse.ts";
import { GET_WRITES, PER_TOOL_WRITES } from "../routes.ts";

export function isPreviewHost(hostname) {
  return asText(hostname, "").toLowerCase().endsWith(".workers.dev");
}

export const PREVIEW_ROBOTS = "noindex, nofollow";

const SAFE_UNSAFE_METHODS = PER_TOOL_WRITES;

const UNSAFE_READS = GET_WRITES;

export const PREVIEW_GET_WRITES = UNSAFE_READS;

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

export function previewToolRefusal(request, tools, name) {
  let hostname = "";
  try { hostname = new URL(request.url).hostname; } catch { return null; }
  if (!isPreviewHost(hostname)) return null;

  const tool = (tools || []).find((t) => t && t.name === name);
  if (!tool || tool.annotations?.readOnlyHint !== false) return null;

  return `${name} writes production state and is disabled on preview URLs. ` +
    "This is a Workers preview build of aadhar.sh, running against production " +
    "bindings and secrets. Read-only tools work.";
}

function denial(reason) {
  return new Response(
    `${reason}\n\n` +
    "This is a Workers preview build of aadhar.sh. It runs against production\n" +
    "bindings and secrets, so writes are refused here. Read-only routes work.\n",
    {
      status: 403,
      headers: {
        "content-type":  "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag":  PREVIEW_ROBOTS,
      },
    },
  );
}
