// security.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { serveMarkdownTwin } from "./lib/assets.js";
import { lunaPage } from "./lib/chrome.js";
import { esc, wantsMarkdown } from "./lib/http.js";

// ── /security handler (Windows Security Center reskin) ───────────────
export async function handleSecurityCenter(request, env) {
  // The prose here is static; only the three connection values below are
  // per-request, and the twin says so and points at /whoareyou.json for them.
  // Hand-authored (www/md/security.md) because this page renders from a
  // template literal, and build.mjs fails the deploy if the twin drifts from
  // lib/security.js, which is where the header values it quotes actually live.
  // x-robots-tag rides along because the HTML sets it: a Markdown rendering of a
  // noindex page should not be the indexable copy of it.
  if (wantsMarkdown(request)) {
    const md = await serveMarkdownTwin(request, env, "/security.md", { "x-robots-tag": "noindex" });
    if (md) return md;
  }

  const cf = request.cf || {};
  const tls = esc(cf.tlsVersion || "—");
  const proto = esc(cf.httpProtocol || "—");
  const colo = esc(cf.colo || "—");
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
      <div class="sc-body"><b>Cloudflare edge.</b> Every request hits Cloudflare's network before it reaches the origin, so the edge filters traffic, terminates TLS, and absorbs DDoS attempts before they get near me. You reached this page through colo <b>${colo}</b> over <b>${proto}</b>, <b>${tls}</b>.</div>
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
      <dt>script-src</dt><dd>every page built here ships a sha256 of each of its own inline scripts, so the policy can name them individually instead of trusting inline code as a class. Currently sent as <code>Content-Security-Policy-Report-Only</code> while it proves itself against real browsers; the enforced policy still carries <code>'unsafe-inline'</code>. The style directive keeps <code>'unsafe-inline'</code> and will, because the CSS here is inline by design &mdash; so this is protection against script injection, not against style injection, and the two are not the same claim</dd>
      <dt>&hellip; and what it lets through</dt><dd>hashing inline scripts says nothing about scripts loaded by <code>src</code> from this origin, which <code>'self'</code> permits. That is not hypothetical here: since 2026-08-06 the edge injects <code>/.webmcp/bridge.js</code> into every page after this worker is done, so the strictest policy this site can currently ship still admits 47KB of code the repository does not contain. Named rather than buried, because a page about guarantees should say where they stop &mdash; details at <a href="/whoareyou">/whoareyou</a></dd>
      <dt>Permissions-Policy</dt><dd>camera, microphone, geolocation, USB, Topics + 10 more: all denied</dd>
      <dt>X-Frame-Options</dt><dd>DENY</dd>
      <dt>X-Content-Type-Options</dt><dd>nosniff</dd>
      <dt>Referrer-Policy</dt><dd>strict-origin-when-cross-origin</dd>
      <dt>DNSSEC</dt><dd>signed (ECDSAP256SHA256, DS at the registrar)</dd>
      <dt>Content Signals</dt><dd>search, ai-input, ai-train: all yes (deliberately open)</dd>
      <dt>This connection</dt><dd>${proto} · ${tls}</dd>
    </dl>
    <p class="sc-foot">Read-only, nothing logged or stored. <a href="/whoareyou">System Properties</a> shows what your specific request revealed.</p>
`;

  return lunaPage({
    title: "Security Center · aadhar.sh",
    path: "Security Center",
    route: "/security",
    width: 620,
    description: "This site's security posture in a Windows Security Center reskin. Read-only.",
    robots: "noindex",
    css,
    body,
    cache: "no-store, must-revalidate",
    closeHref: "/whoareyou",
    closeTitle: "back to System Properties",
    closeLabel: "back to System Properties",
    headers: {
      "x-robots-tag":    "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}
