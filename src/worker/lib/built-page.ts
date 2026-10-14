import { serveStaticPage } from "./assets.ts";

type Awaitable<T> = T | Promise<T>;

export type BuiltPage = {
  headers?: Record<string, string>;
  divert?: (url: URL) => Awaitable<Response | null | undefined | false>;
  live?: () => Awaitable<Response>;
};

export async function serveBuiltPage(request: Request, env, page: BuiltPage = {}): Promise<Response> {
  if (page.divert) {
    const diverted = await page.divert(new URL(request.url));
    if (diverted) return diverted;
  }
  const built = await serveStaticPage(request, env, { headers: page.headers });
  if (built.status !== 404 || !page.live) return built;
  try { await built.body?.cancel(); } catch {}
  return withPagePolicy(await page.live(), page.headers);
}

function withPagePolicy(live: Response, headers: Record<string, string> = {}): Response {
  const isDocument = live.status === 200 && (live.headers.get("content-type") || "").startsWith("text/html");
  if (!isDocument) return live;
  // The Response itself as init, then mutate: a handler's response can come out
  // of caches.default with immutable headers, and an init OBJECT would drop
  // encodeBody on an encoded body (docs/GOTCHAS.md gotcha 13).
  const out = new Response(live.body, live);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}
