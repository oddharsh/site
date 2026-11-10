#!/usr/bin/env node
// check-browser.ts: `bun run browser:check`. What a visitor's browser sees on
// every page, read on every PR.
//
//   bun run browser:check                          # build, boot the Worker in-process, sweep
//   bun run browser:check -- --base https://aadhar.sh   # sweep a deployment, with its real data
//   bun run browser:check -- --only /coffee,/lens       # some pages
//
// Four readings per manifest surface, in Chrome:
//
//   scroll  the window's scroller and the document are no wider than their box
//           at 320, 360 and 390px (gotcha 97). A page that is, drags sideways.
//   shift   content does not move after it is painted: cumulative layout shift
//           at 1280px and at 390px, under 4x CPU throttle so a script that
//           runs after first paint is caught doing it (gotcha 98).
//   intl    nothing calls Intl before the reader acts. The first Intl object
//           in a renderer process loads ICU data, 8 to 17 ms of a landing view
//           and 30 to 53 ms throttled (gotcha 92).
//   error   no uncaught exception while the page loads.
//
// Each was found by hand on 2026-11-10, a page at a time: six pages scrolling
// sideways, four shifting, nine paying for Intl. This is that crawl, kept, so
// the next one is found by the PR that causes it.
//
// config/browser-budget.json holds the exceptions, each with its reason. A
// page not named there gets SHIFT_MAX and no Intl. A budget entry the page no
// longer needs is reported too, so the file can only shrink.
//
// The harness's KV, R2 and D1 come up empty (routes:check's header has the
// rest), so a data-backed page is measured in its fallback state here. --base
// reads a deployment with its data, and is the reading to trust for those.
// The runner has Linux's fallback fonts, wider than Tahoma and Verdana, so a
// scroll pass is the conservative one.
//
// THE CONTROLS RUN EVERY TIME, before the sweep, on /search: a 600px block for
// scroll, a 300px block pushed in above the content for shift, a number
// formatted for intl, a thrown error for error. A reading that misses its
// plant exits 2 ("blind") and nothing is reported as passing.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createTestHarness } from "wrangler";
import { chromeChannel } from "./lib/browser-channel.ts";
import { writeSiteConfigFile } from "./lib/site-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { base: { type: "string" }, only: { type: "string" } } });

/** Phone widths, widest first: the page loads once at 390 and is narrowed. */
const WIDTHS = [390, 360, 320];
/** A layout shift under this is a sub-pixel settle, not content moving. */
const SHIFT_MAX = 0.01;
/** Long enough for an island's fetch and swap to land under throttle. */
const SETTLE_MS = 1500;
/** Pages open at once. Three keeps a 4-core runner from starving the throttle. */
const PARALLEL = 3;
// /rn answers 302 to Spotify, so there is no page of ours to measure.
const OFFSITE = new Set(["/rn"]);

type Budget = { shift: Record<string, { max: number; why: string }>; intl: Record<string, string> };
const budget: Budget = JSON.parse(readFileSync(`${root}config/browser-budget.json`, "utf8"));
const manifest: { surfaces: { path: string }[] } = JSON.parse(readFileSync(`${root}config/site-manifest.json`, "utf8"));
const only = values.only?.split(",");
const paths = manifest.surfaces.map((s) => s.path).filter((p) => !OFFSITE.has(p) && (!only || only.includes(p)));

declare global {
  var __seen: { shift: number; moved: string[]; intl: string[] };
}

/** Installed before any page script: counts layout shift and every Intl call. */
function instrument() {
  const seen: typeof globalThis.__seen = { shift: 0, moved: [], intl: [] };
  globalThis.__seen = seen;
  const name = (node: Node | null) =>
    node instanceof Element ? node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "") + (node.classList.length ? `.${node.classList[0]}` : "") : "?";
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources: { node: Node | null }[] })[]) {
      if (entry.hadRecentInput) continue;
      seen.shift += entry.value;
      if (entry.value > 0.005) seen.moved.push(...entry.sources.slice(0, 2).map((s) => name(s.node)));
    }
  }).observe({ type: "layout-shift", buffered: true });
  for (const key of ["DateTimeFormat", "NumberFormat", "Collator", "Segmenter", "PluralRules", "RelativeTimeFormat", "ListFormat", "DisplayNames"] as const) {
    const real = Intl[key];
    Object.defineProperty(Intl, key, {
      value: new Proxy(real, {
        construct: (target, args, self) => (seen.intl.push(`Intl.${key}`), Reflect.construct(target, args, self)),
        apply: (target, self, args) => (seen.intl.push(`Intl.${key}`), Reflect.apply(target, self, args)),
      }),
    });
  }
  const methods: [object, string][] = [
    [Date.prototype, "toLocaleDateString"],
    [Date.prototype, "toLocaleTimeString"],
    [Date.prototype, "toLocaleString"],
    [Number.prototype, "toLocaleString"],
    [String.prototype, "localeCompare"],
  ];
  for (const [proto, method] of methods) {
    const real: (...args: unknown[]) => unknown = Reflect.get(proto, method);
    Reflect.set(proto, method, function (this: unknown, ...args: unknown[]) {
      seen.intl.push(method);
      return real.apply(this, args);
    });
  }
}

/** Every scroller wider than its box, with the leaf elements that stick out. */
const overflows = (page: Page) =>
  page.evaluate(() => {
    const name = (el: Element) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (el.classList.length ? `.${el.classList[0]}` : "");
    const found: string[] = [];
    for (const box of [document.documentElement, ...document.querySelectorAll("main, .content")]) {
      if (box.scrollWidth <= box.clientWidth + 1) continue;
      const edge = box.getBoundingClientRect().left + box.clientWidth + 1;
      const past = (el: Element) => el.getBoundingClientRect().right > edge;
      const clips = (el: Element) => getComputedStyle(el).overflowX !== "visible";
      const culprits: string[] = [];
      for (const el of box.querySelectorAll("*")) {
        if (!past(el) || [...el.children].some(past)) continue;
        let up = el.parentElement;
        while (up && up !== box && !clips(up)) up = up.parentElement;
        if (up === box) culprits.push(`${name(el)} +${Math.round(el.getBoundingClientRect().right - edge)}px`);
      }
      found.push(`${name(box)} is ${box.scrollWidth}px in a ${box.clientWidth}px box: ${culprits.slice(0, 4).join(", ") || "no leaf found"}`);
    }
    return found;
  });

type Reading = { status: number; shift: number; moved: string[]; intl: string[]; errors: string[]; scroll: Record<number, string[]> };

/** One throttled load. `plant` runs in the page once it has loaded, before the settle. */
async function load(ctx: BrowserContext, url: string, widths: number[], plant?: () => void): Promise<Reading> {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 160)));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.addInitScript(instrument);
  const response = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
  if (plant) await page.evaluate(plant);
  await page.waitForTimeout(SETTLE_MS);
  const seen = await page.evaluate(() => globalThis.__seen);
  const scroll: Record<number, string[]> = {};
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    scroll[width] = await overflows(page);
  }
  await page.close();
  return { status: response?.status() ?? 0, ...seen, errors, scroll };
}

/**
 * A shift over the limit is read a second time and judged on the lower reading.
 * With three pages loading at once a paint can land early: /garage/pretext read
 * 0.056 in one sweep and 0.005 in each of 6 loads alone (2026-11-10). A script
 * that moves content after paint does it on every load, so it still fails.
 */
async function confirmed(ctx: BrowserContext, url: string, widths: number[], max: number): Promise<Reading> {
  const first = await load(ctx, url, widths);
  if (first.shift <= max) return first;
  const second = await load(ctx, url, widths);
  return second.shift < first.shift ? { ...second, errors: [...first.errors, ...second.errors], intl: [...first.intl, ...second.intl] } : first;
}

const desktop = (browser: Browser) => browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
const phone = (browser: Browser) =>
  browser.newContext({ viewport: { width: WIDTHS[0], height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });

async function controls(browser: Browser, base: string) {
  const [wide, narrow] = [await desktop(browser), await phone(browser)];
  const blind: string[] = [];
  const url = `${base}/search`;
  const clean = await load(wide, url, []);
  if (clean.shift > SHIFT_MAX || clean.intl.length || clean.errors.length) blind.push(`the control page /search is not clean itself: ${JSON.stringify(clean)}`);
  const shifted = await load(wide, url, [], () => {
    setTimeout(() => document.querySelector("main")?.insertAdjacentHTML("afterbegin", '<div style="height:300px"></div>'), 300);
  });
  if (shifted.shift <= SHIFT_MAX) blind.push(`shift: a 300px block pushed in above /search's content read ${shifted.shift}`);
  const formatted = await load(wide, url, [], () => void (1234).toLocaleString());
  if (!formatted.intl.includes("toLocaleString")) blind.push("intl: a number formatted on /search went uncounted");
  const built = await load(wide, url, [], () => void new Intl.DateTimeFormat("en-US"));
  if (!built.intl.includes("Intl.DateTimeFormat")) blind.push("intl: an Intl.DateTimeFormat built on /search went uncounted");
  const thrown = await load(wide, url, [], () => {
    setTimeout(() => {
      throw new Error("planted");
    }, 0);
  });
  if (!thrown.errors.some((e) => e.includes("planted"))) blind.push("error: an exception thrown on /search went unreported");
  const widened = await load(narrow, url, WIDTHS, () => {
    document.querySelector("main")?.insertAdjacentHTML("beforeend", '<div id="planted" style="width:600px;height:1px"></div>');
  });
  for (const width of WIDTHS) {
    if (!widened.scroll[width]?.some((line) => line.includes("div#planted")))
      blind.push(`scroll: a 600px block planted in /search went unreported at ${width}px`);
  }
  await Promise.all([wide.close(), narrow.close()]);
  return blind;
}

async function sweep(browser: Browser, base: string) {
  const [wide, narrow] = [await desktop(browser), await phone(browser)];
  const failures: string[] = [];
  const stale: string[] = [];
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const max = budget.shift[path]?.max ?? SHIFT_MAX;
      const [d, p] = [await confirmed(wide, base + path, [], max), await confirmed(narrow, base + path, WIDTHS, max)];
      const fail = (kind: string, detail: string) => failures.push(`FAIL  ${kind.padEnd(6)} ${path}  ${detail}`);
      if (d.status < 200 || d.status > 299) fail("status", `answered ${d.status}`);
      for (const [where, r] of [
        ["1280px", d],
        [`${WIDTHS[0]}px`, p],
      ] as const) {
        if (r.shift > max)
          fail("shift", `${r.shift.toFixed(3)} at ${where}, over ${max}: ${[...new Set(r.moved)].slice(0, 4).join(", ") || "no source named"}`);
      }
      const calls = [...new Set([...d.intl, ...p.intl])];
      if (calls.length && !budget.intl[path]) fail("intl", `${calls.join(", ")} before the reader acts`);
      for (const error of new Set([...d.errors, ...p.errors])) fail("error", error);
      for (const width of WIDTHS) for (const line of p.scroll[width] ?? []) fail("scroll", `${width}px: ${line}`);
      // A budget the page no longer needs. Only a local sweep says so: a
      // deployment's data can make a page quieter than the fallback state.
      // Stale means under HALF the limit, so a page that sits on the line
      // (/lens/census reads 0.011 against 0.01) cannot flap between failing
      // and stale. The first CI run read /access 0.000 where 4 of 9 loads
      // here read 0.021, and called its budget stale: a page whose shift
      // depends on the machine gets fixed, never budgeted.
      if (!values.base) {
        const allowed = budget.shift[path];
        if (allowed && Math.max(d.shift, p.shift) <= SHIFT_MAX / 2)
          stale.push(`${path} holds a shift budget of ${allowed.max} and read ${Math.max(d.shift, p.shift).toFixed(3)}`);
        if (budget.intl[path] && !calls.length) stale.push(`${path} holds an intl exception and called none`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  await Promise.all([wide.close(), narrow.close()]);
  return { failures: failures.sort(), stale: stale.sort() };
}

async function run(base: string) {
  const browser = await chromium.launch({ channel: chromeChannel(), headless: true });
  try {
    const blind = await controls(browser, base);
    if (blind.length) {
      for (const line of blind) console.error(`browser:check is BLIND. ${line}`);
      return 2;
    }
    const { failures, stale } = await sweep(browser, base);
    for (const line of failures) console.log(line);
    for (const line of stale) console.log(`STALE ${line}: drop it from config/browser-budget.json`);
    console.log(
      `browser:check: ${paths.length} pages against ${values.base ?? "the local build"}, ${failures.length} failure(s), ${stale.length} stale budget(s); every planted control was caught.`,
    );
    return failures.length || stale.length ? 1 : 0;
  } finally {
    await browser.close();
  }
}

let code = 1;
if (values.base) {
  code = await run(values.base.replace(/\/$/, ""));
} else {
  const server = createTestHarness({
    workers: [{ configPath: "./" + (await writeSiteConfigFile({ localOnly: true })) }, { configPath: `${root}counter/wrangler.jsonc` }],
  });
  try {
    code = await run(String((await server.listen()).url).replace(/\/$/, ""));
  } finally {
    // workerd holds the process open; close() before the exit code is reported.
    await server.close();
  }
}

process.exit(code);
