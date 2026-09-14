#!/usr/bin/env bun
// bun run canary:browsers [--pairs a:b,c:d,e] [--json <path>] [--page <html>]
//
// /garage/horizon's own feature probes, run in a STABLE engine and in that
// engine's prerelease, and diffed. A probe that answers differently in the
// two is a card that changed underneath the page, which is the half of a
// horizon sweep no release note can produce (the "features that finish
// without being news" and "cards that moved" directions in the page's own
// lede). And a probe that flips FALSE in a prerelease is a regression in the
// browser, which is the bug report this site is unusually well placed to
// file: 90-odd one-line probes, each one already pinned to a card that says
// what the feature is for.
//
// WHAT IS DIFFED. `window.__horizonCaps` is the object the page hoists into
// <head> so its chip strip is correct on first paint: `checks` is the probe
// per capability and `state` is each probe's answer. Two things are read
// beside it. A probe whose whole body is `return (false)` is the page's
// honest-false convention (jpeg-xl, sizes-auto, http-query, ...: no
// synchronous probe exists, so the chip says no rather than pretending), and
// those are EXCLUDED from every comparison, since a constant cannot flip. And
// a `<section class="demo shipped">` is a card that graduated onto the live
// site, which the page's own rule says needs two engines: with stable
// chromium, firefox and webkit all in the run, a shipped card whose honest
// probe is true in fewer than two of them is reported.
//
// PAIRS. `a:b` diffs b against a; a lone name is a snapshot with no control.
// Names are Playwright's: the bare engines (chromium, firefox, webkit) launch
// the bundled build, anything else is a `channel`. The default is the trio
// Linux CI can install; on a Mac with Canary, `--pairs chrome:chrome-canary`
// is the one-minute version and needs nothing downloaded.
//
//   node node_modules/playwright-core/cli.js install chromium chromium-tip-of-tree firefox firefox-beta webkit
//
// THE CONTROL is the stable half of each pair, and it is two assertions: the
// engine returned every probe the page declares, and at least one probe is
// true. A prerelease that reports 0 of 92 is a page that did not load in it,
// which is the instrument, and it exits 2 rather than reporting 92 flips.
//
// The page is loaded from the SOURCE file over file://, so this needs no
// build and no server. The shell assets 404 there and nothing in <head>
// depends on them; the probes run before <body> parses by design.
//
// Exit codes: 0 green, 1 changed, 2 the instrument could not run.

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

import { type Browser, chromium, firefox, webkit } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

export const DEFAULT_PAIRS = "chromium:chromium-tip-of-tree,firefox:firefox-beta,webkit";
const pairs = (flag("--pairs") ?? DEFAULT_PAIRS).split(",").map((p) => p.trim()).filter(Boolean).map((p) => p.split(":"));
const pagePath = realpathSync(flag("--page") ?? join(ROOT, "src", "pages", "garage", "horizon.html"));
const jsonPath = flag("--json");
const started = Date.now();

type Probe = { value: boolean; honest: boolean };
type Snapshot = { name: string; family: "chromium" | "firefox" | "webkit"; version: string; probes: Record<string, Probe> };
type Flip = { cap: string; stable: boolean; prerelease: boolean; pair: string };
type Report = {
  leg: "browsers";
  verdict: "green" | "changed" | "instrument";
  subject: { page: string; engines: { name: string; version: string; probes: number; true: number; honest: number }[] };
  signature: string;
  flips: Flip[];
  belowBar: { cap: string; trueIn: string[] }[];
  reason?: string;
  ms: number;
};

/** Which Playwright engine a channel or bare name launches. */
export function familyOf(name: string): Snapshot["family"] {
  if (name === "webkit") return "webkit";
  if (name.startsWith("firefox")) return "firefox";
  return "chromium";
}

/** The `data-cap` of every card the page marks as shipped on the site. */
export function shippedCaps(html: string): string[] {
  const caps: string[] = [];
  for (const m of html.matchAll(/<section class="([^"]*)" data-cap="([^"]+)"/g)) {
    if (m[1].split(/\s+/).includes("shipped")) caps.push(m[2]);
  }
  return caps;
}

/** The page's honest-false convention: a probe whose whole body returns false. */
export const HONEST_FALSE = /\{\s*return\s*\(?\s*false\s*\)?\s*;?\s*\}\s*$/;

async function launch(name: string): Promise<Browser> {
  const family = familyOf(name);
  const engine = family === "webkit" ? webkit : family === "firefox" ? firefox : chromium;
  const bare = name === "chromium" || name === "firefox" || name === "webkit";
  return engine.launch(bare ? { headless: true } : { headless: true, channel: name });
}

async function snapshot(name: string): Promise<Snapshot> {
  const browser = await launch(name);
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(pagePath).href, { waitUntil: "domcontentloaded" });
    const probes = await page.evaluate((honest: string) => {
      const re = new RegExp(honest);
      const h = (window as unknown as { __horizonCaps?: { checks: Record<string, () => boolean>; state: Record<string, boolean> } }).__horizonCaps;
      if (!h) return null;
      const out: Record<string, { value: boolean; honest: boolean }> = {};
      for (const k of Object.keys(h.checks)) out[k] = { value: h.state[k] === true, honest: !re.test(String(h.checks[k])) };
      return out;
    }, HONEST_FALSE.source);
    if (!probes) throw new Error(`${name}: the page exposed no __horizonCaps`);
    return { name, family: familyOf(name), version: browser.version(), probes };
  } finally {
    await browser.close();
  }
}

const emit = (verdict: Report["verdict"], snaps: Snapshot[], flips: Flip[], belowBar: Report["belowBar"], reason?: string) => {
  const sig = [
    ...flips.map((f) => `${f.cap}@${f.pair}:${f.stable ? "t" : "f"}>${f.prerelease ? "t" : "f"}`),
    ...belowBar.map((b) => `bar:${b.cap}`),
  ].sort();
  const report: Report = {
    leg: "browsers",
    verdict,
    subject: {
      page: pagePath.replace(ROOT, ""),
      engines: snaps.map((s) => ({
        name: s.name,
        version: s.version,
        probes: Object.keys(s.probes).length,
        true: Object.values(s.probes).filter((p) => p.value).length,
        honest: Object.values(s.probes).filter((p) => p.honest).length,
      })),
    },
    signature: verdict === "green" ? "green" : verdict === "instrument" ? `instrument:${reason}` : `changed:${sig.join("|")}`,
    flips,
    belowBar,
    reason,
    ms: Date.now() - started,
  };
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  return report;
};

async function main() {
if (!existsSync(pagePath)) {
  console.error(`no page at ${pagePath}`);
  emit("instrument", [], [], [], "page missing");
  process.exit(2);
}

const html = readFileSync(pagePath, "utf8");
const shipped = shippedCaps(html);
const snaps: Snapshot[] = [];
const flips: Flip[] = [];
const stableByFamily = new Map<Snapshot["family"], Snapshot>();

console.log(`page:      ${pagePath.replace(ROOT, "")}  (${shipped.length} cards shipped on the site)`);

for (const pair of pairs) {
  const taken: Snapshot[] = [];
  for (const name of pair) {
    try {
      const s = await snapshot(name);
      snaps.push(s);
      taken.push(s);
      const total = Object.keys(s.probes).length;
      const truthy = Object.values(s.probes).filter((p) => p.value).length;
      console.log(`${name.padEnd(26)} ${s.version.padEnd(18)} ${truthy}/${total} probes true`);
      // THE CONTROL. A page that did not load answers 0 of 0 or 0 of 92, and
      // either way every later comparison would be about the instrument.
      if (total === 0 || truthy === 0) {
        console.error(`${name}: ${truthy}/${total} true reads as a page that did not load in this engine`);
        emit("instrument", snaps, flips, [], `${name} returned ${truthy}/${total}`);
        process.exit(2);
      }
    } catch (err) {
      console.error(`${name}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      emit("instrument", snaps, flips, [], `${name} could not launch`);
      process.exit(2);
    }
  }

  const [stable, pre] = taken;
  if (!stableByFamily.has(stable.family)) stableByFamily.set(stable.family, stable);
  if (!pre) continue;

  const a = new Set(Object.keys(stable.probes));
  const b = new Set(Object.keys(pre.probes));
  if (a.size !== b.size || [...a].some((k) => !b.has(k))) {
    console.error(`${stable.name} and ${pre.name} disagree on WHICH probes exist, which a page cannot do; the instrument is wrong`);
    emit("instrument", snaps, flips, [], "probe sets differ within a pair");
    process.exit(2);
  }

  for (const cap of [...a].sort()) {
    const p = stable.probes[cap];
    const q = pre.probes[cap];
    if (!p.honest) continue;
    if (p.value !== q.value) flips.push({ cap, stable: p.value, prerelease: q.value, pair: `${stable.name}:${pre.name}` });
  }
}

// The two-engine bar, only when the run holds enough engines to ask it.
const belowBar: Report["belowBar"] = [];
if (stableByFamily.size >= 2) {
  for (const cap of shipped) {
    const trueIn = [...stableByFamily.values()].filter((s) => s.probes[cap]?.honest && s.probes[cap].value).map((s) => s.name);
    const honestAnywhere = [...stableByFamily.values()].some((s) => s.probes[cap]?.honest);
    if (honestAnywhere && trueIn.length < 2) belowBar.push({ cap, trueIn });
  }
}

console.log("");
if (flips.length) {
  console.log(`${flips.length} probe(s) answer differently in the prerelease:`);
  for (const f of flips) console.log(`  ${f.cap.padEnd(28)} ${f.pair.padEnd(36)} ${f.stable ? "true" : "false"} -> ${f.prerelease ? "true" : "false"}${!f.prerelease ? "   <-- gone in the prerelease" : ""}`);
}
if (belowBar.length) {
  console.log(`${belowBar.length} card(s) marked shipped no longer clear the two-engine bar in stable engines:`);
  for (const b of belowBar) console.log(`  ${b.cap.padEnd(28)} true in ${b.trueIn.length ? b.trueIn.join(", ") : "none"}`);
}

if (flips.length || belowBar.length) {
  emit("changed", snaps, flips, belowBar);
  console.log(`\ncanary:browsers: CHANGED. Each line above is a card to re-read; a "gone" line is a browser bug to file.`);
  process.exit(1);
}
emit("green", snaps, flips, belowBar);
console.log(`canary:browsers: every honest probe answers the same in stable and prerelease${stableByFamily.size >= 2 ? `, and all ${shipped.length} shipped cards clear the two-engine bar` : ""}.`);
}

if (import.meta.main) await main();
