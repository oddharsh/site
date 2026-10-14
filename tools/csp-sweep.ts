// Sweep every hashed document against the ENFORCING hashed CSP and report any
// blocked script. This was the evidence that flipped the ENFORCE_PAGE_HASHES
// rollout flag on (2026-08-16), and it outlived the flag's deletion (2026-08-23)
// because the thing it measures did not change: the failure is silent, so a
// blocked inline script leaves the page rendering and merely dead. With no flag
// left, this IS the rollback signal.
import { chromium } from "playwright-core";
import { chromeChannel } from "./lib/browser-channel.ts";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:8812";

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
  // The Worker stages at .build/src/worker/ since the 2026-08-18 split; this read
  // .build/public/_worker.js/ until 2026-09-16 and died with ENOENT before the
  // browser launched, which is gotcha 40's shape (a path that was correct when
  // written and rotted under a move) on the one instrument that proves CSP hashes.
  : pathsFrom(new URL("../.build/src/worker/lib/csp-hashes.ts", import.meta.url));

const browser = await chromium.launch({ channel: chromeChannel(), headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

let bad = 0, swept = 0;
for (const path of paths) {
  const page = await ctx.newPage();
  const violations = [];
  const errors: string[] = [];
  await page.addInitScript(() => {
    globalThis.__csp = [];
    // The event IS a SecurityPolicyViolationEvent; lib.dom declares it and the
    // listener overload does not narrow for a bare addEventListener call, so
    // every field below reads as missing on the base Event.
    addEventListener("securitypolicyviolation", (e: SecurityPolicyViolationEvent) => {
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
