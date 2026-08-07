import { escapeHtml, renderDocument } from "../document.mjs";

export function renderDirectory({ section, items, stylesheet }) {
  const list = items.map((item) => `
    <li>
      <a href="${escapeHtml(item.path)}">
        <span>${escapeHtml(item.title)}</span>
        <small>${escapeHtml(item.description)}</small>
      </a>
    </li>`).join("");

  const body = `
    <header>
      <p class="eyebrow">Local Disk (C:) · ${escapeHtml(section.title)}</p>
      <h1>${escapeHtml(section.title)}</h1>
      <p class="lede">${escapeHtml(section.description)}</p>
    </header>
    <ol class="object-list">${list}</ol>`;

  return renderDocument({
    title: section.title,
    description: section.description,
    path: section.path,
    stylesheet,
    body,
    tasks: [
      { href: `${section.path}/feed.xml`, label: "Subscribe with RSS" },
      { href: `${section.path}.md`, label: "Read this folder as Markdown" },
      { href: "/search.json", label: "Search the site as JSON" },
    ],
    details: [
      { term: "Type", value: "Public folder" },
      { term: "Contains", value: `${items.length} items` },
      { term: "Format", value: "HTML + Markdown" },
    ],
    head: `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(section.title)} RSS" href="${escapeHtml(section.path)}/feed.xml">
  <link rel="alternate" type="text/markdown" href="${escapeHtml(section.path)}.md">`,
  });
}

export function directoryMarkdown(section, items) {
  return `# ${section.title}\n\n${section.description}\n\n${items.map((item) => `- [${item.title}](${item.path}) — ${item.description}`).join("\n")}\n`;
}
