import { renderDocument } from "../document.mjs";

export function renderReading({ stylesheet }) {
  return renderDocument({
    title: "Reading",
    description: "A public mirror of Aadharsh's saved reading list.",
    path: "/reading",
    stylesheet,
    body: `<header><p class="eyebrow">Favorites · Reading</p><h1>Reading</h1><p class="lede">Recent links and highlights from my public Curius list. The server fills this document from a bounded, cached snapshot.</p></header><section class="live-list" id="reading-list" aria-live="polite"><p class="empty-state">The reading snapshot is empty in this environment. <a href="https://curius.app/aadharsh-pannirselvam" rel="external">Open the canonical list on Curius</a>.</p></section>`,
    tasks: [{ href: "https://curius.app/aadharsh-pannirselvam", label: "Open the canonical Curius list" }],
    details: [{ term: "Source", value: "Curius public list" }, { term: "Client script", value: "None" }],
  });
}

export function renderAround({ stylesheet }) {
  return renderDocument({
    title: "Around",
    description: "A cached, robots-aware snapshot of neighboring crypto venture sites.",
    path: "/around",
    stylesheet,
    body: `<header><p class="eyebrow">Network Places · Neighborhood</p><h1>Around</h1><p class="lede">A scheduled crawler checks a small public neighborhood. Visits only read its last snapshot; they never trigger third-party requests.</p></header><section class="live-list" id="around-report"><p class="empty-state">No crawl snapshot is available in this environment yet.</p></section>`,
    tasks: [{ href: "/around/json", label: "Open the latest snapshot as JSON" }, { href: "/around/changes.json", label: "Open the change feed" }, { href: "/bot", label: "Read the crawler contract" }],
    details: [{ term: "Targets", value: "20 public sites" }, { term: "Trigger", value: "Scheduled only" }, { term: "Visitor fetches", value: "Zero" }],
    head: `<link rel="alternate" type="application/json" href="/around/json">`,
  });
}

export function renderLedger({ stylesheet }) {
  return renderDocument({
    title: "Crawl Ledger",
    description: "A transparent ledger of self-identified crawler traffic to worker-served routes.",
    path: "/ledger",
    stylesheet,
    body: `<header><p class="eyebrow">Accounts Receivable · Public record</p><h1>Crawl Ledger</h1><p class="lede">A 30-day invoice for self-identified crawler visits. Identity comes from the request's User-Agent and the posted rate is commentary, not a market price.</p></header><section class="ledger-sheet" id="ledger-data"><h2>Meter status</h2><p class="empty-state">This environment cannot read the Analytics Engine ledger. Counting, when configured, remains best-effort and never affects a response.</p></section>`,
    tasks: [{ href: "/ledger.json", label: "Open the ledger as JSON" }, { href: "/security", label: "Read the data posture" }],
    details: [{ term: "Window", value: "30 days" }, { term: "Posted rate", value: "$0.01 / request" }, { term: "Identity", value: "Self-reported" }],
    head: `<link rel="alternate" type="application/json" href="/ledger.json">`,
  });
}
