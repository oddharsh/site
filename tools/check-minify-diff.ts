#!/usr/bin/env node
// check-minify-diff.ts: does a different JS minifier change what a visitor sees?
//
//   node tools/check-minify-diff.ts record <dir>      # sweep the current .build into <dir>
//   node tools/check-minify-diff.ts record <dir> --mutate nav:3   # same, with planted bug 3 in /a/nav.*.js
//   node tools/check-minify-diff.ts diff <dirA> <dirB> [<dirA2> ...]   # each dirA2: another record of A, a noise control
//
// `record` boots the Worker on whatever .build holds, opens every manifest page
// in Chrome with the clock and Math.random fixed, and walks each one through
// the same script: load, Ctrl-K, type, Escape, then a click on each of the
// first CLICKS visible controls, with navigations blocked so the walk stays on
// the page. After every step it saves the page's DOM, and over the whole walk
// the console lines, uncaught errors and request URLs. Content-hashed /a/ names
// are written without their hash, since two minifiers mint different ones.
//
// `diff` names, per page, the first step whose snapshot differs. Each extra
// record of A is a noise control: a reading on which A's records disagree (a
// measured timing, a server timestamp, fresh crypto keys, an animation frame)
// is left out. One control is not enough: on 2026-11-21 a third oxc record
// still differed from the first on 2 of 77 pages (an rAF dot, a "rested 1 ms"
// readout) with one control, and on 0 with two.
//
// It is how a minifier pick (config/minify-picks.json) gets checked before it
// ships; tools/minify-pick.ts prints the sequence, with the baseline built by
// `MINIFY_PICKS=off bun run build`. Measured 2026-11-21: spokeshave's picks
// differed from oxc on 0 of 77 pages (936 readings, 43 left out as noise), and
// the walk caught 32 of 55 seeded bugs in the oxc build (58%). Every miss was
// on a page that renders from data the local harness lacks (lens,
// photos-view, md-to-html, serendipity) or needs input the walk doesn't type.
// About 5 minutes a record, so it runs by hand, not in validate.
//
//   node tools/check-minify-diff.ts record <dir> --classes   # for a class rename (build step 5e)
//
// --classes is the record for a class rename. A renamed class shows up in
// styling, not in the DOM, so each snapshot drops script and style bodies
// (their text is renamed on purpose), reads every class token back through the
// inverse of .build/class-names.json, and appends each element's box and a set
// of computed styles, ::before and ::after content included. Record both
// builds with it.
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createTestHarness } from "wrangler";
import { chromeChannel } from "./lib/browser-channel.ts";
import { siteConfig, withoutRemoteOnly } from "./lib/site-config.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { only: { type: "string" }, mutate: { type: "string" }, classes: { type: "boolean" } },
});
const [verb, dirA, dirB] = positionals;

const CLICKS = 15;
const STEP_MS = 250;
const PARALLEL = 4;
const FIXED_TIME = new Date("2026-06-01T12:00:00Z");
const OFFSITE = new Set(["/rn"]);

// Short name -> authored name, from the map build step 5e wrote, for --classes.
const AUTHORED: Map<string, string> = (() => {
  if (!values.classes) return new Map();
  try {
    const map: { [name: string]: string } = JSON.parse(readFileSync(".build/class-names.json", "utf8"));
    return new Map(Object.entries(map).map(([from, to]) => [to, from]));
  } catch {
    return new Map();
  }
})();
const authored = (classes: string) => classes.replace(/\S+/g, (t) => AUTHORED.get(t) ?? t);
// The walk's own selectors name authored classes; this is the name a renamed build serves.
const served = (name: string) => [...AUTHORED].find(([, from]) => from === name)?.[0] ?? name;
const forClasses = (dom: string) =>
  dom
    .replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/g, "$1$3")
    .replace(/ class="([^"]*)"/g, (_m, v: string) => ` class="${authored(v)}"`)
    // <noscript> content is text while scripts run, so its minified, unquoted attributes survive as written.
    .replace(/ class=([^\s"'=<>`]+)/g, (_m, v: string) => ` class=${authored(v)}`);
const STYLES = [
  "display",
  "position",
  "visibility",
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "margin-top",
  "margin-left",
  "padding-top",
  "padding-left",
  "border-top-width",
  "border-top-color",
  "border-top-style",
  "opacity",
  "transform",
  "flex-direction",
  "grid-template-columns",
  "z-index",
  "cursor",
  "text-decoration-line",
  "box-shadow",
  "white-space",
  "overflow-x",
];

type Record = { path: string; steps: Array<{ step: string; dom: string }>; console: string[]; errors: string[]; requests: string[] };

const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

const unhash = (text: string) => text.replace(/\/a\/([\w./-]+?)\.[0-9a-f]{8}\.(\w+)/g, "/a/$1.$2");

// The same seeded mutations spokeshave's vm oracle measures, applied to the
// served bytes of one asset, so the two oracles' sensitivity can be compared.
const MUTATIONS: Array<[RegExp, (m: string) => string]> = [
  [/===/g, () => "!=="],
  [/&&/g, () => "||"],
  [/"([a-z])/g, (m) => `"Z${m.slice(2)}`],
];
const mutate = (body: string, k: number): string => {
  const [re, fn] = MUTATIONS[k % MUTATIONS.length];
  const hits = [...body.matchAll(re)];
  if (hits.length === 0) throw new Error(`--mutate: no site for mutation ${k}`);
  const h = hits[(Math.floor(k / MUTATIONS.length) * 7919) % hits.length];
  return body.slice(0, h.index) + fn(h[0]) + body.slice(h.index + h[0].length);
};

async function walk(ctx: BrowserContext, base: string, path: string): Promise<Record> {
  const page: Page = await ctx.newPage();
  const rec: Record = { path, steps: [], console: [], errors: [], requests: [] };
  page.on("console", (m) => rec.console.push(`${m.type()} ${unhash(m.text())}`));
  page.on("pageerror", (e) => rec.errors.push(e.message));
  page.on("request", (r) => rec.requests.push(`${r.method()} ${unhash(r.url().replace(base, ""))}`));
  let loaded = false;
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (loaded && req.isNavigationRequest() && req.frame() === page.mainFrame()) return route.abort();
    if (values.mutate) {
      const [stem, k] = values.mutate.split(":");
      if (new RegExp(`/a/${stem}\\.[0-9a-f]{8}\\.js$`).test(req.url())) {
        const res = await route.fetch();
        return route.fulfill({ response: res, body: mutate(await res.text(), Number(k)) });
      }
    }
    return route.continue();
  });
  page.setDefaultTimeout(2_000);
  await page.clock.setFixedTime(FIXED_TIME);
  const snap = async (step: string) => {
    await page.waitForTimeout(STEP_MS);
    const dom = await page.evaluate(() => document.documentElement.outerHTML).catch((e: unknown) => `unreadable: ${firstLine(e)}`);
    if (!values.classes) {
      rec.steps.push({ step, dom: unhash(dom) });
      return;
    }
    const boxes = await page
      .evaluate((props) => {
        const out: string[] = [];
        for (const el of document.querySelectorAll("*")) {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const box = [r.x, r.y, r.width, r.height].map(Math.round).join(",");
          const pseudo = `${getComputedStyle(el, "::before").content} ${getComputedStyle(el, "::after").content}`;
          out.push(`${el.tagName} ${box} ${props.map((p) => cs.getPropertyValue(p)).join("|")} ${pseudo}`);
        }
        return out.join("\n");
      }, STYLES)
      .catch((e: unknown) => `unreadable: ${firstLine(e)}`);
    rec.steps.push({ step, dom: unhash(`${forClasses(dom)}\n${boxes}`) });
  };
  try {
    await page.goto(base + path, { waitUntil: "load", timeout: 20_000 });
    const url = page.url();
    loaded = true;
    await snap("load");
    await page.keyboard.press("Control+k");
    await snap("ctrl-k");
    await page.keyboard.type("lens");
    await snap("type");
    await page.keyboard.press("Escape");
    await snap("escape");
    // History buttons leave the page, which the route block cannot stop.
    const controls = page.locator(
      `button:not(.${served("axp-back")}):not(.${served("axp-fwd")}):visible, summary:visible, [role="button"]:visible, [role="tab"]:visible, [role="menuitem"]:visible`,
    );
    const n = Math.min(await controls.count(), CLICKS);
    for (let i = 0; i < n; i++) {
      const target = controls.nth(i);
      const label = await target
        .evaluate((el) => [el.tagName.toLowerCase(), el.id, el.className])
        .then(([tag, id, cls]) => `${tag}#${id}.${authored(cls)}`)
        .catch(() => "gone");
      await target.click({ timeout: 1_000, noWaitAfter: true }).catch((e: unknown) => rec.steps.push({ step: `click ${i} failed`, dom: firstLine(e) }));
      await snap(`click ${i} ${label}`);
      if (page.url() !== url) {
        rec.steps.push({ step: "left the page", dom: unhash(page.url().replace(base, "")) });
        break;
      }
    }
  } catch (e) {
    rec.errors.push(`walk: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
  }
  await page.close();
  return rec;
}

async function record(out: string) {
  const manifest: { surfaces: { path: string }[] } = JSON.parse(readFileSync(`${root}config/site-manifest.json`, "utf8"));
  const only = values.only?.split(",");
  const paths = manifest.surfaces.map((s) => s.path).filter((p) => !OFFSITE.has(p) && (!only || only.includes(p)));
  mkdirSync(out, { recursive: true });
  // No build command: the record reads the .build already staged, which is the
  // point (the A and B builds differ only in their minifier).
  // The homepage grid shuffles with Math.random in the Worker, so the harness
  // boots the Worker through an entry that reseeds it on every request.
  const config = withoutRemoteOnly(await siteConfig());
  writeFileSync(
    ".build/src/worker/minify-diff-entry.ts",
    `import worker from "./index.ts";
export * from "./index.ts";
let seed = 1;
Math.random = () => ((seed = (seed * 16807) % 2147483647), (seed - 1) / 2147483646);
export default { ...worker, fetch: (request, env, ctx) => ((seed = 1), worker.fetch(request, env, ctx)) };
`,
  );
  writeFileSync(".wrangler.minify-diff.json", JSON.stringify({ ...config, build: undefined, main: ".build/src/worker/minify-diff-entry.ts" }));
  const server = createTestHarness({
    workers: [{ configPath: "./.wrangler.minify-diff.json" }, { configPath: `${root}counter/wrangler.jsonc` }],
  });
  try {
    const base = String((await server.listen()).url).replace(/\/$/, "");
    const browser = await chromium.launch({ channel: chromeChannel(), headless: true });
    try {
      const queue = [...paths];
      await Promise.all(
        Array.from({ length: PARALLEL }, async () => {
          for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
            const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", reducedMotion: "reduce" });
            await ctx.addInitScript(() => {
              let seed = 1;
              Math.random = () => {
                seed = (seed * 16807) % 2147483647;
                return (seed - 1) / 2147483646;
              };
            });
            const rec = await walk(ctx, base, path);
            await ctx.close();
            writeFileSync(`${out}/${encodeURIComponent(path)}.json`, JSON.stringify(rec));
          }
        }),
      );
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
  console.log(`recorded ${paths.length} pages into ${out}`);
}

// The harness picks a new port each boot, and pages print their own origin.
const unport = (text: string) => text.replace(/(https?:\/\/)?127\.0\.0\.1:\d+/g, "ORIGIN");

const read = (dir: string, f: string): Record | null => {
  try {
    return JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  } catch {
    return null;
  }
};

// Compare record b against record a. With a control (a second record of a's
// build), a step or field where a and the control already disagree is noise
// (a measured timing, a server timestamp, fresh crypto keys, an animation
// frame) and is left out; everything the control reproduced has to match.
function diff(a: string, b: string, controls: string[]): number {
  let dirty = 0;
  let compared = 0;
  let skipped = 0;
  // The second record decides the pages, so a mutant recorded on a few pages
  // diffs against those pages of a full record.
  const files = readdirSync(b).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    const rb = read(b, f)!;
    const ra = read(a, f);
    const rcs = controls.map((c) => read(c, f));
    if (ra === null || rcs.includes(null)) {
      console.log(`${rb.path}: missing from ${ra === null ? a : controls[rcs.indexOf(null)]}`);
      dirty++;
      continue;
    }
    const others = rcs as Record[];
    const problems: string[] = [];
    const steps = Math.max(ra.steps.length, rb.steps.length);
    for (let i = 0; i < steps; i++) {
      const sa = ra.steps[i],
        sb = rb.steps[i];
      const da = unport(sa?.dom ?? ""),
        db = unport(sb?.dom ?? "");
      if (others.some((rc) => rc.steps[i]?.step !== sa?.step || unport(rc.steps[i]?.dom ?? "") !== da)) {
        skipped++;
        continue;
      }
      compared++;
      if (sa?.step !== sb?.step || da !== db) {
        let at = 0;
        while (at < da.length && da[at] === db[at]) at++;
        problems.push(
          `step ${i} (${sa?.step ?? "none"} / ${sb?.step ?? "none"}): DOM differs at char ${at}: ${JSON.stringify(da.slice(Math.max(0, at - 60), at + 60))} vs ${JSON.stringify(db.slice(Math.max(0, at - 60), at + 60))}`,
        );
        break;
      }
    }
    for (const key of ["console", "errors", "requests"] as const) {
      // Parallel fetches finish in any order, so requests compare as a sorted list.
      const norm = (r: Record) => JSON.stringify((key === "requests" ? [...r[key]].sort() : r[key]).map(unport));
      if (others.some((rc) => norm(rc) !== norm(ra))) {
        skipped++;
        continue;
      }
      compared++;
      if (norm(ra) !== norm(rb))
        problems.push(
          `${key}: ${JSON.stringify(ra[key].filter((x) => !rb[key].includes(x)).slice(0, 3))} vs ${JSON.stringify(rb[key].filter((x) => !ra[key].includes(x)).slice(0, 3))}`,
        );
    }
    if (problems.length) {
      dirty++;
      console.log(`${ra.path}:\n  ${problems.join("\n  ")}`);
    }
  }
  console.log(`diff: ${dirty} of ${files.length} pages differ; ${compared} readings compared, ${skipped} left out as noise the control reproduced`);
  return dirty;
}

if (verb === "record" && dirA) await record(dirA);
else if (verb === "diff" && dirA && dirB) process.exit(diff(dirA, dirB, positionals.slice(3)) ? 1 : 0);
else throw new Error("usage: record <dir> [--only a,b] [--mutate stem:k] | diff <dirA> <dirB> [<dirA2> ...]");
process.exit(0);
