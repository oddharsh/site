import { escapeHtml, renderDocument } from "../document.mjs";
import { parseFrontmatter, renderMarkdown } from "../markdown.mjs";

const labels = {
  access: "Device Manager",
  bot: "Internet",
  "pixel-peeper": "Pictures",
  security: "Security Center",
  terminal: "Command Prompt",
  whoareyou: "System Properties",
};

function liveRegion(slug) {
  if (slug === "whoareyou") {
    return `<section class="request-panel">
      <h2>What this request revealed</h2>
      <dl id="request-details"><dt>Live fields</dt><dd><a href="/whoareyou.json">Open this request as JSON</a></dd></dl>
      <p>Rendered for this response and never written to storage.</p>
    </section>`;
  }
  if (slug === "terminal") {
    return `<pre class="terminal-frame" data-terminal-font="Courier New" aria-label="Terminal ready screen">Microsoft Windows [Version aadhar.sh]\n\nC:\\aadhar.sh&gt; help\nType finger, photos, lens, dict, cache, radar, encode, or agent-ready.\n\nC:\\aadhar.sh&gt; _</pre>`;
  }
  if (slug === "pixel-peeper") {
    return `<section class="peeper-intro"><h2>compression eye exam</h2><p>The image trials are public records. The route-scoped comparison control is rebuilt in the interaction phase; the complete manifest is available now.</p><a href="/pixel-peeper/manifest.json">Open the trial manifest</a></section>`;
  }
  return "";
}

export function renderSystemPage({ surface, source, stylesheet }) {
  const slug = surface.path.slice(1);
  const { attributes } = parseFrontmatter(source);
  const article = renderMarkdown(source).replace(/^<h1>[\s\S]*?<\/h1>\n?/, "");
  const body = `
    <header>
      <p class="eyebrow">Control Panel · ${escapeHtml(labels[slug] ?? surface.title)}</p>
      <h1>${escapeHtml(surface.title)}</h1>
      <p class="lede">${escapeHtml(surface.description)}</p>
    </header>
    ${liveRegion(slug)}
    <article class="article system-article">${article}</article>`;

  return renderDocument({
    title: surface.title,
    description: surface.description,
    path: surface.path,
    stylesheet,
    body,
    tasks: [
      { href: `${surface.path}.md`, label: "Read canonical Markdown" },
      ...(slug === "whoareyou" ? [{ href: "/whoareyou.json", label: "Inspect this request as JSON" }] : []),
      ...(slug === "pixel-peeper" ? [{ href: "/pixel-peeper/manifest.json", label: "Open the trial manifest" }] : []),
    ],
    details: [
      { term: "Type", value: surface.kind === "utility" ? "Public utility" : "System document" },
      ...(attributes.updated ? [{ term: "Updated", value: attributes.updated }] : []),
      { term: "Canonical format", value: "HTML + Markdown" },
    ],
    head: `<link rel="alternate" type="text/markdown" href="${escapeHtml(surface.path)}.md">`,
  });
}
