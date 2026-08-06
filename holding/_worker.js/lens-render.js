// lens-render.js — what the page becomes once JavaScript has run, and how much
// of it a crawler that does not run JavaScript never sees.
//
// ── why this is a third view ──────────────────────────────────────────────
// Lens fetches raw HTML and reads it. That is honest about what a plain crawler
// gets, and it is half the story: on a client-rendered page the crawler gets an
// empty shell while a browser builds a full document from the same URL. The gap
// between those two IS the argument the site keeps making, and until now the
// page could only show one side of it.
//
// ── the engines ───────────────────────────────────────────────────────────
// Two ways to render, and the difference is a credential:
//
//   binding  — env.BROWSER.quickAction("content"), real Chromium, no token.
//   kitesurf — Cloudflare's WASM browser engine, built for agents rather than
//              people (3.1x less CPU, 7x less memory, ~1.8x slower wall time).
//              Free during its beta. Only reachable over REST, because the
//              binding's payload schema is CLOSED — probed 2026-08-06, passing
//              `browser` to quickAction returns
//              {"code":"unrecognized_keys","keys":["browser"]}, and an invented
//              engine name returns the byte-identical error, so the binding is
//              refusing the option rather than ignoring an unknown value.
//
// The REST route needs a Browser Rendering EDIT token in BROWSER_RUN_TOKEN.
// Absent it, this module falls to the binding and says so. Nothing here fails
// the page: a render that cannot happen is reported as absent, never as zero.
//
// ── one unverified thing, handled rather than assumed ─────────────────────
// `browser=kitesurf` is documented in Cloudflare's launch post and NOT in the
// Quick Actions REST reference. So the first REST call tries it and watches for
// a rejection; on one it retries plain and remembers, for this isolate, that the
// parameter is not live yet. The alternative was to hard-code a query parameter
// on the strength of a blog post and let a 400 read as "the target site broke".
import { span } from "./lib/trace.js";

export const RENDER_ENGINES = ["kitesurf", "binding"];

// Per-isolate memo: null = untested, true/false = whether REST accepted the
// engine selector. Deliberately not persisted — it is a fact about Cloudflare's
// API surface during a beta, so the right lifetime is "until this isolate dies".
let kitesurfParamLive = null;

export function _resetKitesurfProbe() { kitesurfParamLive = null; }

const REST_BASE = "https://api.cloudflare.com/client/v4/accounts";

async function renderOverRest(url, env, engine) {
  const account = env.CF_ACCOUNT_ID;
  if (!account || !env.BROWSER_RUN_TOKEN) return null;
  const call = async (withEngine) => {
    const endpoint = `${REST_BASE}/${account}/browser-rendering/content${withEngine ? "?browser=kitesurf" : ""}`;
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.BROWSER_RUN_TOKEN}` },
      body: JSON.stringify({ url, gotoOptions: { waitUntil: "networkidle0", timeout: 18000 } }),
    });
    return r;
  };
  const wantEngine = engine === "kitesurf" && kitesurfParamLive !== false;
  let response = await call(wantEngine);
  // A 400 on the FIRST attempt with the selector is the signal that the beta
  // parameter is not live on this endpoint. Retry once without it rather than
  // report the target as broken.
  if (wantEngine && response.status === 400) {
    kitesurfParamLive = false;
    response = await call(false);
  } else if (wantEngine && response.ok) {
    kitesurfParamLive = true;
  }
  if (!response.ok) return { ok: false, status: response.status };
  const payload = await response.json().catch(() => null);
  // The REST envelope wraps the HTML in {success, result}. A body that does not
  // parse is a failure, not an empty page.
  const html = typeof payload?.result === "string" ? payload.result : null;
  if (html === null) return { ok: false, status: response.status };
  return { ok: true, html, engine: wantEngine && kitesurfParamLive ? "kitesurf" : "chromium-rest" };
}

async function renderOverBinding(url, env) {
  if (!env.BROWSER || typeof env.BROWSER.quickAction !== "function") return null;
  const r = await env.BROWSER.quickAction("content", { url, gotoOptions: { waitUntil: "networkidle0", timeout: 18000 } });
  if (!r.ok) return { ok: false, status: r.status };
  return { ok: true, html: await r.text(), engine: "chromium-binding" };
}

// Renders `url` and reports WHICH engine answered, because a reader comparing
// two renders needs to know whether they came from the same one.
export async function renderPage(url, env, { engine = "kitesurf" } = {}) {
  return span("lens.render", async (s) => {
    s.setAttribute("lens.render_engine_requested", engine);
    const started = Date.now();
    let out = null;
    try {
      out = await renderOverRest(url, env, engine);
      if (!out) out = await renderOverBinding(url, env);
    } catch (error) {
      s.setAttribute("lens.outcome", "render_threw");
      return { ok: false, reason: "render_failed", detail: String(error && error.message || error).slice(0, 200) };
    }
    if (!out) {
      s.setAttribute("lens.outcome", "no_engine");
      return { ok: false, reason: "no_engine" };
    }
    if (!out.ok) {
      s.setAttribute("lens.outcome", out.status === 429 ? "budget_spent" : "render_failed");
      s.setAttribute("http.response.status_code", out.status);
      return { ok: false, reason: out.status === 429 ? "budget_spent" : "render_failed", status: out.status };
    }
    s.setAttribute("lens.render_engine", out.engine);
    s.setAttribute("lens.render_bytes", out.html.length);
    return { ok: true, html: out.html, engine: out.engine, ms: Date.now() - started };
  });
}

// ── measuring the gap ─────────────────────────────────────────────────────
// A pure-JS extractor rather than HTMLRewriter, because HTMLRewriter needs the
// workerd runtime and every one of these numbers has to be assertable under
// plain `node --test`. The counts are coarse on purpose: this is a comparison
// between two documents run through the SAME function, so a systematic
// undercount cancels and only the difference is claimed.
const stripped = (html) => String(html || "")
  .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
  .replace(/<!--[\s\S]*?-->/g, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&(?:nbsp|#160);/gi, " ")
  .replace(/\s+/g, " ")
  .trim();

const countMatches = (html, re) => (String(html || "").match(re) || []).length;

export function documentShape(html) {
  const text = stripped(html);
  return {
    bytes: String(html || "").length,
    words: text ? text.split(" ").filter(Boolean).length : 0,
    headings: countMatches(html, /<h[1-6]\b/gi),
    links: countMatches(html, /<a\b[^>]*\shref=/gi),
    images: countMatches(html, /<img\b/gi),
    jsonld: countMatches(html, /<script\b[^>]*type\s*=\s*["']application\/ld\+json["']/gi),
  };
}

// The headline number: how much of the RENDERED document a non-JS crawler
// already had. Word count is the basis because it is the closest cheap proxy
// for readable substance — bytes would count a framework's inline payload as
// content, and elements would count an empty div as a paragraph.
//
// It is a PROXY and the copy that shows it should say so. What it supports is a
// comparison ("this page hides most of itself from crawlers"), not a
// measurement of meaning.
export function measureGap(rawHtml, renderedHtml) {
  const raw = documentShape(rawHtml);
  const rendered = documentShape(renderedHtml);
  // A rendered document with no words at all cannot ground a ratio. Absent
  // rather than 100%, because "JS added nothing" and "nothing came back" are
  // different claims and only one of them is about the page.
  const visible = rendered.words > 0 ? Math.min(100, Math.round((raw.words / rendered.words) * 100)) : null;
  const deltas = {};
  for (const key of Object.keys(raw)) deltas[key] = rendered[key] - raw[key];
  return {
    raw,
    rendered,
    deltas,
    ...(visible === null ? {} : { crawlerSeesPercent: visible }),
    // Reported separately from the percentage because it is the case the
    // percentage cannot express: the raw HTML already held everything, so the
    // clamp to 100 is hiding that rendering SHRANK the document.
    rendersSmaller: rendered.words > 0 && rendered.words < raw.words,
  };
}
