# Security Center

Windows used to greet you with three green shields. This is the honest version
for aadhar.sh: what actually guards the site, and what each layer really does.

Three values on the live page come from your own connection (the Cloudflare colo
that answered, the HTTP version, the TLS version), so they are not published
here. <https://aadhar.sh/whoareyou.json> returns those for your request as JSON.

## Firewall: the Cloudflare edge

Every request hits Cloudflare's network before it reaches the origin, so the
edge filters traffic, terminates TLS, and absorbs DDoS attempts before they get
near me.

## Automatic Updates: deploy-time delivery

Every deploy purges the edge, shared assets carry short revalidating caches, and
pages ship origin-fresh, so a return visit picks up changes without a hard
reload and there is no second cache to go stale. A service worker used to do
this job; it retired in v136 because the platform now covers it. The recent
installs are listed at <https://aadhar.sh/updates>.

## Threat and identity protection: bot management and Web Bot Auth

Cloudflare scores incoming bots. This site signs its *own* crawler's outbound
requests per RFC 9421 and publishes the key at
`/.well-known/http-message-signatures-directory`, so a site receiving a request
from AadharshBot can verify it really came from here. See
<https://aadhar.sh/bot.md> for the full crawler contract.

## Header and transport details

- **Content-Security-Policy**: `default-src 'self'; object-src 'none';
  frame-ancestors 'none'; upgrade-insecure-requests`. No external script or
  connect origin: the browser-facing directives are self-only. Server-side
  route handlers may still make the outbound calls documented on their own
  surfaces.
- **script-src**: every page built here ships a sha256 of each of its own inline
  scripts, so the enforced policy names each inline script by hash instead of
  trusting inline code as a class. `'unsafe-inline'` is gone from this directive
  as of 2026-08-16; it rode along in a report-only twin for the two weeks it took
  to prove itself against real browsers. The style directive keeps
  `'unsafe-inline'` and will, because the CSS here is inline by design, so this is
  protection against script injection and not against style injection.
- **... and what it lets through**: hashing inline scripts says nothing about
  scripts loaded by `src` from this origin, which `'self'` permits. That is not
  hypothetical here: since 2026-08-06 the edge injects `/.webmcp/bridge.js` into
  every page after this worker is done, so the strictest policy this site can
  currently ship still admits 47KB of code the repository does not contain. Named
  rather than buried, because a page about guarantees should say where they stop;
  details at <https://aadhar.sh/whoareyou.md>.
- **Permissions-Policy**: camera, microphone, geolocation, USB, Topics and 10
  more, all denied.
- **X-Frame-Options**: `DENY`.
- **X-Content-Type-Options**: `nosniff`.
- **Referrer-Policy**: `strict-origin-when-cross-origin`.
- **DNSSEC**: signed (ECDSAP256SHA256, DS at the registrar).
- **Content Signals**: search, ai-input, ai-train, all yes, deliberately open.

Read-only, nothing logged or stored. <https://aadhar.sh/whoareyou.md> covers
what your specific request revealed.
