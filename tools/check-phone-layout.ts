#!/usr/bin/env node
// check-phone-layout.ts: `bun run phone:check`. No page scrolls sideways on a phone.
//
// Boots the built Worker in-process (the harness routes:check uses), opens
// every surface in config/site-manifest.json in Chrome at 360px and 390px, and
// fails when the window's scroller or the document is wider than its box. A
// page that is, drags left and right under the thumb, and whatever sits past
// the edge (a submit button, a table column) is off screen until somebody
// finds the scroll. Six pages did on 2026-11-10 (gotcha 97).
//
// 360 and 390 are the two widths phones ship today (Android's common width and
// the iPhone's). 320 is left out on purpose: eight pages still overflow there
// by 3 to 37px (measured 2026-11-10), and the last 320px iPhone left sale in
// 2018.
//
// The runner has Linux's fallback fonts, which run wider than Tahoma and
// Verdana, so a pass here is the conservative reading.
//
// THE CONTROL RUNS EVERY TIME. Before the sweep, a 600px block is planted in
// /search's scroller and the detector has to name it. If it can't, the run
// exits 2 ("blind") without reporting a pass.
import { chromium, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTestHarness } from "wrangler";
import { chromeChannel } from "./lib/browser-channel.ts";
import { writeSiteConfigFile } from "./lib/site-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const WIDTHS = [360, 390];
// /rn answers 302 to Spotify, so there is no page of ours to measure.
const OFFSITE = new Set(["/rn"]);

const manifest: { surfaces: { path: string }[] } = JSON.parse(readFileSync(`${root}config/site-manifest.json`, "utf8"));
const paths = manifest.surfaces.map((s) => s.path).filter((p) => !OFFSITE.has(p));

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

const server = createTestHarness({
  workers: [{ configPath: "./" + (await writeSiteConfigFile({ localOnly: true })) }, { configPath: `${root}counter/wrangler.jsonc` }],
});

let code = 1;
try {
  const base = String((await server.listen()).url).replace(/\/$/, "");
  const browser = await chromium.launch({ channel: chromeChannel(), headless: true });
  try {
    let failures = 0;
    for (const width of WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });

      const control = await ctx.newPage();
      await control.goto(`${base}/search`, { waitUntil: "load" });
      await control.evaluate(() => document.querySelector("main")?.insertAdjacentHTML("beforeend", '<div id="planted" style="width:600px;height:1px"></div>'));
      if (!(await overflows(control)).some((line) => line.includes("div#planted"))) {
        console.error(`phone:check is BLIND at ${width}px: a 600px block planted in /search went unreported.`);
        process.exit(2);
      }
      await control.close();

      for (const path of paths) {
        const page = await ctx.newPage();
        const response = await page.goto(base + path, { waitUntil: "load" });
        const found = response?.ok() ? await overflows(page) : [`answered ${response?.status()}`];
        for (const line of found) console.log(`FAIL  ${width}px  ${path}  ${line}`);
        failures += found.length;
        await page.close();
      }
      await ctx.close();
    }
    console.log(`phone:check: ${paths.length} pages at ${WIDTHS.join(" and ")}px, ${failures} failure(s); the planted control was caught at each width.`);
    code = failures ? 1 : 0;
  } finally {
    await browser.close();
  }
} finally {
  // workerd holds the process open; close() before the exit code is reported.
  await server.close();
}

process.exit(code);
