import { escapeHtml, renderDocument } from "../document.mjs";
import { parseFrontmatter, renderMarkdown } from "../markdown.mjs";

export function renderArticle({ surface, source, stylesheet }) {
  const { attributes } = parseFrontmatter(source);
  const sectionTitle = surface.section === "lwe" ? "Learning with Errors" : "Garage";
  const article = renderMarkdown(source).replace(/^<h1>[\s\S]*?<\/h1>\n?/, "");
  const body = `
    <header>
      <p class="eyebrow">Local Disk (C:) · ${escapeHtml(sectionTitle)}</p>
      <h1>${escapeHtml(surface.title)}</h1>
      <p class="lede">${escapeHtml(surface.description)}</p>
    </header>
    <aside class="edition-note" aria-label="Edition note">
      <strong>Static edition.</strong> This authored lab note is preserved at its recorded date. Mentions of earlier interfaces or embedded controls are historical; the current site architecture and guarantees are documented in <a href="/security">Security Center</a>.
    </aside>
    <article class="article${surface.section === "lwe" ? " chat" : ""}">${article}</article>`;

  return renderDocument({
    title: surface.title,
    description: surface.description,
    path: surface.path,
    stylesheet,
    body,
    tasks: [
      { href: `${surface.path}.md`, label: "Read canonical Markdown" },
      { href: `/${surface.section}`, label: `Return to ${sectionTitle}` },
    ],
    details: [
      { term: "Type", value: surface.section === "lwe" ? "Explainer" : "Garage experiment" },
      ...(attributes.updated ? [{ term: "Updated", value: attributes.updated }] : []),
      { term: "Script at first paint", value: "None" },
    ],
    head: `<link rel="alternate" type="text/markdown" href="${escapeHtml(surface.path)}.md">`,
  });
}
