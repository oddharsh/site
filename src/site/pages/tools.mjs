import { escapeHtml, renderDocument } from "../document.mjs";

const definitions = {
  finger: { title: "Finger", eyebrow: "Command Prompt · Host record", description: "A compact directory of who runs this host and what is published here.", label: "Lookup", placeholder: "aadharsh", parameter: "q", intro: "The useful part of finger was never emulating a terminal. It is the small, stable host dossier underneath.", tasks: [{ href: "/whoareyou", label: "Inspect this request" }, { href: "/search", label: "Search the site" }] },
  radar: { title: "Radar", eyebrow: "Command Prompt · Signal instrument", description: "Turn bounded signal readings into a compact radio-band report.", label: "Readings as JSON", placeholder: '[{"frequency":2412,"dbm":-48}]', parameter: "samples", intro: "Paste a JSON array of readings. The server groups them into bands and reports range, strength, and trend without storing the sample." },
  dict: { title: "Dict", eyebrow: "Internet Options · Compression", description: "Inspect compression-dictionary response headers for a public URL.", label: "Public asset URL", placeholder: "https://example.com/app.js", parameter: "url", intro: "Dictionary compression fails quietly. This makes the registration and content-encoding headers visible." },
  cache: { title: "Cache", eyebrow: "Internet Options · Revalidation", description: "Check how a public URL responds to a conditional revalidation.", label: "Public URL", placeholder: "https://example.com/", parameter: "url", intro: "Two bounded requests reveal whether validators are present and whether the origin honors them." },
  encode: { title: "Encode", eyebrow: "Picture and Fax Viewer · Structure", description: "Inspect the container structure of a public JPEG, PNG, WebP, or AVIF asset.", label: "Public image URL", placeholder: "https://example.com/photo.jpg", parameter: "url", intro: "The first 512 KiB is enough to identify the container and its important markers without decoding pixels." },
  "agent-ready": { title: "Agent Ready", eyebrow: "Network Connections · Agent doors", description: "Audit the public machine-readable doors exposed by a web origin.", label: "Public URL", placeholder: "https://example.com/", parameter: "url", intro: "Doors are observed, never guessed: Markdown negotiation, llms.txt, an agent card, an API catalog, and an MCP endpoint." },
};

export function renderToolPage({ slug, stylesheet }) {
  const tool = definitions[slug];
  const body = `<header><p class="eyebrow">${escapeHtml(tool.eyebrow)}</p><h1>${escapeHtml(tool.title)}</h1><p class="lede">${escapeHtml(tool.description)}</p></header><p class="tool-intro">${escapeHtml(tool.intro)}</p><form class="tool-form" action="/${slug}" method="get"><label for="tool-input">${escapeHtml(tool.label)}</label>${slug === "radar" ? `<textarea id="tool-input" name="${tool.parameter}" rows="5" maxlength="12000" placeholder="${escapeHtml(tool.placeholder)}" required></textarea>` : `<input id="tool-input" name="${tool.parameter}" ${slug === "finger" ? "" : `type="url" inputmode="url"`} maxlength="2048" placeholder="${escapeHtml(tool.placeholder)}" required>`}<button type="submit">Run</button></form><section class="tool-output" id="tool-output" aria-live="polite"><p class="empty-state">No reading yet.</p></section>`;
  return renderDocument({ title: tool.title, description: tool.description, path: `/${slug}`, stylesheet, body, tasks: [{ href: `/${slug}.txt?plain=1`, label: "Open the terminal representation" }, ...tool.tasks ?? []], details: [{ term: "Execution", value: "Server side" }, { term: "Input retained", value: "No" }, { term: "Client script", value: "None" }] });
}

export function renderInbox({ stylesheet }) {
  return renderDocument({
    title: "Inbox",
    description: "Approved Webmentions from the open web.",
    path: "/inbox",
    stylesheet,
    body: `<header><p class="eyebrow">Outlook Express · Local folders</p><h1>Inbox</h1><p class="lede">When another site links to a page here, its verified Webmention can appear as mail after moderation.</p></header><section class="mention-list" id="mention-list"><p class="empty-state">No approved Webmentions in this environment.</p></section><p class="tool-intro">Endpoint: <code>https://aadhar.sh/webmention</code>. POST <code>source</code> and <code>target</code>; nothing is published automatically.</p>`,
    tasks: [{ href: "https://www.w3.org/TR/webmention/", label: "Read the Webmention standard" }, { href: "/writing", label: "Open Writing" }],
    details: [{ term: "State", value: "Moderated" }, { term: "Avatars", value: "Never hotlinked" }, { term: "Client script", value: "None" }],
    head: `<link rel="webmention" href="/webmention">`,
  });
}

export function renderCensus({ stylesheet }) {
  return renderDocument({
    title: "The census",
    description: "A weekly time series of machine-readable web surfaces.",
    path: "/lens/census",
    stylesheet,
    body: `<header><p class="eyebrow">The Other Web · Longitudinal record</p><h1>The census</h1><p class="lede">One inspection is an anecdote. This table keeps the weekly record: named sites, observed agent doors, and readiness scores over time.</p></header><section class="census" id="census"><p class="empty-state">No census snapshots are recorded in this environment yet.</p></section>`,
    tasks: [{ href: "/lens/census.json", label: "Open the series as JSON" }, { href: "/lens", label: "Inspect one URL" }],
    details: [{ term: "Cadence", value: "Weekly" }, { term: "Targets", value: "Published roster" }, { term: "Crawler", value: "AadharshBot" }],
    head: `<link rel="alternate" type="application/json" href="/lens/census.json">`,
  });
}
