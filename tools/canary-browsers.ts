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
// the bundled build, anything else is a `channel`. The default is what Linux
// CI can INSTALL, which is narrower than what Playwright can launch, and it
// moved under this leg once already: the first draft paired chromium with
// `chromium-tip-of-tree` and firefox with `firefox-beta`, both of which
// playwright-core 1.63's installer refuses ("Invalid installation targets"),
// so the leg's first scheduled run on 2026-09-15 died at the install step
// and every "first-run finding" before that came from a Mac. The installable
// prerelease channels are Google's and Microsoft's: `chrome-beta` (one major
// ahead of stable) and `msedge-dev` (Chromium's tip, roughly weekly), each
// paired with its own stable. Playwright's bundled firefox and webkit are
// themselves built from near-trunk, so they stand alone as snapshots. On a
// Mac with Canary, `--pairs chrome:chrome-canary` is the one-minute version
// and needs nothing downloaded. A contract test asks the pinned installer
// about every default name, so the next rename fails there by name.
//
//   node node_modules/playwright-core/cli.js install --with-deps chromium chrome-beta msedge msedge-dev firefox webkit
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
// TWO LIVE PROBES ride beside the page's own, since 2026-09-15, for the two
// site features parked on a browser rather than on a card: a JXL `/i/` tier
// (a 2x2 JPEG XL decoded from a data URI, with a PNG decoded the same way as
// the control), and dictionary transport (a real visit to production, then a
// second navigation, read for the `Available-Dictionary` the engine sends and
// the `dcz` it gets back). Horizon marks jpeg-xl honest-false because no
// synchronous probe exists, and nothing on the page can see a request header,
// so neither could ever flip there. They are diffed exactly like the page's
// probes: a prerelease answering true where stable answers false is the
// feature arriving. `--offline` skips the production visit. The dictionary
// probe's control is stable chromium, which has sent the header since 130: a
// run where it reads false is the network, and exits 2.
//
// Exit codes: 0 green, 1 changed, 2 the instrument could not run.

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

import { type Browser, type Page, chromium, firefox, webkit } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

export const DEFAULT_PAIRS = "chromium:chrome-beta,msedge:msedge-dev,firefox,webkit";
const pairs = (flag("--pairs") ?? DEFAULT_PAIRS).split(",").map((p) => p.trim()).filter(Boolean).map((p) => p.split(":"));
const pagePath = realpathSync(flag("--page") ?? join(ROOT, "src", "pages", "garage", "horizon.html"));
const jsonPath = flag("--json");
const offline = argv.includes("--offline");
const LIVE_ORIGIN = "https://aadhar.sh";
const started = Date.now();

type Probe = { value: boolean; honest: boolean };
type Snapshot = { name: string; family: "chromium" | "firefox" | "webkit"; version: string; probes: Record<string, Probe> };
type Flip = { cap: string; stable: boolean; prerelease: boolean; pair: string };
type Report = {
  leg: "browsers";
  verdict: "green" | "changed" | "instrument";
  subject: { page: string };
  signature: string;
  flips: Flip[];
  belowBar: { cap: string; trueIn: string[] }[];
  /** the findings as timbrado's reporter renders them: engines, flips, the two-engine bar */
  tables: { caption?: string; columns: string[]; rows: string[][] }[];
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

/** A 2x2 JPEG XL, 190 bytes: `cjxl -d 0 -e 1` (libjxl 0.11) on a 2x2 RGB PNG, decoded back by djxl to the same pixels. Starts with the ff0a codestream signature. */
export const JXL_2X2 = "/woIEBAJCAIBAMgCSxibnHGEAziAAzggSsA5BQEAIESACBABIkDk+Zd7+h5aZ+9TVXVvkiQJAXV3d3d39////1v1ZmZmZuD//Xv+e2jMOeda+9ybJElCQFVVVVVV9f///9z7uru7u+H//Xv+e2jMOeda+9ybJElCQFVVVVVV9f///9z7uru7u+H//Xv+e2jMOeda+9ybJElCQFVVVVVV9f///9z7uru7uy8QBQCH/9F/+HP0H/4c/kf/0S+YAg==";
/** The control: a 2x1 PNG every engine decodes. */
export const PNG_2X1 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNgYGD4//8/AAYBAv4CsjmuAAAAAElFTkSuQmCC";
/** The live probes' names in the probe set, so a test and the reporter can find them. */
export const LIVE_PROBES = ["live:jxl-decode", "live:dictionary-transport"] as const;

/** Does this engine decode `data:<mime>;base64,...` into a real image? Answered by the image element, which is what a `<picture>` source would ask. */
async function decodes(page: Page, mime: string, b64: string): Promise<boolean> {
  return page.evaluate(([m, b]) => new Promise<boolean>((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve(false), 5000);
    img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 0); };
    img.onerror = () => { clearTimeout(timer); resolve(false); };
    img.src = `data:${m};base64,${b}`;
  }), [mime, b64]);
}

/**
 * Does this engine fetch the dictionary production offers and send it back on
 * the next navigation? Two page loads against the live site: the first is
 * where the `Link: rel="compression-dictionary"` arrives, the second is where
 * `Available-Dictionary` would go out. An engine that never fetches the
 * dictionary answers false after a bounded wait, which is the honest reading
 * for firefox and webkit today. A network failure throws, and the caller
 * treats that as the instrument.
 */
async function dictionaryTransport(browser: Browser): Promise<{ value: boolean; note: string }> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    // Listen BEFORE navigating: the dictionary fetch lands around 450ms into
    // the load, often before `goto` resolves, and a listener attached after
    // that only ever sees the trials where it came late (measured 2026-09-15:
    // 3 of 6 trials read "never fetched" with the response visibly at 450ms).
    const dictSeen = page.waitForResponse((r) => /\/a\/page-family\.[0-9a-f]+\.dict$/.test(r.url()), { timeout: 20_000 }).then(() => true, () => false);
    await page.goto(`${LIVE_ORIGIN}/`, { waitUntil: "load", timeout: 30_000 });
    if (!(await dictSeen)) return { value: false, note: "never fetched the offered dictionary" };
    // The registration lands after the response body; a beat before the
    // second navigation keeps a fast engine from racing its own store.
    await page.waitForTimeout(1000);
    const nav = page.waitForRequest((r) => r.isNavigationRequest() && r.url().startsWith(`${LIVE_ORIGIN}/garage`), { timeout: 15_000 });
    await page.goto(`${LIVE_ORIGIN}/garage`, { waitUntil: "commit", timeout: 30_000 });
    const req = await nav;
    const headers = await req.allHeaders();
    const offered = "available-dictionary" in headers;
    const encoding = (await (await req.response())?.headerValue("content-encoding")) ?? "?";
    return { value: offered, note: offered ? `sent Available-Dictionary, got ${encoding}` : `fetched the dictionary and sent no Available-Dictionary (got ${encoding})` };
  } finally {
    await context.close();
  }
}

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

    // The live probes. The PNG control is what separates "this engine does
    // not decode JXL" from "this engine decoded nothing".
    if (!(await decodes(page, "image/png", PNG_2X1))) throw new Error(`${name}: the PNG control did not decode, so the JXL reading would be about the instrument`);
    probes["live:jxl-decode"] = { value: await decodes(page, "image/jxl", JXL_2X2), honest: true };
    if (!offline) {
      const dict = await dictionaryTransport(browser);
      probes["live:dictionary-transport"] = { value: dict.value, honest: true };
      console.log(`${" ".repeat(26)} ${name}: ${dict.note}`);
    }
    return { name, family: familyOf(name), version: browser.version(), probes };
  } finally {
    await browser.close();
  }
}

/** The issue-body tables, pure so a test can render them through the reporter. */
export function tablesFor(engines: { name: string; version: string; probes: number; true: number }[], flips: Flip[], belowBar: Report["belowBar"]): Report["tables"] {
  return [
    { columns: ["engine", "version", "probes true"], rows: engines.map((e) => [e.name, e.version, `${e.true} / ${e.probes}`]) },
    { caption: "Probes that answer differently in the prerelease (a `gone` is a browser bug to file):", columns: ["probe", "pair", "stable", "prerelease"], rows: flips.map((f) => [`\`${f.cap}\``, f.pair, String(f.stable), `${f.prerelease}${f.prerelease ? "" : " (gone)"}`]) },
    { caption: "Cards marked shipped that no longer clear the two-engine bar in stable engines:", columns: ["card", "true in"], rows: belowBar.map((b) => [`\`${b.cap}\``, b.trueIn.length ? b.trueIn.join(", ") : "no stable engine"]) },
  ];
}

const emit = (verdict: Report["verdict"], snaps: Snapshot[], flips: Flip[], belowBar: Report["belowBar"], reason?: string) => {
  const sig = [
    ...flips.map((f) => `${f.cap}@${f.pair}:${f.stable ? "t" : "f"}>${f.prerelease ? "t" : "f"}`),
    ...belowBar.map((b) => `bar:${b.cap}`),
  ].sort();
  const engines = snaps.map((s) => ({
    name: s.name,
    version: s.version,
    probes: Object.keys(s.probes).length,
    true: Object.values(s.probes).filter((p) => p.value).length,
  }));
  const report: Report = {
    leg: "browsers",
    verdict,
    subject: { page: pagePath.replace(ROOT, "") },
    signature: verdict === "green" ? "green" : verdict === "instrument" ? `instrument:${reason}` : `changed:${sig.join("|")}`,
    flips,
    belowBar,
    tables: tablesFor(engines, flips, belowBar),
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
  // THE CONTROL for the dictionary probe: stable chromium has sent
  // Available-Dictionary since 130, so a false here is production or the
  // network, and every other engine's reading would be about the same thing.
  if (!offline && stable.family === "chromium" && stable.probes["live:dictionary-transport"]?.value === false) {
    console.error(`${stable.name}: stable chromium did not complete the dictionary exchange with ${LIVE_ORIGIN}; the instrument is the network or production, so nothing here is a reading`);
    emit("instrument", snaps, flips, [], "the dictionary control failed in stable chromium");
    process.exit(2);
  }
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
