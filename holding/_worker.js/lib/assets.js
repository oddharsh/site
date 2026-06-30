// lib/assets.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
// read a bundled static asset bypassing the read-through asset cache (a unique
// query string forces a cache miss), then re-emit it under the canonical URL
// with the given content-type + a short, deploy-purgeable edge cache. used for
// the agent-discovery docs whose canonical URL a long Cache-Control had pinned.
export async function serveFreshAsset(request, env, contentType) {
  const u = new URL(request.url);
  u.searchParams.set("__r", Date.now().toString(36));
  const res = await env.ASSETS.fetch(new Request(u.toString(), { headers: request.headers }));
  const headers = new Headers(res.headers);
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "public, max-age=0, must-revalidate, s-maxage=300");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
