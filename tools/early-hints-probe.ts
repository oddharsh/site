#!/usr/bin/env node
// early-hints-probe.ts — is the 103 actually preloading, and does CDP change that?
//
//   bun run early-hints:probe                        # cloudflare.com, a known-good origin
//   bun run early-hints:probe https://aadhar.sh/     # or any target
//
// Committed because CLAUDE.md gotcha 15 spent a month asserting a MECHANISM that
// nobody could re-run. It claimed a CDP session suppressed Chrome's Early-Hints
// preload; measured 2026-08-24 on Chrome 151 it does not, and the harness that
// produced the original claim was ad-hoc and gone. This is the control that would
// have caught it.
//
// TWO signals, and you need both.
//
//   initiatorType === "early-hints"  the feature is active at all
//   duration far below the byte count  the preload finished inside the 103 window
//
// 59,604 bytes in 1.8ms is a preload-cache hit rather than a network fetch. Do NOT
// judge by startTime: it is stamped when the DOCUMENT consumes the resource, so it
// always looks like it lands just after the 200 whether or not the hint worked.
//
// The payoff scales with the 103-to-200 window, which is worker think-time, so a
// warm isolate legitimately shows real fetches. A short window is not a defect.
import { chromium } from "playwright-core";

type Entry = { name: string; initiatorType: string; duration: number; encodedBodySize: number };

const targets = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const urls = targets.length ? targets : ["https://www.cloudflare.com/"];
const headless = !process.argv.includes("--headful");

async function run(url: string, attachCDP: boolean): Promise<{ entries: Entry[]; hints: number }> {
  const browser = await chromium.launch({ channel: "chrome", headless });
  try {
    const ctx = await browser.newContext(); // fresh profile, so a cold cache
    const page = await ctx.newPage();
    let hints = 0;
    if (attachCDP) {
      const cdp = await ctx.newCDPSession(page);
      cdp.on("Network.responseReceivedEarlyHints", () => {
        hints++;
      });
      await cdp.send("Network.enable");
    }
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    const entries = (await page.evaluate(() =>
      performance.getEntriesByType("resource").map((e) => {
        const r = e as PerformanceResourceTiming;
        return {
          name: r.name,
          initiatorType: r.initiatorType,
          duration: Math.round(r.duration * 100) / 100,
          encodedBodySize: r.encodedBodySize,
        };
      }),
    )) as Entry[];
    return { entries, hints };
  } finally {
    await browser.close();
  }
}

let failed = false;
for (const url of urls) {
  console.log(`\n=== ${url} ===`);
  for (const attachCDP of [false, true]) {
    const label = attachCDP ? "WITH Network.enable" : "no CDP session    ";
    try {
      const { entries, hints } = await run(url, attachCDP);
      const eh = entries.filter((e) => e.initiatorType === "early-hints");
      const bytes = eh.reduce((n, e) => n + e.encodedBodySize, 0);
      const slowest = eh.length ? Math.max(...eh.map((e) => e.duration)) : null;
      console.log(
        `${label}  early-hints: ${String(eh.length).padStart(2)}  bytes: ${String(bytes).padStart(6)}` +
          `  slowest: ${slowest === null ? "n/a" : `${slowest}ms`}  resources: ${entries.length}` +
          (attachCDP ? `  103 events: ${hints}` : ""),
      );
      for (const e of eh) console.log(`    ${e.duration}ms  ${e.encodedBodySize}B  ${e.name.slice(0, 74)}`);
      if (!eh.length) console.log("    no early-hints entries: either the origin sends no 103, or the run measured the instrument");
    } catch (err) {
      failed = true;
      console.log(`${label}  ERROR: ${(err as Error).message.split("\n")[0]}`);
    }
  }
}

// Read the two rows against each other. Equal counts and equal byte totals mean
// the CDP session changed nothing, which is the expected result today.
process.exit(failed ? 1 : 0);
