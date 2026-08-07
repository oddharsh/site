import { escapeHtml, renderDocument } from "../document.mjs";

function paragraphs(items) {
  return items.map((item) => `<p>${escapeHtml(item)}</p>`).join("");
}

function photoMarkup(photo) {
  return `<a href="/photos#${escapeHtml(photo.stem)}">
    <picture>
      <source srcset="/${escapeHtml(photo.avif)}" type="image/avif">
      <img src="/${escapeHtml(photo.jpg)}" width="600" height="600" alt="${escapeHtml(photo.alt)}" loading="lazy" decoding="async" fetchpriority="low">
    </picture>
  </a>`;
}

export function renderHome({ content, photos, stylesheet }) {
  const links = content.links.map(({ href, label, rel }) =>
    `<li><a href="${escapeHtml(href)}"${rel ? ` rel="${escapeHtml(rel)}"` : ""}>${escapeHtml(label)}</a></li>`
  ).join("");
  const body = `
    <header>
      <p class="eyebrow">Local Disk (C:) · Personal computer</p>
      <h1>${escapeHtml(content.name)}</h1>
      <p class="lede">${escapeHtml(content.role)}</p>
    </header>
    <p class="construction"><strong>Under construction.</strong> The machine is usable while it changes.</p>
    <div class="home-grid">
      <section>
        <h2>Welcome</h2>
        ${paragraphs(content.introduction)}
      </section>
      <section>
        <h2>Make contact</h2>
        <p>${escapeHtml(content.contact)}</p>
        <a class="section-action" href="/coffee">See coffee availability</a>
      </section>
      <section>
        <h2>Now playing</h2>
        <p>The current playlist has a human view and a small public data surface. It stays live without holding this document's first paint open.</p>
        <a class="section-action" href="/rn">Open music</a>
      </section>
      <section>
        <h2>Elsewhere</h2>
        <ul class="link-list">${links}</ul>
      </section>
      <section class="photo-strip">
        <h2>Recent photographs</h2>
        <p>A small view into the straight-out-of-camera archive.</p>
        <div class="photo-grid">${photos.map(photoMarkup).join("")}</div>
        <a class="section-action" href="/photos">Browse all photographs</a>
      </section>
    </div>`;

  return renderDocument({
    title: content.name,
    description: "Research, photographs, writing, experiments, and small internet tools by Aadharsh Pannirselvam.",
    path: "/",
    stylesheet,
    body,
    tasks: [
      { href: "/coffee", label: "Book coffee in New York" },
      { href: "mailto:coffee@aadhar.sh", label: "Send electronic mail" },
      { href: "/whoareyou", label: "Inspect this request" },
    ],
    details: [
      { term: "Type", value: "Personal site" },
      { term: "Location", value: "New York" },
      { term: "Status", value: "Under construction" },
    ],
    head: `<link rel="alternate" type="text/markdown" href="/index.md">`,
  });
}
