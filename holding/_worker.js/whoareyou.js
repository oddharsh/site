// whoareyou.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { BOT_UA } from "./lib/botauth.js";
import { xpChromeCss } from "./lib/chrome.js";
import { esc } from "./lib/http.js";

// ── /whoareyou handler ───────────────────────────────────────────────
// shows the visitor what their HTTP request revealed. no logging, no
// storage. one server-side outbound call to ARIN's RDAP service to
// enrich the IP with its registration metadata (network name, owner,
// CIDR) — the visitor's browser never speaks to a third party. RDAP
// results are CF-edge-cached by URL for 24h so visitors from the same
// IP block don't re-hit ARIN.

// RDAP returns the registered owner of the IP block — often more
// specific than the ASN's operator (e.g. "Columbia University" rather
// than the upstream ISP). ARIN's endpoint handles IANA-bootstrap
// redirects to whichever RIR is authoritative for the queried IP, so
// one URL works for all five RIRs as long as we follow redirects.
export async function fetchRdap(ip) {
  if (!ip || ip === "—") return null;
  // basic shape check to avoid sending garbage to ARIN
  if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  try {
    const res = await fetch(`https://rdap.arin.net/registry/ip/${encodeURIComponent(ip)}`, {
      headers: {
        "user-agent": BOT_UA,                 // identifies as AadharshBot
        "accept":     "application/rdap+json",
      },
      redirect: "follow",
      cf: { cacheTtl: 86400, cacheEverything: true },  // 24h CF edge cache, keyed by URL
    });
    if (!res.ok) return null;
    const data = await res.json();

    // network name — short identifier for the allocated block (e.g.
    // "COMCAST-1", "COLUMBIA-UNIV"). `handle` falls back to ARIN's
    // internal NET- handle if `name` isn't populated.
    const networkName = data.name || data.handle || null;

    // CIDR — prefer the structured cidr0_cidrs[0]; otherwise compose
    // from startAddress/endAddress (less precise but always present).
    let cidr = null;
    const c = Array.isArray(data.cidr0_cidrs) ? data.cidr0_cidrs[0] : null;
    if (c) {
      const prefix = c.v4prefix || c.v6prefix;
      if (prefix && typeof c.length === "number") cidr = `${prefix}/${c.length}`;
    }
    if (!cidr && data.startAddress && data.endAddress) {
      cidr = `${data.startAddress} – ${data.endAddress}`;
    }

    // registered owner — pulled from the entity with role "registrant".
    // RDAP encodes entity contact info as a vCard 4.0 jCard structure;
    // the "fn" (formatted name) property is the human-readable owner.
    let owner = null;
    const registrant = (data.entities || []).find(e =>
      Array.isArray(e.roles) && e.roles.includes("registrant")
    );
    const vcard = registrant?.vcardArray;
    if (Array.isArray(vcard) && Array.isArray(vcard[1])) {
      const fn = vcard[1].find(v => Array.isArray(v) && v[0] === "fn");
      if (fn && typeof fn[3] === "string") owner = fn[3];
    }

    // events — registration date + last changed are most interesting.
    const events = Array.isArray(data.events) ? data.events : [];
    const regEvent = events.find(e => e.eventAction === "registration");
    const lastChanged = events.find(e => e.eventAction === "last changed");

    // allocation type — "DIRECT ASSIGNMENT", "REASSIGNED", "ALLOCATED PORTABLE", etc.
    const allocType = data.type || null;

    return {
      networkName,
      owner,
      cidr,
      allocType,
      registered:  regEvent?.eventDate || null,
      lastChanged: lastChanged?.eventDate || null,
    };
  } catch (_e) {
    return null;
  }
}

// gather everything one HTTP request revealed: the cf.* edge signals, the
// request headers, a parsed UA, and the (optional, cached) RDAP enrichment.
// shared by the /whoareyou page and the /whoareyou.json popout feed.
export async function gatherWhoareyou(request) {
  const cf = request.cf || {};
  const h  = request.headers;

  const bm = cf.botManagement || {};
  const data = {
    ip:             h.get("cf-connecting-ip") || "—",
    asn:            cf.asn || "—",
    asOrg:          cf.asOrganization || "—",
    country:        cf.country || "??",
    continent:      cf.continent || "—",
    isEU:           cf.isEUCountry === "1" || cf.isEUCountry === true,
    region:         cf.region || "—",
    city:           cf.city || "—",
    postalCode:     cf.postalCode || "—",
    latitude:       cf.latitude || null,
    longitude:      cf.longitude || null,
    timezone:       cf.timezone || "—",
    colo:           cf.colo || "—",
    clientTcpRtt:   cf.clientTcpRtt ?? null,
    httpProtocol:   cf.httpProtocol || "—",
    tlsVersion:     cf.tlsVersion || "—",
    tlsCipher:      cf.tlsCipher || "—",
    acceptEncoding: h.get("accept-encoding") || "—",
    userAgent:      h.get("user-agent") || "—",
    acceptLanguage: h.get("accept-language") || "—",
    dnt:            h.get("dnt") === "1" ? "set (1)" : "not set",
    referer:        h.get("referer") || "(none)",
    cookies:        h.get("cookie") ? "present" : "none",
    botScore:       bm.score ?? null,
    verifiedBot:    bm.verifiedBot ?? false,
    detectionIds:   bm.detectionIds || null,
    corporateProxy: bm.corporateProxy ?? null,
    ja3Hash:        bm.ja3Hash || null,
    ja4:            bm.ja4 || null,
    when:           new Date().toISOString(),
  };

  const ua = parseUA(data.userAgent);

  // RDAP enrichment — server-side only, never blocks rendering if it
  // fails or times out (the page renders fine without these fields).
  const rdap = await fetchRdap(data.ip);

  return { data, ua, rdap };
}

// the fields-only model behind the System Properties views. values are plain
// strings; extra detail that is itself DATA (continent, allocation type,
// last-changed date, QUIC) rides inline. pure explanation (what a field means,
// why it matters) is omitted — the popout shows fields, the page carries prose.
export function buildWhoareyouGroups(data, ua, rdap) {
  const net = [
    { k: "IP address", v: data.ip },
    { k: "ISP / ASN", v: `${data.asOrg} (AS${data.asn})` },
    rdap && rdap.owner ? { k: "Registered to", v: rdap.owner } : null,
    rdap && rdap.networkName ? { k: "Network name", v: rdap.networkName + (rdap.allocType ? ` (${rdap.allocType.toLowerCase()})` : "") } : null,
    rdap && rdap.cidr ? { k: "Allocated range", v: rdap.cidr } : null,
    rdap && rdap.registered ? { k: "Block registered", v: rdap.registered.slice(0, 10) + (rdap.lastChanged && rdap.lastChanged.slice(0, 10) !== rdap.registered.slice(0, 10) ? ` (changed ${rdap.lastChanged.slice(0, 10)})` : "") } : null,
    { k: "Country", v: data.country + (data.continent !== "—" ? ` (${data.continent}${data.isEU ? ", EU" : ""})` : "") },
    { k: "Region", v: data.region },
    { k: "City", v: data.city + (data.postalCode !== "—" ? ` (${data.postalCode})` : "") },
    { k: "Timezone", v: data.timezone },
    data.latitude ? { k: "Approx. coords", v: `${data.latitude}, ${data.longitude}` } : null,
    { k: "Cloudflare colo", v: data.colo },
    data.clientTcpRtt !== null ? { k: "TCP round-trip", v: `${data.clientTcpRtt} ms` } : null,
  ];
  const transport = [
    { k: "HTTP version", v: data.httpProtocol + (data.httpProtocol === "HTTP/3" ? " (over QUIC)" : "") },
    { k: "TLS version", v: data.tlsVersion },
    { k: "TLS cipher", v: data.tlsCipher },
    { k: "Accept-Encoding", v: data.acceptEncoding },
    data.ja3Hash ? { k: "JA3", v: data.ja3Hash } : null,
    data.ja4 ? { k: "JA4", v: data.ja4 } : null,
  ];
  const computer = [
    { k: "Best guess", v: `${ua.browser} on ${ua.os} ${ua.device}` },
    { k: "User agent", v: data.userAgent, mono: true },
    { k: "Languages", v: data.acceptLanguage },
    { k: "Do-not-track", v: data.dnt },
  ];
  const session = [
    { k: "Received at", v: data.when },
    { k: "Referrer", v: data.referer },
    { k: "Cookies sent", v: data.cookies },
    data.botScore !== null ? { k: "CF bot score", v: `${data.botScore} / 99` } : null,
    data.verifiedBot ? { k: "Verified bot", v: "yes" } : null,
    data.corporateProxy ? { k: "Corporate proxy", v: "detected" } : null,
  ];
  return [
    { title: "Network adapter", fields: net.filter(Boolean) },
    { title: "Transport & security", fields: transport.filter(Boolean) },
    { title: "Computer", fields: computer.filter(Boolean) },
    { title: "This session", fields: session.filter(Boolean) },
  ];
}

export async function handleWhoareyouJson(request) {
  const { data, ua, rdap } = await gatherWhoareyou(request);
  const body = JSON.stringify({ groups: buildWhoareyouGroups(data, ua, rdap) });
  return new Response(body, {
    headers: {
      "content-type":    "application/json; charset=utf-8",
      "cache-control":   "no-store, must-revalidate",
      "x-robots-tag":    "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

export async function handleWhoareyou(request) {
  const { data, ua, rdap } = await gatherWhoareyou(request);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>System Properties · aadhar.sh/whoareyou</title>
<meta name="description" content="what one HTTP request to aadhar.sh reveals about you. read-only, never stored.">
<meta name="robots" content="noindex">
<style>
/* ─── /whoareyou, circa 2003 ──────────────────────────────────────────
   matches the holding page chrome: light-blue gradient body, white
   window panel, fake XP title bar, verdana body, trebuchet headings,
   beveled data tables that feel like a Windows properties dialog.
   ────────────────────────────────────────────────────────────────── */

${xpChromeCss(720)}
/* whoareyou-specific title-bar extras: the title text flexes to fill,
   and the boxed _ □ × controls get a touch more letter-spacing. */
.title-bar .title-text { flex: 1; padding-left: 4px; }
.title-bar .controls { letter-spacing: 2px; font-family: Tahoma, Verdana, Geneva, sans-serif; font-size: 9pt; }

h1 {
  font-family: "Trebuchet MS", Verdana, Geneva, sans-serif;
  font-size: 14pt;
  color: oklch(41.92% 0.0962 250.51);
  margin: 0 0 4px;
  font-weight: bold;
  letter-spacing: -0.01em;
}
h2 {
  font-family: "Trebuchet MS", Verdana, Geneva, sans-serif;
  font-size: 12pt;
  color: oklch(41.92% 0.0962 250.51);
  margin: 18px 0 6px;
  font-weight: bold;
  line-height: 1.3;
  /* the rule lives on a ::after pseudo with an explicit margin-top
     rather than border-bottom + padding-bottom. Safari's font-metric
     rounding leaves Trebuchet's "g"/"y" descenders kissing the rule
     even at 6-8px padding; a block-level pseudo with margin-top sits
     a fixed distance below the line-box and is immune to that. */
}
h2::after {
  content: "";
  display: block;
  height: 1px;
  background: oklch(86.67% 0.0294 259.59);
  margin-top: 8px;
}

.lede { margin: 0 0 14px; color: oklch(38.67% 0 0); font-size: 10.5pt; }
p { margin: 0 0 12px; }
ul { margin: 0 0 12px 22px; padding: 0; }
li { margin-bottom: 4px; }

a:link    { color: oklch(42.61% 0.2353 263.74); text-decoration: underline; }
a:visited { color: oklch(42.09% 0.1935 328.36); }
a:hover   { color: oklch(62.80% 0.2577 29.23); }
a:active  { color: oklch(62.80% 0.2577 29.23); }

hr {
  border: 0;
  border-top: 2px groove oklch(86.67% 0.0294 259.59);
  margin: 16px 0;
  height: 0;
}

code, .mono {
  font-family: "Courier New", Courier, monospace;
  font-size: 10pt;
  background: oklch(96.72% 0 0);
  border: 1px solid oklch(88.22% 0 0);
  padding: 0 3px;
}

/* properties-dialog field grid — inset bevel like a Windows form */
.field-grid {
  display: grid;
  grid-template-columns: 14em 1fr;
  gap: 1px;
  margin: 4px 0 14px;
  background: oklch(85.04% 0.0283 248.16);
  border: 1px solid oklch(61.14% 0.0611 253.60);
  border-top-color: oklch(47.12% 0.0555 253.58);
  border-left-color: oklch(47.12% 0.0555 253.58);
  font-size: 10pt;
}
.field-grid dt {
  background: oklch(94.66% 0.0114 252.09);
  color: oklch(41.92% 0.0962 250.51);
  font-weight: bold;
  padding: 4px 8px;
  font-family: Tahoma, Verdana, Geneva, sans-serif;
}
.field-grid dd {
  background: oklch(100.00% 0 0);
  margin: 0;
  padding: 4px 8px;
  font-family: "Courier New", Courier, monospace;
  font-size: 9.5pt;
  word-break: break-all;
  color: oklch(21.78% 0 0);
}
.field-grid dd .dim { color: oklch(62.68% 0 0); font-family: Tahoma, Verdana, Geneva, sans-serif; font-size: 9pt; }
.field-grid dd.muted { color: oklch(44.95% 0 0); }

/* little raised "pill" — looks like a tiny 3D button */
.pill {
  display: inline-block;
  padding: 0 5px;
  border: 1px solid oklch(61.14% 0.0611 253.60);
  background: oklch(94.66% 0.0114 252.09);
  color: oklch(41.92% 0.0962 250.51);
  font-family: Tahoma, Verdana, Geneva, sans-serif;
  font-size: 8.5pt;
  font-weight: bold;
  margin-right: 4px;
  border-radius: 2px;
}

/* info callout — beveled like a Windows information dialog */
.callout {
  border: 1px solid oklch(61.14% 0.0611 253.60);
  background: oklch(98.81% 0.0263 99.90);
  padding: 8px 12px;
  margin: 14px 0;
  font-size: 10pt;
  box-shadow: 1px 1px 0 oklch(61.14% 0.0611 253.60 / 0.3);
}
.callout::before {
  content: "ⓘ ";
  color: oklch(41.92% 0.0962 250.51);
  font-weight: bold;
}

/* footer */
footer {
  text-align: center;
  font-family: Tahoma, Verdana, Geneva, sans-serif;
  font-size: 9pt;
  color: oklch(44.95% 0 0);
  margin: 18px 0 0;
  padding-top: 14px;
  border-top: 1px solid oklch(86.67% 0.0294 259.59);
}
footer .signature { font-style: italic; margin-top: 4px; }
footer .signature small { color: oklch(56.93% 0 0); }
</style>
</head>
<body>

<div class="window">

  <div class="title-bar">
    <span class="title-text"><span class="icon"></span>System Properties</span>
    <span class="controls"><span class="min" aria-hidden="true"></span><span class="max" aria-hidden="true"></span><a class="close" href="/" title="back to aadhar.sh" aria-label="back to aadhar.sh"></a></span>
  </div>

  <div class="content">

    <h1>System Properties</h1>
    <p class="lede">
      Your machine as the edge sees it: everything one HTTP request from your browser
      revealed to this site. None of it is logged, none of it is stored. Close this tab and it's gone.
    </p>

    <div style="border:1px solid #9aa7bd;background:#fff;box-shadow:inset 1px 1px 0 #eef2f8;margin:8px 0 2px">
      <div style="background:linear-gradient(#fbfdff,#eaf0f9);border-bottom:1px solid #cfd8e6;padding:5px 9px;font-weight:bold;color:#0a246a">🖥 Device Manager &middot; this connection</div>
      <ul style="list-style:none;margin:0;padding:7px 12px;line-height:1.95;font-size:9.5pt">
        <li>🖧 <b>Network adapter</b> &nbsp;Anycast edge, colo <b>${esc(data.colo)}</b> <span class="dim">(${esc(data.asOrg)}, AS${esc(data.asn)})</span></li>
        <li>🔒 <b>Security coprocessor</b> &nbsp;<b>${esc(data.tlsVersion)}</b> <span class="dim">${esc(data.tlsCipher)}</span></li>
        <li>🌐 <b>Transport</b> &nbsp;<b>${esc(data.httpProtocol)}</b>${data.httpProtocol === "HTTP/3" ? ` <span class="dim">over QUIC</span>` : ""}</li>
        <li>🌍 <b>Region</b> &nbsp;${esc(data.city)}, ${esc(data.country)} <span class="dim">(${esc(data.timezone)})</span></li>
        <li>🖥 <b>Client</b> &nbsp;${esc(ua.browser)} on ${esc(ua.os)} <span class="dim">${esc(ua.device)}</span></li>
      </ul>
      <div style="border-top:1px solid #cfd8e6;padding:5px 10px;font-size:8.5pt;color:#6b7280">What guards all this: <a href="/security">Security Center</a></div>
    </div>

    <hr>

    <h2>Network adapter</h2>
    <dl class="field-grid">
      <dt>IP address</dt>           <dd>${esc(data.ip)}</dd>
      <dt>ISP / ASN</dt>            <dd>${esc(data.asOrg)} (AS${esc(data.asn)})</dd>
      ${rdap?.owner ? `<dt>Registered to</dt>       <dd>${esc(rdap.owner)} <span class="dim">(per RDAP, usually more specific than the ASN operator)</span></dd>` : ""}
      ${rdap?.networkName ? `<dt>Network name</dt>        <dd>${esc(rdap.networkName)}${rdap.allocType ? ` <span class="dim">(${esc(rdap.allocType.toLowerCase())})</span>` : ""}</dd>` : ""}
      ${rdap?.cidr ? `<dt>Allocated range</dt>     <dd>${esc(rdap.cidr)}</dd>` : ""}
      ${rdap?.registered ? `<dt>Block registered</dt>    <dd>${esc(rdap.registered.slice(0, 10))}${rdap.lastChanged && rdap.lastChanged.slice(0,10) !== rdap.registered.slice(0,10) ? ` <span class="dim">(last changed ${esc(rdap.lastChanged.slice(0, 10))})</span>` : ""}</dd>` : ""}
      <dt>Country</dt>              <dd>${esc(data.country)}${data.continent !== "—" ? ` <span class="dim">(${esc(data.continent)}${data.isEU ? ", EU" : ""})</span>` : ""}</dd>
      <dt>Region</dt>               <dd>${esc(data.region)}</dd>
      <dt>City</dt>                 <dd>${esc(data.city)} ${data.postalCode !== "—" ? `(${esc(data.postalCode)})` : ""}</dd>
      <dt>Timezone</dt>             <dd>${esc(data.timezone)}</dd>
      ${data.latitude ? `<dt>Approx. coords</dt><dd>${esc(data.latitude)}, ${esc(data.longitude)} <a href="https://www.openstreetmap.org/?mlat=${data.latitude}&mlon=${data.longitude}&zoom=10" target="_blank" rel="noopener">(see on map)</a></dd>` : ""}
      <dt>Cloudflare colo</dt>      <dd>${esc(data.colo)} <span class="dim">(nearest CF data center serving you)</span></dd>
      ${data.clientTcpRtt !== null ? `<dt>TCP round-trip</dt><dd>${esc(data.clientTcpRtt)} ms</dd>` : ""}
    </dl>

    <h2>Transport and security</h2>
    <dl class="field-grid">
      <dt>HTTP version</dt>         <dd>${esc(data.httpProtocol)} ${data.httpProtocol === "HTTP/3" ? `<span class="pill">over QUIC</span>` : ""}</dd>
      <dt>TLS version</dt>          <dd>${esc(data.tlsVersion)}</dd>
      <dt>TLS cipher</dt>           <dd>${esc(data.tlsCipher)}</dd>
      <dt>Accept-Encoding</dt>      <dd>${esc(data.acceptEncoding)}</dd>
      ${data.ja3Hash ? `<dt>JA3 fingerprint</dt><dd>${esc(data.ja3Hash)} <span class="dim">(TLS ClientHello hash)</span></dd>` : ""}
      ${data.ja4 ? `<dt>JA4 fingerprint</dt><dd>${esc(data.ja4)}</dd>` : ""}
    </dl>

    <h2>Computer</h2>
    <dl class="field-grid">
      <dt>Best guess</dt>           <dd>${esc(ua.browser)} on ${esc(ua.os)} ${esc(ua.device)}</dd>
      <dt>User agent</dt>           <dd class="muted">${esc(data.userAgent)}</dd>
      <dt>Languages</dt>            <dd>${esc(data.acceptLanguage)}</dd>
      <dt>Do-not-track</dt>         <dd>${esc(data.dnt)}</dd>
    </dl>

    <h2>This session</h2>
    <dl class="field-grid">
      <dt>Received at</dt>          <dd>${esc(data.when)}</dd>
      <dt>Referrer</dt>             <dd>${esc(data.referer)}</dd>
      <dt>Cookies sent</dt>         <dd>${esc(data.cookies)}</dd>
      ${data.botScore !== null ? `<dt>CF bot score</dt><dd>${esc(data.botScore)} / 99 <span class="dim">(higher = more human-like)</span></dd>` : ""}
      ${data.detectionIds ? `<dt>Bot detection IDs</dt><dd class="muted">${esc(JSON.stringify(data.detectionIds))}</dd>` : ""}
      ${data.corporateProxy ? `<dt>Corporate proxy</dt><dd>detected</dd>` : ""}
      ${data.verifiedBot ? `<dt>Verified bot</dt><dd>yes <span class="pill">CF-signed</span></dd>` : ""}
    </dl>

    <hr>

    <h2>What I Can't See</h2>
    <ul>
      <li><strong>Your DNS resolver or protocol.</strong> Your resolver answers the name before the request reaches this site, so I only see the IP that connected. HTTP/3 implies a modern network stack that <em>probably</em> speaks DoH, though I can only infer that; the request itself never carries your resolver.</li>
      <li><strong>Your real identity</strong> unless you've told me. An IP isn't a name.</li>
      <li><strong>The rest of your browsing.</strong> I see this one request, nothing else.</li>
      <li><strong>The contents of any encrypted data</strong> outside this HTTP session. TLS is doing its job.</li>
    </ul>

    <h2>Want This To Leak Less?</h2>
    <ul>
      <li><strong>Use a VPN or Tor.</strong> Either one changes your IP, ASN, and geo. Tor also anonymizes most fingerprintable details.</li>
      <li><strong>Use a private browsing window.</strong> It drops cookies and language hints, somewhat.</li>
      <li><strong>Set <code>DNT: 1</code></strong> or use a browser that does. Almost no servers honor it, though it's still a signal.</li>
      <li><strong>Strip the user-agent.</strong> Some browsers and extensions let you fake or hide it, which shrinks your fingerprinting surface.</li>
    </ul>

    <div class="callout">
      <strong>About this page:</strong> The Cloudflare edge renders it. Your
      browser never speaks to a third party. The only outbound call is one
      server-side RDAP lookup to your IP's registry, which the edge caches for
      24h so visitors from the same block don't re-hit ARIN. No analytics. The
      data above lives for one HTTP request, then nothing writes
      it to storage. View-source if you want, since it's a single JavaScript file
      you can read end-to-end.
    </div>

    <footer>
      <p>
        &larr; Back to <a href="/">aadhar.sh</a>
        &middot; Built as a Cloudflare Pages worker
      </p>
      <p class="signature">
        <small>&copy; 2026 Aadharsh Pannirselvam &middot; Best viewed in any browser made since 2001.</small>
      </p>
    </footer>

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

// ── helpers ──────────────────────────────────────────────────────────
export function parseUA(ua) {
  const browser =
    /Edg\//.test(ua)             ? "Edge"    :
    /OPR\//.test(ua)             ? "Opera"   :
    /Firefox\//.test(ua)         ? "Firefox" :
    /Chrome\//.test(ua)          ? "Chrome"  :
    /Safari\//.test(ua)          ? "Safari"  :
    /curl/.test(ua)              ? "curl"    :
    /bot|spider|crawl/i.test(ua) ? "a bot"   : "an unknown browser";
  const os =
    /iPhone|iPad/.test(ua)       ? "iOS"     :
    /Android/.test(ua)           ? "Android" :
    /Mac OS X/.test(ua)          ? "macOS"   :
    /Windows/.test(ua)           ? "Windows" :
    /Linux/.test(ua)             ? "Linux"   : "an unknown OS";
  const device =
    /iPhone/.test(ua)            ? "(iPhone)" :
    /iPad/.test(ua)              ? "(iPad)"   :
    /Mobile/.test(ua)            ? "(mobile)" : "";
  return { browser, os, device };
}
