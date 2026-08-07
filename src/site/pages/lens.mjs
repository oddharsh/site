import { renderDocument } from "../document.mjs";

export function renderLens({ stylesheet }) {
  const body = `
    <header>
      <p class="eyebrow">Internet Explorer · Inspection</p>
      <h1>The Other Web</h1>
      <p class="lede">Put in one public URL. The server makes a bounded, identified request and shows the response a machine actually receives—without asking your browser to run an application.</p>
    </header>
    <search class="lens-search">
      <form action="/lens" method="get">
        <label for="lens-url">Public HTTP or HTTPS URL</label>
        <span><input id="lens-url" name="url" type="url" inputmode="url" maxlength="2048" placeholder="https://example.com" required><button type="submit">Inspect</button></span>
      </form>
    </search>
    <section class="lens-results" id="lens-results" aria-live="polite">
      <h2>One URL, two audiences</h2>
      <div class="lens-intro-grid">
        <article><h3>Human document</h3><p>Visible title, outline, readable text, and declared metadata.</p></article>
        <article><h3>Machine document</h3><p>Status, headers, structured data, robots policy, and discovery files.</p></article>
      </div>
      <p class="empty-state">Try <a href="/lens?url=https%3A%2F%2Fexample.com">example.com</a> or paste another public URL above.</p>
    </section>`;

  return renderDocument({
    title: "The Other Web",
    description: "Inspect how a public URL reads to people and machines.",
    path: "/lens",
    stylesheet,
    body,
    tasks: [
      { href: "/lens/fetch?url=https%3A%2F%2Fexample.com", label: "Open a machine-readable inspection" },
      { href: "/lens/browser?url=https%3A%2F%2Fexample.com", label: "Request a rendered document" },
      { href: "/bot", label: "Read the crawler identity" },
    ],
    details: [
      { term: "Fetch cap", value: "256 KiB parsed" },
      { term: "Redirects", value: "4 maximum" },
      { term: "Private networks", value: "Refused" },
      { term: "Client script", value: "None" },
    ],
  });
}
