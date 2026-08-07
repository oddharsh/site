const siteName = "Aadharsh Explorer";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderLinks(links) {
  return links.map(({ href, label }) =>
    `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`
  ).join("");
}

export function renderDocument({
  title,
  description,
  path,
  stylesheet,
  body,
  tasks = [],
  places = [],
  details = [],
  head = "",
}) {
  const segments = path.split("/").filter(Boolean);
  const crumbs = [
    `<li><a href="/">aadhar.sh</a></li>`,
    ...segments.map((segment, index) => {
      const href = `/${segments.slice(0, index + 1).join("/")}`;
      const label = segment.replaceAll("-", " ");
      return index === segments.length - 1
        ? `<li aria-current="page">${escapeHtml(label)}</li>`
        : `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`;
    }),
  ].join("");
  const taskLinks = tasks.length ? tasks : [{ href: "/", label: "Return home" }];
  const placeLinks = places.length ? places : [
    { href: "/writing", label: "Writing" },
    { href: "/photos", label: "Photographs" },
    { href: "/garage", label: "Garage" },
    { href: "/lwe", label: "Learning with Errors" },
  ];
  const detailRows = details.map(({ term, value }) =>
    `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`
  ).join("");
  const compactLinks = [...taskLinks, ...placeLinks]
    .filter(({ href }, index, all) => all.findIndex((item) => item.href === href) === index);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · aadhar.sh</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="theme-color" content="#0054e3">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="canonical" href="https://aadhar.sh${escapeHtml(path)}">
  <link rel="stylesheet" href="${escapeHtml(stylesheet)}">
  ${head}
</head>
<body>
  <div class="explorer">
    <header class="caption">
      <span class="caption__mark" aria-hidden="true">A</span>
      <span>${siteName}</span>
      <span class="caption__state">Public</span>
    </header>
    <nav class="menu-bar" aria-label="Site">
      <a href="/">Home</a><a href="/writing">Writing</a><a href="/photos">Photos</a><a href="/garage">Garage</a><a href="/terminal">Tools</a>
    </nav>
    <div class="address-bar">
      <span class="address-bar__label">Address</span>
      <nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${crumbs}</ol></nav>
      <a class="go" href="${escapeHtml(path)}" aria-label="Reload this page">Go</a>
    </div>
    <div class="workspace">
      <aside class="task-pane" aria-label="Context">
        <section class="task-group"><h2>Object tasks</h2><ul>${renderLinks(taskLinks)}</ul></section>
        <section class="task-group"><h2>Other places</h2><ul>${renderLinks(placeLinks)}</ul></section>
        ${detailRows ? `<section class="task-group"><h2>Details</h2><dl>${detailRows}</dl></section>` : ""}
      </aside>
      <div>
        <details class="mobile-tasks">
          <summary>Explore this page</summary>
          <ul>${renderLinks(compactLinks)}</ul>
        </details>
        <main class="document" id="content">${body}</main>
      </div>
    </div>
    <footer class="status-bar"><p>Ready</p><p>Public document · no client script</p></footer>
  </div>
</body>
</html>`;
}

export { escapeHtml };
