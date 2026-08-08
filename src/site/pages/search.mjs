import { escapeHtml, renderDocument } from "../document.mjs";

function searchForm(action, label, button, datalist = "") {
  return `<form class="command-form" action="${escapeHtml(action)}" method="get">
    <label for="command-input">${escapeHtml(label)}</label>
    <span><input id="command-input" name="${action === "/run" ? "cmd" : "q"}" type="search" maxlength="120" autocomplete="off"${datalist ? ` list="site-commands"` : ""}><button type="submit">${escapeHtml(button)}</button></span>
    ${datalist}
  </form>`;
}

export function renderSearch({ stylesheet }) {
  // #search-results is the mount the Worker fills when the form is submitted.
  // It ships with the resting state so the page reads correctly with no query,
  // and so a browser that never reaches the Worker still gets a whole document.
  const body = `<header><p class="eyebrow">Local Disk (C:) · Find</p><h1>Search aadhar.sh</h1><p class="lede">Search the authored public corpus. The JSON response keeps the same query address for scripts and agents.</p></header>${searchForm("/search", "A word or phrase", "Search")}<section id="search-results"><p class="empty-state">Results appear here. Every query is answered by the server, so this page needs no script.</p></section>`;
  return renderDocument({ title: "Search aadhar.sh", description: "Search the public authored site corpus.", path: "/search", stylesheet, body, tasks: [{ href: "/search.json?q=photo", label: "Try the JSON search" }], details: [{ term: "Type", value: "Public full-text search" }, { term: "Index", value: "Built with the site" }] });
}

export function renderRun({ surfaces, stylesheet, unknown = "" }) {
  const options = surfaces.map(({ path, title }) => `<option value="${escapeHtml(path.slice(1) || "home")}">${escapeHtml(title)}</option>`).join("");
  const datalist = `<datalist id="site-commands">${options}</datalist>`;
  const message = unknown ? `<p class="command-error">Windows cannot find “${escapeHtml(unknown)}”. Check the spelling and try again.</p>` : "";
  const body = `<header><p class="eyebrow">Start · Run</p><h1>Run</h1><p class="lede">Open a public place by name or path.</p></header>${message}${searchForm("/run", "Type the name of a page", "Open", datalist)}`;
  return renderDocument({ title: "Run", description: "Open any registered public page by name.", path: "/run", stylesheet, body, tasks: [{ href: "/", label: "Return home" }], details: [{ term: "Type", value: "Navigation command" }, { term: "Registered places", value: String(surfaces.length) }] });
}
