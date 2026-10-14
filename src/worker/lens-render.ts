// lens-render.ts — WHICH browser engine answers a Quick Action, and the shape
// of what came back.

import { isCallable } from "./lib/parse.ts";

// Kitesurf REFUSES options it has not implemented, by name, before rendering:
// 501, code 2000, "Unsupported options: viewport.deviceScaleFactor", in 790ms
// with no x-browser-ms-used header, so the refusal costs nothing. Two things
// follow. A deviceScaleFactor of exactly 1 is Chromium's default, so it is
// dropped from the Kitesurf payload rather than paid for with a fallback. And a
// 400 or 501 on the Kitesurf attempt retries ONCE on Chromium, labelled as such,
// because a refused request shape is not the scanned site failing. Anything else
// (a 429, a 5xx) is returned as Kitesurf's, since a retry would spend a render
// and a rate-limit slot to hide which engine failed.

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

let kitesurfParamLive: boolean | null = null;

export function _resetKitesurfProbe() { kitesurfParamLive = null; }
export function _kitesurfParamLive() { return kitesurfParamLive; }

const REST_BASE = "https://api.cloudflare.com/client/v4/accounts";

export const restUrl = (accountId, action, engine?) =>
  `${REST_BASE}/${accountId}/browser-run/${action}${engine ? `?browser=${encodeURIComponent(engine)}` : ""}`;

export const hasRenderEngine = (env) =>
  Boolean((env && env.BROWSER && isCallable(env.BROWSER.quickAction))
    || (env && env.CF_ACCOUNT_ID && env.BROWSER_RUN_TOKEN));

export async function runBrowserAction(action, payload, env, { engine = "kitesurf" } = {}) {
  if (env && env.BROWSER && isCallable(env.BROWSER.quickAction)) {
    if (engine === "kitesurf") {
      const response = await env.BROWSER.quickAction(action, kitesurfPayload(payload));
      if (response.status !== 400 && response.status !== 501) return { response, engine: "kitesurf" };
    }
    return { response: await env.BROWSER.quickAction(action, payload), engine: "chromium-binding" };
  }
  const canRest = Boolean(env && env.CF_ACCOUNT_ID && env.BROWSER_RUN_TOKEN);
  if (!canRest) return null;
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
  if (tryEngine && response.status === 400) {
    kitesurfParamLive = false;
    response = await call(false);
    return { response, engine: "chromium-rest" };
  }
  if (tryEngine && response.ok) kitesurfParamLive = true;
  return { response, engine: tryEngine && kitesurfParamLive ? "kitesurf-requested" : "chromium-rest" };
}

export function kitesurfPayload(payload) {
  const out = { ...payload, browser: "kitesurf" };
  const vp = payload && payload.viewport;
  if (vp && vp.deviceScaleFactor === 1) {
    const { deviceScaleFactor: _dsf, ...rest } = vp;
    out.viewport = rest;
  }
  return out;
}

const stripped = (html) => String(html || "")
  .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&(?:nbsp|#160);/gi, " ")
  .replace(/\s+/g, " ")
  .trim();

const countMatches = (html, re) => (String(html || "").match(re) || []).length;

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
