#!/usr/bin/env node
// lens-warm.mjs — fill /lens's browser caches before a demo.
//
// WHY THIS EXISTS. Browser Run on the free plan allows 6 calls a minute
// account-wide and 10 browser-minutes a DAY, shared by /lens/shot,
// /lens/browser and /lens/wire. One render costs ~19s of that. So the Human and
// Browser panes are fine on a quiet afternoon and blacked out the moment
// anybody leans on them, which is precisely what a live demo does.
//
// The fix is not a bigger budget, it is spending the budget EARLIER. Every
// browser route caches to KV for 6h, so rendering the demo URLs ahead of time
// means the demo reads from cache and spends nothing. Nothing here fakes a
// render: it performs the real ones, away from an audience. The pane labels a
// cached snapshot as "KV cache" either way, so nobody is being told a stale
// picture is fresh.
//
// RUN IT WITHIN 6 HOURS OF THE DEMO. Entries expire, and an expired warm is
// the same as no warm.
//
//   node scripts/lens-warm.mjs                 # the 7 seeded chips, production
//   node scripts/lens-warm.mjs <url> [url...]  # specific URLs instead
//   node scripts/lens-warm.mjs --origin http://localhost:8796
//
// THERE IS DELIBERATELY NO --check MODE. A cache hit costs nothing and a cache
// MISS costs a full render, so any probe that reports "is this warm?" warms it
// as a side effect. The first version had one; it spent a chunk of the daily
// allowance measuring whether the daily allowance was spent. Re-running this
// script IS the check: an already-warm URL comes back as `cached` in
// milliseconds and bills nothing.
//
// Exit code is 0 when every target ended up cached, 1 otherwise.

import { lensChipTargets } from "./lib/lens-chips.mjs";

const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

const ORIGIN = (valueOf("--origin", "https://aadhar.sh") || "").replace(/\/+$/, "");

// The seeded chips on /lens, which is what a demo actually clicks. Read out of
// the shell renderer rather than pasted here: this list used to carry a "keep in
// sync" comment, and a comment is not a mechanism. The reader throws if its
// pattern stops matching, so a moved chip fails loudly instead of warming
// nothing and reporting a clean run.
const urls = args.filter((a) => /^https?:\/\//.test(a));
const targets = urls.length ? urls : lensChipTargets();

// The binding mints at most one new browser every 10 seconds on this plan, and
// the per-IP ceilings are tighter still (/lens/shot 3/min, /lens/browser 3/min,
// 4/min across every browser route). A burst just converts allowance into 429s,
// so serial with a gap finishes sooner in wall-clock terms than a retried burst.
const GAP_MS = 21_000;
const BACKOFF_MS = 45_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two refusals that look alike and mean opposite things. A per-minute limit
// clears by waiting; the daily allowance does not clear until 00:00 UTC, and
// retrying into it just burns time.
const isPerMinute = (note) => /rate.?limit|per minute|\d+\/min|for this minute|Hang on/i.test(note);
const isDaily = (note) => /budget_spent|min\/day|day\b/i.test(note) && !/for this minute/i.test(note);

async function ask(path, url) {
  const at = `${ORIGIN}${path}?url=${encodeURIComponent(url)}`;
  const started = Date.now();
  try {
    const res = await fetch(at, { headers: { "user-agent": "lens-warm (workstation)" } });
    const ms = Date.now() - started;
    const type = res.headers.get("content-type") || "";
    // /lens/shot answers PNG bytes and reports cache state in a header;
    // /lens/browser answers JSON carrying `cached`. Read each on its own terms
    // rather than inferring from the status code.
    if (type.startsWith("image/")) {
      return { ok: res.ok, cached: res.headers.get("x-lens-cache") === "hit", ms, note: "PNG" };
    }
    let body = null;
    try { body = await res.json(); } catch { /* an HTML error page from the edge */ }
    if (!body) return { ok: false, cached: false, ms, note: `${res.status} ${type || "no content-type"}` };
    if (body.ok === false) return { ok: false, cached: false, ms, note: body.reason || body.error || String(res.status) };
    return { ok: true, cached: !!body.cached, ms, note: body.cached ? "cache" : "fresh render" };
  } catch (e) {
    return { ok: false, cached: false, ms: Date.now() - started, note: (e && e.message) || String(e) };
  }
}

// One retry, and only for the refusal that a wait actually fixes.
async function askWithBackoff(path, url) {
  let r = await ask(path, url);
  if (!r.ok && isPerMinute(r.note) && !isDaily(r.note)) {
    process.stdout.write(`      per-minute limit, waiting ${BACKOFF_MS / 1000}s\n`);
    await sleep(BACKOFF_MS);
    r = await ask(path, url);
  }
  return r;
}

const pad = (s, n) => String(s).padEnd(n);
const short = (u) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");

console.log(`warming ${targets.length} URL(s) against ${ORIGIN}`);
console.log(`serial, ${GAP_MS / 1000}s apart. Budget-spent stops early; a per-minute limit backs off once.\n`);

let cold = 0;
let stopped = false;

for (const [i, url] of targets.entries()) {
  // The shot feeds the Human pane and the render feeds the Browser pane. They
  // are separate cache entries and a demo clicks through both, so warm both.
  const shot = await askWithBackoff("/lens/shot", url);
  await sleep(GAP_MS);
  const render = await askWithBackoff("/lens/browser", url);

  const state = (r) => (r.ok ? (r.cached ? "cached" : "warmed") : "COLD");
  if (!shot.ok || !render.ok) cold++;
  console.log(`  ${pad(short(url), 38)} shot ${pad(state(shot), 7)} render ${pad(state(render), 7)} ${
    shot.ok && render.ok ? "" : [shot, render].filter((r) => !r.ok).map((r) => r.note).join(" | ")}`);

  if (isDaily(shot.note) || isDaily(render.note)) {
    stopped = true;
    console.log(`\n  stopping: the daily browser allowance is gone. It resets at 00:00 UTC.`);
    console.log(`  ${targets.length - i - 1} URL(s) not attempted.`);
    break;
  }
  if (i < targets.length - 1) await sleep(GAP_MS);
}

if (!stopped) {
  console.log(
    cold === 0
      ? `\nall ${targets.length} URL(s) cached. Entries live 6h, so re-run within 6h of the demo.`
      : `\n${cold} of ${targets.length} URL(s) did not cache.`,
  );
}
console.log("both panes degrade honestly regardless: Human shows the readable text, Browser shows the HTTP evidence.");
process.exit(cold === 0 && !stopped ? 0 : 1);
