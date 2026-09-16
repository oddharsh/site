// security.ts — /security, the Windows Security Center reskin, and /security.json,
// the three connection values it fills in. Bundled by wrangler at deploy.
//
// The page is a STATIC DOCUMENT since 2026-09-16, rendered once by build.ts step
// 5b into the staged tree, so it gets what every other document here gets: a
// brotli q11 twin, a dcz delta against the family and per-page dictionaries, an
// ETag, and CSP hashes for its one inline script. It rendered per request until
// then (edge-compressed at about q4, no twin, no delta) to produce bytes that
// differed only in three values: the colo that answered, the HTTP version, the
// TLS version. Those three are the reason it was live at all, and the owner
// wants them to stay TRUE for the visitor reading the page, so the document
// carries placeholders and one inline script that fills them from
// /security.json. That endpoint reads request.cf and nothing else: no RDAP, no
// UA parse, no subrequest, unlike /whoareyou.json, which the tray already pays
// for and which would be the wrong thing to spend on a page about firewalls.
//
// The prose is static; the twin (src/content/md/security.md) says so and points
// at /whoareyou.json for the live values. build.ts fails the deploy if the twin
// drifts from lib/security.ts, which is where the header values it quotes live.
import { lunaPage } from "./lib/chrome.ts";
import { html, unsafeHtml } from "./lib/html.ts";

// The three per-connection values, read straight off request.cf. `—` is the
// same glyph the page used when it rendered live and a value was absent.
export function handleSecurityJson(request) {
  const cf = request.cf || {};
  const body = JSON.stringify({
    colo:         cf.colo || "—",
    httpProtocol: cf.httpProtocol || "—",
    tlsVersion:   cf.tlsVersion || "—",
  });
  return new Response(body, {
    headers: {
      "content-type":    "application/json; charset=utf-8",
      "cache-control":   "no-store, must-revalidate",
      "x-robots-tag":    "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

// ── /security (rendered at BUILD time; see the header) ────────────────
export function renderSecurityCenter() {
  // Placeholders the inline script below fills from /security.json. The "…" is
  // what a no-JS reader sees, beside the <noscript> line that says where the
  // values are. data-sc is the whole contract between the markup and the script.
  const live = (key) => `<b data-sc="${key}">…</b>`;
  const tls = live("tlsVersion");
  const proto = live("httpProtocol");
  const colo = live("colo");
  const shield = `<svg class="shield" viewBox="0 0 16 16" fill="#fff" aria-hidden="true"><path d="M8 1.2 2 3.3v4.2c0 3.8 2.5 6.2 6 7.5 3.5-1.3 6-3.7 6-7.5V3.3z"/><path d="M5.4 8.2 7 9.8l3.4-3.6" fill="none" stroke="#3c8f24" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const css = `/*min*/
h1{margin:0 0 4px}
.sc-lede{font-size:9.5pt;color:#4a5568;margin:0 0 13px}
.sc-panel{border:1px solid #b7c0d0;border-radius:4px;margin:0 0 9px;overflow:hidden;box-shadow:inset 0 1px 0 #fff}
.sc-bar{display:flex;align-items:center;gap:8px;padding:6px 11px;font-weight:bold;font-family:var(--font-caption);font-size:10.5pt;color:#fff;background:linear-gradient(180deg,#62b043,#3c8f24);text-shadow:0 1px 1px rgba(0,0,0,.25)}
.sc-bar .shield{width:17px;height:17px;flex:0 0 17px}
/* 3px, not the 9px pill it was: the only other radius on this page is 4px, and
   a fully-rounded lozenge is the one shape Luna never used for a status read. */
.sc-bar .state{margin-left:auto;font-size:8.5pt;font-weight:normal;background:rgba(255,255,255,.24);padding:1px 9px;border-radius:3px;letter-spacing:.04em}
.sc-body{padding:8px 12px;background:#fbfdff;font-size:9.5pt;color:#33415c;line-height:1.5}
.sc-body b{color:#15243f}
.sc-body code,.sc-body .mono{font-family:var(--font-mono);font-size:8.5pt}
dl.sc-grid{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:6px 0 0;font-size:9pt}
dl.sc-grid dt{color:#6b7280}
dl.sc-grid dd{margin:0;color:#15243f;font-family:var(--font-mono);font-size:8.5pt;word-break:break-word}
.sc-foot{font-size:8.5pt;color:#6b7280;border-top:1px solid #e2e8f0;padding-top:8px;margin-top:10px}
`;
  const body = `
    <h1>Security Center</h1>
    <p class="sc-lede">Windows used to greet you with three green shields. Here is the honest version for this site: what actually guards it, and what each layer really does.</p>

    <div class="sc-panel">
      <div class="sc-bar">${shield} Firewall <span class="state">ON</span></div>
      <div class="sc-body"><b>Cloudflare edge.</b> Every request hits Cloudflare's network before it reaches the origin, so the edge filters traffic, terminates TLS, and absorbs DDoS attempts before they get near me. You reached this page through colo ${colo} over ${proto}, ${tls}.</div>
    </div>

    <div class="sc-panel">
      <div class="sc-bar">${shield} Automatic Updates <span class="state">ON</span></div>
      <div class="sc-body"><b>Deploy-time delivery.</b> Every deploy purges the edge, shared assets carry short revalidating caches, and pages ship origin-fresh, so a return visit picks up changes without a hard reload and there is no second cache to go stale. (A service worker used to do this job; it retired in v136 because the platform now covers it.) See the recent installs in <a href="/updates">Windows Update</a>.</div>
    </div>

    <div class="sc-panel">
      <div class="sc-bar">${shield} Threat &amp; identity protection <span class="state">ON</span></div>
      <div class="sc-body"><b>Bot management and Web Bot Auth.</b> Cloudflare scores incoming bots. This site signs its <em>own</em> crawler's outbound requests per RFC 9421 and publishes the key at <code>/.well-known/http-message-signatures-directory</code>, so a site receiving a request can verify it really came from here.</div>
    </div>

    <h2>Header &amp; transport details</h2>
    <dl class="sc-grid">
      <dt>Content-Security-Policy</dt><dd>default-src 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests &mdash; no external script or connect origin. The browser-facing directives are self-only; server-side route handlers may still make the outbound calls documented on their own surfaces</dd>
      <dt>script-src</dt><dd>every page built here ships a sha256 of each of its own inline scripts, so the enforced policy names each inline script by hash instead of trusting inline code as a class. <code>'unsafe-inline'</code> left this directive on 2026-08-16, after riding along in a report-only twin while it proved itself against real browsers. The style directive keeps <code>'unsafe-inline'</code> and will, because the CSS here is inline by design &mdash; so this is protection against script injection, not against style injection, and the two are not the same claim</dd>
      <dt>&hellip; and what it lets through</dt><dd>hashing inline scripts says nothing about scripts loaded by <code>src</code> from this origin, which <code>'self'</code> permits. That was not hypothetical here: from 2026-08-06 the edge injected <code>/.webmcp/bridge.js</code> into every page after this worker was done, so the strictest policy the site could ship still admitted 47KB of code the repository does not contain. That injection is off, and every <code>src</code> this page loads is now a file in the repository. The directive still permits any same-origin script, so what closed the gap was removing the script rather than tightening the policy, and the next edge feature anybody enables re-opens it silently. Named rather than buried, because a page about guarantees should say where they stop; details at <a href="/whoareyou">/whoareyou</a></dd>
      <dt>Permissions-Policy</dt><dd>camera, microphone, geolocation, USB, Topics + 10 more: all denied</dd>
      <dt>X-Frame-Options</dt><dd>DENY</dd>
      <dt>X-Content-Type-Options</dt><dd>nosniff</dd>
      <dt>Referrer-Policy</dt><dd>strict-origin-when-cross-origin</dd>
      <dt>DNSSEC</dt><dd>signed (ECDSAP256SHA256, DS at the registrar)</dd>
      <dt>Content Signals</dt><dd>search, ai-input, ai-train: all yes (deliberately open)</dd>
      <dt>This connection</dt><dd>${proto} · ${tls}</dd>
    </dl>
    <p class="sc-foot">Read-only, nothing logged or stored. <a href="/whoareyou">System Properties</a> shows what your specific request revealed.<noscript> The three connection values above need a script to fill in; without one, <a href="/whoareyou.json">/whoareyou.json</a> has them for your request.</noscript></p>
`;
  // One fetch, three text nodes. Failure leaves the "…" placeholders alone, which
  // is the honest state: the page never claims a value it did not read. The
  // build hashes this block into script-src (step 7c), so it stays self-contained.
  const scripts = html`<script>fetch("/security.json",{headers:{accept:"application/json"}}).then(function(r){return r.ok?r.json():null}).then(function(j){if(!j)return;for(var k in j){var els=document.querySelectorAll('[data-sc="'+k+'"]');for(var i=0;i<els.length;i++)els[i].textContent=j[k]}}).catch(function(){})</script>`;

  return lunaPage({
    title: "Security Center · aadhar.sh",
    path: "Security Center",
    route: "/security",
    width: 620,
    description: "This site's security posture in a Windows Security Center reskin. Read-only.",
    robots: "noindex",
    css,
    body: unsafeHtml(body),
    scripts,
    closeHref: "/whoareyou",
    closeTitle: "back to System Properties",
    closeLabel: "back to System Properties",
    headers: {
      "x-robots-tag":    "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
