#!/usr/bin/env node
// check-minify-diff.ts: does a different JS minifier change what a visitor sees?
//
//   node tools/check-minify-diff.ts record <dir>      # sweep the current .build into <dir>
//   node tools/check-minify-diff.ts record <dir> --mutate nav:3   # same, with planted bug 3 in /a/nav.*.js
//   node tools/check-minify-diff.ts diff <dirA> <dirB> [<dirA2> ...]   # each dirA2: another record of A, a noise control
//   node tools/check-minify-diff.ts catch serendipity:3 --only /serendipity --build   # must see that planted bug
//   node tools/check-minify-diff.ts outbound           # re-record the Worker fetches the walk replays
//
// `record` boots the Worker on whatever .build holds, opens every manifest page
// (plus VISITS, the deep links that make a page run on data) in Chrome with the
// clock and Math.random fixed, and walks each one through the same script:
// load, Ctrl-K, type, Escape, then a click on each of the first CLICKS visible
// controls, counted again after every click so controls a click reveals get
// their turn, with navigations blocked so the walk stays on the page. After
// every step it saves the page's DOM, and over the whole walk the console
// lines, uncaught errors and request URLs. Content-hashed /a/ names are
// written without their hash, since two minifiers mint different ones.
//
// The world the walk runs in is fixed too, so island code that sits behind
// data actually runs. The Worker boots through a wrapper entry that reseeds
// Math.random per request, stops its clock at FIXED_TIME, lets every Rate
// Limiting binding through, and answers every fetch that leaves the harness
// from tools/fixtures/minify-diff/outbound.json or with a 404 (`outbound`
// re-records it; `/lens?url=https://example.com/` is what reads it). Chrome's
// own requests off the harness are aborted. The local SERENDIPITY_DB gets
// serendipity's migrations and the 4 synthetic events in SERENDIPITY_EVENTS,
// dated around FIXED_TIME so the week and weekend chips each keep a different
// subset. A page with lazy sections is scrolled to the bottom and back before
// its first snapshot, and every snapshot waits for the DOM to go quiet.
//
// `diff` names, per page, the first step whose snapshot differs. Each extra
// record of A is a noise control: a reading on which A's records disagree (a
// measured timing, a server timestamp, fresh crypto keys, an animation frame)
// is left out. The mask is per token (a tag or a run of text), so a timing
// readout hides itself and not the rest of the page; a step falls back to
// being left out whole only when the controls disagree on its token count.
// One control is not enough: on 2026-11-21 a third oxc record still differed
// from the first on 2 of 77 pages (an rAF dot, a "rested 1 ms" readout) with
// one control, and on 0 with two.
//
// It is how a minifier pick (config/minify-picks.json) gets checked before it
// ships; tools/minify-pick.ts prints the sequence, with the baseline built by
// `MINIFY_PICKS=off bun run build`. Measured 2026-11-21: spokeshave's picks
// differed from oxc on 0 of 77 pages, and the walk caught 32 of 55 seeded bugs
// in the oxc build (58%), none on lens, photos-view, md-to-html or
// serendipity. The fixed world, the re-counted controls and the per-token mask
// are what moved that; the PR that added them has the before and after table.
// About 5 minutes a record, so it runs by hand, not in validate; `catch` is
// the one-page self-test tools/lib/controls.ts runs.
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createTestHarness, unstable_splitSqlQuery } from "wrangler";
import { chromeChannel } from "./lib/browser-channel.ts";
import { siteConfig, withoutRemoteOnly } from "./lib/site-config.ts";
import { asList, asRecord, asText } from "../src/worker/lib/parse.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { only: { type: "string" }, mutate: { type: "string" }, build: { type: "boolean" } },
});
const [verb, dirA, dirB] = positionals;

const CLICKS = 15;
const FIELDS = 3;
const FIELD_TEXT = "fixture week";
// Past infotip's 400 ms hover dwell (src/client/infotip.ts openMs): at 250 ms
// plus the settle, a tip showed in some records of /serendipity and not others.
const STEP_MS = 500;
const SETTLE_QUIET_MS = 150;
const SETTLE_CAP_MS = 1_000;
const NET_QUIET_MS = 300;
const NET_CAP_MS = 3_000;
const PARALLEL = 4;
const FIXED_TIME = new Date("2026-06-01T12:00:00Z");
const OFFSITE = new Set(["/rn"]);
// Deep links that make a page render from data a bare visit never asks for.
const VISITS = ["/lens?url=https://example.com/"];
const OUTBOUND = "tools/fixtures/minify-diff/outbound.json";
// A throwaway key, committed on purpose: lens refuses to fetch unsigned, and a
// key minted per boot would change the key id the page prints between records.
// The fixture is keyed by method and URL, so no recorded response depends on it.
const THROWAWAY_SIGNING_KEY = {
  kty: "OKP",
  crv: "Ed25519",
  x: "4UkYhMg3D1L6-MK3Ye2aEaMBr25gKO6oZ5zi2Gd5m4E",
  d: "niL_UFS_Qx4n6h3xk_vEqZ3Lh3ezZsSrzAFJSiUU_qU",
};
// 2026-06-01 is a Monday: the week chip keeps the first 2, the weekend chip
// the second, and the last stays upcoming whatever day the Worker thinks it is.
const SERENDIPITY_EVENTS = [
  ["sd-fixture-1", "Fixture: compiler night", "2026-06-02T22:00:00.000Z", "Brooklyn"],
  ["sd-fixture-2", "Fixture: Saturday hack day", "2026-06-06T15:00:00.000Z", "Manhattan"],
  ["sd-fixture-3", "Fixture: reading group", "2026-06-20T23:00:00.000Z", "Queens"],
  ["sd-fixture-4", "Fixture: far future", "2030-01-15T23:00:00.000Z", "Online"],
] as const;

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

async function walk(ctx: BrowserContext, base: string, path: string, mutant: string | undefined): Promise<Record> {
  const page: Page = await ctx.newPage();
  const rec: Record = { path, steps: [], console: [], errors: [], requests: [] };
  page.on("console", (m) => rec.console.push(`${m.type()} ${unhash(m.text())}`));
  page.on("pageerror", (e) => rec.errors.push(e.message));
  page.on("request", (r) => rec.requests.push(`${r.method()} ${unhash(r.url().replace(base, ""))}`));
  let inflight = 0;
  page.on("request", () => inflight++);
  page.on("requestfinished", () => inflight--);
  page.on("requestfailed", () => inflight--);
  const networkQuiet = async () => {
    let quiet = 0;
    for (let waited = 0; waited < NET_CAP_MS && quiet < NET_QUIET_MS; waited += 50) {
      await page.waitForTimeout(50);
      quiet = inflight === 0 ? quiet + 50 : 0;
    }
  };
  let loaded = false;
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (loaded && req.isNavigationRequest() && req.frame() === page.mainFrame()) return route.abort();
    // Nothing leaves the harness: lens's human pane frames whatever a chip
    // names, and live Wikipedia loaded 4 more requests in 1 of 5 records.
    if (!req.url().startsWith(base)) return route.abort();
    if (mutant) {
      const [stem, k] = mutant.split(":");
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
    // Then until the DOM goes quiet: lens's machine pane read a spinner in 1
    // of 4 records at a fixed 250 ms. Capped, because an rAF dot never rests.
    await page
      .evaluate(
        ([quietMs, capMs]) =>
          new Promise<void>((done) => {
            let timer = setTimeout(finish, quietMs);
            const observer = new MutationObserver(() => {
              clearTimeout(timer);
              timer = setTimeout(finish, quietMs);
            });
            const cap = setTimeout(finish, capMs);
            function finish() {
              observer.disconnect();
              clearTimeout(timer);
              clearTimeout(cap);
              done();
            }
            observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          }),
        [SETTLE_QUIET_MS, SETTLE_CAP_MS],
      )
      .catch(() => {});
    // outerHTML holds attributes, never a control's live value or checked
    // state, and dotfiles writes its whole script into a textarea's value: 14
    // ticked boxes recorded nothing. So each control's state follows the markup.
    const dom = await page
      .evaluate(() => {
        const state = [...document.querySelectorAll("input, textarea, select")].map((el) =>
          el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")
            ? `<!--control ${el.checked}-->`
            : `<!--control ${JSON.stringify((el as HTMLInputElement).value)}-->`,
        );
        return document.documentElement.outerHTML + state.join("");
      })
      .catch((e: unknown) => `unreadable: ${firstLine(e)}`);
    rec.steps.push({ step, dom: unhash(dom) });
  };
  try {
    await page.goto(base + path, { waitUntil: "load", timeout: 20_000 });
    // A filter chip rewrites the query with replaceState; only a new path is leaving.
    const pathname = new URL(page.url()).pathname;
    loaded = true;
    // Down to the bottom of every scroller, held there until no request has
    // been in flight for NET_QUIET_MS, then back, so lazy sections load in
    // every record. Round-trip's quiz loaded in 3 of 4 when its observer's
    // first look raced the Markdown that pushes it down (src/client/quiz.ts),
    // and resample's in 3 of 5 when the walk scrolled back before it fetched.
    const scroll = (to: "bottom" | "top") =>
      page
        .evaluate((end) => {
          for (const el of [document.scrollingElement, ...document.querySelectorAll("*")])
            if (el && el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY))
              el.scrollTop = end === "bottom" ? el.scrollHeight : 0;
        }, to)
        .catch(() => {});
    await scroll("bottom");
    await networkQuiet();
    await scroll("top");
    await snap("load");
    await page.keyboard.press("Control+k");
    await snap("ctrl-k");
    await page.keyboard.type("lens");
    await snap("type");
    await page.keyboard.press("Escape");
    await snap("escape");
    // Each visible text field gets the same words and an Enter, the input a
    // click never gives: the notepad, lwe's ask box, serendipity's search.
    const fields = page.locator(
      'input:is([type="text"], [type="search"], [type="url"], :not([type])):visible, textarea:visible, [contenteditable="true"]:visible',
    );
    for (let i = 0; i < FIELDS && i < (await fields.count()); i++) {
      const field = fields.nth(i);
      const label = await field.evaluate((el) => `${el.tagName.toLowerCase()}#${el.id}.${el.className}`).catch(() => "gone");
      await field.click({ timeout: 1_000 }).catch(() => field.focus().catch(() => {}));
      await page.keyboard.type(FIELD_TEXT);
      await page.keyboard.press("Enter");
      await snap(`field ${i} ${label}`);
    }
    // History buttons leave the page, which the route block cannot stop.
    const controls = page.locator(
      'button:not(.axp-back):not(.axp-fwd):visible, summary:visible, input:is([type="checkbox"], [type="radio"]):visible, [role="button"]:visible, [role="tab"]:visible, [role="menuitem"]:visible',
    );
    // Counted again before every click: photos' view switch reveals the sort
    // headers, which a count taken once at the start never reached.
    for (let i = 0; i < CLICKS && i < (await controls.count()); i++) {
      const target = controls.nth(i);
      const label = await target.evaluate((el) => `${el.tagName.toLowerCase()}#${el.id}.${el.className}`).catch(() => "gone");
      // A control Playwright calls not actionable (lens's tab strip, every one
      // of its chips) still gets its click, sent to the element itself.
      await target.click({ timeout: 1_000, noWaitAfter: true }).catch(async (e: unknown) => {
        rec.steps.push({ step: `click ${i} failed`, dom: firstLine(e) });
        await target.dispatchEvent("click").catch(() => {});
      });
      await snap(`click ${i} ${label}`);
      if (new URL(page.url()).pathname !== pathname) {
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

// The Worker's entry for a record. `replay` answers every fetch that leaves
// the harness from the fixture, and one the fixture lacks with a 404 that
// names this tool, so a record never reaches the network (a lens chip's live
// read of aadhar.sh/llms-full.txt raced the snapshot in 1 of 5 records);
// `capture` passes them through and serves what it saw at /__minify-diff/outbound.
function workerEntry(mode: "replay" | "capture", rateLimits: string[]) {
  return `import worker from "./index.ts";
import outbound from "../../../${OUTBOUND}" with { type: "json" };
export * from "./index.ts";
let seed = 1;
Math.random = () => ((seed = (seed * 16807) % 2147483647), (seed - 1) / 2147483646);
// The page's clock, on the Worker too, and stopped: lens's elapsedMs and
// whoareyou's "Received at" come out the same in every record, and serendipity
// splits upcoming from past on the day the page filters by. Stopped rather
// than stepping per read, because requests from 4 parallel pages share one
// isolate and stepped each other's clock (lens's null record, 2026-11-22).
// No Worker loop waits for the clock to move.
const FIXED = ${FIXED_TIME.getTime()};
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FIXED);
  }
  static now() {
    return FIXED;
  }
};
Object.defineProperty(performance, "now", { value: () => 0, configurable: true });
// Every Rate Limiting binding allows: their windows run on Miniflare's own
// clock, and lens's browserAll budget is global, so which page drew the 429
// depended on run order (LENS_BUDGETS in src/worker/lens-pipeline.ts). The
// names come from the config, because an RPC stub such as ASSETS answers any
// property, limit included, with a callable.
const allow = { limit: async () => ({ success: true }) };
const unlimited = (env) => ({ ...env, ...Object.fromEntries(${JSON.stringify(rateLimits)}.map((name) => [name, allow])) });
// The Cache API always misses: lens's discovery read "cached" or not by which
// of the two lens pages ran first (2026-11-22). The API never promises a hit,
// so this is a state the Worker already has to handle.
const miss = { match: async () => undefined, put: async () => {}, delete: async () => false };
Object.defineProperty(caches, "default", { value: miss, configurable: true });
caches.open = async () => miss;
const MODE = ${JSON.stringify(mode)};
const captured = {};
const network = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const key = request.method + " " + request.url;
  if (MODE === "replay" && !/^(127\\.0\\.0\\.1|localhost)$/.test(new URL(request.url).hostname)) {
    const hit = outbound[key];
    return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : new Response("check-minify-diff: not in ${OUTBOUND}", { status: 404 });
  }
  const response = await network(request);
  if (MODE === "capture" && /^(text\\/|application\\/(json|xml|[\\w.+-]+\\+(json|xml)))/.test(response.headers.get("content-type") ?? "")) {
    const headers = Object.fromEntries([...response.headers].filter(([name]) => name !== "content-encoding" && name !== "content-length"));
    captured[key] = { status: response.status, headers, body: await response.clone().text() };
  }
  return response;
};
export default {
  ...worker,
  fetch: (request, env, ctx) => {
    if (MODE === "capture" && new URL(request.url).pathname === "/__minify-diff/outbound") return Response.json(captured);
    seed = 1;
    return worker.fetch(request, unlimited(env), ctx);
  },
};
`;
}

// Serendipity's island reads SERENDIPITY_DB, which the harness boots empty and
// tableless, so /serendipity/events.html answered 503 and the filter code had
// no cards to filter.
// The slice of D1 the seed calls; the tools program has no Workers types.
type Statement = { run(): Promise<unknown>; bind(...values: unknown[]): Statement };
type SeedEnv = { SERENDIPITY_DB: { prepare(sql: string): Statement } };
async function seedSerendipity(env: SeedEnv) {
  const db = env.SERENDIPITY_DB;
  const dir = `${root}serendipity/migrations`;
  for (const file of readdirSync(dir).sort())
    for (const statement of unstable_splitSqlQuery(readFileSync(join(dir, file), "utf8"))) await db.prepare(statement).run();
  await db.prepare("INSERT INTO user_cookies (user_key, cookies_json, label) VALUES ('fixture-key', '{}', 'fixture contributor')").run();
  for (const [id, name, start, location] of SERENDIPITY_EVENTS) {
    await db
      .prepare("INSERT INTO events (id, name, start_at, location, url, user_status) VALUES (?, ?, ?, ?, ?, 'going')")
      .bind(id, name, start, location, `https://example.com/${id}`)
      .run();
    await db.prepare("INSERT INTO event_contributions (event_id, user_key) VALUES (?, 'fixture-key')").bind(id).run();
  }
}

// The Rate Limiting bindings the config declares, which the entry stubs out.
const rateLimitNames = (config: { [key: string]: unknown }): string[] => asList(config.ratelimits).flatMap((r) => asText(asRecord(r)?.name) ?? []);

// Boots the Worker on .build with the fixed world and hands `use` its origin.
async function withSite<T>(mode: "replay" | "capture", use: (base: string) => Promise<T>): Promise<T> {
  // No build command: the record reads the .build already staged, which is the
  // point (the A and B builds differ only in their minifier).
  const config = withoutRemoteOnly(await siteConfig());
  writeFileSync(".build/src/worker/minify-diff-entry.ts", workerEntry(mode, rateLimitNames(config)));
  writeFileSync(".wrangler.minify-diff.json", JSON.stringify({ ...config, build: undefined, main: ".build/src/worker/minify-diff-entry.ts" }));
  const server = createTestHarness({
    workers: [
      { configPath: "./.wrangler.minify-diff.json", secrets: { RN_SIGNING_KEY_JWK: JSON.stringify(THROWAWAY_SIGNING_KEY) } },
      { configPath: `${root}counter/wrangler.jsonc` },
    ],
  });
  try {
    const base = String((await server.listen()).url).replace(/\/$/, "");
    await seedSerendipity(await server.getWorker<SeedEnv>().getEnv());
    return await use(base);
  } finally {
    await server.close();
  }
}

function sweepPaths(): string[] {
  const manifest: { surfaces: { path: string }[] } = JSON.parse(readFileSync(`${root}config/site-manifest.json`, "utf8"));
  const only = values.only?.split(",");
  return [...manifest.surfaces.map((s) => s.path), ...VISITS].filter((p) => !OFFSITE.has(p) && (!only || only.includes(p)));
}

async function sweep(base: string, paths: string[], mutant: string | undefined, out: string) {
  mkdirSync(out, { recursive: true });
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
          const rec = await walk(ctx, base, path, mutant);
          await ctx.close();
          writeFileSync(`${out}/${encodeURIComponent(path)}.json`, JSON.stringify(rec));
        }
      }),
    );
  } finally {
    await browser.close();
  }
}

async function record(out: string, mutant = values.mutate) {
  const paths = sweepPaths();
  await withSite("replay", (base) => sweep(base, paths, mutant, out));
  console.log(`recorded ${paths.length} pages into ${out}`);
}

// Re-records the fixture: walks VISITS with the network live and keeps what
// the Worker fetched from the hosts they name (example.com), so the file
// holds nothing but what those deep links ask about.
async function captureOutbound() {
  const hosts = new Set(VISITS.map((v) => new URL(new URL(v, "http://visit").searchParams.get("url") ?? "http://none").host));
  const scratch = mkdtempSync(join(tmpdir(), "minify-diff-outbound-"));
  try {
    writeFileSync(OUTBOUND, "{}\n");
    const seen = await withSite("capture", async (base) => {
      await sweep(base, VISITS, undefined, scratch);
      return (await (await fetch(`${base}/__minify-diff/outbound`)).json()) as { [key: string]: unknown };
    });
    const kept = Object.keys(seen)
      .filter((key) => hosts.has(new URL(key.slice(key.indexOf(" ") + 1)).host))
      .sort();
    writeFileSync(OUTBOUND, `${JSON.stringify(Object.fromEntries(kept.map((key) => [key, seen[key]])), null, 1)}\n`);
    console.log(`outbound: ${kept.length} responses into ${OUTBOUND}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The harness picks a new port each boot, and pages print their own origin.
// A measured duration ("took 3 ms", "rested 1 ms") is the machine, never the
// minifier, and flipped 1 of 3 round-trip records on 2026-11-22.
const steady = (text: string) => text.replace(/(https?:\/\/)?127\.0\.0\.1:\d+/g, "ORIGIN").replace(/\d+(?:\.\d+)?(?:\s|&nbsp;)?ms\b/g, "N ms");

const tokens = (dom: string) => dom.split(/(<[^>]*>)/).filter((t) => t !== "");

const read = (dir: string, f: string): Record | null => {
  try {
    return JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  } catch {
    return null;
  }
};

// Compare record b against record a. With a control (a second record of a's
// build), a token or field where a and the control already disagree is noise
// (a measured timing, a server timestamp, fresh crypto keys, an animation
// frame) and is left out; everything the control reproduced has to match.
function diff(a: string, b: string, controls: string[]): number {
  let dirty = 0;
  let compared = 0;
  let skipped = 0;
  let masked = 0;
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
      const ta = tokens(steady(sa?.dom ?? "")),
        tb = tokens(steady(sb?.dom ?? ""));
      if (others.some((rc) => rc.steps[i]?.step !== sa?.step)) {
        skipped++;
        continue;
      }
      const tcs = others.map((rc) => tokens(steady(rc.steps[i]?.dom ?? "")));
      if (tcs.some((tc) => tc.length !== ta.length)) {
        skipped++;
        continue;
      }
      const noise = new Set<number>();
      for (const tc of tcs) for (let j = 0; j < ta.length; j++) if (tc[j] !== ta[j]) noise.add(j);
      masked += noise.size;
      compared++;
      let at = -1;
      if (sa?.step !== sb?.step || tb.length !== ta.length) at = 0;
      else for (let j = 0; j < ta.length && at < 0; j++) if (!noise.has(j) && ta[j] !== tb[j]) at = j;
      if (at >= 0) {
        while (at < ta.length && at < tb.length && ta[at] === tb[at]) at++;
        const near = (t: string[]) =>
          JSON.stringify(
            t
              .slice(Math.max(0, at - 2), at + 2)
              .join("")
              .slice(0, 240),
          );
        problems.push(
          `step ${i} (${sa?.step ?? "none"} / ${sb?.step ?? "none"}): DOM differs at token ${at} of ${ta.length}/${tb.length}: ${near(ta)} vs ${near(tb)}`,
        );
        break;
      }
    }
    for (const key of ["console", "errors", "requests"] as const) {
      // Parallel fetches finish in any order, so requests compare as a sorted
      // list. One that left the harness (absolute, and aborted) counts once:
      // Chrome retried lens's aborted example.com frame 5 or 6 times.
      const once = (list: string[]) => list.filter((x, i) => !/^\w+ https?:/.test(x) || list.indexOf(x) === i);
      const norm = (r: Record) => JSON.stringify((key === "requests" ? once([...r[key]].sort()) : r[key]).map(steady));
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
  console.log(
    `diff: ${dirty} of ${files.length} pages differ; ${compared} readings compared (${masked} tokens masked), ${skipped} left out as noise the control reproduced`,
  );
  return dirty;
}

// The differential's own control: three clean records and one with `mutant`
// planted, on the --only pages, and the mutant must differ.
async function catchMutant(mutant: string) {
  if (!values.only) throw new Error("catch: name the page with --only");
  if (values.build) execFileSync("bun", ["tools/build.ts"], { stdio: "ignore", env: { ...process.env, MINIFY_PICKS: "off" } });
  const scratch = mkdtempSync(join(tmpdir(), "minify-diff-catch-"));
  try {
    for (const run of ["a1", "a2", "a3"]) await record(join(scratch, run), undefined);
    await record(join(scratch, "m"), mutant);
    const caught = diff(join(scratch, "a1"), join(scratch, "m"), [join(scratch, "a2"), join(scratch, "a3")]) > 0;
    console.log(`catch: ${caught ? "caught" : "missed"} ${mutant} on ${values.only}`);
    return caught;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (verb === "record" && dirA) await record(dirA);
else if (verb === "diff" && dirA && dirB) process.exit(diff(dirA, dirB, positionals.slice(3)) ? 1 : 0);
else if (verb === "catch" && dirA) process.exit((await catchMutant(dirA)) ? 0 : 1);
else if (verb === "outbound") await captureOutbound();
else
  throw new Error("usage: record <dir> [--only a,b] [--mutate stem:k] | diff <dirA> <dirB> [<dirA2> ...] | catch <stem:k> --only <page> [--build] | outbound");
process.exit(0);
