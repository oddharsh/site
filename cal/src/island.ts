// island.ts — cal's copy of the site's island contract (src/worker/lib/island.ts).
//
// DELIBERATELY a near-duplicate, for the reason trace.ts gives: the dependency
// direction runs site -> cal, so cal imports nothing that carries the site's
// module graph. lib/island.ts pulls lib/html.ts behind it, and the Html type it
// returns is the site's escaping contract, which cal's templates do not use.
//
// What has to agree is small and exact, and a root contract test holds it
// (tools/contract-coffee-is-a-built-document.test.mjs): the marker header, the
// preload and mount markup, and the loader script BYTE FOR BYTE. The loader is
// one CSP hash across every page that ships it, so a copy that drifted by a
// character would cost /coffee its own hash and read as a CSP bug.
//
// The site's rules, restated because they are why each piece looks the way it
// does: the placeholder comes from the same renderer as the fragment (templates.ts
// renderSlotList); the preload carries crossorigin so it matches the script's cors
// fetch; the script injects only a response carrying the marker; and a failure
// leaves the placeholder and sets data-state="failed".

export const ISLAND_MARKER = "x-island";

// Byte-identical to islandScript().html. It takes no arguments and finds every
// mount by its data-island attribute, so nothing is ever interpolated into it.
export const ISLAND_SCRIPT = `<script>(function(){if(!window.fetch)return;var ms=document.querySelectorAll("[data-island]");for(var k=0;k<ms.length;k++)(function(m){fetch(m.getAttribute("data-island")).then(function(r){if(!r.ok||r.headers.get("x-island")!=="1")throw 0;return r.text()}).then(function(t){m.innerHTML=t;m.setAttribute("data-state","live");m.dispatchEvent(new Event("island",{bubbles:true}))}).catch(function(){m.setAttribute("data-state","failed")})})(ms[k])})()</script>`;

// The callers pass constants and pre-escaped markup; `url` and `id` are escaped
// anyway so the helpers hold the same guarantee the site's do.
export function islandPreload(url: string): string {
  return `<link rel="preload" as="fetch" href="${esc(url)}" crossorigin>`;
}

export function islandMount(id: string, url: string, placeholder: string, noscript: string): string {
  return `<div id="${esc(id)}" data-island="${esc(url)}" data-state="pending">${placeholder}<noscript>${noscript}</noscript></div>`;
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
