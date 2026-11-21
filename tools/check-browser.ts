#!/usr/bin/env node
// check-browser.ts: `bun run browser:check`. What a visitor's browser sees on
// every page, read on every PR.
//
//   bun run browser:check                          # build, boot the Worker in-process, sweep
//   bun run browser:check -- --base https://aadhar.sh   # sweep a deployment, with its real data
//   bun run browser:check -- --only /coffee,/lens       # some pages
//   bun run browser:check -- --viewport phone           # one viewport (CI runs each as its own job)
//   bun run browser:check -- --engine webkit --viewport phone   # the phone widths in the engine an iPhone runs (gotcha 109)
//   bun run browser:check -- --changed origin/main --sample 5   # pages the diff reaches, and 1 in 5 of the rest
//                                                  # (built and served beside origin/main when the map can't place a file)
//
// Five readings per manifest surface, in Chrome (WebKit takes three; ENGINES says which and why):
//
//   scroll  the window's scroller and the document are no wider than their box
//           at 320, 360 and 390px (gotcha 97). A page that is, drags sideways.
//   shift   content does not move after it is painted: cumulative layout shift
//           at 1280px and at 390px, under 4x CPU throttle so a script that
//           runs after first paint is caught doing it (gotcha 98), and so is
//           a content-visibility placeholder drawn at its stand-in size (gotcha 103).
//   intl    nothing calls Intl before the reader acts. The first Intl object
//           in a renderer process loads ICU data, 8 to 17 ms of a landing view
//           and 30 to 53 ms throttled (gotcha 92).
//   error   no uncaught exception while the page loads.
//   csp     no Content-Security-Policy violation while the page loads. Chrome
//           reports one whenever a parser sets an inline event handler, even in
//           an inert document, so a demo that parses onerror= on load logs an
//           error on every visit (gotcha 99).
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
// formatted for intl, a thrown error for error, an inline onclick for csp. A reading that misses its
// plant exits 2 ("blind") and nothing is reported as passing.
import { chromium, webkit } from "playwright-core";
import type { Browser, BrowserContext } from "playwright-core";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createTestHarness } from "wrangler";
import { reach, rereadsEverything } from "./lib/browser-pages.ts";
import type { Reach } from "./lib/browser-pages.ts";
import { chromeChannel } from "./lib/browser-channel.ts";
import { overflows } from "./lib/browser-readings.ts";
import { writeSiteConfigFile } from "./lib/site-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    base: { type: "string" },
    only: { type: "string" },
    viewport: { type: "string" },
    changed: { type: "string" },
    sample: { type: "string" },
    engine: { type: "string" },
  },
});

/**
 * The engine that reads the pages. Chrome reads all five. WebKit is what an
 * iPhone runs, in every browser on it, and it reads three: it has no
 * layout-shift entries (PerformanceObserver.supportedEntryTypes, WebKit 27.2),
 * it reports an inline handler's CSP violation only when the handler fires, and
 * it has no CDP to throttle the CPU through. A reading an engine can't take is
 * named in the run's last line and its control is not planted; it is never
 * counted as passing.
 */
const ENGINES = {
  chromium: { name: "Chrome", reads: ["scroll", "shift", "intl", "error", "csp"], launch: () => chromium.launch({ channel: chromeChannel(), headless: true }) },
  webkit: { name: "WebKit", reads: ["scroll", "intl", "error"], launch: () => webkit.launch({ headless: true }) },
} satisfies Record<string, { name: string; reads: string[]; launch: () => Promise<Browser> }>;
const engineName = values.engine ?? "chromium";
if (!(engineName in ENGINES)) throw new Error(`--engine takes ${Object.keys(ENGINES).join(" or ")}, got ${engineName}`);
const engine = ENGINES[engineName as keyof typeof ENGINES];
const reads = (reading: string) => engine.reads.includes(reading);

/**
 * What a --base run adds to Chrome's own user agent, so a deployment can tell
 * this check from a visitor. The visit counter reads "bot" in it and does not
 * advance (PEEK_UA in src/worker/counter.ts); a sweep with Chrome's bare string
 * counted as two visits to / a night. Everything else Chrome sends stays, so
 * the page served is the one a visitor gets. Unset on a local run.
 */
const OWN_UA = "aadhar-sh-browser-check/1.0 (+https://aadhar.sh/bot)";
let userAgent: string | undefined;

/** Phone widths, widest first: the page loads once at 390 and is narrowed. */
const WIDTHS = [390, 360, 320];
/**
 * Each viewport loads every page once, in its own context: the width its shift
 * is read at, and the widths its scroll reading narrows through. The two share
 * nothing, so CI runs each as its own job and a failure names its viewport.
 */
const VIEWPORTS = {
  desktop: { at: "1280px", widths: [], open: (b: Browser) => b.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", userAgent }) },
  phone: {
    at: `${WIDTHS[0]}px`,
    widths: WIDTHS,
    open: (b: Browser) => b.newContext({ viewport: { width: WIDTHS[0], height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block", userAgent }),
  },
} satisfies Record<string, { at: string; widths: number[]; open: (b: Browser) => Promise<BrowserContext> }>;
type Viewport = keyof typeof VIEWPORTS;
const NAMES = Object.keys(VIEWPORTS) as Viewport[];
const viewports: Viewport[] = values.viewport === undefined ? NAMES : NAMES.filter((v) => v === values.viewport);
if (!viewports.length) throw new Error(`--viewport takes ${NAMES.join(" or ")}, got ${values.viewport}`);
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
const every = manifest.surfaces.map((s) => s.path).filter((p) => !OFFSITE.has(p) && (!only || only.includes(p)));
const paths = values.changed === undefined ? every : changedPages(values.changed);

/**
 * The pages a diff against `ref` reaches (lib/browser-pages.ts), and with
 * `--sample n` one in n of the rest, so a reach the map can't see is still
 * read every few PRs. The slice turns with HEAD, which in a PR's CI is the
 * merge commit and moves on every push. A push to main reads every page.
 */
function changedPages(ref: string): string[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const n = values.sample === undefined ? 0 : Number(values.sample);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--sample takes a whole number, got ${values.sample}`);
  const changed = [...git("diff", "--name-only", ref), ...git("ls-files", "--others", "--exclude-standard")];
  const sources = new Map(git("ls-files", "--cached", "--others", "--exclude-standard", "src").map((f) => [f, readFileSync(root + f, "utf8")]));
  let reached = reach(changed, sources);
  if ("all" in reached) {
    // The map gave up, so ask what the Worker serves differently. That can't see
    // a change to the check itself, which moves the reading without moving a byte.
    const instrument = rereadsEverything(changed);
    const start = performance.now();
    const served = instrument === undefined ? servedChange(ref) : { all: instrument };
    const took = `${((performance.now() - start) / 1000).toFixed(0)} s`;
    if ("all" in served) {
      console.log(`browser:check: every page, since ${reached.all} and ${served.all}`);
      return every;
    }
    console.log(`browser:check: ${reached.all}; ${served.pages.length} page(s) serve different bytes than ${ref} (diffed in ${took})`);
    reached = served;
  }
  const turn = n && parseInt(git("rev-parse", "HEAD")[0].slice(0, 8), 16) % n;
  const others = n ? every.filter((p) => !reached.pages.includes(p)).filter((_, i) => i % n === turn) : [];
  console.log(
    `browser:check: ${changed.length} changed file(s) reach ${reached.pages.join(", ") || "no page"}; sampling ${others.length} more${n ? ` (slice ${turn + 1} of ${n})` : ""}`,
  );
  return [...every.filter((p) => reached.pages.includes(p)), ...others];
}

/**
 * The pages whose served bytes differ between `ref` and this checkout
 * (tools/served-pages.ts in each), or why that can't be told. `ref` is built in
 * a throwaway worktree with its own lockfile, so a dependency bump is compared
 * as it would ship; the Bun binary is the one thing both sides share.
 */
function servedChange(ref: string): Reach {
  const dir = mkdtempSync(join(tmpdir(), "served-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("worktree", "add", "--detach", dir, ref);
    cpSync(`${root}tools/served-pages.ts`, `${dir}/tools/served-pages.ts`);
    execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: dir, stdio: "ignore" });
    const playwright = (at: string) => JSON.parse(readFileSync(`${at}/node_modules/playwright-core/package.json`, "utf8")).version;
    if (playwright(dir) !== playwright(root)) return { all: `playwright-core moved from ${playwright(dir)} to ${playwright(root)}` };
    const hash = (cwd: string): Record<string, string> => {
      execFileSync("node", ["tools/served-pages.ts", `${dir}.json`, ...every], { cwd, stdio: "ignore" });
      return JSON.parse(readFileSync(`${dir}.json`, "utf8"));
    };
    const [before, after] = [hash(dir), hash(root)];
    return { pages: every.filter((p) => before[p] !== after[p]) };
  } catch (e) {
    return { all: `the served diff failed (${e instanceof Error ? e.message.split("\n")[0] : e})` };
  } finally {
    if (existsSync(`${dir}/.git`)) git("worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.json`, { force: true });
  }
}

declare global {
  var __seen: { shift: number; moved: string[]; intl: string[]; csp: string[] };
}

/** Installed before any page script: counts layout shift and every Intl call. */
function instrument() {
  const seen: typeof globalThis.__seen = { shift: 0, moved: [], intl: [], csp: [] };
  globalThis.__seen = seen;
  document.addEventListener(
    "securitypolicyviolation",
    (e) => seen.csp.push(`${e.violatedDirective} at ${e.sourceFile.split("/").pop() || "(inline)"}:${e.lineNumber}:${e.columnNumber}`),
    true,
  );
  const name = (node: Node | null) =>
    node instanceof Element ? node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "") + (node.classList.length ? `.${node.classList[0]}` : "") : "?";
  const shifts = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean; sources: { node: Node | null }[] })[]) {
      // No hadRecentInput skip: this harness sends no input, and under
      // isMobile Chrome flags every shift as following input (gotcha 102).
      seen.shift += entry.value;
      if (entry.value > 0.005) seen.moved.push(...entry.sources.slice(0, 2).map((s) => name(s.node)));
    }
  });
  if (PerformanceObserver.supportedEntryTypes.includes("layout-shift")) shifts.observe({ type: "layout-shift", buffered: true });
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

type Reading = {
  status: number;
  shift: number;
  moved: string[];
  intl: string[];
  csp: string[];
  errors: string[];
  scroll: Record<number, string[]>;
  styled: boolean;
};

/**
 * WebKit over plain http needs one directive taken out of each document's CSP.
 * Every page sends `upgrade-insecure-requests`, and WebKit applies it to
 * http://127.0.0.1 where Chrome exempts loopback: each stylesheet and script
 * was re-requested over https, failed its TLS handshake, and the first WebKit
 * sweep read 77 unstyled pages as 255 sideways scrolls (2026-11-20). Only that
 * directive is removed, only from documents, and only here; a deployment is
 * https and is read untouched. The control that checks /search's taskbar is
 * `position: fixed` is what proves a page was read styled.
 */
async function prepared(ctx: BrowserContext, base: string): Promise<BrowserContext> {
  if (engine !== ENGINES.webkit) return ctx;
  // An iPhone overlays its scrollbar and ignores ::-webkit-scrollbar. WebKit on
  // Linux honours luna.css's 16px one, which narrows the window's scroller from
  // 288px to 272px at 320px and reads 16px of overflow no phone has.
  await ctx.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "*::-webkit-scrollbar{width:0!important;height:0!important}";
      document.head.append(style);
    });
  });
  if (!base.startsWith("http://")) return ctx;
  await ctx.route(
    () => true,
    async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback();
      const response = await route.fetch();
      const headers = { ...response.headers() };
      const csp = headers["content-security-policy"];
      if (csp) headers["content-security-policy"] = csp.replace(/;?\s*upgrade-insecure-requests/, "");
      await route.fulfill({ response, headers });
    },
  );
  return ctx;
}

/** One throttled load. `plant` runs in the page once it has loaded, before the settle. */
async function load(ctx: BrowserContext, url: string, widths: number[], plant?: () => void): Promise<Reading> {
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 160)));
  if (reads("shift")) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  await page.addInitScript(instrument);
  const response = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
  if (plant) await page.evaluate(plant);
  await page.waitForTimeout(SETTLE_MS);
  const seen = await page.evaluate(() => globalThis.__seen);
  const styled = await page.evaluate(() => {
    const taskbar = document.getElementById("axp-taskbar");
    return !!taskbar && getComputedStyle(taskbar).position === "fixed";
  });
  const scroll: Record<number, string[]> = {};
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    scroll[width] = await overflows(page);
  }
  await page.close();
  return { status: response?.status() ?? 0, ...seen, errors, scroll, styled };
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
  return second.shift < first.shift
    ? { ...second, errors: [...first.errors, ...second.errors], intl: [...first.intl, ...second.intl], csp: [...first.csp, ...second.csp] }
    : first;
}

/** Every viewport this run reads gets its plants, so no reading is trusted that a plant didn't prove. */
async function controls(browser: Browser, base: string) {
  const blind: string[] = [];
  const url = `${base}/search`;
  for (const v of viewports) {
    const { at, widths, open } = VIEWPORTS[v];
    const ctx = await prepared(await open(browser), base);
    const clean = await load(ctx, url, []);
    if (!clean.styled)
      blind.push(`the control page /search is unstyled in ${engine.name} at ${at}: its taskbar is not position: fixed, so no page was read as it ships`);
    if (clean.shift > SHIFT_MAX || clean.intl.length || clean.csp.length || clean.errors.length)
      blind.push(`the control page /search is not clean itself at ${at}: ${JSON.stringify(clean)}`);
    const shifted = !reads("shift")
      ? null
      : await load(ctx, url, [], () => {
          setTimeout(() => document.querySelector("main")?.insertAdjacentHTML("afterbegin", '<div style="height:300px"></div>'), 300);
        });
    if (shifted && shifted.shift <= SHIFT_MAX) blind.push(`shift: a 300px block pushed in above /search's content read ${shifted.shift} at ${at}`);
    const formatted = await load(ctx, url, [], () => void (1234).toLocaleString());
    if (!formatted.intl.includes("toLocaleString")) blind.push(`intl: a number formatted on /search went uncounted at ${at}`);
    const built = await load(ctx, url, [], () => {
      new Intl.DateTimeFormat("en-US");
    });
    if (!built.intl.includes("Intl.DateTimeFormat")) blind.push(`intl: an Intl.DateTimeFormat built on /search went uncounted at ${at}`);
    const thrown = await load(ctx, url, [], () => {
      setTimeout(() => {
        throw new Error("planted");
      }, 0);
    });
    if (!thrown.errors.some((e) => e.includes("planted"))) blind.push(`error: an exception thrown on /search went unreported at ${at}`);
    const handler = !reads("csp")
      ? null
      : await load(ctx, url, [], () => document.querySelector("main")?.insertAdjacentHTML("beforeend", '<b onclick="void 0"></b>'));
    if (handler && !handler.csp.some((s) => s.startsWith("script-src-attr"))) blind.push(`csp: an inline onclick parsed into /search went unreported at ${at}`);
    if (widths.length) {
      const widened = await load(ctx, url, widths, () => {
        document.querySelector("main")?.insertAdjacentHTML("beforeend", '<div id="planted" style="width:600px;height:1px"></div>');
      });
      for (const width of widths) {
        if (!widened.scroll[width]?.some((line) => line.includes("div#planted")))
          blind.push(`scroll: a 600px block planted in /search went unreported at ${width}px`);
      }
    }
    await ctx.close();
  }
  return blind;
}

async function sweep(browser: Browser, base: string) {
  const legs = await Promise.all(viewports.map(async (v) => ({ ...VIEWPORTS[v], ctx: await prepared(await VIEWPORTS[v].open(browser), base) })));
  const failures: string[] = [];
  const stale: string[] = [];
  const notes: string[] = [];
  const suspects: { path: string; leg: (typeof legs)[number]; max: number; under: number }[] = [];
  const queue = [...paths];
  const worker = async () => {
    for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
      const max = budget.shift[path]?.max ?? SHIFT_MAX;
      const readings: { at: string; r: Reading }[] = [];
      for (const leg of legs) readings.push({ at: leg.at, r: await confirmed(leg.ctx, base + path, leg.widths, max) });
      const fail = (kind: string, detail: string) => failures.push(`FAIL  ${kind.padEnd(6)} ${path}  ${detail}`);
      const every = (pick: (r: Reading) => string[]) => [...new Set(readings.flatMap(({ r }) => pick(r)))];
      for (const status of new Set(readings.map(({ r }) => r.status))) if (status < 200 || status > 299) fail("status", `answered ${status}`);
      readings.forEach(({ r }, i) => {
        if (r.shift > max) suspects.push({ path, leg: legs[i], max, under: r.shift });
      });
      const calls = every((r) => r.intl);
      if (calls.length && !budget.intl[path]) fail("intl", `${calls.join(", ")} before the reader acts`);
      for (const error of every((r) => r.errors)) fail("error", error);
      for (const violation of every((r) => r.csp)) fail("csp", violation);
      for (const { r } of readings) for (const [width, lines] of Object.entries(r.scroll)) for (const line of lines) fail("scroll", `${width}px: ${line}`);
      // A budget the page no longer needs. Only a local sweep says so: a
      // deployment's data can make a page quieter than the fallback state.
      // Stale means under HALF the limit, so a page that sits on the line
      // (/lens/census reads 0.011 against 0.01) cannot flap between failing
      // and stale. The first CI run read /access 0.000 where 4 of 9 loads
      // here read 0.021, and called its budget stale: a page whose shift
      // depends on the machine gets fixed, never budgeted.
      //
      // A budget covers every viewport, so only a run that read them all can
      // call one unneeded: the desktop job alone would retire a budget the
      // phone load still spends. CI's split jobs never judge; a local
      // `bun run browser:check` does.
      if (!values.base && viewports.length === NAMES.length && engine === ENGINES.chromium) {
        const allowed = budget.shift[path];
        const worst = Math.max(...readings.map(({ r }) => r.shift));
        if (allowed && worst <= SHIFT_MAX / 2) stale.push(`${path} holds a shift budget of ${allowed.max} and read ${worst.toFixed(3)}`);
        if (budget.intl[path] && !calls.length) stale.push(`${path} holds an intl exception and called none`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  // A shift over its limit has to repeat with the page read ALONE before it
  // fails. Two readings side by side were not enough: a production sweep on
  // 2026-11-20 read /coffee 0.014 twice with three pages loading at once, and
  // 0.000 in each of three runs on its own. A shift that needs the runner to be
  // busy can't be reproduced by whoever is handed the failure, so it is printed
  // as a NOTE and does not fail the run.
  for (const { path, leg, max, under } of suspects) {
    const alone = await load(leg.ctx, base + path, []);
    if (alone.shift > max) {
      const moved = [...new Set(alone.moved)].slice(0, 4).join(", ") || "no source named";
      failures.push(`FAIL  ${"shift".padEnd(6)} ${path}  ${alone.shift.toFixed(3)} at ${leg.at}, over ${max}: ${moved}`);
    } else notes.push(`${path} read ${under.toFixed(3)} at ${leg.at} beside other loads and ${alone.shift.toFixed(3)} alone`);
  }
  await Promise.all(legs.map((leg) => leg.ctx.close()));
  return { failures: failures.sort(), stale: stale.sort(), notes: notes.sort() };
}

async function run(base: string) {
  const browser = await engine.launch();
  try {
    if (values.base) {
      const probe = await browser.newPage();
      userAgent = `${await probe.evaluate(() => navigator.userAgent)} ${OWN_UA}`;
      await probe.close();
    }
    const blind = await controls(browser, base);
    if (blind.length) {
      for (const line of blind) console.error(`browser:check is BLIND. ${line}`);
      return 2;
    }
    const { failures, stale, notes } = await sweep(browser, base);
    for (const line of failures) console.log(line);
    for (const line of notes) console.log(`NOTE  shift  ${line}`);
    for (const line of stale) console.log(`STALE ${line}: drop it from config/browser-budget.json`);
    const unread = ENGINES.chromium.reads.filter((r) => !reads(r));
    console.log(
      `browser:check: ${paths.length} pages at ${viewports.join(" and ")} in ${engine.name} against ${values.base ?? "the local build"}, ${failures.length} failure(s), ${stale.length} stale budget(s); every planted control was caught${unread.length ? `. NOT READ in ${engine.name}: ${unread.join(", ")}` : ""}.`,
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
