// inbox.js — /inbox, the Outlook Express window where approved webmentions land.
//
// The web writing back to this site is mail, so it renders as mail: a folder
// tree of the pages people wrote about, a striped message list, and a preview
// pane. Every row links OUT to the source, because sending readers to the person
// who wrote about you is the whole social contract of the format.
//
// Deliberately NOT reusing the homepage's `.np-*` classes: that prefix already
// means two different things in this codebase (now-playing inline, Notepad in
// luna.css), and a third meaning would be cruel. Everything here is `oe-`.
//
// No avatars, by choice: hotlinking a stranger's profile picture leaks my
// readers' IPs to their host and buys nothing OE ever had. Name, subject, date,
// excerpt — very 2003.
import { lunaPage } from "./lib/chrome.ts";
import { unsafeHtml } from "./lib/html.ts";
import { esc } from "./lib/http.ts";
import { readApprovedMentions } from "./webmention.ts";

const KIND_LABEL = {
  reply: "replied",
  like: "liked",
  repost: "reposted",
  bookmark: "bookmarked",
  mention: "mentioned",
};

export async function handleInbox(request, env, ctx) {
  const { state, mentions } = await readApprovedMentions(env);
  const origin = new URL(request.url).origin;

  // Folders are the pages that were written about, newest activity first. This
  // answers the question that actually matters at a glance: who is talking
  // about which thing I made.
  const folders = new Map();
  for (const m of mentions) {
    const path = pathOf(m.target, origin);
    folders.getOrInsertComputed(path, () => []).push(m);
  }

  const folderRows = [...folders.entries()].map(([path, items]) =>
    `<li><a class="oe-folder" href="#f-${esc(slugOf(path))}"><span class="oe-fico" aria-hidden="true"></span>${esc(path)}<span class="oe-count">${items.length}</span></a></li>`
  ).join("\n        ");

  const messageRows = mentions.map((m, i) => {
    const kind = KIND_LABEL[m.kind] || "mentioned";
    const when = m.approved_at ? new Date(m.approved_at).toISOString().slice(0, 10) : "";
    // A like/bookmark is a read receipt, not a message: one compact line, no
    // excerpt. A reply/repost/mention is a real message with its own row.
    const light = m.kind === "like" || m.kind === "bookmark";
    return `<li class="oe-row${light ? " oe-light" : ""}" id="m-${i}">
          <span class="oe-from">${esc(m.author || "someone")}</span>
          <span class="oe-subject"><a href="${esc(m.source)}" rel="noopener ugc external" target="_blank">${esc(m.title || m.source)}</a></span>
          <span class="oe-kind">${esc(kind)}</span>
          <span class="oe-target">${esc(pathOf(m.target, origin))}</span>
          <span class="oe-date">${esc(when)}</span>
          ${light || !m.excerpt ? "" : `<p class="oe-excerpt">${esc(m.excerpt)}</p>`}
        </li>`;
  }).join("\n        ");

  const empty = state === "unbound"
    ? "The mention store (Cloudflare D1, aadhar-social) is not connected to this page yet."
    : state === "error"
    ? "The mention store did not answer just now. This page stays read-only either way."
    : "No mentions yet. Link to a page here from your own site and it will show up, once I have approved it.";

  return lunaPage({
    title: "Inbox · aadhar.sh",
    path: "Inbox — Outlook Express",
    route: "/inbox",
    width: 860,
    description: "Webmentions from the open web: who linked to aadhar.sh, moderated and rendered as mail.",
    // The endpoint advertised on the page that displays its results, so a reader
    // (or their software) can find it from here too.
    headers: { link: `<${origin}/webmention>; rel="webmention"` },
    css: OE_CSS,
    body: unsafeHtml(`
    <h1>Inbox</h1>
    <p class="oe-sub">When someone links to a page here from their own site, their post arrives as
      <a href="https://www.w3.org/TR/webmention/" rel="noopener external" target="_blank">a webmention</a>
      — the standards-track descendant of the trackback. Verified automatically (the source really
      does link here), then approved by hand before it appears.</p>

    <div class="oe-panes">
      <nav class="oe-tree" aria-label="folders">
        <ul>
          <li><a class="oe-folder oe-root" href="#all"><span class="oe-fico" aria-hidden="true"></span>Local Folders<span class="oe-count">${mentions.length}</span></a>
            <ul>
        ${folderRows || '<li><span class="oe-folder oe-muted"><span class="oe-fico" aria-hidden="true"></span>(no mail)</span></li>'}
            </ul>
          </li>
        </ul>
      </nav>

      <section class="oe-list" id="all" aria-label="messages">
        <div class="oe-head"><span>From</span><span>Subject</span><span>Kind</span><span>Page</span><span>Received</span></div>
        <ol class="oe-rows">
        ${messageRows || `<li class="oe-row oe-none">${esc(empty)}</li>`}
        </ol>
      </section>
    </div>

    <p class="oe-foot">Endpoint: <code>${esc(origin)}/webmention</code> · POST <code>source</code> and <code>target</code>.
      Mentions are moderated; nothing appears here automatically. Sending a mention again after the link is
      removed retracts it.</p>
`),
  });
}

function pathOf(target, origin) {
  try { return new URL(target).pathname.replace(/\/+$/, "") || "/"; }
  catch { return String(target).replace(origin, "") || "/"; }
}
function slugOf(path) { return path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root"; }

/*min*/
const OE_CSS = `
h1{margin:0 0 4px}
.oe-sub{font-size:9pt;color:#4a5568;margin:0 0 12px;max-width:64ch;line-height:1.5}
.oe-panes{display:grid;grid-template-columns:186px 1fr;gap:9px;align-items:start}
.oe-tree{border:1px solid #7f9db9;background:#fff;padding:6px 4px;min-height:220px}
.oe-tree ul{list-style:none;margin:0;padding:0}
.oe-tree ul ul{margin-left:13px}
.oe-folder{display:flex;align-items:center;gap:6px;padding:3px 5px;font-size:8.5pt;color:#123;text-decoration:none;border-radius:2px}
.oe-folder:hover{background:#e8f0fb}
.oe-root{font-weight:bold}
.oe-muted{color:#8a94a6}
.oe-fico{width:15px;height:12px;flex:0 0 15px;border-radius:1px 2px 2px 1px;background:linear-gradient(180deg,#ffd88a,#eda42c);border:1px solid #c07f14;box-shadow:inset 0 1px 0 #fff6}
.oe-count{margin-left:auto;font-family:var(--font-mono);font-size:7.5pt;color:#5a6b85;background:#eef2f8;border:1px solid #dbe3ee;border-radius:8px;padding:0 5px}
.oe-list{border:1px solid #7f9db9;background:#fff;overflow:hidden}
.oe-head,.oe-row{display:grid;grid-template-columns:1.1fr 2fr .7fr .9fr .7fr;gap:8px;align-items:baseline}
.oe-head{background:linear-gradient(180deg,#f6f8fb,#e3e9f2);border-bottom:1px solid #b9c8dc;padding:4px 8px;font-size:8pt;color:#42506b;font-weight:bold}
.oe-rows{list-style:none;margin:0;padding:0}
.oe-row{padding:6px 8px;border-bottom:1px solid #eef2f7;font-size:9pt;color:#22314d}
.oe-row:nth-child(even){background:#f7f9fc}
.oe-row.oe-light{color:#5a6b85;font-size:8.5pt}
.oe-row.oe-none{display:block;color:#5a6b85;font-size:9pt;padding:14px 10px}
.oe-from{font-weight:bold}
.oe-subject a{color:#0b3fa8;text-decoration:none}
.oe-subject a:hover{text-decoration:underline}
.oe-kind{font-size:8pt;color:#5a6b85}
.oe-target{font-family:var(--font-mono);font-size:7.5pt;color:#6b7280}
.oe-date{font-family:var(--font-mono);font-size:8pt;color:#6b7280}
.oe-excerpt{grid-column:1 / -1;margin:5px 0 1px;padding-left:9px;border-left:3px solid #c7d4e6;color:#41506c;font-size:8.5pt;line-height:1.5}
.oe-foot{font-size:8.5pt;color:#6b7280;border-top:1px solid #e2e8f0;padding-top:8px;margin-top:12px}
.oe-foot code{font-family:var(--font-mono);font-size:8pt}
@media (max-width:640px){.oe-panes{grid-template-columns:1fr}.oe-head{display:none}.oe-row{grid-template-columns:1fr;gap:2px}}
`;
