import { brotliCompressSync, constants } from "node:zlib";
import type { SiteRequest } from "./env.ts";
import { preferredEncoding } from "./encoding.ts";
import { ISLAND_MARKER } from "./island.ts";

// Static documents already have q11 twins. Islands and JSON are generated from
// live data; q11 on the 85 KiB reading list took ~77 ms in pinned workerd.
// q5 took ~3.5 ms including harness overhead and saved ~1 KiB over edge q4.
// Bound the input and quality to keep this work off full-page streaming paths
// and avoid an unbounded native encode on the Worker's CPU budget.
export const FRAGMENT_COMPRESSION_LIMIT = 128 * 1024;

export async function compressFragment(request: SiteRequest, response: Response): Promise<Response> {
  const eligible = response.headers.get(ISLAND_MARKER) === "1"
    || /^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(response.headers.get("content-type") ?? "");
  if (!eligible || response.status !== 200 || response.headers.has("content-encoding")
    || /\bno-transform\b/i.test(response.headers.get("cache-control") ?? "")
    || preferredEncoding(request, ["br", "gzip", "identity"]) !== "br") return response;
  if (request.method === "HEAD") {
    // The plain length would no longer describe GET's encoded representation.
    response.headers.delete("content-length");
    return response;
  }
  if (request.method !== "GET" || !response.body
    || Number(response.headers.get("content-length")) > FRAGMENT_COMPRESSION_LIMIT) return response;

  const reader = response.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > FRAGMENT_COMPRESSION_LIMIT) {
        // Cancelling one tee branch waits for the other; don't block the original.
        void reader.cancel().catch(() => {});
        return response;
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (length < 1024) return response;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const encoded = brotliCompressSync(bytes, { params: {
    [constants.BROTLI_PARAM_QUALITY]: 5,
    [constants.BROTLI_PARAM_LGWIN]: 24,
    [constants.BROTLI_PARAM_SIZE_HINT]: length,
  } });
  if (encoded.byteLength >= length) return response;
  void response.body.cancel().catch(() => {});
  const headers = new Headers(response.headers);
  headers.set("content-encoding", "br");
  headers.set("content-length", String(encoded.byteLength));
  headers.append("vary", "accept-encoding");
  const etag = headers.get("etag");
  if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
  return new Response(encoded, { status: response.status, statusText: response.statusText, headers, encodeBody: "manual" });
}
