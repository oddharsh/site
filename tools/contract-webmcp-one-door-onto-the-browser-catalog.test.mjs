// ── WebMCP: one door onto the browser-local catalog ─────────────────────────
//
// The browser's tool catalog is SHARED and APPEND-ONLY. Chrome rejects a
// duplicate name, offers no unregisterTool, and ignores an AbortSignal, so a
// name is claimed once per document and a second claim is simply dropped.
// Measured on Chrome 152, 2026-08-25.
//
// That makes two mistakes silent rather than loud, and this file exists for
// both. A page tool named after a /mcp tool never registers, and nothing says
// so. A module that reaches document.modelContext directly skips the annotation
// channel and the consent gate, and the tool still works, which is the worst
// possible outcome for a safety layer.
import {
  SITE_MCP_TOOLS,
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { readdirSync } from "node:fs";

const LENS = readFileSync("./src/client/lens.js", "utf8");
const WEBMCP = readFileSync("./src/client/webmcp.js", "utf8");
const NAV = readFileSync("./src/client/nav.js", "utf8");
const BUILD = readFileSync("./tools/build.ts", "utf8");
const TRAY = readFileSync("./src/client/nav-tray.js", "utf8");
const SHELL = readFileSync("./tools/photos/shell-data.ts", "utf8");
const CHROME = readFileSync("./src/worker/lib/desktop.ts", "utf8");

// The page tools are declared in one array literal at the end of lens.js. Read
// the array rather than the whole file, so a `name:` in some unrelated object
// cannot inflate the count and hide a collision.
function pageToolNames() {
  const start = LENS.indexOf("var defs = [");
  assert.ok(start > 0, "lens.js no longer declares its WebMCP page tools as `var defs = [` — update this scanner");
  const end = LENS.indexOf("\n    ];", start);
  assert.ok(end > start, "could not find the end of the page-tool array");
  return [...LENS.slice(start, end).matchAll(/^\s+name:\s*"([a-z0-9_]+)",$/gm)].map((m) => m[1]);
}

test("no Lens page tool is named after a tool /mcp already serves", () => {
  const page = pageToolNames();
  // The whole served catalog. DATA_TOOLS is only 10 of the 25 names /mcp
  // answers with, so checking against it would miss a collision with any of
  // the terminal or hosted tools mcp.ts composes on top.
  const server = SITE_MCP_TOOLS.map((t) => t.name);
  // FLOORS. A scanner that matches nothing otherwise reports a clean pass, which
  // is the failure mode every scanner in this repo has had at least once.
  assert.ok(page.length >= 6, `expected at least 6 page tools, found ${page.length}`);
  assert.ok(server.length >= 20, `expected at least 20 server tools, found ${server.length}`);
  const clash = page.filter((name) => server.includes(name));
  assert.deepEqual(clash, [],
    `these page tools share a name with a /mcp tool, so the browser will reject them and say nothing: ${clash.join(", ")}`);
});

test("every Lens page tool states its own safety, rather than inheriting a default", () => {
  const start = LENS.indexOf("var defs = [");
  const end = LENS.indexOf("\n    ];", start);
  const body = LENS.slice(start, end);
  const count = pageToolNames().length;
  // `writes` is what arms the consent dialog and `annotations` is what feeds the
  // description's safety line. Defaulting either one is how a tool that changes
  // something ends up describing itself as read-only.
  assert.equal((body.match(/^\s+writes:\s/gm) || []).length, count,
    "every page tool must declare `writes` explicitly");
  assert.equal((body.match(/^\s+annotations:\s/gm) || []).length, count,
    "every page tool must declare `annotations` explicitly");
});

test("webmcp.js is the only client module that reads document.modelContext", () => {
  // Anything reaching the API directly bypasses the safety note and the consent
  // gate, and its tools would keep working, so this cannot be left to review.
  // Going THROUGH webmcp.js (wm.registerTool) is exactly the point, so the rule
  // is about who READS the browser object, not who calls a method named like it.
  const clients = readdirSync("./src/client").filter((f) => f.endsWith(".js"));
  assert.ok(clients.length >= 15, `expected at least 15 client modules, found ${clients.length}`);
  // String bodies are blanked first. lens.js legitimately NAMES the API in the
  // readiness fix copy it shows a visitor ("Expose safe browser actions with
  // document.modelContext"), and a rule that cannot tell page copy from a call
  // would either fail on that sentence or be silenced into uselessness.
  // Strings FIRST, in ONE pass over all three quote styles, then comments.
  //
  // Both halves are load-bearing and the order is too. Three separate quote
  // passes is wrong: the double-quote pass runs first, so a ' ... " ... " ... '
  // string is chewed from the middle and whatever followed is exposed as if it
  // were code. And stripping comments BEFORE strings would eat the // inside a
  // URL literal. lens.js is the file that proves both, since it names this API
  // in visitor-facing copy, in a comment, and in an HTML string.
  const codeOnly = (src) => src
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const mentions = clients.filter((f) => /modelContext/.test(codeOnly(readFileSync(`./src/client/${f}`, "utf8")))).sort();
  assert.deepEqual(mentions, ["nav.js", "webmcp.js"],
    `only webmcp.js may own the WebMCP API, and nav.js may feature-check it; found: ${mentions.join(", ")}`);
  // nav.js may READ the object to decide whether to spend the import, and may
  // never touch anything ON it. Counting the mentions was the first version of
  // this and it was wrong the moment a second guard appeared (the tray reader
  // needs its own); the number was never the rule. This is: bare truthiness
  // only, so no property access, no call, no index.
  const navUse = codeOnly(NAV).match(/modelContext\s*[.([]/g) || [];
  assert.deepEqual(navUse, [],
    `nav.js must only feature-check modelContext, never use it: found ${navUse.join(", ")}`);
  assert.ok(/modelContext/.test(codeOnly(NAV)),
    "nav.js should still feature-check before importing webmcp.js");
  assert.ok(/document\.modelContext/.test(WEBMCP) && /\.registerTool\(/.test(WEBMCP),
    "webmcp.js should be the module that reads the API and registers against it");
});

test("webmcp.js ships as a minified asset with a readable twin", () => {
  assert.ok(/\["webmcp\.js",\s*"\/webmcp\.src\.js",/.test(BUILD),
    "webmcp.js is missing from build.ts SHELLS, so it would ship unminified and without a .src.js twin");
});

test("both entry points reach webmcp.js through an import specifier", () => {
  // Deliberately unhashed, for hoist.js's reason: the /a/ repointer is
  // attribute-scoped (src=/href= only) and would never rewrite an import().
  for (const [file, source] of [["nav.js", NAV], ["lens.js", LENS]]) {
    assert.ok(/import\(\s*"\/webmcp\.js"\s*\)/.test(source),
      `${file} should load the WebMCP core with import("/webmcp.js")`);
  }
});

test("a tool that writes cannot reach its handler without passing the gate", () => {
  // Structural on purpose: the gate needs a real browser and a real person, and
  // node has neither. What IS checkable is that the one path to a writing tool's
  // handler runs through gate() first, in the single function that builds them.
  const start = WEBMCP.indexOf("export async function registerTool");
  assert.ok(start > 0, "registerTool moved; update this scanner");
  const body = WEBMCP.slice(start);
  const gateAt = body.indexOf("await gate(");
  const callAt = body.indexOf("await def.execute(");
  assert.ok(gateAt > 0 && callAt > 0, "registerTool no longer both gates and calls");
  assert.ok(gateAt < callAt,
    "the consent gate must run BEFORE the tool's own handler, or it is decoration");
  assert.ok(/if \(writes\) \{/.test(body), "the gate must be conditional on `writes`");
});

test("the agent-activity tray icon ships HIDDEN and is unhidden by script", () => {
  // The icon claims "an agent can drive this page", which is only true in a
  // browser that implements WebMCP. Shipping it visible would show a Safari
  // visitor a control for a thing their browser cannot do.
  assert.ok(/id: "axp-webmcp"[^}]*hidden: true/s.test(SHELL),
    "the webmcp tray item must declare hidden: true in shell-data.ts");
  assert.ok(/id=\\"axp-webmcp\\" class=\\"axp-trayico\\" hidden/.test(CHROME),
    "the generated chrome must carry the hidden attribute — re-run bun run gen:shell");
  assert.ok(/ico\.hidden = false/.test(NAV),
    "nav.js must be what unhides it, and only after tools registered");
});

test("the tray reads the log rather than fetching it, and renders every outcome", () => {
  // The audit log is module state in this document. A reader that fetched would
  // be inventing an endpoint for data it already holds.
  assert.ok(/loadWebmcp/.test(NAV) && /loadWebmcp/.test(TRAY),
    "nav.js should pass a loadWebmcp reader and nav-tray.js should take it");
  assert.ok(!/fetch\(/.test(TRAY.slice(TRAY.indexOf("function renderWebmcp"), TRAY.indexOf("var BALLOON"))),
    "renderWebmcp must not fetch anything");
  for (const outcome of ["ok", "refused", "failed"]) {
    assert.ok(new RegExp(`"${outcome}"`).test(TRAY),
      `the balloon must render the ${outcome} outcome`);
  }
  // webmcp.js has to keep exporting what the tray reads.
  for (const name of ["summary", "onActivity"]) {
    assert.ok(new RegExp(`export function ${name}\\b`).test(WEBMCP),
      `webmcp.js must export ${name}; nav.js depends on it`);
  }
});
