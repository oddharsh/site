// lib/island.ts — the site's one convention for a page that is MOSTLY fixed and
// partly per request.
//
// The page is rendered ONCE by build.ts into the staged tree, so it gets what
// every built document gets: a brotli q11 twin, a dcz delta against the family
// and per-page dictionaries, an ETag, and sha256 CSP hashes for its inline
// scripts. The per-request part is an ISLAND: a placeholder in the built bytes,
// and one same-origin fetch after load that swaps in an HTML fragment the Worker
// renders for that request. Precompressed bytes cannot take a per-request
// injection (the runtime ships no brotli encoder), so this split is what a
// per-request page has to become to earn any of those.
//
// It is the homepage's shape (/photos/grid.html, /rn/tracks.html) and the shape
// Topcoat calls a "shard", written down once so the next page takes it by
// importing three functions rather than by copying a hydrator out of
// index.html. A page whose live part is a handful of SCALARS wants /security's
// lighter form instead (JSON into data-attributes); an island is for rows.
//
// Four rules, each learned on the homepage first:
//   1. The placeholder comes from the SAME renderer as the fragment, fed a
//      placeholder model, so the two share markup and the swap moves as little
//      as possible.
//   2. The preload carries `crossorigin` even same-origin. Without it the
//      preload is mode no-cors and cannot match the script's cors fetch, so the
//      fragment is requested twice.
//   3. The script requires the `x-island` marker before injecting. A 5xx from
//      the edge is also text/html and also resolves fine.
//   4. A failure leaves the placeholder and says so (data-state="failed"),
//      because a page that shows what it read must not show a guess.
import { html, type Html } from "./html.ts";

// Spelled out again inside islandScript, whose text is a constant on purpose; a
// contract test holds the two together.
export const ISLAND_MARKER = "x-island";

/** The fragment response. `no-store` because the body is one request's. */
export function islandResponse(body: Html, headers: Record<string, string> = {}): Response {
  return new Response(body.html, {
    headers: {
      "content-type":           "text/html; charset=utf-8",
      "cache-control":          "no-store, must-revalidate",
      "x-content-type-options": "nosniff",
      // Worth fetching, worthless in an index: a bare fragment is not a page.
      "x-robots-tag":           "noindex",
      [ISLAND_MARKER]:          "1",
      ...headers,
    },
  });
}

/** For `<head>`: starts the fragment request while the document is still parsing. */
export function islandPreload(url: string): Html {
  return html`<link rel="preload" as="fetch" href="${url}" crossorigin>`;
}

/** The mount. `noscript` is what a reader without scripts gets instead of the swap. */
export function islandMount(id: string, url: string, placeholder: Html, noscript: Html): Html {
  return html`<div id="${id}" data-island="${url}" data-state="pending">${placeholder}<noscript>${noscript}</noscript></div>`;
}

/** The one inline script, and it takes no arguments: it finds every mount by
 *  its `data-island` attribute and reads the URL from there. So the script is
 *  byte-identical on every page that uses it (one CSP hash, one thing to read),
 *  and nothing caller-supplied is ever interpolated into script text. On success
 *  it dispatches a bubbling `island` event, so a page can finish off the rows
 *  the server structurally cannot fill. */
export function islandScript(): Html {
  return html`<script>(function(){if(!window.fetch)return;var ms=document.querySelectorAll("[data-island]");for(var k=0;k<ms.length;k++)(function(m){fetch(m.getAttribute("data-island")).then(function(r){if(!r.ok||r.headers.get("x-island")!=="1")throw 0;return r.text()}).then(function(t){m.innerHTML=t;m.setAttribute("data-state","live");m.dispatchEvent(new Event("island",{bubbles:true}))}).catch(function(){m.setAttribute("data-state","failed")})})(ms[k])})()</script>`;
}
