// link-integrity.mjs — does every internal reference in the staged pages point at
// something this site actually serves?

import { claimedByWorker } from "../../src/worker/routes.ts";

export function makeResolver({ files, routeKeys, allow, surfaces }: {
  files: Set<string>;
  routeKeys: Set<string>;
  allow: string[];
  surfaces: Set<string>;
}) {
  const workerOwned = claimedByWorker(allow);

  const governed = new Set();
  for (const p of surfaces) {
    const parent = p.slice(0, p.lastIndexOf("/"));
    if (parent) governed.add(parent);
  }

  return function resolves(path) {
    // /cdn-cgi/ is Cloudflare's own namespace on every zone it fronts (the edge
    // answers /cdn-cgi/trace before any Worker or asset runs), so nothing in
    // this tree could ever serve it and nothing here can vouch for it either.
    // /whoareyou links /cdn-cgi/trace, and became the first built page to do so
    // on 2026-09-25; before that it rendered per request and was never scanned.
    if (path.startsWith("/cdn-cgi/")) return true;
    const bare = path.length > 1 ? path.replace(/\/$/, "") : path;
    if (files.has(path) || files.has(bare)) return true;
    if (files.has(bare + ".html") || files.has(bare + "/index.html")) return true;
    if (routeKeys.has(bare) || surfaces.has(bare)) return true;
    const parent = bare.slice(0, bare.lastIndexOf("/"));
    if (governed.has(parent)) return false;
    return workerOwned(bare);
  };
}

const REF_ATTRS = ["href", "src", "data-src"];
const SET_ATTRS = ["srcset", "data-srcset"];

export async function internalRefs(html) {
  const out = [];
  const take = (raw) => {
    if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return;
    const path = raw.split("#")[0].split("?")[0];
    if (path) out.push(path);
  };
  const handler = {
    element(el) {
      for (const a of REF_ATTRS) take(el.getAttribute(a));
      // `url 200w, url 400w` — the descriptor is not part of the URL.
      for (const a of SET_ATTRS) {
        const v = el.getAttribute(a);
        if (v) for (const part of v.split(",")) take(part.trim().split(/\s+/)[0]);
      }
    },
  };
  await new HTMLRewriter()
    .on("*", handler)
    .transform(new Response(html))
    .arrayBuffer();
  return out;
}

const META_IMAGE_KEYS = new Set([
  "og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src",
]);

export async function metaImageRefs(html: string, origin = "https://aadhar.sh"): Promise<string[]> {
  const out: string[] = [];
  const host = new URL(origin).host;
  await new HTMLRewriter()
    .on("meta", {
      element(el) {
        const key = el.getAttribute("property") || el.getAttribute("name");
        const raw = el.getAttribute("content");
        if (!key || !raw || !META_IMAGE_KEYS.has(key)) return;
        if (raw.startsWith("/") && !raw.startsWith("//")) { out.push(raw.split(/[?#]/)[0]); return; }
        let url: URL;
        try { url = new URL(raw); } catch { return; }
        if (url.host === host) out.push(url.pathname);
      },
    })
    .transform(new Response(html))
    .arrayBuffer();
  return out;
}
