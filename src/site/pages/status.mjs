import { escapeHtml, renderDocument } from "../document.mjs";

function latestFirst(checkpoints, limit = checkpoints.length) {
  return checkpoints.slice(-limit).reverse();
}

export function updatesMarkdown(checkpoints) {
  const rows = latestFirst(checkpoints, 18);
  return `# Windows Update\n\n## Recently installed\n\n${rows.map((point) => `- **${point.version}** — ${point.title} (${point.ymd})`).join("\n")}\n`;
}

export function restoreMarkdown(checkpoints) {
  return `# System Restore\n\n## Restore points\n\nThese are read-only records of releases; this page cannot perform a rollback.\n\n${latestFirst(checkpoints).map((point) => `- **Restore point ${point.vnum}:** ${point.version} — ${point.title} (${point.ymd})`).join("\n")}\n`;
}

export function renderUpdates({ checkpoints, stylesheet }) {
  const recent = latestFirst(checkpoints, 18);
  const current = recent[0];
  const body = `
    <header>
      <p class="eyebrow">Control Panel · Windows Update</p>
      <h1>Windows Update</h1>
      <p class="lede">A read-only release log generated from the same checkpoint projection used by System Restore.</p>
    </header>
    <section class="system-state" aria-labelledby="update-state">
      <h2 id="update-state">aadhar.sh is up to date</h2>
      <p>Running checkpoint <code>${escapeHtml(current?.version ?? "unrecorded")}</code>.</p>
    </section>
    <section class="record-section">
      <h2>Recently installed</h2>
      <ol class="record-list">${recent.map((point) => `<li><time datetime="${point.ymd}">${point.ymd}</time><strong>${escapeHtml(point.version)}</strong><span>${escapeHtml(point.title)}</span></li>`).join("")}</ol>
    </section>`;

  return renderDocument({
    title: "Windows Update",
    description: "The public aadhar.sh release checkpoint log.",
    path: "/updates",
    stylesheet,
    body,
    tasks: [
      { href: "/updates.json", label: "Open release data as JSON" },
      { href: "/updates.md", label: "Read canonical Markdown" },
      { href: "/restore", label: "Browse restore points" },
    ],
    details: [
      { term: "State", value: "Read only" },
      { term: "Entries shown", value: String(recent.length) },
      { term: "Source", value: "Release checkpoints" },
    ],
    head: `<link rel="alternate" type="application/json" href="/updates.json"><link rel="alternate" type="text/markdown" href="/updates.md">`,
  });
}

export function renderRestore({ checkpoints, stylesheet }) {
  const points = latestFirst(checkpoints);
  const body = `
    <header>
      <p class="eyebrow">Control Panel · System Restore</p>
      <h1>System Restore</h1>
      <p class="lede">Every recorded release is visible here. The browser can inspect the history but cannot change production.</p>
    </header>
    <section class="system-state" aria-labelledby="restore-state">
      <h2 id="restore-state">You are here</h2>
      <p>The newest recorded checkpoint is <code>${escapeHtml(points[0]?.version ?? "unrecorded")}</code>.</p>
    </section>
    <section class="record-section">
      <h2>Restore points</h2>
      <p>Choose a row to open its stable address in the release history. A real rollback remains an authenticated operator action.</p>
      <ol class="record-list restore-points">${points.map((point) => `<li id="v${point.vnum}"><a href="#v${point.vnum}"><time datetime="${point.ymd}">${point.ymd}</time><strong>Restore point ${point.vnum}</strong><span>${escapeHtml(point.title)} · ${escapeHtml(point.version)}</span></a></li>`).join("")}</ol>
    </section>`;

  return renderDocument({
    title: "System Restore",
    description: "A read-only browser for the aadhar.sh release history.",
    path: "/restore",
    stylesheet,
    body,
    tasks: [
      { href: "/restore.md", label: "Read canonical Markdown" },
      { href: "/updates", label: "Open Windows Update" },
    ],
    details: [
      { term: "State", value: "Read only" },
      { term: "Restore points", value: String(points.length) },
      { term: "Recovery", value: "Operator controlled" },
    ],
    head: `<link rel="alternate" type="text/markdown" href="/restore.md">`,
  });
}
