// Scratch probe (not for merge): load pages N times the way check-browser does and print
// every layout-shift entry with its timing and rects.
import { chromium, type Browser } from "playwright-core";
import { parseArgs } from "node:util";
import { createTestHarness } from "wrangler";
import { chromeChannel } from "./lib/browser-channel.ts";
import { writeSiteConfigFile } from "./lib/site-config.ts";

const { values } = parseArgs({ options: { only: { type: "string" }, n: { type: "string" }, viewport: { type: "string" }, parallel: { type: "string" }, rate: { type: "string" } } });
const paths = values.only!.split(",");
const N = Number(values.n ?? 10);
const PAR = Number(values.parallel ?? 3);
const vp = values.viewport ?? "desktop";
const open = (b: Browser) =>
  vp === "desktop"
    ? b.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" })
    : b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });

function instrument() {
  const seen: any = { entries: [], marks: [] };
  (globalThis as any).__probe = seen;
  const name = (node: Node | null) =>
    node instanceof Element ? node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "") + (node.classList.length ? `.${[...node.classList].join(".")}` : "") : "?";
  const r = (x: DOMRectReadOnly) => `${Math.round(x.x)},${Math.round(x.y)} ${Math.round(x.width)}x${Math.round(x.height)}`;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as any[])
      seen.entries.push({
        t: Math.round(e.startTime),
        v: +e.value.toFixed(4),
        src: e.sources.map((s: any) => `${name(s.node)} ${r(s.previousRect)} -> ${r(s.currentRect)}`),
      });
  }).observe({ type: "layout-shift", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) seen.marks.push(`${e.name}@${Math.round(e.startTime)}`);
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) seen.marks.push(`lcp@${Math.round(e.startTime)}`);
  }).observe({ type: "largest-contentful-paint", buffered: true });
  document.addEventListener("DOMContentLoaded", () => seen.marks.push(`dcl@${Math.round(performance.now())}`));
  addEventListener("load", () => seen.marks.push(`load@${Math.round(performance.now())}`));
  addEventListener("resize", () => seen.marks.push(`resize@${Math.round(performance.now())} ${innerWidth}x${innerHeight}`));
  new ResizeObserver(() => seen.marks.push(`ro@${Math.round(performance.now())} cw=${document.documentElement.clientWidth} sh=${document.documentElement.scrollHeight}`)).observe(
    document.documentElement,
  );
}

async function run(base: string) {
  const browser = await chromium.launch({ channel: chromeChannel(), headless: true });
  const ctx = await open(browser);
  const jobs = paths.flatMap((p) => Array.from({ length: N }, (_, i) => ({ p, i })));
  const worker = async () => {
    for (let j = jobs.shift(); j; j = jobs.shift()) {
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(values.rate ?? 4) });
      await page.addInitScript(instrument);
      await page.goto(base + j.p, { waitUntil: "load", timeout: 45_000 });
      await page.waitForTimeout(1500);
      const s = await page.evaluate(() => (globalThis as any).__probe);
      const total = s.entries.reduce((a: number, e: any) => a + e.v, 0);
      console.log(JSON.stringify({ path: j.p, i: j.i, total: +total.toFixed(4), marks: s.marks, entries: s.entries }));
      await page.close();
    }
  };
  await Promise.all(Array.from({ length: PAR }, worker));
  await browser.close();
}

const server = createTestHarness({
  workers: [{ configPath: "./" + (await writeSiteConfigFile({ localOnly: true })) }, { configPath: `${new URL("..", import.meta.url).pathname}counter/wrangler.jsonc` }],
});
try {
  await run(String((await server.listen()).url).replace(/\/$/, ""));
} finally {
  await server.close();
}
process.exit(0);
