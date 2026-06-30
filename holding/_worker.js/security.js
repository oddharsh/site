// security.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { xpChromeCss } from "./lib/chrome.js";
import { esc } from "./lib/http.js";

// ── /security handler (Windows Security Center reskin) ───────────────
export function handleSecurityCenter(request) {
  const cf = request.cf || {};
  const tls = esc(cf.tlsVersion || "—");
  const proto = esc(cf.httpProtocol || "—");
  const colo = esc(cf.colo || "—");
  const shield = `<svg class="shield" viewBox="0 0 16 16" fill="#fff" aria-hidden="true"><path d="M8 1.2 2 3.3v4.2c0 3.8 2.5 6.2 6 7.5 3.5-1.3 6-3.7 6-7.5V3.3z"/><path d="M5.4 8.2 7 9.8l3.4-3.6" fill="none" stroke="#3c8f24" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Security Center · aadhar.sh</title>
<meta name="description" content="This site's security posture in a Windows Security Center reskin. Read-only.">
<meta name="robots" content="noindex">
<style>
${xpChromeCss(620)}
h1{margin:0 0 4px}
.sc-lede{font-size:9.5pt;color:#4a5568;margin:0 0 13px}
.sc-panel{border:1px solid #b7c0d0;border-radius:4px;margin:0 0 9px;overflow:hidden;box-shadow:inset 0 1px 0 #fff}
.sc-bar{display:flex;align-items:center;gap:8px;padding:6px 11px;font-weight:bold;font-family:var(--font-caption);font-size:10.5pt;color:#fff;background:linear-gradient(180deg,#62b043,#3c8f24);text-shadow:0 1px 1px rgba(0,0,0,.25)}
.sc-bar .shield{width:17px;height:17px;flex:0 0 17px}
.sc-bar .state{margin-left:auto;font-size:8.5pt;font-weight:normal;background:rgba(255,255,255,.24);padding:1px 9px;border-radius:9px;letter-spacing:.04em}
.sc-body{padding:8px 12px;background:#fbfdff;font-size:9.5pt;color:#33415c;line-height:1.5}
.sc-body b{color:#15243f}
.sc-body code,.sc-body .mono{font-family:var(--font-mono);font-size:8.5pt}
dl.sc-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:6px 0 0;font-size:9pt}
dl.sc-grid dt{color:#6b7280}
dl.sc-grid dd{margin:0;color:#15243f;font-family:var(--font-mono);font-size:8.5pt;word-break:break-word}
.sc-foot{font-size:8.5pt;color:#6b7280;border-top:1px solid #e2e8f0;padding-top:8px;margin-top:10px}
</style>
</head>
<body>
<div class="window">
  <div class="title-bar">
    <span class="title-text"><span class="icon"></span>Security Center</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="/whoareyou" title="back to System Properties" aria-label="back to System Properties"></a></span>
  </div>
  <div class="content">
    <h1>Security Center</h1>
    <p class="sc-lede">Windows used to greet you with three green shields. Here is the honest version for this site: what actually guards it, and what each layer really does.</p>

    <div class="sc-panel">
      <div class="sc-bar">${shield} Firewall <span class="state">ON</span></div>
      <div class="sc-body"><b>Cloudflare edge.</b> Every request hits Cloudflare's network before it reaches the origin, so the edge filters traffic, terminates TLS, and absorbs DDoS attempts before they get near me. You reached this page through colo <b>${colo}</b> over <b>${proto}</b>, <b>${tls}</b>.</div>
    </div>

    <div class="sc-panel">
      <div class="sc-bar">${shield} Automatic Updates <span class="state">ON</span></div>
      <div class="sc-body"><b>Service worker.</b> A versioned service worker caches the shared assets and sweeps the old versions whenever its version string bumps, so a return visit picks up changes without a hard reload. The worker-rendered pages stay network-only, so they always render fresh. See the recent installs in <a href="/updates">Windows Update</a>.</div>
    </div>

    <div class="sc-panel">
      <div class="sc-bar">${shield} Threat &amp; identity protection <span class="state">ON</span></div>
      <div class="sc-body"><b>Bot management and Web Bot Auth.</b> Cloudflare scores incoming bots. This site signs its <em>own</em> crawler's outbound requests per RFC 9421 and publishes the key at <code>/.well-known/http-message-signatures-directory</code>, so a site receiving a request can verify it really came from here.</div>
    </div>

    <h2>Header &amp; transport details</h2>
    <dl class="sc-grid">
      <dt>Content-Security-Policy</dt><dd>default-src 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests</dd>
      <dt>Permissions-Policy</dt><dd>camera, microphone, geolocation, USB, FLoC + 10 more: all denied</dd>
      <dt>X-Frame-Options</dt><dd>DENY</dd>
      <dt>X-Content-Type-Options</dt><dd>nosniff</dd>
      <dt>Referrer-Policy</dt><dd>strict-origin-when-cross-origin</dd>
      <dt>DNSSEC</dt><dd>signed (ECDSAP256SHA256, DS at the registrar)</dd>
      <dt>Content Signals</dt><dd>search, ai-input, ai-train: all yes (deliberately open)</dd>
      <dt>This connection</dt><dd>${proto} · ${tls}</dd>
    </dl>
    <p class="sc-foot">Read-only, nothing logged or stored. <a href="/whoareyou">System Properties</a> shows what your specific request revealed.</p>
  </div>
</div>
  <script src="/nav.js" defer></script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type":    "text/html; charset=utf-8",
      "cache-control":   "no-store, must-revalidate",
      "x-robots-tag":    "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
