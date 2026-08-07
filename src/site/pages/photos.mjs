import { escapeHtml, renderDocument } from "../document.mjs";

function tile(photo, index) {
  const eager = index < 6;
  return `<li id="${escapeHtml(photo.stem)}">
    <a href="/images/full/${escapeHtml(encodeURIComponent(photo.full))}">
      <picture>
        <source type="image/avif" srcset="/${escapeHtml(photo.thumbSmall)} 400w, /${escapeHtml(photo.thumbAvif)} 600w" sizes="(max-width: 440px) 31vw, (max-width: 900px) 22vw, 160px">
        <img src="/${escapeHtml(photo.thumbJpg)}" alt="${escapeHtml(photo.alt)}" width="600" height="600" ${eager ? "" : `loading="lazy" `}decoding="async"${index === 0 ? ` fetchpriority="high"` : eager ? "" : ` fetchpriority="low"`}>
      </picture>
      <span>${escapeHtml(photo.stem)}</span>
    </a>
  </li>`;
}

export function renderPhotos({ photos, stylesheet }) {
  const body = `
    <header>
      <p class="eyebrow">Local Disk (C:) · Pictures</p>
      <h1>Photographs</h1>
      <p class="lede">All ${photos.length}, straight out of camera. Fujifilm X-T50 and Leica M originals sit behind responsive AVIF and JPEG contact sheets.</p>
    </header>
    <search class="photo-search">
      <form action="/photos/query.json" method="get">
        <label for="photo-query">Search the public photo records</label>
        <span><input id="photo-query" name="q" type="search" maxlength="120" placeholder="camera, place, film, caption…" autocomplete="off"><button type="submit">Search JSON</button></span>
      </form>
    </search>
    <ol class="photo-archive">${photos.map(tile).join("")}</ol>`;

  return renderDocument({
    title: "Photographs",
    description: `All ${photos.length} photographs by Aadharsh Pannirselvam, straight out of camera.`,
    path: "/photos",
    stylesheet,
    body,
    tasks: [
      { href: "/images/manifest.json", label: "Open the photo manifest" },
      { href: "/images/metadata.json", label: "Inspect public EXIF" },
      { href: "/photos.md", label: "Read the archive as Markdown" },
    ],
    details: [
      { term: "Type", value: "Photograph archive" },
      { term: "Contains", value: `${photos.length} originals` },
      { term: "Thumbnails", value: "AVIF + JPEG" },
    ],
    head: `<link rel="alternate" type="text/markdown" href="/photos.md"><link rel="alternate" type="application/json" href="/images/manifest.json">`,
  });
}

export function photosMarkdown(photos) {
  return `# Photographs\n\nAll ${photos.length}, straight out of camera.\n\n${photos.map((photo) => `- [${photo.stem}](/images/full/${encodeURIComponent(photo.full)}) — ${photo.alt}`).join("\n")}\n`;
}
