// lens.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { BOT_UA, SIG_AGENT, signRequestForWebBotAuth } from "./lib/botauth.js";
import { xpChromeCss } from "./lib/chrome.js";
import { jsonResponse } from "./lib/http.js";

// ── /lens — "the other web" -----------------------------------------------
// A URL goes in; what a MACHINE sees comes out, across four lenses: page
// anatomy (raw HTML, headers, headings, stripped text), structured/semantic
// data (JSON-LD, microdata, RDFa, microformats, OG/Twitter), the LLM/AI view
// (a markdown rendering + crawler directives), and site-level discovery files
// (robots.txt, sitemap.xml, llms.txt, feeds). The fetch is server-side (CORS
// blocks the browser), guarded against SSRF, capped in time + size, and made
// honestly as AadharshBot. Engine here; the /lens page (handleLens) is the UI.

// /lens — the SSR shell: IE6 address bar, a Human/Machine view toggle, the
// four lens tabs, two panes, seeded examples. The renderer lives in /lens.js
// (a real static file, SW-cached like nav.js) so it can use normal JS without
// fighting this template literal's ${} and backticks.
export function handleLens(request, env, ctx) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Other Web &middot; aadhar.sh</title>
<meta name="description" content="Paste any URL and see it the way a machine does: raw HTML, headers, JSON-LD and microformats, an LLM-style markdown render, and the site's robots.txt / sitemap / llms.txt — side by side with the human view.">
<meta name="robots" content="index, nofollow">
<link rel="icon" href="/favicon.ico">
<style>
${xpChromeCss(980)}
h1 { font-family:"Trebuchet MS",Verdana,Geneva,sans-serif; font-size:13pt; color:oklch(41.92% 0.0962 250.51); margin:0 0 2px; font-weight:bold; }
.lx-lede { margin:0 0 10px; color:oklch(40% 0 0); font-size:10pt; }
.lx-lede a { color:oklch(42.61% 0.2353 263.74); }

/* IE6 address bar */
.lx-addr { display:flex; align-items:center; gap:6px; background:oklch(94.66% 0.0114 252.09); border:1px solid oklch(72% 0.03 250); border-radius:3px; padding:5px 6px; }
.lx-addr-label { font-size:9pt; color:oklch(45% 0 0); padding:0 2px; }
.lx-globe { width:15px; height:15px; flex:0 0 auto; border-radius:50%; background:radial-gradient(circle at 35% 30%, oklch(78% 0.13 230), oklch(48% 0.16 250)); box-shadow:inset 0 0 0 1px oklch(100% 0 0 / .4); }
.lx-url { flex:1 1 auto; min-width:0; font-family:"Courier New",Courier,monospace; font-size:10pt; padding:3px 6px; border:2px solid; border-color:oklch(55% 0 0) oklch(85% 0 0) oklch(85% 0 0) oklch(55% 0 0); background:#fff; color:oklch(25% 0.02 255); }
.lx-url:focus { outline:1px dotted oklch(42.61% 0.2353 263.74); }
.lx-go, .lx-seg, .lx-tab, .lx-chip { font-family:Tahoma,Verdana,sans-serif; cursor:pointer; }
.lx-go { font-size:9.5pt; font-weight:bold; padding:3px 14px; color:oklch(20% 0 0); background:linear-gradient(180deg,#fdfdfd,#dcdcd2); border:1px solid; border-color:#fff oklch(45% 0 0) oklch(45% 0 0) #fff; border-radius:3px; }
.lx-go:active { border-color:oklch(45% 0 0) #fff #fff oklch(45% 0 0); }

/* example chips */
.lx-chips { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin:7px 0 9px; }
.lx-chips-label { font-size:9pt; color:oklch(48% 0 0); }
.lx-chip { font-size:8.8pt; padding:2px 8px; color:oklch(35% 0.06 255); background:oklch(97% 0.006 250); border:1px solid oklch(74% 0.03 250); border-radius:10px; }
.lx-chip:hover { background:oklch(90% 0.04 250); }

/* toolbar: view toggle + lens tabs */
.lx-toolbar { display:flex; align-items:flex-end; justify-content:space-between; gap:10px; flex-wrap:wrap; border-bottom:2px solid oklch(58% 0.10 250); margin-top:2px; }
.lx-view { display:inline-flex; margin-bottom:5px; }
.lx-seg { font-size:9pt; padding:3px 11px; color:oklch(28% 0 0); background:linear-gradient(180deg,#fbfbfb,#e3e3da); border:1px solid oklch(55% 0 0); border-right-width:0; }
.lx-seg:first-child { border-radius:3px 0 0 3px; }
.lx-seg:last-child { border-right-width:1px; border-radius:0 3px 3px 0; }
.lx-seg.is-on { color:#fff; background:linear-gradient(180deg, oklch(58% 0.15 255), oklch(44% 0.18 257)); }
.lx-lenses { display:inline-flex; gap:2px; }
.lx-tab { font-size:9.2pt; padding:5px 12px 6px; color:oklch(35% 0.04 255); background:linear-gradient(180deg, oklch(96% 0.01 250), oklch(88% 0.02 250)); border:1px solid oklch(60% 0.05 250); border-bottom:none; border-radius:5px 5px 0 0; position:relative; top:1px; }
.lx-tab.is-on { color:oklch(33% 0.10 263); font-weight:bold; background:#fff; top:2px; padding-bottom:7px; }

/* panes */
.lx-panes { display:flex; gap:8px; margin-top:8px; min-height:560px; }
.lx-panes.is-human .lx-pane-machine, .lx-panes.is-machine .lx-pane-human { display:none; }
.lx-pane { flex:1 1 0; min-width:0; display:flex; flex-direction:column; border:1px solid oklch(70% 0.03 250); border-radius:0 3px 3px 3px; background:#fff; }
.lx-pane-h { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:8.5pt; font-weight:bold; text-transform:uppercase; letter-spacing:.05em; color:#fff; background:linear-gradient(180deg, oklch(56% 0.12 252), oklch(45% 0.15 255)); padding:4px 8px; border-radius:0 2px 0 0; }
.lx-pane-human .lx-pane-h { background:linear-gradient(180deg, oklch(58% 0.06 150), oklch(46% 0.09 155)); }
.lx-body { flex:1 1 auto; overflow:auto; padding:10px 11px; }
.lx-empty { color:oklch(55% 0 0); font-size:9.5pt; padding:18px 6px; text-align:center; }
.lx-spin { color:oklch(42.61% 0.2353 263.74); font-size:9.5pt; padding:18px 6px; text-align:center; }
.lx-body.is-bleed { padding:0; }
.lx-frame { width:100%; height:100%; min-height:520px; border:0; display:block; background:#fff; }
.lx-shot { width:100%; height:auto; display:block; }
.lx-fallback-note { font-size:8.8pt; color:oklch(42% 0.11 60); background:oklch(96% 0.045 92); border:1px solid oklch(82% 0.09 80); border-radius:3px; padding:5px 9px; margin:0 0 10px; }
.lx-mode { font-family:"Courier New",monospace; font-size:7.6pt; font-weight:normal; text-transform:none; letter-spacing:0; color:oklch(38% 0.09 150); background:#fff; border-radius:7px; padding:1px 7px; vertical-align:middle; }
.lx-mode-sub { font-weight:normal; text-transform:none; letter-spacing:0; opacity:.85; font-size:8pt; }

/* rendered machine content */
.lx-h-title { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:13pt; font-weight:bold; color:oklch(30% 0.06 255); margin:0 0 8px; }
.lx-h-text { font-size:10pt; line-height:1.55; color:oklch(28% 0 0); white-space:pre-wrap; }
.lx-h-outline { margin:0 0 12px; padding:8px 10px; background:oklch(98% 0.01 250); border:1px solid oklch(90% 0.02 250); border-radius:3px; font-size:9pt; }
.lx-h-outline a { color:oklch(42.61% 0.2353 263.74); text-decoration:none; }
.lx-pre { font-family:"Courier New",Courier,monospace; font-size:8.6pt; line-height:1.45; white-space:pre-wrap; word-break:break-word; background:oklch(20% 0.02 255); color:oklch(92% 0.02 150); padding:9px 10px; border-radius:3px; overflow:auto; max-height:520px; }
.lx-pre-light { background:oklch(98.5% 0.008 250); color:oklch(25% 0.02 255); border:1px solid oklch(90% 0.02 250); }
.lx-sec { margin:0 0 15px; }
.lx-sec-h { font-family:"Trebuchet MS",Verdana,sans-serif; font-size:10pt; font-weight:bold; color:oklch(33% 0.09 263); margin:0 0 2px; display:flex; align-items:center; gap:7px; }
.lx-badge { font-family:"Courier New",monospace; font-size:7.6pt; font-weight:normal; color:#fff; background:oklch(52% 0.13 255); border-radius:8px; padding:1px 7px; }
.lx-badge.warn { background:oklch(60% 0.16 50); }
.lx-badge.ok { background:oklch(52% 0.13 150); }
.lx-badge.off { background:oklch(60% 0 0); }
.lx-cap { font-size:8.4pt; color:oklch(50% 0 0); margin:0 0 6px; font-style:italic; }
.lx-kv { width:100%; border-collapse:collapse; font-size:8.8pt; }
.lx-kv td { border-bottom:1px solid oklch(93% 0.01 250); padding:3px 6px 3px 0; vertical-align:top; }
.lx-kv td:first-child { font-family:"Courier New",monospace; color:oklch(42% 0.08 255); white-space:nowrap; width:1%; padding-right:12px; }
.lx-kv td:last-child { color:oklch(28% 0 0); word-break:break-word; }
.lx-tags { display:flex; flex-wrap:wrap; gap:4px; margin:4px 0 0; }
.lx-tag { font-family:"Courier New",monospace; font-size:8.2pt; color:oklch(33% 0.06 255); background:oklch(95% 0.02 255); border:1px solid oklch(80% 0.03 255); border-radius:3px; padding:1px 6px; }
.lx-none { font-size:8.8pt; color:oklch(58% 0 0); padding:2px 0; }
.lx-ogcard { display:flex; gap:9px; border:1px solid oklch(85% 0.02 250); border-radius:4px; padding:8px; background:oklch(99% 0.004 250); }
.lx-ogcard img { width:96px; height:96px; object-fit:cover; border-radius:3px; flex:0 0 auto; background:oklch(92% 0 0); }
.lx-ogcard .t { font-weight:bold; font-size:9.6pt; color:oklch(28% 0.04 255); }
.lx-ogcard .d { font-size:8.8pt; color:oklch(45% 0 0); margin-top:3px; }
.lx-ogcard .u { font-family:"Courier New",monospace; font-size:8pt; color:oklch(50% 0.05 150); margin-top:4px; }

/* status bar */
.lx-status { margin-top:9px; border-top:1px solid oklch(86% 0.03 260); padding-top:6px; display:flex; flex-wrap:wrap; gap:5px 14px; font-size:8.6pt; color:oklch(45% 0 0); }
.lx-status b { color:oklch(30% 0.04 255); font-weight:bold; }
.lx-status .err { color:oklch(55% 0.2 27); font-weight:bold; }
footer { text-align:center; font-size:9pt; color:oklch(45% 0 0); margin-top:14px; padding-top:11px; border-top:1px solid oklch(86.67% 0.0294 259.59); }
footer a { color:oklch(42.61% 0.2353 263.74); }
@media (max-width:720px){ .lx-panes{ flex-direction:column; } .lx-panes.is-both .lx-pane{ min-height:280px; } }
</style>
</head>
<body>
<div class="window">
  <div class="title-bar">
    <span><span class="icon"></span>The Other Web</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="/" title="back to aadhar.sh" aria-label="back to aadhar.sh"></a></span>
  </div>
  <div class="content">
    <h1>The Other Web</h1>
    <p class="lx-lede">Every page has a second life as data. Paste a URL to see it the way a crawler, a model, or a link-preview bot does: the markup, the metadata, the machine directives, next to the human read. Fetched server-side, honestly, as <a href="/bot">AadharshBot</a>.</p>

    <form class="lx-addr" id="lx-form">
      <span class="lx-globe" aria-hidden="true"></span>
      <label class="lx-addr-label" for="lx-url">Address</label>
      <input id="lx-url" class="lx-url" type="text" inputmode="url" placeholder="https://example.com  —  paste any URL" autocomplete="off" spellcheck="false">
      <button class="lx-go" type="submit">Go</button>
    </form>
    <div class="lx-chips">
      <span class="lx-chips-label">Try:</span>
      <button class="lx-chip" data-url="https://aadhar.sh/">aadhar.sh</button>
      <button class="lx-chip" data-url="https://daringfireball.net/">a hand-built blog</button>
      <button class="lx-chip" data-url="https://stripe.com/">a modern marketing site</button>
      <button class="lx-chip" data-url="https://en.wikipedia.org/wiki/Semantic_Web">a Wikipedia article</button>
      <button class="lx-chip" data-url="https://example.com/">the bare minimum</button>
    </div>

    <div class="lx-toolbar">
      <div class="lx-view" role="group" aria-label="view layout">
        <button class="lx-seg is-on" data-view="both" type="button">Both</button>
        <button class="lx-seg" data-view="human" type="button">Human</button>
        <button class="lx-seg" data-view="machine" type="button">Machine</button>
      </div>
      <div class="lx-lenses" role="tablist" aria-label="machine lens">
        <button class="lx-tab is-on" data-lens="anatomy" type="button">Anatomy</button>
        <button class="lx-tab" data-lens="structured" type="button">Structured</button>
        <button class="lx-tab" data-lens="ai" type="button">AI view</button>
        <button class="lx-tab" data-lens="discovery" type="button">Discovery</button>
      </div>
    </div>

    <div class="lx-panes is-both" id="lx-panes">
      <section class="lx-pane lx-pane-human" id="lx-human">
        <div class="lx-pane-h" id="lx-human-h">Human view &middot; the live page</div>
        <div class="lx-body" id="lx-human-body"><div class="lx-empty">Paste a URL above to see it through both eyes.</div></div>
      </section>
      <section class="lx-pane lx-pane-machine" id="lx-machine">
        <div class="lx-pane-h" id="lx-machine-h">Machine view &middot; Anatomy</div>
        <div class="lx-body" id="lx-machine-body"><div class="lx-empty">The markup, metadata, and machine directives land here.</div></div>
      </section>
    </div>

    <div class="lx-status" id="lx-status"><span>Idle. Nothing is fetched until you ask, and then just once, server-side, with no logging.</span></div>
    <footer>&larr; <a href="/">aadhar.sh</a> &middot; a research toy about how machines read the web &middot; fetched by <a href="/bot">AadharshBot</a></footer>
  </div>
</div>
<script src="/lens.js" defer></script>
<script src="/nav.js" defer></script>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60, s-maxage=300",
      "x-robots-tag": "noindex",
      // /lens embeds arbitrary sites in the Human view, so it needs a looser
      // policy than the site default (which has no frame-src → falls back to
      // default-src 'self' and blocks every cross-origin iframe). This relaxes
      // ONLY frame-src (any https origin, for the live iframe) and img-src
      // (blob: for the Browser Rendering screenshot, https: for OG-card art);
      // everything else stays locked down. withSecurityHeaders sees a CSP is
      // already present and leaves it alone. frame-ancestors 'none' keeps OTHER
      // sites from embedding /lens itself.
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; font-src 'self'; frame-src https:; child-src https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; worker-src 'self'",
    },
  });
}

// /lens/fetch?url=… → one JSON envelope with every lens. no-store.
export async function handleLensFetch(request, env, ctx) {
  const v = validateLensTarget(new URL(request.url).searchParams.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);

  // best-effort per-IP rate limit so the proxy can't be turned into a firehose.
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (env.RN_KV) {
    const bucket = `lens:rl:${ip}:${Math.floor(Date.now() / 60000)}`;
    const n = parseInt((await env.RN_KV.get(bucket)) || "0", 10);
    if (n >= 30) return jsonResponse({ ok: false, error: "Slow down — 30 lookups a minute. Try again shortly." }, 429);
    ctx.waitUntil(env.RN_KV.put(bucket, String(n + 1), { expirationTtl: 120 }));
  }

  try {
    return jsonResponse(await lensInspect(v.url, env), 200);
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "The site took too long to answer (8s timeout)." : (e && e.message) || String(e);
    return jsonResponse({ ok: false, error: msg }, 502);
  }
}

// /lens/shot?url=… → a faithful PNG of the page, rendered by Cloudflare
// Browser Rendering (real headless Chrome, server-side). The Human view uses
// this only when a site forbids live framing. Needs CF_ACCOUNT_ID +
// BROWSER_RENDER_TOKEN in env; degrades to a clear 503 when unconfigured.
export async function handleLensShot(request, env, ctx) {
  const v = validateLensTarget(new URL(request.url).searchParams.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);
  if (!env.BROWSER_RENDER_TOKEN || !env.CF_ACCOUNT_ID) {
    const missing = [];
    if (!env.CF_ACCOUNT_ID) missing.push("CF_ACCOUNT_ID");
    if (!env.BROWSER_RENDER_TOKEN) missing.push("BROWSER_RENDER_TOKEN");
    return jsonResponse({ ok: false, missing, error: "Snapshot rendering isn't configured: this deployment can't see " + missing.join(" + ") + ". Check the exact variable name(s) (case-sensitive) and that they're set on the same environment this branch deploys to, then redeploy." }, 503);
  }

  // screenshots are the expensive path — tighter per-IP limit + a KV cache.
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  if (env.RN_KV) {
    const bucket = `lens:shotrl:${ip}:${Math.floor(Date.now() / 60000)}`;
    const n = parseInt((await env.RN_KV.get(bucket)) || "0", 10);
    if (n >= 8) return jsonResponse({ ok: false, error: "Snapshots are rate-limited to 8/min. Hang on a moment." }, 429);
    ctx.waitUntil(env.RN_KV.put(bucket, String(n + 1), { expirationTtl: 120 }));
  }

  const cacheKey = "lens:shot:" + (await lensSha256Hex(v.url));
  if (env.RN_KV) {
    const hit = await env.RN_KV.get(cacheKey, "arrayBuffer");
    if (hit) return new Response(hit, { headers: lensPngHeaders(true) });
  }

  const api = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/screenshot`;
  const payload = {
    url: v.url,
    viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
    screenshotOptions: { fullPage: true, type: "png" },
    gotoOptions: { waitUntil: "networkidle0", timeout: 18000 },
    userAgent: BOT_UA,
  };
  let r;
  try {
    r = await fetch(api, { method: "POST", headers: { authorization: "Bearer " + env.BROWSER_RENDER_TOKEN, "content-type": "application/json" }, body: JSON.stringify(payload) });
  } catch (e) {
    return jsonResponse({ ok: false, error: "Render request failed: " + ((e && e.message) || e) }, 502);
  }
  const ctype = r.headers.get("content-type") || "";
  if (!r.ok || !ctype.startsWith("image/")) {
    let detail = "";
    try { detail = (await r.text()).slice(0, 300); } catch (_e) {}
    return jsonResponse({ ok: false, error: "Browser Rendering returned " + r.status + ".", detail }, 502);
  }
  const buf = await r.arrayBuffer();
  if (env.RN_KV) ctx.waitUntil(env.RN_KV.put(cacheKey, buf, { expirationTtl: 3600 }));
  return new Response(buf, { headers: lensPngHeaders(false) });
}

export function lensPngHeaders(cached) {
  return { "content-type": "image/png", "cache-control": "public, max-age=3600", "x-robots-tag": "noindex", "x-lens-cache": cached ? "hit" : "miss" };
}

export async function lensSha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// X-Frame-Options / CSP frame-ancestors → can a browser embed this live?
export function lensFramable(headers) {
  const xfo = (headers["x-frame-options"] || "").toLowerCase();
  if (xfo.includes("deny") || xfo.includes("sameorigin") || xfo.includes("allow-from")) {
    return { framable: false, reason: "X-Frame-Options: " + xfo.trim() };
  }
  const csp = headers["content-security-policy"] || "";
  const m = csp.match(/frame-ancestors([^;]*)/i);
  if (m) {
    const val = m[1].toLowerCase();
    if (/'none'/.test(val)) return { framable: false, reason: "CSP frame-ancestors 'none'" };
    if (!/\*/.test(val)) return { framable: false, reason: "CSP frame-ancestors restricts embedding" };
  }
  return { framable: true, reason: null };
}

// Only public http(s). Reject loopback / private / link-local / cloud-metadata
// literals + non-standard ports. (Workers can't egress to the internal network
// anyway, but blocking the obvious literals is cheap hygiene.)
export function validateLensTarget(raw) {
  const s0 = String(raw || "").trim();
  if (!s0) return { ok: false, error: "Type a URL to inspect." };
  const s = /^https?:\/\//i.test(s0) ? s0 : "https://" + s0;
  let url;
  try { url = new URL(s); } catch { return { ok: false, error: "That doesn't parse as a URL." }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "Only http and https URLs." };
  if (url.port && url.port !== "80" && url.port !== "443") return { ok: false, error: "Only ports 80 and 443 are allowed." };
  if (lensHostBlocked(url.hostname.toLowerCase())) return { ok: false, error: "That host is on the no-fetch list (localhost / private / link-local)." };
  return { ok: true, url: url.toString() };
}

export function lensHostBlocked(host) {
  const h = host.replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".onion")) return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;        // link-local incl. 169.254.169.254 metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;                        // multicast / reserved
  }
  return false;
}

// the orchestrator: fetch the target, parse it, then probe the origin's
// site-level files in parallel. returns the full lens envelope.
export async function lensInspect(targetUrl, env) {
  const started = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 8000);
  let res;
  try { res = await lensFetch(targetUrl, env, ctrl.signal); }
  finally { clearTimeout(to); }

  const finalUrl = res.url || targetUrl;
  const ct = res.headers.get("content-type") || "";
  const headers = {};
  for (const [k, val] of res.headers) headers[k] = val;
  const isTextual = ct === "" || /text|html|xml|json|javascript|\+xml|\+json/i.test(ct);
  const isHtml = /html/i.test(ct) || (ct === "" && false);

  let body = "", truncated = false;
  if (isTextual) { const r = await lensReadCapped(res, 2 * 1024 * 1024); body = r.text; truncated = r.truncated; }

  const out = {
    ok: true, url: targetUrl, finalUrl, redirected: finalUrl !== targetUrl,
    status: res.status, contentType: ct, binary: !isTextual, truncated,
    elapsedMs: Date.now() - started, fetchedBy: BOT_UA, headers,
  };

  // can the browser embed this URL live in an <iframe>, or does the site
  // forbid framing (so the Human view must fall back to a screenshot)?
  var fr = lensFramable(headers);
  out.framable = fr.framable;
  out.frameReason = fr.reason;

  if (isHtml && body) {
    const attrs = await lensExtractAttrs(body);
    const jsonld = attrs.jsonld.map(lensParseJsonld);
    out.anatomy = {
      rawHtml: body.length > 80000 ? body.slice(0, 80000) : body,
      rawBytes: body.length,
      headings: lensHeadings(body),
      text: lensText(body).slice(0, 24000),
      imgTotal: attrs.imgTotal, imgNoAlt: attrs.imgNoAlt,
    };
    out.anatomy.wordCount = out.anatomy.text ? out.anatomy.text.split(/\s+/).filter(Boolean).length : 0;
    out.structured = {
      title: (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ""])[1].replace(/\s+/g, " ").trim(),
      meta: attrs.meta, og: attrs.og, twitter: attrs.twitter, jsonld,
      microdata: { itemtypes: [...attrs.microItemtypes], props: [...attrs.microProps] },
      rdfa: { typeof: [...attrs.rdfaTypeof], properties: [...attrs.rdfaProps] },
      microformats: [...attrs.mf],
      relLinks: attrs.relLinks.map((l) => ({ ...l, href: lensAbs(l.href, finalUrl) })),
    };
    out.ai = { markdown: lensMarkdown(body, finalUrl) };
  } else if (isTextual && body) {
    // non-HTML text (xml/json/txt/markdown): show it raw, no parsing.
    out.anatomy = { rawHtml: body.slice(0, 80000), rawBytes: body.length, text: lensText(body).slice(0, 24000), headings: [], imgTotal: 0, imgNoAlt: 0 };
    out.anatomy.wordCount = out.anatomy.text ? out.anatomy.text.split(/\s+/).filter(Boolean).length : 0;
  }

  // site-level discovery — probe the origin's well-known files in parallel.
  const origin = (() => { try { return new URL(finalUrl).origin; } catch { return null; } })();
  if (origin) {
    const [robots, sitemap, llms, llmsFull, aiTxt, secTxt] = await Promise.all([
      lensProbe(origin + "/robots.txt", env), lensProbe(origin + "/sitemap.xml", env),
      lensProbe(origin + "/llms.txt", env), lensProbe(origin + "/llms-full.txt", env),
      lensProbe(origin + "/ai.txt", env), lensProbe(origin + "/.well-known/security.txt", env),
    ]);
    const feeds = (out.structured?.relLinks || []).filter((l) =>
      /alternate/.test(l.rel) && /(rss|atom|feed|\+xml|\+json)/i.test((l.type || "") + " " + (l.href || "")));
    out.discovery = { origin, robotsTxt: robots, sitemapXml: sitemap, llmsTxt: llms, llmsFullTxt: llmsFull, aiTxt, securityTxt: secTxt, feeds };
    out.ai = out.ai || {};
    out.ai.llmsTxtPresent = llms.ok;
    out.ai.directives = {
      metaRobots: out.structured?.meta?.robots || null,
      xRobotsTag: headers["x-robots-tag"] || null,
      namesAiCrawlers: robots.ok ? /GPTBot|ClaudeBot|Claude-Web|Google-Extended|CCBot|PerplexityBot|anthropic-ai|OAI-SearchBot|Bytespider|Amazonbot/i.test(robots.body || "") : false,
    };
  }
  return out;
}

// honest, identified fetch — AadharshBot UA + (when the key is set) a Web Bot
// Auth signature, same identity the rest of the site crawls under.
export async function lensFetch(targetUrl, env, signal) {
  const headers = new Headers({
    "user-agent": BOT_UA,
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    "accept-language": "en-US,en;q=0.9",
  });
  if (env.RN_SIGNING_KEY_JWK) {
    try {
      const sig = await signRequestForWebBotAuth(targetUrl, env);
      headers.set("Signature-Agent", `"${SIG_AGENT}"`);
      headers.set("Signature-Input", `sig1=${sig.params}`);
      headers.set("Signature", `sig1=:${sig.b64}:`);
    } catch (_e) { /* recipient just can't verify */ }
  }
  return fetch(targetUrl, { method: "GET", headers, redirect: "follow", signal, cf: { cacheTtl: 0 } });
}

// read a response body but stop at `max` bytes so a giant page can't blow memory.
export async function lensReadCapped(res, max) {
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) { const t = await res.text(); return { text: t.length > max ? t.slice(0, max) : t, truncated: t.length > max }; }
  const chunks = []; let total = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > max) { chunks.push(value.subarray(0, max - total)); truncated = true; try { await reader.cancel(); } catch (_e) {} break; }
    chunks.push(value); total += value.length;
  }
  let len = 0; for (const c of chunks) len += c.length;
  const merged = new Uint8Array(len); let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return { text: new TextDecoder("utf-8").decode(merged), truncated };
}

// small, forgiving probe for a single site-level file.
export async function lensProbe(url, env) {
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 5000);
    let res;
    try { res = await lensFetch(url, env, ctrl.signal); } finally { clearTimeout(to); }
    if (!res.ok) { try { await res.body?.cancel(); } catch (_e) {} return { ok: false, status: res.status, url }; }
    const cap = await lensReadCapped(res, 256 * 1024);
    return { ok: true, status: res.status, url, contentType: res.headers.get("content-type") || "", body: cap.text, truncated: cap.truncated };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e), url }; }
}

// HTMLRewriter pass for the attribute-driven extraction it's robust at:
// meta/OG/Twitter, JSON-LD script bodies, rel-links, img alt coverage,
// microdata, RDFa, and microformats class tokens.
export async function lensExtractAttrs(html) {
  const acc = {
    meta: {}, og: {}, twitter: {}, relLinks: [], jsonld: [],
    microItemtypes: new Set(), microProps: new Set(), mf: new Set(),
    rdfaTypeof: new Set(), rdfaProps: new Set(), imgTotal: 0, imgNoAlt: 0,
  };
  let jbuf = null;
  const MF = /^(h|p|u|dt|e)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const MF_CLASSIC = /^(vcard|hcard|hcalendar|hentry|hfeed|hreview|hrecipe|hatom|hresume|hproduct|adr|geo)$/;
  const rw = new HTMLRewriter()
    .on("meta", { element(el) {
      const name = (el.getAttribute("name") || "").toLowerCase();
      const prop = (el.getAttribute("property") || "").toLowerCase();
      const content = el.getAttribute("content") || "";
      if (prop.startsWith("og:")) acc.og[prop.slice(3)] = content;
      else if (/^(article|product|book|profile|video|music):/.test(prop)) acc.og[prop] = content;
      else if (name.startsWith("twitter:")) acc.twitter[name.slice(8)] = content;
      else if (name) acc.meta[name] = content;
      else if (prop) acc.meta[prop] = content;
    } })
    .on("script", {
      element(el) { jbuf = (el.getAttribute("type") || "").toLowerCase() === "application/ld+json" ? [] : null; },
      text(t) { if (jbuf) { jbuf.push(t.text); if (t.lastInTextNode) { acc.jsonld.push(jbuf.join("")); jbuf = null; } } },
    })
    .on("link", { element(el) {
      const rel = (el.getAttribute("rel") || "").toLowerCase();
      if (!rel || acc.relLinks.length >= 80) return;
      acc.relLinks.push({ rel, href: el.getAttribute("href") || "", type: el.getAttribute("type") || "", title: el.getAttribute("title") || "", hreflang: el.getAttribute("hreflang") || "" });
    } })
    .on("img", { element(el) { acc.imgTotal++; const alt = el.getAttribute("alt"); if (alt === null || alt.trim() === "") acc.imgNoAlt++; } })
    .on("[itemtype]", { element(el) { const v = el.getAttribute("itemtype"); if (v && acc.microItemtypes.size < 100) acc.microItemtypes.add(v); } })
    .on("[itemprop]", { element(el) { const v = el.getAttribute("itemprop"); if (v && acc.microProps.size < 200) v.split(/\s+/).forEach((x) => x && acc.microProps.add(x)); } })
    .on("[typeof]", { element(el) { const v = el.getAttribute("typeof"); if (v && acc.rdfaTypeof.size < 100) v.split(/\s+/).forEach((x) => x && acc.rdfaTypeof.add(x)); } })
    .on("[property]", { element(el) { const v = (el.getAttribute("property") || ""); if (acc.rdfaProps.size >= 200) return; v.split(/\s+/).forEach((x) => { if (x && !/^(og|twitter|article|product|book|profile|video|music):/.test(x)) acc.rdfaProps.add(x); }); } })
    .on("[class]", { element(el) { if (acc.mf.size >= 60) return; (el.getAttribute("class") || "").split(/\s+/).forEach((tok) => { if (MF.test(tok) || MF_CLASSIC.test(tok)) acc.mf.add(tok); }); } });
  await rw.transform(new Response(html)).arrayBuffer();
  return acc;
}

export function lensParseJsonld(raw) {
  const trimmed = String(raw || "").trim();
  try {
    const obj = JSON.parse(trimmed);
    const types = new Set();
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (o["@type"]) [].concat(o["@type"]).forEach((t) => types.add(String(t)));
      for (const k in o) walk(o[k]);
    })(obj);
    return { valid: true, types: [...types], json: JSON.stringify(obj, null, 2).slice(0, 12000) };
  } catch (e) { return { valid: false, error: (e && e.message) || "parse error", raw: trimmed.slice(0, 3000) }; }
}

export function lensHeadings(html) {
  const out = []; const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi; let m;
  while ((m = re.exec(html)) && out.length < 250) { const txt = lensStripInline(m[2]).trim(); if (txt) out.push({ level: +m[1], text: txt.slice(0, 300) }); }
  return out;
}

export function lensText(html) {
  let s = html;
  const b = s.match(/<body[^>]*>([\s\S]*)<\/body>/i); if (b) s = b[1];
  s = s.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  return lensDecode(s).replace(/\s+/g, " ").trim();
}

// best-effort, dependency-free HTML→Markdown — roughly what a basic LLM
// scraper ingests. High-fidelity Readability/Turndown is a deliberate v2.
export function lensMarkdown(html, baseUrl) {
  let s = html;
  const b = s.match(/<body[^>]*>([\s\S]*)<\/body>/i); if (b) s = b[1];
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|template|svg|head|nav|footer|aside)[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, i) => "\n\n```\n" + lensDecode(i.replace(/<[^>]+>/g, "")).replace(/\n+$/g, "") + "\n```\n\n");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (m, i) => "`" + lensStripInline(i).trim() + "`");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (m, l, i) => "\n\n" + "#".repeat(+l) + " " + lensStripInline(i).trim() + "\n\n");
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, i) => "\n\n> " + lensStripInline(i).trim().replace(/\n+/g, "\n> ") + "\n\n");
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, i) => "- " + lensStripInline(i).trim() + "\n");
  s = s.replace(/<img\b[^>]*>/gi, (m) => { const alt = lensTagAttr(m, "alt"); const src = lensAbs(lensTagAttr(m, "src"), baseUrl); return src ? `![${alt}](${src})` : ""; });
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (m, i) => { const href = lensAbs(lensTagAttr(m, "href"), baseUrl); const txt = lensStripInline(i).trim(); if (!txt) return ""; return href ? `[${txt}](${href})` : txt; });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, i) => "**" + lensStripInline(i).trim() + "**");
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, i) => "*" + lensStripInline(i).trim() + "*");
  s = s.replace(/<\/(p|div|section|article|header|main|ul|ol|table|tr|h[1-6])>/gi, "\n\n");
  s = s.replace(/<[^>]+>/g, "");
  s = lensDecode(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

export function lensStripInline(h) { return lensDecode(String(h).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " "); }

export function lensTagAttr(tag, name) { const m = String(tag).match(new RegExp(name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i")); return m ? (m[2] ?? m[3] ?? m[4] ?? "") : ""; }

export function lensAbs(href, base) { if (!href) return href; try { return new URL(href, base).toString(); } catch { return href; } }

export function lensDecode(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch { return m; } })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return m; } })
    .replace(/&amp;/g, "&");
}
