// lens-render.js — WHICH browser engine answers a Quick Action, and the shape
import { isCallable } from "./lib/parse.ts";
// of what came back.
//
// This file used to carry a whole second rendering route (/lens/rendered) before
// anyone read lens-browser.js properly. /lens/browser already renders after
// JavaScript, already asks for content, screenshot, markdown and the
// accessibility tree in ONE Quick Action, and its deltaStrip already computes
// the HTTP-versus-rendered word gap with an honest bail when the render was
// truncated. The second route was a thinner copy of a better thing, at the cost
// of an extra subrequest. It is gone; what survives is the part that was
// genuinely missing.
//
// ── the engines ───────────────────────────────────────────────────────────
//   kitesurf — Cloudflare's WASM browser engine, built for agents rather than
//              people (3.1x less CPU, 7x less memory, ~1.8x slower wall time),
//              free during its beta. Reached through the BINDING, as
//              quickAction(action, { ...payload, browser: "kitesurf" }).
//   chromium — the binding without that key, and the fallback below.
//
// The binding door is new, and this header said the opposite until 2026-09-28.
// Probed 2026-08-06, passing `browser` returned
// {"code":"unrecognized_keys","keys":["browser"]} for any value. Re-probed
// 2026-09-28 against the production binding, every case carrying an invalid
// `url` so nothing rendered:
//
//   browser: "kitesurf"                  Invalid URL, and nothing else
//   browser: "definitely-not-an-engine"  Invalid URL + invalid_value: expected "kitesurf"
//   definitely_not_a_key_xyz: 1          Invalid URL + unrecognized_keys
//
// The last row is the control: the schema is still CLOSED, so the first row
// means the key is accepted rather than ignored. The middle row is the part the
// REST door never gave us: the engine name is VALIDATED, so a 200 from the
// binding carrying `browser: "kitesurf"` is Kitesurf, and the label is a bare
// `kitesurf`. A real render the same day agreed: example.com came back with
// window.chrome undefined and no WebGL, where Chromium has both, in 1118
// browser-ms against Chromium's 2656.
//
// Kitesurf REFUSES options it has not implemented, by name, before rendering:
// 501, code 2000, "Unsupported options: viewport.deviceScaleFactor", in 790ms
// with no x-browser-ms-used header, so the refusal costs nothing. Two things
// follow. A deviceScaleFactor of exactly 1 is Chromium's default, so it is
// dropped from the Kitesurf payload rather than paid for with a fallback. And a
// 400 or 501 on the Kitesurf attempt retries ONCE on Chromium, labelled as such,
// because a refused request shape is not the scanned site failing. Anything else
// (a 429, a 5xx) is returned as Kitesurf's, since a retry would spend a render
// and a rate-limit slot to hide which engine failed.
//
// REST is now the fallback for a deployment with no binding. It needs a Browser
// Rendering EDIT token in BROWSER_RUN_TOKEN, and its label stays
// `kitesurf-requested` (below), because nothing has shown the REST endpoint
// validates the engine name the way the binding does.

// ── the path IS the opt-in, and the wrong one fails silently ──────────────
// This posted to /browser-rendering/<action> until 2026-08-08. Both spellings
// route — probed unauthenticated against the real account id, each answers
// error 10000 "Authentication error" rather than 7003 "could not route to" —
// so nothing was broken and nothing said so. But Kitesurf's own documentation
// puts `browser=kitesurf` on /browser-run/<action> ALONE, and an endpoint that
// ignores an unrecognised query parameter answers 200. A dropped opt-in and an
// honoured one are the same response.
//
// ── what a REST 200 proves, which is less than this file used to claim ────
// A 400 on the attempt carrying the selector still means the parameter is dead
// here, and is still remembered for the isolate. A 200 means only that the call
// succeeded. It does NOT mean Kitesurf served it: the documented envelope is
// {success, result, meta:{status,title}} with no engine field, and there is no
// response header we can rely on appearing. So the label is `kitesurf-requested`
// rather than `kitesurf`, because /lens exists to say what a machine actually
// saw and cannot start guessing about its own renderer.
//
// Promoting that to a bare `kitesurf` takes one control: does the REST endpoint
// REJECT an invented engine name? A rejection means the parameter is parsed and
// enforced, so a 200 carrying `kitesurf` is Kitesurf. `bun run kitesurf:check`
// runs that control and prints the verdict.
//
// It is a script rather than a runtime probe on purpose. An IGNORED parameter
// means the control renders instead of erroring, and this account gets 10 free
// browser-minutes a day, so a once-per-isolate control would spend the budget
// measuring itself and black out the feature it was checking.

// Per-isolate memo: null = untested, false = REST rejected the selector. Not
// persisted, because it is a fact about an API during a beta.
// TRI-STATE, and the annotation is what makes it one: `let x = null` infers the
// type `null`, so both assignments below were errors and the isolate-level memo
// this implements could not be written down. null is "not probed yet", false is
// "the endpoint refused the selector", true is "a call carrying it came back
// clean". Only false suppresses the retry, which is why `!== false` is the
// guard rather than a truthiness check.
let kitesurfParamLive: boolean | null = null;

export function _resetKitesurfProbe() { kitesurfParamLive = null; }
export function _kitesurfParamLive() { return kitesurfParamLive; }

const REST_BASE = "https://api.cloudflare.com/client/v4/accounts";

// Exported so check-kitesurf.mjs probes the SAME URL this ships, rather than a
// second copy of the path that can agree with itself while both are wrong.
// engine is OPTIONAL: the body already treats an absent one as "no query
// string", and the contract test asserts exactly that by calling with two args.
export const restUrl = (accountId, action, engine?) =>
  `${REST_BASE}/${accountId}/browser-run/${action}${engine ? `?browser=${encodeURIComponent(engine)}` : ""}`;

// Either door counts. A deployment holding only a REST token still renders, so
// a guard that insists on the BINDING would 503 a working configuration.
export const hasRenderEngine = (env) =>
  Boolean((env && env.BROWSER && isCallable(env.BROWSER.quickAction))
    || (env && env.CF_ACCOUNT_ID && env.BROWSER_RUN_TOKEN));

// Runs a Quick Action and reports which engine served it. Returns a Response so
// callers keep their own status/JSON handling — /lens/browser has four distinct
// 502 shapes and this must not flatten them into one.
export async function runBrowserAction(action, payload, env, { engine = "kitesurf" } = {}) {
  if (env && env.BROWSER && isCallable(env.BROWSER.quickAction)) {
    if (engine === "kitesurf") {
      const response = await env.BROWSER.quickAction(action, kitesurfPayload(payload));
      // A refused request SHAPE (400 validation, 501 unimplemented option) is the
      // one case worth a second call: it rendered nothing, and Chromium takes
      // the original payload whole. See the header for why nothing else retries.
      if (response.status !== 400 && response.status !== 501) return { response, engine: "kitesurf" };
    }
    return { response: await env.BROWSER.quickAction(action, payload), engine: "chromium-binding" };
  }
  const canRest = Boolean(env && env.CF_ACCOUNT_ID && env.BROWSER_RUN_TOKEN);
  if (!canRest) return null;
  // REST is used whenever it CAN be, not only while the beta selector works.
  // Gating the whole REST path on `kitesurfParamLive` abandoned a perfectly good
  // door the moment the parameter turned out to be dead, silently demoting every
  // later render to the binding. Only the PARAMETER is conditional.
  const tryEngine = engine === "kitesurf" && kitesurfParamLive !== false;
  const call = (withEngine) => fetch(
    restUrl(env.CF_ACCOUNT_ID, action, withEngine ? "kitesurf" : ""),
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.BROWSER_RUN_TOKEN}` },
      body: JSON.stringify(payload),
    },
  );
  let response = await call(tryEngine);
  // A 400 on the attempt CARRYING the selector is the signal that the beta
  // parameter is not live here. Retry once without it rather than report the
  // scanned site as broken.
  if (tryEngine && response.status === 400) {
    kitesurfParamLive = false;
    response = await call(false);
    return { response, engine: "chromium-rest" };
  }
  if (tryEngine && response.ok) kitesurfParamLive = true;
  // `kitesurf-requested`, never `kitesurf`: the selector was sent and the call
  // came back clean, which is everything a 200 can tell us. See the header.
  return { response, engine: tryEngine && kitesurfParamLive ? "kitesurf-requested" : "chromium-rest" };
}

// The caller's payload with the engine selected and the one option Kitesurf
// refuses dropped, when dropping it changes nothing. A NEW object, shallow:
// the caller's own payload goes to Chromium untouched on a fallback, and nested
// references (gotoOptions is shared with /lens/shot by identity) are kept.
export function kitesurfPayload(payload) {
  const out = { ...payload, browser: "kitesurf" };
  const vp = payload && payload.viewport;
  if (vp && vp.deviceScaleFactor === 1) {
    const { deviceScaleFactor: _dsf, ...rest } = vp;
    out.viewport = rest;
  }
  return out;
}

// ── the shape of a document ───────────────────────────────────────────────
// Counted server-side so the client is handed numbers instead of re-parsing a
// rendered DOM it already received, and so the counting is unit-testable under
// plain node. Coarse on purpose: both sides of any comparison run through the
// SAME function, so a systematic undercount cancels and only the difference is
// ever claimed.
const stripped = (html) => String(html || "")
  .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&(?:nbsp|#160);/gi, " ")
  .replace(/\s+/g, " ")
  .trim();

const countMatches = (html, re) => (String(html || "").match(re) || []).length;

// Words are the honest axis and the rest are structure. Bytes are deliberately
// NOT a comparison axis here: a framework's inlined payload swings them wildly
// while changing nothing a reader or a parser gets, which is the same reason
// lens-browser.js's deltaStrip already leads with words.
export function documentTally(html) {
  const text = stripped(html);
  return {
    words: text ? text.split(" ").filter(Boolean).length : 0,
    headings: countMatches(html, /<h[1-6]\b/gi),
    links: countMatches(html, /<a\b[^>]*\shref=/gi),
    images: countMatches(html, /<img\b/gi),
    jsonld: countMatches(html, /<script\b[^>]*type\s*=\s*["']application\/ld\+json["']/gi),
  };
}
