// ── a route table over globalThis.fetch, for one test ────────────────────
//
// The suite's fetch doubles used to be assigned by hand and answer every URL:
// `testGlobals.fetch = async () => new Response(PAGE)`. A test written that way
// can't tell when the code under test starts fetching a URL nobody planned
// for, because the catch-all answers it with a 200. MSW's
// `onUnhandledRequest: "error"` exists for that, and MSW was measured and left
// out on 2026-11-18: 3.0.6's `msw/node` intercepts nothing under the pinned
// Bun, and 2.15's interceptor is this same global assignment plus a router.
//
//   using _fetch = routeFetch({
//     "https://api.resend.com/": async (request) => Response.json({ id: "m1" }),
//     "https://mari.example/": () => new Response(PAGE),
//   });
//
// Keys are URL prefixes and the longest match wins, so a narrow route can sit
// beside a host-wide one. A URL no key matches is a miss: it's appended to the
// network tripwire's record, then refused. The record is the part that holds,
// for the reason no-network.ts gives: lens probes catch fetch errors, so a
// refusal alone can be swallowed by a test that then passes. A recorded miss
// fails the run whatever the caller did with the throw.
//
// Importing no-network.ts arms the tripwire in runners that don't preload it
// (cal, lens-reader, cf-garage), so the guarantee holds there too. `using`
// puts back whatever fetch was installed before, which is the tripwire, when
// the enclosing block exits.

import { escaped } from "./no-network.ts";

// `init` rides along because `new Request` drops Cloudflare's `cf` options, and a
// test telling an Images transform from a plain fetch of the same URL reads
// `init.cf.image`.
type Route = (request: Request, init?: RequestInit & { cf?: Record<string, unknown> }) => Response | Promise<Response>;

const glob: { fetch: unknown } = globalThis;

export function routeFetch(routes: Record<string, Route>) {
  const previous = glob.fetch;
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);

  glob.fetch = async function routedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const request = new Request(input, init);
    const prefix = prefixes.find((candidate) => request.url.startsWith(candidate));
    if (prefix === undefined) {
      escaped.push(request.url);
      throw new TypeError(`no fetch route matches ${request.url}; routes: ${prefixes.join(", ") || "(none)"}`);
    }
    return routes[prefix](request, init);
  };

  return {
    [Symbol.dispose]() {
      glob.fetch = previous;
    },
  };
}
