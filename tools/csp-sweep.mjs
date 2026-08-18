// Sweep every hashed document against the ENFORCING hashed CSP and report any
// blocked script. This is the evidence ENFORCE_PAGE_HASHES was always supposed to
// be flipped on, and the reason it needs a sweep rather than a page load is that
// the failure is silent: a blocked inline script leaves the page rendering and
// merely dead.
//
// Reads securitypolicyviolation events rather than the console, because that is
// the authoritative signal and it carries the directive and the blocked sample.
//
// Run it against a LOCALLY BUILT worker (`wrangler dev -c wrangler.jsonc`), never
// the readable dev tree: the committed hash map is empty by design, so `pnpm run
// dev` serves every page loose and this would sweep 48 documents that cannot fail.
//
// PROVE THE INSTRUMENT BEFORE BELIEVING A GREEN RUN. Two ways this reports a clean
// sweep while measuring nothing, both hit for real while it was being written:
//
//   1. The worker answers from `caches.default`, persisted in `.wrangler/state`.
//      A cached entry carries the CSP it was stored with, so a stale one serves
//      the loose policy and nothing can ever be blocked. `CF-Cache-Status: HIT`
//      on a cache-busted URL is the tell. Delete `.wrangler/state` and restart.
//   2. Editing a staged `.html` changes nothing, because build step 8 precompresses
//      and the `.br` twin is what ships. Perturb both, or perturb nothing.
//
// The control: add a space inside one inline script in a staged document AND its
// .br twin, leaving the hash map alone, then sweep that one path. It must FAIL with
// `blocked script-src-elem`. A control that passes means the sweep is decoration.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:8812";

// Default to every document the build could hash, read from the staged module the
// worker itself imports, so the sweep and the policy cannot disagree about scope.
const pathsFrom = (file) => {
  const src = readFileSync(file, "utf8");
  const m = /PAGE_SCRIPT_HASHES = (.*); \/\/ build:csp-hashes/.exec(src);
  if (!m) throw new Error(`csp-sweep: ${file} has no generated hash map (build first)`);
  const map = JSON.parse(m[1]);
  if (!Object.keys(map).length) throw new Error("csp-sweep: the hash map is EMPTY, so nothing here is enforced");
  return Object.keys(map);
};

const paths = process.env.PATHS
  ? JSON.parse(readFileSync(process.env.PATHS, "utf8"))
  : pathsFrom(new URL("../.build/public/_worker.js/lib/csp-hashes.js", import.meta.url));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

let bad = 0, swept = 0;
for (const path of paths) {
  const page = await ctx.newPage();
  const violations = [];
  const errors = [];
  await page.addInitScript(() => {
    globalThis.__csp = [];
    addEventListener("securitypolicyviolation", (e) => {
      globalThis.__csp.push({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        disposition: e.disposition,
        sample: (e.sample || "").slice(0, 60),
        line: e.lineNumber,
      });
    });
  });
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 20000 });
    await page.waitForTimeout(900);
    violations.push(...(await page.evaluate(() => globalThis.__csp || [])));
    // sub-documents inherit the policy, so ask each frame too
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      try { violations.push(...(await f.evaluate(() => globalThis.__csp || []))); } catch {}
    }
  } catch (e) {
    errors.push(`navigation: ${String(e).split("\n")[0]}`);
  }
  swept++;
  const enforced = violations.filter((v) => v.disposition !== "report");
  if (enforced.length || errors.length) {
    bad++;
    console.log(`\nFAIL ${path}`);
    for (const v of enforced) console.log(`   blocked ${v.directive} ${v.blocked} line ${v.line} ${v.sample ? `sample: ${v.sample}` : ""}`);
    for (const e of errors) console.log(`   pageerror: ${e}`);
  }
  await page.close();
}

await browser.close();
console.log(`\nswept ${swept} documents, ${bad} with a blocked script or page error`);
process.exit(bad ? 1 : 0);
