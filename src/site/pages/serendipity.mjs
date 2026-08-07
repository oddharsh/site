import { renderDocument } from "../document.mjs";

const places = [
  { href: "/serendipity", label: "Events" },
  { href: "/serendipity/contribute", label: "Contribute" },
  { href: "/serendipity/mcp-info", label: "For agents" },
  { href: "/", label: "aadhar.sh" },
];

export function renderSerendipity({ stylesheet }) {
  return renderDocument({
    title: "Serendipity",
    description: "A public pool of events worth going to and the people attending them.",
    path: "/serendipity",
    stylesheet,
    body: `<header><p class="eyebrow">Network Places · Shared folder</p><h1>Serendipity</h1><p class="lede">A public pool of events worth going to and the people attending them. Upcoming events lead; a short recent history stays available underneath.</p></header><section class="event-pool" id="event-pool"><p class="empty-state">The event database is empty in this environment.</p></section>`,
    tasks: [{ href: "/serendipity/events.json", label: "Open events as JSON" }, { href: "/serendipity/contribute", label: "Suggest an event" }, { href: "/serendipity/mcp-info", label: "Connect an agent" }],
    places,
    details: [{ term: "Access", value: "Public, read only" }, { term: "Client script", value: "None" }, { term: "Storage", value: "Cloudflare D1" }],
    head: `<link rel="alternate" type="application/json" href="/serendipity/events.json"><link rel="alternate" type="text/markdown" href="/serendipity.md">`,
  });
}

export function renderSerendipityContribute({ stylesheet }) {
  return renderDocument({
    title: "Contribute to Serendipity",
    description: "Suggest a public event for the Serendipity pool.",
    path: "/serendipity/contribute",
    stylesheet,
    body: `<header><p class="eyebrow">Serendipity · Contribute</p><h1>Suggest an event</h1><p class="lede">Send a public event URL and a sentence about why it belongs. The pool no longer accepts pasted account cookies or session exports.</p></header><section class="contribute-panel"><h2>Private by default</h2><p>The old importer stored third-party session cookies. The new system has no credential intake surface: suggestions arrive as ordinary links and are reviewed before publication.</p><p><a class="native-button" href="mailto:coffee@aadhar.sh?subject=Serendipity%20event%20suggestion&amp;body=Event%20URL%3A%20%0AWhy%20it%20belongs%3A%20">Compose an event suggestion</a></p></section>`,
    tasks: [{ href: "mailto:coffee@aadhar.sh?subject=Serendipity%20event%20suggestion", label: "Email an event suggestion" }, { href: "/serendipity", label: "Browse the pool" }],
    places,
    details: [{ term: "Accepted", value: "Public links" }, { term: "Credentials", value: "Never" }, { term: "Publication", value: "Reviewed" }],
  });
}

export function renderSerendipityMcpInfo({ stylesheet }) {
  return renderDocument({
    title: "Serendipity for agents",
    description: "Read-only MCP access to the public Serendipity event pool.",
    path: "/serendipity/mcp-info",
    stylesheet,
    body: `<header><p class="eyebrow">Serendipity · Network service</p><h1>For agents</h1><p class="lede">The event pool exposes the same public records through a stateless, read-only JSON-RPC endpoint.</p></header><section class="protocol-panel"><h2>Connection</h2><dl><dt>Endpoint</dt><dd><code>https://aadhar.sh/serendipity/mcp</code></dd><dt>Transport</dt><dd>POST JSON-RPC 2.0</dd><dt>State</dt><dd>Stateless</dd><dt>Writes</dt><dd>None</dd></dl><h2>Tools</h2><ul><li><code>list_events</code> — browse upcoming, past, or all events.</li><li><code>get_event</code> — open one event and its public attendee list.</li><li><code>search_people</code> — find public attendees by name.</li><li><code>stats</code> — count events and people.</li></ul><pre>curl -s https://aadhar.sh/serendipity/mcp \\\n  -H 'content-type: application/json' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'</pre></section>`,
    tasks: [{ href: "/serendipity/events.json", label: "Open events JSON" }, { href: "/serendipity", label: "Browse the human view" }],
    places,
    details: [{ term: "Protocol", value: "MCP 2026-07-28" }, { term: "Tools", value: "4 read-only" }, { term: "Sessions", value: "None" }],
  });
}

export function serendipityMarkdown() {
  return `# Serendipity\n\nA public pool of events worth going to and the people attending them.\n\n- [Browse events](https://aadhar.sh/serendipity)\n- [Events as JSON](https://aadhar.sh/serendipity/events.json)\n- [Read-only MCP service](https://aadhar.sh/serendipity/mcp-info)\n`;
}
