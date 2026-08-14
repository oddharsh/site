// lens-inject-probe.mjs — does Browser Run actually run an injected script, and
// is the page captured AFTER it runs?
//
// /lens/browser?do=<recipe> reaches the page through `addScriptTag`. That
// parameter is documented on the Quick Actions REST endpoints, and documented
// is not the same as accepted: the Kitesurf probe established that the BINDING's
// payload schema is CLOSED (`{"code":"unrecognized_keys","keys":["browser"]}`),
// so a key the REST docs describe can still be refused one door over. This
// settles it by measurement instead of by reading.
//
// ── the fixture is inline HTML, on purpose ────────────────────────────────
// Every case posts `html:` rather than `url:`. A self-contained fixture needs no
// route, no deploy, no run_worker_first entry, and sends no traffic to anybody
// else's site — and it is the cheapest render that exists here, which matters
// against ten browser-minutes a day. The fixture plants absent-markers that only
// an executed injection can flip, so a pass cannot be faked by the page itself.
//
//     BROWSER_RUN_TOKEN=... node scripts/lens-inject-probe.mjs
//     BROWSER_RUN_TOKEN=... node scripts/lens-inject-probe.mjs --only 1,3
//
// Roughly one render per case, spaced 11s apart because the free plan allows six
// a minute account-wide and a burst here would 429 the probe rather than answer
// it. Budget ~7 renders for a full run.
//
// ── the one case this script CANNOT run ───────────────────────────────────
// Q1 asks about `env.BROWSER.quickAction`, which exists only inside a Worker.
// Run it separately, once:
//
//     pnpm run dev:remote          # local Worker, production Browser binding
//     curl -s 'http://localhost:8787/lens/browser?url=https://aadhar.sh/garage&do=expand' | jq .interaction
//
// A payload rejection surfaces as the existing `upstream_not_ok` 502 carrying
// `unrecognized_keys`, which is the same signature the Kitesurf probe produced.

import { restUrl } from "../www/_worker.js/lens-render.js";

const TOKEN = process.env.BROWSER_RUN_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "1c99acdb6141579023fb97d24261ea58";
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg > -1 ? new Set((process.argv[onlyArg + 1] || "").split(",").map(Number)) : null;

// Markers a passing injection must flip, a <details> for the real `expand`
// recipe to act on, and a load stamp so case 2 can prove injection happened
// after the load rather than at parse time.
const FIXTURE = `<!doctype html><title>probe</title><body>
<p id="sync">SYNC-ABSENT</p><p id="async">ASYNC-ABSENT</p>
<details><summary>s</summary><p>HIDDENWORD</p></details>
<script>window.__loadAt=Date.now();setTimeout(function(){document.body.dataset.late="1";},300);</script>
</body>`;

// Same shape as a real recipe harness: flip a marker synchronously, plant an
// async one 800ms out, create a node a waitForSelector could target, and remove
// our own element.
const INJECT = `(function(){var me=document.currentScript,t0=Date.now();
document.getElementById("sync").textContent="SYNC-PRESENT";
document.documentElement.dataset.afterLoad=String(t0-(window.__loadAt||t0));
setTimeout(function(){var a=document.getElementById("async");if(a)a.textContent="ASYNC-PRESENT";
var p=document.createElement("p");p.id="settled";p.textContent="SETTLED";document.body.appendChild(p);},800);
if(me&&me.parentNode)me.parentNode.removeChild(me);})();`;

const CSP_FIXTURE = `<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src 'none'">
<title>probe-csp</title><body><p id="sync">SYNC-ABSENT</p></body>`;

const CASES = [
  { n: 1, why: "Q3 — is the capture after the injected script's SYNCHRONOUS mutations? THE GATE.",
    body: { html: FIXTURE, addScriptTag: [{ content: INJECT }] } },
  { n: 2, why: "Q2 — does injection happen after networkidle2 settles, not at parse?",
    body: { html: FIXTURE, addScriptTag: [{ content: INJECT }], gotoOptions: { waitUntil: "networkidle2", timeout: 18000 } } },
  { n: 3, why: "Q4 — is waitForTimeout accepted, and does it delay capture until AFTER the injection's async work?",
    body: { html: FIXTURE, addScriptTag: [{ content: INJECT }], waitForTimeout: 1500 } },
  { n: 4, why: "negative control for case 3 — without the wait, ASYNC-ABSENT must still hold, or case 3 proves nothing",
    body: { html: FIXTURE, addScriptTag: [{ content: INJECT }] } },
  { n: 5, why: "Q5 — can waitForSelector resolve against a node the INJECTED script created?",
    body: { html: FIXTURE, addScriptTag: [{ content: INJECT }], waitForSelector: { selector: "#settled", timeout: 5000 } } },
  { n: 6, why: "Q6 — does Kitesurf, a WASM engine, execute injected scripts at all?",
    body: { html: FIXTURE, addScriptTag: [{ content: INJECT }] }, engine: "kitesurf" },
  { n: 7, why: "CSP — a page refusing inline script must produce a clean no-injection, which is the reader-facing copy",
    body: { html: CSP_FIXTURE, addScriptTag: [{ content: INJECT }] } },
];

async function run(kase) {
  const url = restUrl(ACCOUNT, "snapshot", kase.engine || "");
  const started = Date.now();
  let status = 0, content = "", error = null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      // Two formats minimum: /snapshot rejects a single-format request.
      body: JSON.stringify({ formats: ["content", "markdown"], ...kase.body }),
    });
    status = response.status;
    const text = await response.text();
    try { const j = JSON.parse(text); content = String((j.result && j.result.content) || ""); if (!j.success) error = text.slice(0, 300); }
    catch (_e) { error = text.slice(0, 300); }
  } catch (e) { error = String((e && e.message) || e); }

  const after = content.match(/data-after-load="(\d+)"/);
  return {
    case: kase.n, why: kase.why, engine: kase.engine || "default", status, ms: Date.now() - started,
    // The four readings. `syncRan` is the gate; everything else is detail.
    syncRan: content.includes("SYNC-PRESENT"),
    asyncRan: content.includes("ASYNC-PRESENT"),
    settledNode: content.includes('id="settled"'),
    detailsOpen: /<details[^>]*\bopen/i.test(content),
    injectedTagLeftBehind: content.includes("document.currentScript"),
    msAfterLoad: after ? Number(after[1]) : null,
    error,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!TOKEN) {
    console.error("BROWSER_RUN_TOKEN is unset. This probe needs the Browser Rendering - Edit token the Worker holds.");
    process.exit(2);
  }
  const cases = CASES.filter((c) => !ONLY || ONLY.has(c.n));
  const out = [];
  for (const [i, kase] of cases.entries()) {
    if (i) await wait(11000); // 6 renders/min account-wide
    const row = await run(kase);
    out.push(row);
    console.error(`case ${row.case}: status ${row.status} syncRan=${row.syncRan} asyncRan=${row.asyncRan} (${row.ms}ms)${row.error ? " ERR " + row.error : ""}`);
  }
  console.log(JSON.stringify(out, null, 2));

  // The verdict, stated rather than left for a reader to infer from seven rows.
  const c = (n) => out.find((r) => r.case === n);
  console.error("\n--- verdict ---");
  if (c(1)) console.error(c(1).syncRan
    ? "Q3 PASS: synchronous mutations are captured. expand and consent are buildable."
    : "Q3 FAIL: the injected script did not reach the captured HTML. The whole feature is dead; stop here.");
  if (c(2)) console.error(`Q2: injection landed ${c(2).msAfterLoad}ms after the page's own load stamp` + (c(2).msAfterLoad > 0 ? " (after load, good)" : " (at or before load — SPAs will render empty)"));
  if (c(3) && c(4)) console.error(c(3).asyncRan && !c(4).asyncRan
    ? "Q4 PASS: waitForTimeout delays capture past the injection's async work. lazy/more are unblocked."
    : c(3).asyncRan && c(4).asyncRan
      ? "Q4 INCONCLUSIVE: the control also caught the async marker, so the wait proved nothing."
      : "Q4 FAIL: async recipes are not buildable. Ship synchronous recipes only.");
  if (c(5)) console.error(c(5).settledNode ? "Q5 PASS: waitForSelector resolves against injected nodes." : "Q5 FAIL: no targeted settle available.");
  if (c(6)) console.error(c(6).syncRan ? "Q6 PASS: Kitesurf executes injected scripts." : "Q6 FAIL: pin recipe runs to chromium in runBrowserAction.");
  if (c(7)) console.error(c(7).syncRan ? "CSP: UNEXPECTED — inline script ran under script-src 'none'." : "CSP PASS: a refusing page yields no injection, which is the no-receipt path the UI explains.");
}

main().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(2); });
