#!/usr/bin/env node
// paint-diff.ts: `bun run paint:diff <base-checkout>`. What a PR does to first
// contentful paint and layout shift, page by page, against the merge base.
//
//   bun run paint:diff ../main                     # every page that serves different bytes
//   bun run paint:diff ../main --only /,/garage    # these pages, changed or not
//   bun run paint:diff ../main --runs 15 --out paint.md
//
// browser:check holds every page to an absolute line (shift under 0.01). This
// reads the change: a page that went from 0.000 to 0.008 passes that line and
// shows up here, and so does a page whose first paint got 40 ms later because
// a new stylesheet blocks it. perf-diff.yml posts it beside the wire-size diff,
// and like that diff it fails on nothing.
//
// Both checkouts boot their own Worker (tools/paint-serve.ts, copied into the
// base so the boot is the same code), and the pages read are the ones whose
// served document differs. An /a/ URL names its bytes, so a changed stylesheet
// or script changes every document that links it (served-pages.ts has the
// replay). Each page loads --runs times from each side, base and HEAD back to
// back, in a fresh context with a cold cache, at 390px under 4x CPU throttle
// and a 50 Mbps / 40 ms link. lib/paint-diff.ts turns the pairs into a verdict.
//
// THE CONTROLS RUN EVERY TIME, before the sweep, on a blocking-CSS fixture from HEAD on
// both sides: unplanted, nothing may move (the noise floor); with every
// stylesheet held 150 ms, FCP must move; with a 300px block pushed in above the
// content, CLS must move. A control that misses exits 2 ("blind").
import { chromium } from "playwright-core";
import type { Browser, BrowserContext } from "playwright-core";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromeChannel } from "./lib/browser-channel.ts";
import { FLOOR, P_MAX, verdict } from "./lib/paint-diff.ts";
import type { Metric, Verdict } from "./lib/paint-diff.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    only: { type: "string" },
    runs: { type: "string", default: "9" },
    "max-pages": { type: "string", default: "12" },
    out: { type: "string" },
  },
});
if (positionals.length !== 1) {
  console.error("usage: bun run paint:diff <base-checkout> [--only /a,/b] [--runs 9] [--max-pages 12] [--out file.md]");
  process.exit(64);
}
const baseDir = resolve(positionals[0]);
if (!existsSync(join(baseDir, "node_modules"))) throw new Error(`${baseDir}: no node_modules (run \`bun install --frozen-lockfile\` there)`);
const runs = Number(values.runs);
// Five pairs cannot clear the two-sided sign test even when all five agree.
if (!Number.isInteger(runs) || runs < 6) throw new Error(`--runs: a whole number of at least 6, got ${values.runs}`);
const maxPages = Number(values["max-pages"]);
if (!Number.isInteger(maxPages) || maxPages < 1) throw new Error(`--max-pages: a whole number, got ${values["max-pages"]}`);

/** The visitor modelled: a phone on the 50 Mbps link the byte decisions assume. */
const VIEWPORT = { width: 390, height: 844 };
const CPU_THROTTLE = 4;
const LINK = { offline: false, latency: 40, downloadThroughput: (50e6 / 8) | 0, uploadThroughput: (10e6 / 8) | 0 };
/** browser:check's settle: long enough for an island's fetch and swap to land under throttle. */
const SETTLE_MS = 1500;
const CONTROL_PAGE = "/__paint-control";
// The real pages may all load CSS without blocking paint. This fixture keeps
// one sheet render-blocking so its delayed-load control still tests FCP (gotcha 117).
const CONTROL_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/luna.css"><title>Paint control</title></head><body><main><p>First paint control</p><p>Layout shift control</p><p>Stable content</p></main></body></html>';
/** What the FCP control holds every stylesheet for. Nine times FLOOR.fcp, so a reading that sees it can't mistake it for noise. */
const PLANT_CSS_MS = 150;
// /rn answers 302 to Spotify, so there is no page of ours to measure.
const OFFSITE = new Set(["/rn"]);
/** Headers that differ between two boots of one commit (served-pages.ts has the measurement). Keep the two lists the same. */
const VOLATILE = new Set(["date", "etag"]);

/** HEAD's paint-serve.ts, copied beside each checkout's own tools/lib so both boot through the same code. A dotfile no checkout tracks. */
const SERVE_COPY = "tools/.paint-serve.ts";

type Load = { status: number; fcp: number; cls: number };
type Plant = (ctx: BrowserContext) => Promise<unknown>;
type Side = { url: string; plant?: Plant };

/** Boots one checkout's Worker and resolves with its URL; the child serves until its stdin ends. */
function serve(dir: string): Promise<{ url: string; child: ChildProcess }> {
  copyFileSync(join(root, "tools/paint-serve.ts"), join(dir, SERVE_COPY));
  const child = spawn("node", [SERVE_COPY], { cwd: dir, stdio: ["pipe", "pipe", "inherit"] });
  return new Promise((done, fail) => {
    child.once("exit", (code) => fail(new Error(`${dir}: paint-serve exited ${code} before it served`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith('{"url"')) done({ url: JSON.parse(line).url, child });
    });
  });
}

/** One cold load. FCP is the browser's own entry; CLS sums every shift until the settle ends, as browser:check does. */
async function load(browser: Browser, side: Side, path: string): Promise<Load> {
  const ctx = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  try {
    if (side.plant) await side.plant(ctx);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", LINK);
    await page.addInitScript(() => {
      const seen = { cls: 0 };
      Object.assign(globalThis, { __paint: seen });
      new PerformanceObserver((list) => {
        // No hadRecentInput skip: this sends no input, and under isMobile
        // Chrome flags every shift as following input (gotcha 102).
        for (const entry of list.getEntries() as (PerformanceEntry & { value: number })[]) seen.cls += entry.value;
      }).observe({ type: "layout-shift", buffered: true });
    });
    const response = await page.goto(side.url + path, { waitUntil: "load", timeout: 45_000 });
    await page.waitForTimeout(SETTLE_MS);
    const { fcp, cls } = await page.evaluate(() => ({
      fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? Number.NaN,
      cls: (globalThis as unknown as { __paint: { cls: number } }).__paint.cls,
    }));
    return { status: response?.status() ?? 0, fcp, cls };
  } finally {
    await ctx.close();
  }
}

type Reading = { path: string; fcp: Verdict; cls: Verdict } | { path: string; skipped: string };

/** `runs` pairs, alternating which side loads first so neither always gets the warmer moment. */
async function compare(browser: Browser, base: Side, head: Side, path: string): Promise<Reading> {
  const a: Load[] = [];
  const b: Load[] = [];
  for (let i = 0; i < runs; i++) {
    if (i % 2) {
      b.push(await load(browser, head, path));
      a.push(await load(browser, base, path));
    } else {
      a.push(await load(browser, base, path));
      b.push(await load(browser, head, path));
    }
  }
  for (const [name, side] of [
    ["base", a],
    ["HEAD", b],
  ] as const) {
    const bad = side.find((l) => l.status < 200 || l.status > 299);
    if (bad) return { path, skipped: `${name} answered ${bad.status}` };
    if (side.some((l) => Number.isNaN(l.fcp))) return { path, skipped: `${name} never painted content` };
  }
  const pick = (side: Load[], metric: Metric) => side.map((l) => l[metric]);
  return { path, fcp: verdict("fcp", pick(a, "fcp"), pick(b, "fcp")), cls: verdict("cls", pick(a, "cls"), pick(b, "cls")) };
}

/** Each control as [what it plants, the metric it must move, or none for the noise floor]. */
async function controls(browser: Browser, head: string): Promise<{ blind: string[]; lines: string[] }> {
  const fixture =
    (plant?: Plant): Plant =>
    async (ctx) => {
      await ctx.route(
        (url) => url.pathname === CONTROL_PAGE,
        (route) => route.fulfill({ contentType: "text/html", body: CONTROL_HTML }),
      );
      if (plant) await plant(ctx);
    };
  const holdCss: Plant = (ctx) =>
    ctx.route(
      (url) => url.pathname.endsWith(".css"),
      async (route) => {
        await new Promise((r) => {
          setTimeout(r, PLANT_CSS_MS);
        });
        await route.continue();
      },
    );
  const pushDown: Plant = (ctx) =>
    ctx.addInitScript(() =>
      addEventListener("load", () =>
        setTimeout(() => document.querySelector("main")?.insertAdjacentHTML("afterbegin", '<div style="height:300px"></div>'), 300),
      ),
    );
  const cases: [string, Plant | undefined, Metric | null][] = [
    ["nothing planted", undefined, null],
    [`every stylesheet held ${PLANT_CSS_MS} ms`, holdCss, "fcp"],
    ["a 300px block pushed in above the content", pushDown, "cls"],
  ];
  const blind: string[] = [];
  const lines: string[] = [];
  for (const [what, plant, must] of cases) {
    const r = await compare(browser, { url: head, plant: fixture() }, { url: head, plant: fixture(plant) }, CONTROL_PAGE);
    if ("skipped" in r) {
      blind.push(`the control page ${CONTROL_PAGE} was not read with ${what}: ${r.skipped}`);
      continue;
    }
    lines.push(`${what}: FCP ${signed(r.fcp.delta, "ms")}${r.fcp.moved ? " (moved)" : ""}, CLS ${signed(r.cls.delta)}${r.cls.moved ? " (moved)" : ""}`);
    for (const metric of ["fcp", "cls"] as const) {
      const moved = r[metric].moved;
      if (must === metric && !moved) blind.push(`${metric}: ${what} on ${CONTROL_PAGE} read ${signed(r[metric].delta)}, not flagged`);
      if (must !== metric && moved) blind.push(`${metric}: ${what} on ${CONTROL_PAGE} flagged ${signed(r[metric].delta)} that nothing planted`);
    }
  }
  return { blind, lines };
}

const signed = (n: number, unit = "") => `${n >= 0 ? "+" : ""}${unit === "ms" ? Math.round(n) : n.toFixed(3)}${unit ? ` ${unit}` : ""}`;

/** The pages to read: --only as given, otherwise every manifest page whose served document differs between the two. */
async function pagesToRead(base: string, head: string): Promise<{ read: string[]; changed: number; left: string[] }> {
  const manifest: { surfaces: { path: string }[] } = JSON.parse(readFileSync(`${root}config/site-manifest.json`, "utf8"));
  const every = manifest.surfaces.map((s) => s.path).filter((p) => !OFFSITE.has(p));
  if (values.only) return { read: values.only.split(","), changed: 0, left: [] };
  const hash = async (url: string) => {
    const res = await fetch(url, { headers: { "sec-fetch-dest": "document" }, redirect: "manual" });
    const headers = [...res.headers].filter(([name]) => !VOLATILE.has(name)).sort(([x], [y]) => x.localeCompare(y));
    return createHash("sha256")
      .update(JSON.stringify([res.status, headers]))
      .update(new Uint8Array(await res.arrayBuffer()))
      .digest("hex");
  };
  const changed: string[] = [];
  for (const path of every) if ((await hash(base + path)) !== (await hash(head + path))) changed.push(path);
  return { read: changed.slice(0, maxPages), changed: changed.length, left: changed.slice(maxPages) };
}

function report(readings: Reading[], changed: number, left: string[], control: string[], seconds: number): string {
  const ms = (n: number) => `${Math.round(n)} ms`;
  const cls = (n: number) => n.toFixed(3);
  const cell = (v: Verdict, unit: "ms" | "") => `${signed(v.delta, unit)}${v.moved ? " **moved**" : ""}`;
  const moved = readings.filter((r) => !("skipped" in r) && (r.fcp.moved || r.cls.moved)).length;
  const out = ["<!-- paint-diff -->", "### First paint and layout shift vs merge base", ""];
  out.push(
    readings.length === 0
      ? "No page serves a different document, so nothing was read."
      : `${moved} of ${readings.length} page(s) moved. Chrome at ${VIEWPORT.width}px, ${CPU_THROTTLE}x CPU, ${LINK.downloadThroughput / 125000} Mbps and ${LINK.latency} ms RTT, ${runs} cold loads per side, base and HEAD back to back.`,
  );
  if (!values.only)
    out.push(`${changed} page(s) serve a different document${left.length ? `; the first ${readings.length} were read, and ${left.join(", ")} were not` : ""}.`);
  if (readings.length) {
    out.push("", "| page | FCP base | FCP HEAD | change | CLS base | CLS HEAD | change |", "|---|--:|--:|--:|--:|--:|--:|");
    for (const r of readings) {
      if ("skipped" in r) out.push(`| \`${r.path}\` | | | ${r.skipped} | | | |`);
      else
        out.push(
          `| \`${r.path}\` | ${ms(r.fcp.base)} | ${ms(r.fcp.head)} | ${cell(r.fcp, "ms")} | ${cls(r.cls.base)} | ${cls(r.cls.head)} | ${cell(r.cls, "")} |`,
        );
    }
  }
  out.push(
    "",
    `<details><summary>How a change is called moved, and the controls (${Math.round(seconds)} s)</summary>`,
    "",
    `Each change is the median of HEAD minus base over the ${runs} pairs. It is **moved** when a sign test puts the split under p ${P_MAX} and the median is at least ${FLOOR.fcp} ms of FCP or ${FLOOR.cls} of CLS (tools/lib/paint-diff.ts). Advisory: nothing here fails the PR.`,
    "",
    `Controls on \`${CONTROL_PAGE}\`, HEAD against itself:`,
    "",
    ...control.map((l) => `- ${l}`),
    "",
    "</details>",
    "",
  );
  return out.join("\n");
}

const started = performance.now();
const [base, head] = await Promise.all([serve(baseDir), serve(root)]);
let code = 0;
try {
  const browser = await chromium.launch({ channel: chromeChannel(), headless: true });
  try {
    const { blind, lines } = await controls(browser, head.url);
    for (const line of lines) console.log(`control  ${line}`);
    if (blind.length) {
      for (const line of blind) console.error(`paint:diff is BLIND. ${line}`);
      code = 2;
    } else {
      const { read, changed, left } = await pagesToRead(base.url, head.url);
      console.log(`paint:diff: ${values.only ? "reading" : `${changed} page(s) serve a different document; reading`} ${read.join(", ") || "none"}`);
      const readings: Reading[] = [];
      for (const path of read) {
        const at = performance.now();
        const r = await compare(browser, { url: base.url }, { url: head.url }, path);
        const took = `${((performance.now() - at) / 1000).toFixed(0)} s`;
        console.log(
          "skipped" in r
            ? `${path}  skipped: ${r.skipped}`
            : `${path}  FCP ${signed(r.fcp.delta, "ms")} p=${r.fcp.p.toFixed(3)}  CLS ${signed(r.cls.delta)} p=${r.cls.p.toFixed(3)}  (${took})`,
        );
        readings.push(r);
      }
      const markdown = report(readings, changed, left, lines, (performance.now() - started) / 1000);
      if (values.out) writeFileSync(values.out, markdown);
      else console.log(`\n${markdown}`);
    }
  } finally {
    await browser.close();
  }
} finally {
  for (const { child } of [base, head]) child.stdin?.end();
  for (const dir of [baseDir, root]) rmSync(join(dir, SERVE_COPY), { force: true });
}
process.exit(code);
