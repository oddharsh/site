import { escapeHtml, renderDocument } from "../document.mjs";

export function renderWritingIndex({ posts, stylesheet }) {
  const body = `
    <header>
      <p class="eyebrow">Local Disk (C:) · Documents</p>
      <h1>Writing</h1>
      <p class="lede">Notes in flux. Each canonical document is plain text; the browser view is an editable copy that deliberately does not save.</p>
    </header>
    <ol class="file-list">
      ${posts.map((post) => `<li><a href="/writing/${escapeHtml(post.slug)}"><span aria-hidden="true">▤</span><strong>${escapeHtml(post.title)}</strong><time datetime="${escapeHtml(post.date)}">${escapeHtml(post.date)}</time></a></li>`).join("")}
    </ol>`;

  return renderDocument({
    title: "Writing",
    description: "Notes in flux by Aadharsh Pannirselvam, published as plain text and editable browser documents.",
    path: "/writing",
    stylesheet,
    body,
    tasks: [
      { href: "/writing/feed.xml", label: "Subscribe with RSS" },
      { href: "/writing/posts.json", label: "Open the post registry" },
      { href: "/writing.md", label: "Read this folder as Markdown" },
    ],
    details: [
      { term: "Type", value: "Documents folder" },
      { term: "Contains", value: `${posts.length} notes` },
      { term: "Canonical format", value: "Plain text" },
    ],
    head: `<link rel="alternate" type="application/rss+xml" title="Writing RSS" href="/writing/feed.xml">
  <link rel="alternate" type="text/markdown" href="/writing.md">`,
  });
}

export function renderWritingPost({ post, text, stylesheet }) {
  const lines = text.split("\n").length + 1;
  const body = `
    <header class="visually-hidden"><h1>${escapeHtml(post.title)}</h1></header>
    <label class="visually-hidden" for="note">Editable copy of ${escapeHtml(post.title)}</label>
    <textarea class="notepad" id="note" rows="${lines}" spellcheck="true">${escapeHtml(text)}</textarea>
    <p class="notepad-note">Edits stay in this tab. Reload restores the published text.</p>`;

  return renderDocument({
    title: post.title,
    description: `${post.title}, a note by Aadharsh Pannirselvam.`,
    path: `/writing/${post.slug}`,
    stylesheet,
    body,
    tasks: [
      { href: `/writing/${post.slug}.txt`, label: "Open canonical plain text" },
      { href: "/writing", label: "Return to all writing" },
    ],
    details: [
      { term: "Type", value: "Plain text note" },
      { term: "Published", value: post.date },
      { term: "Editing", value: "Local and temporary" },
    ],
    head: `<link rel="alternate" type="text/plain" href="/writing/${escapeHtml(post.slug)}.txt">`,
  });
}

export function writingMarkdown(posts) {
  return `# Writing\n\nNotes in flux by Aadharsh Pannirselvam.\n\n${posts.map((post) => `- [${post.title}](/writing/${post.slug}) — ${post.date}`).join("\n")}\n`;
}
