const pageHeaders = {
  "content-security-policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'; upgrade-insecure-requests",
  "permissions-policy": "accelerometer=(), ambient-light-sensor=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), publickey-credentials-create=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
} as const;

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return new Response(`${JSON.stringify(value)}\n`, { ...init, headers });
}

export function text(value: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
  headers.set("x-content-type-options", "nosniff");
  return new Response(value, { ...init, headers });
}

export function redirect(request: Request, pathname: string, status = 301): Response {
  const target = new URL(request.url);
  target.pathname = pathname;
  return Response.redirect(target, status);
}

export function withSiteHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(pageHeaders)) headers.set(name, value);
  const type = headers.get("content-type") ?? "";
  if (type.startsWith("text/html")) {
    headers.set("cache-control", "public, max-age=0, must-revalidate, s-maxage=300");
  }
  if (new URL(request.url).hostname !== "aadhar.sh") {
    headers.set("x-robots-tag", "noindex, nofollow");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function quality(header: string, mediaType: string): number {
  for (const part of header.toLowerCase().split(",")) {
    const [type, ...parameters] = part.trim().split(";");
    if (type !== mediaType && type !== "text/*" && type !== "*/*") continue;
    const q = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const value = q ? Number(q.trim().slice(2)) : 1;
    return Number.isFinite(value) ? value : 0;
  }
  return 0;
}

export function prefersMarkdown(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  if (!/\btext\/(?:x-)?markdown\b/i.test(accept)) return false;
  const markdown = Math.max(quality(accept, "text/markdown"), quality(accept, "text/x-markdown"));
  return markdown > 0 && markdown >= quality(accept, "text/html");
}

export function assetRequest(request: Request, pathname: string): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}
