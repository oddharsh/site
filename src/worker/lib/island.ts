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
import { cspHashed } from "./csp-policy.ts";
import { html, type Html } from "./html.ts";

export const ISLAND_MARKER = "x-island";

export const ISLAND_CSP = cspHashed([]);

export function islandResponse(body: Html, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body.html, {
    status,
    headers: {
      "content-type":           "text/html; charset=utf-8",
      "cache-control":          "no-store, must-revalidate",
      "x-content-type-options": "nosniff",
      "x-robots-tag":           "noindex",
      "content-security-policy": ISLAND_CSP,
      [ISLAND_MARKER]:          "1",
      ...headers,
    },
  });
}

export function islandPreload(url: string): Html {
  return html`<link rel="preload" as="fetch" href="${url}" crossorigin>`;
}

export function islandMount(id: string, url: string, placeholder: Html, noscript: Html): Html {
  return html`<div id="${id}" data-island="${url}" data-state="pending">${placeholder}<noscript>${noscript}</noscript></div>`;
}

export function islandScript(): Html {
  return html`<script>(function(){if(!window.fetch)return;var ms=document.querySelectorAll("[data-island]");for(var k=0;k<ms.length;k++)(function(m){fetch(m.getAttribute("data-island")).then(function(r){if(!r.ok||r.headers.get("x-island")!=="1")throw 0;return r.text()}).then(function(t){m.innerHTML=t;m.setAttribute("data-state","live");m.dispatchEvent(new Event("island",{bubbles:true}))}).catch(function(){m.setAttribute("data-state","failed")})})(ms[k])})()</script>`;
}
