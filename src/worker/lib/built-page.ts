// lib/built-page.ts: what "a built document with a live fallback" means, once.
//
// A page declares three things and stops choreographing:
//
//   headers  its policy. It lands on EVERY representation of the page: the q11
//            twin, the dcz delta, the 304, the HEAD, the Markdown twin answered
//            at the page's own URL, and the live render. The twin takes it
//            through twinPolicy (lib/assets.ts), which keeps its no-store and
//            leaves out the shell preloads.
//   divert   the requests the built file cannot answer (a ?q=, a ?cmd=, an
//            owner's ?refresh=). Return a response to take the request, or
//            nothing to serve the document. A diverted response is its own:
//            a search result or a redirect does not take the shell's policy.
//   live     the renderer for a tree that staged no bake, which is `bun run
//            dev` and the contract suite. The build refuses to ship without
//            the file, so production never takes this arm.
//
// Before this module the same six steps (build the header set, serveStaticPage,
// test for 404, cancel the body, render, loop the headers back on) were written
// at 18 routes, and five of them negotiated Markdown by hand so the twin kept
// the page's noindex. The representation engine is still serveStaticPage; this
// is the seam above it that knows a page has a fallback.
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

// The policy belongs to the DOCUMENT. A live handler can also answer a miss (an
// unknown /writing slug is a 404), a redirect or a raw text file, and none of
// those may inherit a day of shared cache from the page they are not.
function withPagePolicy(live: Response, headers: Record<string, string> = {}): Response {
  const isDocument = live.status === 200 && (live.headers.get("content-type") || "").startsWith("text/html");
  if (!isDocument) return live;
  // The Response itself as init, then mutate: a handler's response can come out
  // of caches.default with immutable headers, and an init OBJECT would drop
  // encodeBody on an encoded body (CLAUDE.md gotcha 13).
  const out = new Response(live.body, live);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}
