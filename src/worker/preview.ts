// A version preview runs PRODUCTION bindings and secrets: the same KV, the same
// D1, the same Resend key. Cloudflare offers no per-version override, so this
// guard is what makes a preview URL safe to paste into a pull request.
//
// Default-deny on unsafe methods is the load-bearing half, because the next POST
// route anyone adds is guarded on the day it is written. This list is the other
// half: the routes that WRITE while shaped like a read. Every entry here has to
// be a live pathname, since a stale one guards nothing while reading as though
// it does. The entries below are asserted against the Worker's own route table by
// test/worker-http.test.mjs, so renaming a route fails the test rather than
// quietly reopening the hole.
const getWrites = new Set([
  "/hit",
  "/coffee/approve",
  "/coffee/decline",
  "/webmention/approve",
  "/webmention/decline",
]);

export function previewRefusal(request: Request): Response | null {
  const url = new URL(request.url);
  const productionHost = url.hostname === "aadhar.sh" || url.hostname === "www.aadhar.sh";
  const localHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (productionHost || localHost) return null;
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method) || getWrites.has(url.pathname);
  if (!unsafe) return null;
  return Response.json({ error: "Writes are disabled on version previews." }, {
    status: 403,
    headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

export const previewGuardedGetWrites = getWrites;
