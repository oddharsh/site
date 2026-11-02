// webmcp-catalog.ts — does every tool this site declares reach the browser's
// live WebMCP catalog?
//
// contract-webmcp-one-door-onto-the-browser-catalog reads SOURCE: no Lens page
// tool shares a /mcp name, and nothing reaches document.modelContext around
// webmcp.js. What it can't see is the result. The catalog is shared and
// append-only, so a duplicate name, a schema the browser rejects, or a
// registrar that never boots all leave the page working while the tool is gone.
// Playwright 1.64 added page.webmcp, which lists what a page actually
// registered, so this reads that and diffs it against what should be there:
//
//   - every page: the tools the ORIGIN's own /mcp answers tools/list with
//     (webmcp.js registers exactly those), read live rather than from
//     src/worker/mcp.ts, so a production run can't fail on deploy skew;
//   - /lens: those plus the six page tools in lens-webmcp.js (local source).
//
//     bun run webmcp:check                          # production, the sample
//     bun run webmcp:check -- /lens /whoareyou      # chosen paths
//     ORIGIN=http://localhost:8787 bun run webmcp:check
//
// Exit 0 when every page matches, 1 when one doesn't, 2 when the instrument
// failed (no WebMCP in this Chrome, or /mcp listed nothing).
//
// ── the control ───────────────────────────────────────────────────────────
// It runs first, every time: the same page in a Chrome WITHOUT
// --enable-features=WebMCP must make page.webmcp.tools() throw. If it doesn't,
// the "live" catalog could be coming from somewhere else and a green run means
// nothing. Measured 2026-10-11 on Chrome 155.0.8059.40, production: the control
// throws "WebMCP is not enabled"; with the flag, /, /garage and /whoareyou read
// the 25 /mcp tools and /lens reads 31.
//
// ── what it does NOT do ───────────────────────────────────────────────────
// It doesn't gate CI. It needs a Chrome with WebMCP and a reachable origin, the
// same reasons check-agent.ts and csp-sweep.ts run by hand. Registration
// happens on idle (nav.js loads webmcp.js then), so each page is polled until
// its catalog stops growing rather than read once.
import { chromium, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { chromeChannel } from "./lib/browser-channel.ts";
import { diffCatalog, expectedCatalog, lensPageToolNames } from "./lib/webmcp-catalog.ts";

const ORIGIN = (process.env.ORIGIN || "https://aadhar.sh").replace(/\/+$/, "");
const args = process.argv.slice(2).filter((a) => a.startsWith("/"));
const ROUTES = args.length ? args : ["/", "/lens", "/whoareyou", "/garage"];
const FLAG = "--enable-features=WebMCP";

// Settled means the count held for STEADY_MS; DEADLINE_MS caps a page that
// never registers, which then reads as every tool missing.
const POLL_MS = 250;
const STEADY_MS = 1500;
const DEADLINE_MS = 15_000;

async function siteTools(): Promise<string[]> {
  // The same request webmcp.js makes, so this lists what the page will.
  const response = await fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "Mcp-Method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const payload = await response.json();
  return ((payload?.result?.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
}

async function liveCatalog(page: Page): Promise<string[]> {
  let names: string[] = [];
  let steadySince = Date.now();
  const start = Date.now();
  while (Date.now() - start < DEADLINE_MS) {
    const now = (await page.webmcp.tools()).map((t) => t.name);
    if (now.length !== names.length) steadySince = Date.now();
    names = now;
    if (names.length > 0 && Date.now() - steadySince >= STEADY_MS) break;
    await page.waitForTimeout(POLL_MS);
  }
  return names;
}

async function control(): Promise<string | null> {
  const browser = await chromium.launch({ channel: chromeChannel(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${ORIGIN}${ROUTES[0]}`, { waitUntil: "load" });
    await page.webmcp.tools();
    return "page.webmcp.tools() answered in a Chrome without WebMCP, so this instrument can't tell a live catalog from anything else";
  } catch (error) {
    return /WebMCP is not enabled/.test(String(error)) ? null : `control failed for another reason: ${String(error).split("\n")[0]}`;
  } finally {
    await browser.close();
  }
}

const controlFailure = await control();
if (controlFailure) {
  console.error(`webmcp:check: ${controlFailure}`);
  process.exit(2);
}

const site = await siteTools().catch((error) => {
  console.error(`webmcp:check: ${ORIGIN}/mcp tools/list failed: ${String(error).split("\n")[0]}`);
  process.exit(2);
});
if (site.length === 0) {
  console.error(`webmcp:check: ${ORIGIN}/mcp listed no tools, so every page would read as matching`);
  process.exit(2);
}
const lens = lensPageToolNames(readFileSync(new URL("../src/client/lens-webmcp.ts", import.meta.url), "utf8"));

const browser = await chromium.launch({ channel: chromeChannel(), headless: true, args: [FLAG] });
console.log(`webmcp:check: ${ORIGIN}, Chrome ${browser.version()}, control ok, /mcp lists ${site.length}, Lens declares ${lens.length}`);
let failures = 0;
for (const route of ROUTES) {
  // A fresh context per page: the catalog is per document, and a reused one
  // would carry nothing over anyway, but a fresh one can't leak storage either.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${ORIGIN}${route}`, { waitUntil: "load" });
  const live = await liveCatalog(page);
  const expected = expectedCatalog(route, site, lens);
  const { missing, extra } = diffCatalog(expected, live);
  const ok = missing.length === 0 && extra.length === 0;
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${route.padEnd(14)} ${live.length}/${expected.length} registered`);
  if (missing.length) console.log(`        missing: ${missing.join(" ")}`);
  if (extra.length) console.log(`        unexpected: ${extra.join(" ")}`);
  await context.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
