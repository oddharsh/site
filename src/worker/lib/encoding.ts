import type { SiteRequest } from "./env.ts";

// The edge normalizes Accept-Encoding. Its original client value is retained
// in cf.clientAcceptEncoding; restore it before Workers Cache keys a response.
export function clientEncodingRequest(request: SiteRequest): SiteRequest {
  const original = request.cf?.clientAcceptEncoding ?? null;
  if (original === null || original === request.headers.get("accept-encoding")) return request;
  const headers = new Headers(request.headers);
  headers.set("accept-encoding", original);
  return new Request<unknown, IncomingRequestCfProperties>(request, { headers });
}

export function preferredEncoding(request: SiteRequest, available: string[]): string | null {
  const original = request.cf?.clientAcceptEncoding;
  const offer = original ?? request.headers.get("accept-encoding");
  if (offer === null) return available[0] ?? null; // No field accepts any coding (RFC 9110).
  const weights = new Map<string, number>();
  for (const item of offer.split(",")) {
    const [name, ...params] = item.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.find((p) => p.trim().startsWith("q="))?.trim().slice(2);
    const weight = q === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q) : 0;
    weights.set(name, Math.min(weights.get(name) ?? 1, weight));
  }
  const quality = (name: string) => weights.get(name)
    ?? (name === "identity" ? (weights.get("*") === 0 ? 0 : 1) : weights.get("*") ?? 0);
  let best: string | null = null, weight = 0;
  for (const name of available) {
    const q = quality(name);
    if (q > weight) { best = name; weight = q; }
  }
  return best;
}

// q11/dcz paths select their own available representations. Plain text falling
// back to gzip or identity must also stop the edge from choosing refused br.
// Gzip streams without buffering; its weak validator describes decoded bytes.
export function encodeClientResponse(request: SiteRequest, response: Response): Response {
  const type = response.headers.get("content-type") ?? "";
  if (!/^(?:text\/|application\/(?:json|[^;]+\+json|javascript|xml|[^;]+\+xml)|image\/svg\+xml)/i.test(type)
    || response.headers.has("content-encoding")) return response;
  const fixed = response.status === 206 || /\bno-transform\b/i.test(response.headers.get("cache-control") ?? "");
  const encoding = preferredEncoding(request, fixed ? ["identity"] : ["br", "gzip", "identity"]);
  if (encoding === "br") return response;
  if (!encoding) {
    void response.body?.cancel().catch(() => {});
    return new Response(null, { status: 406, headers: { "vary": "accept-encoding", "cache-control": "no-store" } });
  }
  const headers = new Headers(response.headers);
  headers.append("vary", "accept-encoding");
  if (!/\bno-transform\b/i.test(headers.get("cache-control") ?? "")) headers.append("cache-control", "no-transform");
  let body = response.body;
  if (encoding === "gzip" && (body || request.method === "HEAD")) {
    headers.set("content-encoding", "gzip");
    headers.delete("content-length");
    const etag = headers.get("etag");
    if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
    if (body) body = body.pipeThrough(new CompressionStream("gzip"));
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers, encodeBody: "manual" });
}
