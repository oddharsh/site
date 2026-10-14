// webmcp-catalog.ts — does every tool this site declares reach the browser's
// live WebMCP catalog?
import { chromium, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { chromeChannel } from "./lib/browser-channel.ts";
import { diffCatalog, expectedCatalog, lensPageToolNames } from "./lib/webmcp-catalog.ts";

const ORIGIN = (process.env.ORIGIN || "https://aadhar.sh").replace(/\/+$/, "");
const args = process.argv.slice(2).filter((a) => a.startsWith("/"));
const ROUTES = args.length ? args : ["/", "/lens", "/whoareyou", "/garage"];
const FLAG = "--enable-features=WebMCP";

const POLL_MS = 250;
const STEADY_MS = 1500;
const DEADLINE_MS = 15_000;

async function siteTools(): Promise<string[]> {
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
const lens = lensPageToolNames(readFileSync(new URL("../src/client/lens-webmcp.js", import.meta.url), "utf8"));

const browser = await chromium.launch({ channel: chromeChannel(), headless: true, args: [FLAG] });
console.log(`webmcp:check: ${ORIGIN}, Chrome ${browser.version()}, control ok, /mcp lists ${site.length}, Lens declares ${lens.length}`);
let failures = 0;
for (const route of ROUTES) {
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
