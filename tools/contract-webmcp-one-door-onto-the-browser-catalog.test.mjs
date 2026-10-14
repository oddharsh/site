// ── WebMCP: one door onto the browser-local catalog ─────────────────────────
//
// The browser's tool catalog is SHARED and APPEND-ONLY. Chrome rejects a
// duplicate name, offers no unregisterTool, and ignores an AbortSignal, so a
// name is claimed once per document and a second claim is simply dropped.
// Measured on Chrome 152, 2026-08-25.
import {
  SITE_MCP_TOOLS,
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { readdirSync } from "node:fs";
import { minifiedScripts } from "./lib/client-assets.ts";
import { lensPageToolNames } from "./lib/webmcp-catalog.ts";

const LENS = readFileSync("./src/client/lens.js", "utf8");
const LENS_BOOT = readFileSync("./src/client/lens-boot.js", "utf8");
const LENS_WEBMCP = readFileSync("./src/client/lens-webmcp.js", "utf8");
const WEBMCP = readFileSync("./src/client/webmcp.js", "utf8");
const NAV = readFileSync("./src/client/nav.js", "utf8");
const TRAY = readFileSync("./src/client/nav-tray.js", "utf8");
const SHELL = readFileSync("./tools/photos/shell-data.ts", "utf8");
const CHROME = readFileSync("./src/worker/lib/desktop.ts", "utf8");

const pageToolNames = () => lensPageToolNames(LENS_WEBMCP);

test("no Lens page tool is named after a tool /mcp already serves", () => {
  const page = pageToolNames();
  const server = SITE_MCP_TOOLS.map((t) => t.name);
  assert.ok(page.length >= 6, `expected at least 6 page tools, found ${page.length}`);
  assert.ok(server.length >= 20, `expected at least 20 server tools, found ${server.length}`);
  const clash = page.filter((name) => server.includes(name));
  assert.deepEqual(clash, [],
    `these page tools share a name with a /mcp tool, so the browser will reject them and say nothing: ${clash.join(", ")}`);
});

test("every Lens page tool states its own safety, rather than inheriting a default", () => {
  const start = LENS_WEBMCP.indexOf("const defs = [");
  const end = LENS_WEBMCP.indexOf("\n  ];", start);
  const body = LENS_WEBMCP.slice(start, end);
  const count = pageToolNames().length;
  assert.equal((body.match(/^\s+writes:\s/gm) || []).length, count,
    "every page tool must declare `writes` explicitly");
  assert.equal((body.match(/^\s+annotations:\s/gm) || []).length, count,
    "every page tool must declare `annotations` explicitly");
});

test("webmcp.js is the only client module that uses document.modelContext", () => {
  const clients = readdirSync("./src/client").filter((f) => f.endsWith(".js"));
  assert.ok(clients.length >= 15, `expected at least 15 client modules, found ${clients.length}`);
  const codeOnly = (src) => src
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const mentions = clients.filter((f) => /modelContext/.test(codeOnly(readFileSync(`./src/client/${f}`, "utf8")))).sort();
  assert.deepEqual(mentions, ["lens-boot.js", "nav.js", "webmcp.js"],
    `only webmcp.js may own the WebMCP API, while nav.js and lens-boot.js may feature-check it; found: ${mentions.join(", ")}`);
  for (const [file, source] of [["nav.js", NAV], ["lens-boot.js", LENS_BOOT]]) {
    const uses = codeOnly(source).match(/modelContext\s*[.([]/g) || [];
    assert.deepEqual(uses, [],
      `${file} must only feature-check modelContext, never use it: found ${uses.join(", ")}`);
    assert.ok(/modelContext/.test(codeOnly(source)),
      `${file} should still feature-check before spending its WebMCP-only import`);
  }
  assert.ok(/document\.modelContext/.test(WEBMCP) && /\.registerTool\(/.test(WEBMCP),
    "webmcp.js should be the module that reads the API and registers against it");
  // Both hosts, in both readers. The spec puts the object on `document`;
  // `navigator.modelContext` is the older shape and the one a polyfill or a
  // readiness scanner shims into a browser with no native API. Reading only
  // `document` is how isitagentready.com reported "No tools registered via
  // navigator.modelContext" against a page that registers 25 (2026-09-11), and
  // gating the import on one host while the module reads the other would fail
  // the same way with one more hop.
  assert.match(WEBMCP, /document\.modelContext\)\s*\|\|\s*\(globalThis\.navigator/,
    "webmcp.js must fall back to navigator.modelContext when document has none");
  for (const [file, source] of [["nav.js", NAV], ["lens-boot.js", LENS_BOOT]]) {
    assert.match(codeOnly(source), /modelContext\s*\|\|\s*navigator\.modelContext/,
      `${file} must feature-check navigator.modelContext as well as document.modelContext`);
  }
  assert.match(WEBMCP, /if \(!MC \|\| !MC\.getTools\) return \[\];/,
    "webmcp.js must tolerate a ModelContext with no getTools()");
});

test("a cold Lens document loads its page tools when WebMCP is available", () => {
  assert.match(LENS_BOOT, /\(document\.modelContext \|\| navigator\.modelContext\)\s*\? import\("\/lens-webmcp\.js"\)/,
    "lens-boot.js must load the lightweight registrar in a WebMCP browser");
  assert.match(LENS_BOOT, /if \(pageTools\) pageTools\.then\((?:function \(wm\)|\(wm\) =>) \{ return wm && wm\.boot\(load\); \}\)/,
    "lens-boot.js must register page tools before interaction");
  assert.match(LENS_BOOT, /import\("\/lens-webmcp\.js"\)\.catch\((?:function \(\)|\(\) =>) \{ return null; \}\)/,
    "a failed optional registrar import must not prevent the human Lens client from loading");
  assert.doesNotMatch(LENS_BOOT, /document\.modelContext\s*\|\|\s*hasClientState\(\)/,
    "WebMCP discovery must not hydrate the full Lens client while idle");

  const execute = LENS_WEBMCP.slice(LENS_WEBMCP.indexOf("async function execute"), LENS_WEBMCP.indexOf("const proxy"));
  assert.ok(execute.indexOf("await loadClient()") < execute.indexOf("return handler(args)"),
    "a page-tool call must hydrate lens.js before reaching its live handler");
});

test("the early definitions and lazy Lens handlers stay one-to-one", () => {
  const start = LENS.indexOf("wmBridge.installHandlers({");
  const end = LENS.indexOf("\n  });", start);
  assert.ok(start > 0 && end > start, "could not find the Lens page-handler boundary");
  const handlers = [...LENS.slice(start, end).matchAll(/^\s{4}([a-z0-9_]+): (?:function|\([a-z, ]*\) =>)/gm)].map((m) => m[1]);
  assert.deepEqual(handlers, pageToolNames(),
    "every early page-tool definition needs exactly one closure-backed handler, in the same order");
});

test("successful registration repaints activity observers", () => {
  const start = WEBMCP.indexOf("export async function registerTool");
  assert.ok(start > 0, "registerTool moved; update this scanner");
  const body = WEBMCP.slice(start, WEBMCP.indexOf("// ---- the site's own /mcp tools", start));
  const countAt = body.indexOf("registered += 1");
  const notifyAt = body.indexOf("notify()", countAt);
  const returnAt = body.indexOf('return "registered"', countAt);
  assert.ok(countAt > 0 && notifyAt > countAt && returnAt > notifyAt,
    "registerTool must notify observers after incrementing the count and before returning");
});

test("webmcp.js ships as a minified asset with a readable twin", () => {
  const twins = new Map(minifiedScripts().map((row) => [row.file, row.twin]));
  assert.equal(twins.get("webmcp.js"), "/webmcp.src.js",
    "webmcp.js is missing from the client asset registry, so it would ship unminified and without a .src.js twin");
  assert.equal(twins.get("lens-webmcp.js"), "/lens-webmcp.src.js",
    "lens-webmcp.js is missing from the client asset registry, so the early catalog would ship unminified");
});

test("both entry points reach webmcp.js through an import specifier", () => {
  for (const [file, source] of [["nav.js", NAV], ["lens-webmcp.js", LENS_WEBMCP]]) {
    assert.ok(/import\(\s*"\/webmcp\.js"\s*\)/.test(source),
      `${file} should load the WebMCP core with import("/webmcp.js")`);
  }
});

test("a tool that writes cannot reach its handler without passing the gate", () => {
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
  assert.ok(/id: "axp-webmcp"[^}]*hidden: true/s.test(SHELL),
    "the webmcp tray item must declare hidden: true in shell-data.ts");
  assert.ok(/id=\\"axp-webmcp\\" class=\\"axp-trayico\\" hidden/.test(CHROME),
    "the generated chrome must carry the hidden attribute — re-run bun run gen:shell");
  assert.ok(/ico\.hidden = false/.test(NAV),
    "nav.js must be what unhides it, and only after tools registered");
});

test("the tray reads the log rather than fetching it, and renders every outcome", () => {
  assert.ok(/loadWebmcp/.test(NAV) && /loadWebmcp/.test(TRAY),
    "nav.js should pass a loadWebmcp reader and nav-tray.js should take it");
  assert.ok(!/fetch\(/.test(TRAY.slice(TRAY.indexOf("function renderWebmcp"), TRAY.indexOf("var BALLOON"))),
    "renderWebmcp must not fetch anything");
  for (const outcome of ["ok", "refused", "failed"]) {
    assert.ok(new RegExp(`"${outcome}"`).test(TRAY),
      `the balloon must render the ${outcome} outcome`);
  }
  for (const name of ["summary", "onActivity"]) {
    assert.ok(new RegExp(`export function ${name}\\b`).test(WEBMCP),
      `webmcp.js must export ${name}; nav.js depends on it`);
  }
});
