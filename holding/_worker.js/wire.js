// wire.js — /terminal: what an agent sees when it points at this site.
//
// ── what this replaced ────────────────────────────────────────────────────
// A Windows PowerShell emulator you could type into: roughly 2,000 lines of
// console, TUI panes, keyboard handling and an 80-column frame renderer, to
// explain an MCP server of 433. The frames it drew even carried [_][#][X]
// window controls in ASCII, inside a real XP window that already had them.
//
// The goal was always to show a VIEWER how an agent sees these tools, and a
// shell is the wrong picture of that: an agent never types. It POSTs JSON-RPC
// and reads JSON back. Emulating a terminal faithfully made the demo LESS
// honest the better it got.
//
// So this page is the exchange itself, rendered from the real handler at request
// time. No client script, no input, no scrollback. If the catalogue here ever
// disagrees with what /mcp answers, it is because they are the same call.
//
// Lives outside terminal.js because mcp.js imports terminal.js, and reaching
// back the other way would be a cycle.
import { handleSiteMcp } from "./mcp.js";
import { lunaPage } from "./lib/chrome.js";
import { escHtml } from "./lib/http.js";

const WIRE_CSS = `/*min*/
.wire{font:12px/1.5 var(--font-mono)}
.wire h2{font:bold 11px/1.4 var(--font-ui);text-transform:uppercase;letter-spacing:.06em;color:#555;margin:18px 0 6px}
.wire h2:first-child{margin-top:0}
.wire pre{background:#f4f4f4;border:1px solid #c8c8c8;padding:8px 10px;margin:0 0 4px;overflow-x:auto;white-space:pre}
.wire .req{background:#eef3fb;border-color:#a9c2e4}
.wire p{font:12px/1.6 var(--font-ui);margin:0 0 10px;max-width:64ch}
.wire .note{color:#555}`;

// One cheap, side-effect-free call, so rendering this page costs a cache read
// and not a crawl. now_playing reads KV; it does not go and scrape Spotify.
const DEMO_CALL = { name: "now_playing", arguments: {} };
const META = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };

const rpc = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });
const jsonBlock = (value) => escHtml(JSON.stringify(value, null, 2));

// Through the REAL handler, not a reimplementation of it. A second code path
// that merely agreed with /mcp today is the thing this page exists to not be.
async function mcpEcho(env, ctx, body) {
  try {
    const res = await handleSiteMcp(new Request("https://aadhar.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }), env, ctx);
    return await res.json();
  } catch { return null; }
}

export async function handleTerminal(request, env, ctx) {
  const listReq = rpc("tools/list", { _meta: META });
  const callReq = rpc("tools/call", { ...DEMO_CALL, _meta: META });
  const [listRes, callRes] = await Promise.all([mcpEcho(env, ctx, listReq), mcpEcho(env, ctx, callReq)]);

  // The catalogue, compacted. A model reads every inputSchema; a person reading
  // this page needs the SHAPE, and forty schemas would bury it.
  const tools = (listRes?.result?.tools || [])
    .map((t) => `${String(t.name).padEnd(22)} ${String(t.description || "").slice(0, 84)}`);
  const catalogue = tools.length
    ? `${tools.length} tools\n\n${tools.join("\n")}`
    : "the tool list could not be read just now";
  const callText = String(callRes?.result?.content?.[0]?.text || "").slice(0, 800)
    || "(no content — the cache is cold)";

  return lunaPage({
    title: "aadhar.sh/terminal",
    path: "aadhar.sh/terminal",
    width: 760,
    description: "What an agent sees when it points at aadhar.sh: the MCP tool catalogue and one call, on the wire.",
    robots: "noindex",
    cache: "no-store",
    css: WIRE_CSS,
    headers: { "x-robots-tag": "noindex" },
    body: `<div class="wire">`
      + `<p>An agent pointed at this site does not browse it. It opens one endpoint, asks what it can do, and calls something. Below is that exchange, run against <b>/mcp</b> when you loaded this page.</p>`
      + `<h2>1 &middot; what can you do</h2>`
      + `<pre class="req">POST /mcp\n${jsonBlock(listReq)}</pre>`
      + `<pre>${escHtml(catalogue)}</pre>`
      + `<h2>2 &middot; do one of them</h2>`
      + `<pre class="req">POST /mcp\n${jsonBlock(callReq)}</pre>`
      + `<pre>${escHtml(callText)}</pre>`
      + `<h2>3 &middot; the same call, from a shell</h2>`
      + `<pre>curl -s https://aadhar.sh/mcp -H 'content-type: application/json' \\\n  -d '${escHtml(JSON.stringify(rpc("tools/call", DEMO_CALL)))}'</pre>`
      + `<p class="note">Every tool above also answers a plain GET at its own path &mdash; /finger, /dict, /encode &mdash; returning text instead of JSON. One implementation, three doors: this page, curl, and any MCP client.</p>`
      + `</div>`,
  });
}
