// layout-shift-lab.ts: does anything on a page MOVE after the page painted?
//
//   bun run cls                               # every registered page, against wrangler dev on :8799
//   bun run cls --url http://localhost:8821
//   bun run cls --paths /,/garage/horizon --runs 20
//   bun run cls --hold none                   # natural load, nothing held back
//   bun run cls --json out.json
//
// WHY THIS EXISTS
// This site collects no browser RUM on purpose (build tripwire #7b), so no field
// number has ever said whether a page shifts. Anthropic's claude.ai sprint
// (claude.dev/blog/how-we-made-claude-ai-faster, 2026-09-23) found that 31% of
// their web loads moved something after the page was usable, and that CLS could
// not see it: each shift scored about 0.008, well inside the 0.1 "good" line. What
// found it was reading the Layout Instability API directly and naming WHERE each
// shift landed. This is that instrument, in the lab, per page.
//
// THE METHOD IS THEIRS, and it is what makes a shift deterministic. A late
// fragment shifts the page only when it loses the race against first paint, so a
// natural load reads clean on a fast machine and dirty on a slow network. This
// HOLDS every subresource of the kinds named by --hold until first contentful
// paint, then releases them all. A shift that can happen on a slow connection
// therefore happens on every run. Their sidebar test went red 20 of 20 on main
// and green 20 of 20 on the fix; --runs is how you ask the same question here.
//
// THREE THINGS THAT MAKE THE OUTPUT MEAN ANYTHING:
//
//   1. THE CONTROL RUNS FIRST. It loads one page, pushes a block into the first
//      window after paint, and requires a shift entry to come back. If it does
//      not, the run measured the instrument (a page that never painted reports a
//      clean zero that looks exactly like a stable page), and this exits 2.
//
//   2. A PAGE THAT NEVER PAINTED IS UNMEASURED, NOT CLEAN. Layout shift is only
//      scored after first paint, so no FCP means no entries by construction. Such
//      a page is listed as unmeasured and does not count toward a pass.
//
//   3. THE REGION IS THE RESULT. A total CLS says a page moved; it cannot say what.
//      Each source node is named by its nearest id, window-model class or landmark,
//      so a failure points at `.np-list` rather than at the homepage.
//
// WHAT IT CANNOT SEE: the shift claude.ai found only in the field, where Chrome
// prerenders a page from the address bar at the current tab's height and resizes it
// ~100ms after first paint. Headless Chrome has no browser UI to retract, so that
// case needs a real window and a person watching.

import { chromium, type Browser, type BrowserContextOptions } from "playwright-core";
import { writeFileSync, readFileSync } from "node:fs";
import { chromeChannel } from "./lib/browser-channel.ts";

// ── args ──────────────────────────────────────────────────────────────────────
const arg = (flag: string, dflt: string): string => {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const URL_BASE = arg("--url", "http://localhost:8799").replace(/\/$/, "");
const RUNS = Math.max(1, Number(arg("--runs", "1")));
const HEADED = process.argv.includes("--headed");
const JSON_OUT = arg("--json", "");
const CONCURRENCY = Math.max(1, Number(arg("--concurrency", "4")));
const SETTLE_MS = Number(arg("--settle", "1500"));
// Released at first paint, or at this deadline if paint never comes (a held
// parser-blocking script would otherwise deadlock the load against its own hold).
const RELEASE_DEADLINE_MS = Number(arg("--deadline", "4000"));
const HOLD = new Set(
  arg("--hold", "fetch,xhr,script,image").split(",").map((s) => s.trim()).filter((s) => s && s !== "none"),
);

const VIEWPORTS: Array<{ name: string; opts: BrowserContextOptions }> = [
  { name: "desktop", opts: { viewport: { width: 1280, height: 900 } } },
  { name: "phone", opts: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } },
].filter((v) => arg("--viewports", "desktop,phone").split(",").includes(v.name));

// Every registered surface, because the registry is the one list of what this site
// serves (site-manifest.json). Non-HTML answers (the /rn redirect to Spotify) are
// skipped at load time rather than hard-coded here.
function registeredPaths(): string[] {
  const manifest = JSON.parse(readFileSync(new URL("../config/site-manifest.json", import.meta.url), "utf8"));
  return manifest.surfaces.map((s: { path: string }) => s.path);
}
const PATHS = arg("--paths", "") ? arg("--paths", "").split(",") : registeredPaths();

// ── what the page reports ────────────────────────────────────────────────────
type Shift = { t: number; value: number; phase: "before-paint" | "after-paint"; sources: Array<{ region: string; dx: number; dy: number; dh: number }> };
type PageRead = { fcp: number | null; released: number | null; visible: DocumentVisibilityState; shifts: Shift[] };
type Result = { path: string; viewport: string; run: number; status: "clean" | "shifted" | "unmeasured" | "skipped"; why?: string; cls: number; shifts: Shift[]; perturbedAt?: number };

// Runs INSIDE the page before any of its own script. It must be self-contained:
// Playwright serialises the function source, so nothing from this module's scope
// reaches it.
function collector() {
  const w = window as unknown as { __ls: { fcp: number | null; released: number | null; shifts: unknown[] } };
  w.__ls = { fcp: null, released: null, shifts: [] };
  // The window model's own names first, so a shift reads as the thing a person
  // would point at. Then any id, then a landmark, then the node itself.
  const REGION_CLASSES = ["np-list", "photos", "title-bar", "np-titlebar", "np-status", "axp-tasks", "axp-address", "content", "window", "np-window", "wrap"];
  const describe = (node: Node | null): string => {
    let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null;
    const self = el;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.id) return `#${el.id}`;
      const cls = REGION_CLASSES.find((c) => el!.classList.contains(c));
      if (cls) return `.${cls}`;
      if (/^(HEADER|NAV|MAIN|SECTION|FOOTER|ASIDE)$/.test(el.tagName)) return el.tagName.toLowerCase();
      el = el.parentElement;
    }
    if (!self) return "(removed node)";
    return self.tagName.toLowerCase() + (self.classList[0] ? `.${self.classList[0]}` : "");
  };
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.name === "first-contentful-paint" && w.__ls.fcp === null) {
        w.__ls.fcp = e.startTime;
        (window as unknown as { __lsPainted?: () => void }).__lsPainted?.();
      }
    }
  }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as unknown as Array<PerformanceEntry & { value: number; hadRecentInput: boolean; sources: Array<{ node: Node | null; previousRect: DOMRectReadOnly; currentRect: DOMRectReadOnly }> }>) {
      if (e.hadRecentInput) continue;
      w.__ls.shifts.push({
        t: Math.round(e.startTime),
        value: e.value,
        phase: w.__ls.fcp !== null && e.startTime >= w.__ls.fcp ? "after-paint" : "before-paint",
        sources: (e.sources || []).map((s) => ({
          region: describe(s.node),
          dx: Math.round(s.currentRect.x - s.previousRect.x),
          dy: Math.round(s.currentRect.y - s.previousRect.y),
          dh: Math.round(s.currentRect.height - s.previousRect.height),
        })),
      });
    }
  }).observe({ type: "layout-shift", buffered: true });
}

async function measure(browser: Browser, path: string, vp: (typeof VIEWPORTS)[number], run: number, perturb?: boolean): Promise<Result> {
  // A fresh context per load, so the held resources are really fetched: a warm
  // memory cache answers without ever reaching the route, and the hold would
  // silently hold nothing.
  const ctx = await browser.newContext(vp.opts);
  const page = await ctx.newPage();
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let releasedAt: number | null = null;
  const start = Date.now();
  const doRelease = () => { if (releasedAt === null) { releasedAt = Date.now() - start; release(); } };
  const deadline = setTimeout(doRelease, RELEASE_DEADLINE_MS);
  await page.exposeFunction("__lsPainted", doRelease);
  await page.addInitScript(collector);
  if (HOLD.size) {
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (HOLD.has(req.resourceType()) && req.url().startsWith(URL_BASE)) await released;
      await route.continue().catch(() => {});
    });
  }
  const base: Omit<Result, "status" | "cls"> = { path, viewport: vp.name, run, shifts: [] };
  try {
    const res = await page.goto(`${URL_BASE}${path}`, { waitUntil: "load", timeout: 30000 });
    const type = res?.headers()["content-type"] || "";
    if (!res || res.status() !== 200 || !type.includes("text/html") || !page.url().startsWith(URL_BASE)) {
      return { ...base, status: "skipped", why: `${res?.status()} ${type.split(";")[0]} ${page.url().startsWith(URL_BASE) ? "" : "(left origin)"}`.trim(), cls: 0 };
    }
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    // The selectors are tried IN ORDER. One comma-joined querySelector answers
    // with the first match in DOCUMENT order, which on this site is the fixed
    // #axp-desktop wallpaper, so the control's block moved nothing in the flow and
    // the control "passed" on an unrelated natural shift. Measured on the first run.
    // ".window > .body > .content" sits ahead of ".window > .body" because on
    // /serendipity .body is a flex ROW (the side pane beside main.content): a
    // 160px-tall block prepended there is a zero-width column that moves nothing,
    // so the control went unseen and the lab refused the page (2026-09-25).
    let perturbedAt: number | undefined;
    if (perturb) {
      perturbedAt = await page.evaluate(() => {
        const host = [".window > .content", ".window > .body > .content", ".window > .body", ".np-window > .np-text", ".window", "main"]
          .map((sel) => document.querySelector(sel)).find(Boolean);
        const block = document.createElement("div");
        block.style.cssText = "height:160px;flex:none";
        const t = performance.now();
        host?.prepend(block);
        return t;
      });
      await page.waitForTimeout(600);
    }
    const read = await page.evaluate(() => {
      const ls = (window as unknown as { __ls: { fcp: number | null; shifts: unknown[] } }).__ls;
      return { fcp: ls.fcp, released: null, visible: document.visibilityState, shifts: ls.shifts } as unknown;
    }) as PageRead;
    read.released = releasedAt;
    if (read.visible !== "visible") return { ...base, status: "unmeasured", why: `tab was ${read.visible}`, cls: 0 };
    if (read.fcp === null) return { ...base, status: "unmeasured", why: "no first contentful paint", cls: 0 };
    const after = read.shifts.filter((s) => s.phase === "after-paint");
    const cls = after.reduce((a, s) => a + s.value, 0);
    return { ...base, status: after.length ? "shifted" : "clean", cls, shifts: read.shifts, perturbedAt };
  } catch (e) {
    return { ...base, status: "unmeasured", why: String(e).split("\n")[0].slice(0, 120), cls: 0 };
  } finally {
    clearTimeout(deadline);
    doRelease();
    await ctx.close();
  }
}

function describeShifts(r: Result): string[] {
  return r.shifts
    .filter((s) => s.phase === "after-paint")
    .map((s) => {
      const where = s.sources.map((x) => `${x.region}${x.dy ? ` dy${x.dy > 0 ? "+" : ""}${x.dy}` : ""}${x.dx ? ` dx${x.dx > 0 ? "+" : ""}${x.dx}` : ""}${x.dh ? ` dh${x.dh > 0 ? "+" : ""}${x.dh}` : ""}`);
      return `      @${s.t}ms ${s.value.toFixed(4)}  ${where.join(", ") || "(no sources)"}`;
    });
}

// ── run ───────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ channel: chromeChannel(), headless: !HEADED });
console.log(`layout-shift lab: ${URL_BASE}, hold=[${[...HOLD].join(",") || "none"}], ${PATHS.length} paths x ${VIEWPORTS.length} viewports x ${RUNS} run(s)\n`);

// 1. CONTROL. A forced shift after paint must come back as an entry.
const controlPath = PATHS.find((p) => p !== "/rn") || "/";
const control = await measure(browser, controlPath, VIEWPORTS[0], 0, true);
// Only a shift that STARTED after the block went in counts, so a page that shifts
// on its own cannot pass the control on the instrument's behalf.
const forced = control.shifts.filter((s) => control.perturbedAt !== undefined && s.t >= Math.floor(control.perturbedAt));
const controlSeen = forced.length > 0;
console.log(`CONTROL ${controlPath}: forced a 160px block after paint -> ${controlSeen ? `seen (${forced.reduce((a, s) => a + s.value, 0).toFixed(4)}, ${forced[0].sources.map((x) => x.region).join(", ")})` : `NOT SEEN (${control.status}${control.why ? `: ${control.why}` : ""})`}`);
if (!controlSeen) {
  console.log("\nthe instrument cannot see a shift it caused itself, so a clean sweep would mean nothing. stopping.");
  await browser.close();
  process.exit(2);
}

// 2. SWEEP.
const jobs: Array<() => Promise<Result>> = [];
for (const path of PATHS) for (const vp of VIEWPORTS) for (let run = 1; run <= RUNS; run++) jobs.push(() => measure(browser, path, vp, run));
const results: Result[] = [];
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) results.push(await jobs[next++]());
}));
await browser.close();

// 3. REPORT, grouped by page so a flaky shift reads as "3 of 20" rather than as 20 lines.
const key = (r: Result) => `${r.path} [${r.viewport}]`;
const groups = new Map<string, Result[]>();
for (const r of results.sort((a, b) => key(a).localeCompare(key(b)) || a.run - b.run)) {
  groups.set(key(r), [...(groups.get(key(r)) || []), r]);
}
let shifted = 0, unmeasured = 0, clean = 0, skipped = 0;
for (const [k, rs] of groups) {
  const bad = rs.filter((r) => r.status === "shifted");
  const blind = rs.filter((r) => r.status === "unmeasured");
  if (rs.every((r) => r.status === "skipped")) { skipped++; continue; }
  if (bad.length) {
    shifted++;
    const worst = bad.reduce((a, b) => (b.cls > a.cls ? b : a));
    console.log(`SHIFT ${k}  ${bad.length}/${rs.length} runs, worst after-paint CLS ${worst.cls.toFixed(4)}`);
    for (const line of describeShifts(worst)) console.log(line);
  } else if (blind.length) {
    unmeasured++;
    console.log(`UNMEASURED ${k}  ${blind[0].why}`);
  } else clean++;
}
console.log(`\n${clean} clean, ${shifted} shifted after paint, ${unmeasured} unmeasured, ${skipped} skipped (not HTML on this origin)`);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ url: URL_BASE, hold: [...HOLD], runs: RUNS, control: { path: controlPath, cls: control.cls }, results }, null, 2) + "\n");
process.exit(shifted ? 1 : 0);
