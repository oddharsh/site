// lib/photo-grid.ts — the homepage photo grid's markup, in ONE place.

import { EMPTY, html, joinHtml, type Html } from "./html.ts";
import { asNumber } from "./parse.ts";

// So the first six carry NO fetchpriority (the default) and the last six stay
// low, giving the edge two buckets to order by. Cloudflare honours the
// separation. Twenty same-tier /i/ thumbnails fetched at once with priorities
// ALTERNATING by issue order, on confirmed `cf-cache-status: HIT`, gave mean
// completion ranks of 6.2/12.8, 6.2/12.8, 5.7/13.3 and 8.5/10.5 over four
// trials, where perfect separation is 4.5/14.5 and none is 9.5/9.5; the
// all-equal control sat at exactly 9.5 every run.
const PRIORITISED_TILES = 6;

export function renderPhotoSlots(pick, altMap = {}, { deferred = true, histograms = {} } = {}): Html {
  return joinHtml(pick.map((p, index) => {
    const pri = index < PRIORITISED_TILES ? EMPTY : html` fetchpriority="low"`;
    const thumb = p.thumb_small || p.thumb_avif || p.thumb_jpg;
    const cands = [
      p.thumb_xs ? `${p.thumb_xs} 200w` : "",
      p.thumb_small ? `${p.thumb_small} 400w` : "",
      p.thumb_avif ? `${p.thumb_avif} 600w` : "",
    ].filter(Boolean);
    const srcsetValue = cands.length > 1 ? cands.join(", ") : "";
    const alt = altMap[p.stem] || p.stem;
    const hist = !deferred && index < PRIORITISED_TILES ? histograms[p.stem] : null;
    const histAttr = hist ? html` data-hist="${hist}"` : EMPTY;
    const sizeAttr = (asNumber(p.size) > 0) ? html` data-size="${p.size}"` : EMPTY;
    const upAttr = p.uploaded ? html` data-uploaded="${p.uploaded}"` : EMPTY;

    const noScript = deferred
      ? html`<noscript><img alt="${alt}" width="184" height="184" src="${thumb}" loading="lazy"${pri} decoding="async"></noscript>`
      : EMPTY;

    const image = deferred
      ? html`<img data-photo-deferred alt="${alt}" width="184" height="184" data-src="${thumb}"${srcsetValue ? html` data-srcset="${srcsetValue}" sizes="184px"` : EMPTY} loading="eager"${pri} decoding="async">`
      : html`<img alt="${alt}" width="184" height="184" src="${thumb}"${srcsetValue ? html` srcset="${srcsetValue}" sizes="184px"` : EMPTY} loading="eager"${pri} decoding="async">`;

    return html`<a href="/images/full/${encodeURI(p.full)}" target="_blank" rel="noopener" data-full="${p.full}"${sizeAttr}${upAttr}${histAttr}>${image}${noScript}</a>`;
  }));
}

export function deterministicTwelve(pool) {
  return [...pool].sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)).slice(0, 12);
}
