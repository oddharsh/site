// check-kitesurf.mjs — does Browser Run actually HONOUR `browser=kitesurf`, or
// does it accept the parameter and quietly render Chromium?
//
// lens-render.js cannot answer this at runtime and says so. A 200 proves the
// call succeeded and nothing more: the documented snapshot envelope is
// {success, result, meta:{status,title}} with no engine field. So /lens reports
// `kitesurf-requested` rather than `kitesurf`, and this script is how that gets
// promoted to a claim worth making.
//
// ── the control ───────────────────────────────────────────────────────────
// Send an INVENTED engine name. A rejection means the parameter is parsed and
// enforced, which is what makes a 200 carrying `kitesurf` mean Kitesurf. An
// acceptance means the parameter is decoration and the label must stay hedged.
// Same shape as this repo's other API controls: `--x-bogus-flag` against
// wrangler, `definitely-not-a-real-gateway-xyz` against AI Gateway. Neither the
// docs nor a blog post can answer it, because the question is what the endpoint
// does with input the docs never describe.
//
// ── why this is a script and not a probe in the Worker ────────────────────
// If the parameter IS ignored, the control renders rather than erroring, and
// this account has 10 free browser-minutes a day. A once-per-isolate control
// would spend that budget measuring itself.
//
//     BROWSER_RUN_TOKEN=... pnpm run kitesurf:check          # free probes only
//     BROWSER_RUN_TOKEN=... pnpm run kitesurf:check --render
//
// Free probes send a payload the endpoint must reject anyway (no url, no html),
// so they cost no render. They are decisive only if the error names the engine
// parameter; if payload validation runs first, both spellings return the same
// complaint and the script says so instead of guessing. `--render` then buys the
// decisive answer for two renders of a 40-byte inline document, which is the
// cheapest render that exists here (no outbound fetch, no page to lay out).
//
// The token wants `Browser Rendering - Edit`, the same one the Worker holds in
// BROWSER_RUN_TOKEN. It is not in CI and must not go there.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseJsonc } from "./lib/jsonc.mjs";
import { restUrl } from "../holding/_worker.js/lens-render.js";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const WANT_RENDER = process.argv.includes("--render");

// An engine name no beta will ever ship. If this is accepted, nothing is being
// validated.
const BOGUS = "definitely-not-a-browser-xyz";

// Two formats, because /snapshot rejects a single-format request. `html` rather
// than `url` so the browser never leaves the isolate to fetch anything.
const TINY = { html: "<html><body>control</body></html>", formats: ["content", "markdown"] };

const ok = (m) => console.log(`  ok    ${m}`);
const info = (m) => console.log(`  ..    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

async function probe(accountId, token, engine, body) {
  const url = restUrl(accountId, "snapshot", engine);
  const started = Date.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = (await response.text()).slice(0, 400);
  return { status: response.status, text, ms: Date.now() - started, url };
}

async function main() {
  const token = process.env.BROWSER_RUN_TOKEN;
  if (!token) {
    bad("BROWSER_RUN_TOKEN is unset. This control needs the same Browser Rendering - Edit token the Worker holds.");
    process.exit(2);
  }

  // The account id is pinned in wrangler.jsonc and check-infra.mjs already
  // fails if the four declarations disagree, so reading it here adds no fifth
  // place to keep in sync.
  const wrangler = parseJsonc(await readFile(path.join(ROOT, "wrangler.jsonc"), "utf8"));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || wrangler.account_id;
  if (!accountId) {
    bad("no account id: wrangler.jsonc has no account_id and CLOUDFLARE_ACCOUNT_ID is unset");
    process.exit(2);
  }
  // The account is elided rather than printed. It is not a secret (wrangler.jsonc
  // carries it in a public repo), but it reaches here from process.env and
  // echoing an environment value into stdout is a shape worth not having in a
  // script anyone might pipe into a log. Nothing is lost: the PATH is the thing
  // under test, and it is the half that was wrong.
  console.log(`kitesurf selector control against ${restUrl("<account>", "snapshot", "kitesurf")}\n`);

  // ── tier 1: free ────────────────────────────────────────────────────────
  console.log("free probes (invalid payload, so nothing can render):");
  const emptyKite = await probe(accountId, token, "kitesurf", {});
  const emptyBogus = await probe(accountId, token, BOGUS, {});
  info(`browser=kitesurf  -> ${emptyKite.status} ${emptyKite.text}`);
  info(`browser=${BOGUS} -> ${emptyBogus.status} ${emptyBogus.text}`);

  let verdict = null;
  if (emptyKite.text !== emptyBogus.text) {
    // The endpoint distinguishes the two engine names before it complains about
    // the payload, which is only possible if it is reading the parameter.
    verdict = "enforced";
    ok("the two engine names produce DIFFERENT errors, so the parameter is read and validated");
  } else {
    info("both spellings return the same complaint, so payload validation runs first and this tier cannot decide");
  }

  // ── tier 2: one tiny render each ────────────────────────────────────────
  if (verdict === null && !WANT_RENDER) {
    console.log("\ninconclusive. re-run with --render to spend two renders of a 40-byte inline document:");
    console.log("  BROWSER_RUN_TOKEN=... pnpm run kitesurf:check --render");
    process.exit(1);
  }

  if (WANT_RENDER) {
    console.log("\nrender probes (valid inline payload, ~2 renders against the daily budget):");
    const kite = await probe(accountId, token, "kitesurf", TINY);
    const bogus = await probe(accountId, token, BOGUS, TINY);
    info(`browser=kitesurf  -> ${kite.status} in ${kite.ms}ms`);
    info(`browser=${BOGUS} -> ${bogus.status} in ${bogus.ms}ms`);

    if (kite.status === 200 && bogus.status !== 200) {
      verdict = "enforced";
      ok("kitesurf is accepted and an invented engine is REJECTED: the selector is real");
    } else if (kite.status === 200 && bogus.status === 200) {
      verdict = "ignored";
      bad("an invented engine name renders happily, so `browser=` is being ignored on this path");
    } else if (kite.status !== 200) {
      verdict = "rejected";
      bad(`browser=kitesurf itself was rejected (${kite.status}); the selector is not live for this account`);
    }
  }

  console.log("");
  if (verdict === "enforced") {
    console.log("VERDICT: enforced. A 200 carrying browser=kitesurf really is Kitesurf.");
    console.log("Promote lens-render.js's `kitesurf-requested` label to `kitesurf`, and record");
    console.log("the date and these outputs at the control, the way the other API controls are.");
    process.exit(0);
  }
  if (verdict === "ignored") {
    console.log("VERDICT: ignored. Keep `kitesurf-requested`. /lens is paying Chromium prices");
    console.log("and the free-beta engine is not serving. Check the path against the Kitesurf");
    console.log("docs before concluding it is unavailable.");
    process.exit(1);
  }
  console.log("VERDICT: undecided. Nothing here justifies claiming Kitesurf served a render.");
  process.exit(1);
}

main().catch((e) => {
  bad(e && e.stack ? e.stack : String(e));
  process.exit(2);
});
