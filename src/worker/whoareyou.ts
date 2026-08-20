// whoareyou.js — extracted from the worker (no-build reorg). Bundled by
// wrangler/Cloudflare at deploy; not served (inside _worker.js/).
import { serveMarkdownTwin } from "./lib/assets.ts";
import { BOT_UA } from "./lib/botauth.ts";
import { deadline } from "./lib/cache.ts";
import { lunaPage } from "./lib/chrome.ts";
import { esc, wantsMarkdown } from "./lib/http.ts";
import { asNumber, asRecord, asText } from "./lib/parse.ts";

const RDAP_BUDGET_MS = 250;

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
      // cap the enrichment: a slow/unreachable RIR must not block the page.
      // on abort the catch below returns null and the page renders without the
      // optional owner/CIDR/registration lines (they refill once the 24h edge
      // cache warms). RDAP is non-essential enrichment, so 2s is deliberate.
      signal: AbortSignal.timeout(2000),
      cf: { cacheTtl: 86400, cacheEverything: true },  // 24h CF edge cache, keyed by URL
    });
    if (!res.ok) return null;
    const data = asRecord(await res.json());
    if (!data) return null;

    // network name — short identifier for the allocated block (e.g.
    // "COMCAST-1", "COLUMBIA-UNIV"). `handle` falls back to ARIN's
    // internal NET- handle if `name` isn't populated.
    const networkName = asText(data.name) || asText(data.handle) || null;

    // CIDR — prefer the structured cidr0_cidrs[0]; otherwise compose
    // from startAddress/endAddress (less precise but always present).
    let cidr = null;
    const c = asRecord(Array.isArray(data.cidr0_cidrs) ? data.cidr0_cidrs[0] : null);
    if (c) {
      const prefix = asText(c.v4prefix) || asText(c.v6prefix);
      if (prefix && asNumber(c.length) !== null) cidr = `${prefix}/${c.length}`;
    }
    const startAddress = asText(data.startAddress);
    const endAddress = asText(data.endAddress);
    if (!cidr && startAddress && endAddress) {
      cidr = `${startAddress} – ${endAddress}`;
    }

    // registered owner — pulled from the entity with role "registrant".
    // RDAP encodes entity contact info as a vCard 4.0 jCard structure;
    // the "fn" (formatted name) property is the human-readable owner.
    let owner = null;
    const entities = Array.isArray(data.entities) ? data.entities.map(asRecord).filter(Boolean) : [];
    const registrant = entities.find((entity) =>
      Array.isArray(entity.roles) && entity.roles.includes("registrant")
    );
    const vcard = registrant?.vcardArray;
    if (Array.isArray(vcard) && Array.isArray(vcard[1])) {
      const fn = vcard[1].find(v => Array.isArray(v) && v[0] === "fn");
      if (fn && asText(fn[3]) !== null) owner = asText(fn[3]);
    }

    // events — registration date + last changed are most interesting.
    const events = Array.isArray(data.events) ? data.events.map(asRecord).filter(Boolean) : [];
    const regEvent = events.find((event) => event.eventAction === "registration");
    const lastChanged = events.find((event) => event.eventAction === "last changed");

    // allocation type — "DIRECT ASSIGNMENT", "REASSIGNED", "ALLOCATED PORTABLE", etc.
    const allocType = asText(data.type);

    return {
      networkName,
      owner,
      cidr,
      allocType,
      registered:  asText(regEvent?.eventDate),
      lastChanged: asText(lastChanged?.eventDate),
    };
  } catch (_e) {
    return null;
  }
}

// gather everything one HTTP request revealed: the cf.* edge signals, the
// request headers, a parsed UA, and the (optional, cached) RDAP enrichment.
// shared by the /whoareyou page and the /whoareyou.json popout feed.
export async function gatherWhoareyou(request, ctx) {
  const cf = request.cf || {};
  const h  = request.headers;
  const url = new URL(request.url);

  const bm = cf.botManagement || {};
  const data = {
    host:           url.hostname,
    scheme:         url.protocol.replace(":", ""),
    ray:            h.get("cf-ray") || "—",
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
    // QUIC's counterpart to clientTcpRtt: only populated on HTTP/3, so the two
    // are mutually exclusive and together they always name the transport.
    clientQuicRtt:  cf.clientQuicRtt ?? null,
    deliveryRate:   cf.edgeL4?.deliveryRate ?? null,
    requestPriority: cf.requestPriority || null,
    httpProtocol:   cf.httpProtocol || "—",
    tlsVersion:     cf.tlsVersion || "—",
    tlsCipher:      cf.tlsCipher || "—",
    tlsExtensions:  cf.tlsClientExtensionsSha1 || null,
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

  // RDAP enrichment is optional. Give a warm edge-cached response a short place
  // on the critical path, then render without it while the same read finishes in
  // the background and warms the colo. fetchRdap's own 2s abort remains the
  // outer bound; a cold or unreachable RIR no longer makes the page pay it.
  let rdapTimedOut = false;
  const rdapRead = fetchRdap(data.ip);
  const rdap = await deadline(rdapRead, RDAP_BUDGET_MS, null, () => { rdapTimedOut = true; });
  if (rdapTimedOut) {
    if (ctx) ctx.waitUntil(rdapRead);
    else void rdapRead;
  }

  return { data, ua, rdap };
}

// the fields-only model behind the System Properties views. values are plain
// strings; extra detail that is itself DATA (continent, allocation type,
// last-changed date, QUIC) rides inline. pure explanation (what a field means,
// why it matters) is omitted — the popout shows fields, the page carries prose.
export function buildWhoareyouGroups(data, ua, rdap, version) {
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
    data.clientQuicRtt !== null ? { k: "QUIC round-trip", v: `${data.clientQuicRtt} ms` } : null,
    data.deliveryRate !== null ? { k: "Delivery rate", v: `${data.deliveryRate} B/s` } : null,
  ];
  const transport = [
    { k: "Host asked for", v: `${data.scheme}://${data.host}` },
    { k: "HTTP version", v: data.httpProtocol + (data.httpProtocol === "HTTP/3" ? " (over QUIC)" : "") },
    { k: "TLS version", v: data.tlsVersion },
    { k: "TLS cipher", v: data.tlsCipher },
    { k: "Accept-Encoding", v: data.acceptEncoding },
    data.requestPriority ? { k: "Stream priority", v: data.requestPriority } : null,
    data.ja3Hash ? { k: "JA3", v: data.ja3Hash } : null,
    data.ja4 ? { k: "JA4", v: data.ja4 } : null,
    data.tlsExtensions ? { k: "TLS extensions hash", v: data.tlsExtensions } : null,
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
    { k: "Cloudflare ray", v: data.ray },
  ];
  // NOTE: the edge-trace fields (sni/warp/gateway/rbi/kex/sliver) are absent
  // here on purpose. They exist only in Cloudflare's /cdn-cgi/trace response
  // and are not exposed on request.cf, so the worker genuinely cannot know
  // them. The page fills them in the browser; this JSON feed is server-rendered
  // and would have to invent them, so it says nothing instead.
  // The one field here that describes the SERVER rather than the caller, and it
  // is here because "what does one request reveal" honestly includes which build
  // answered it. During a gradual deployment two versions serve this route at
  // once, so an outside prober polling this feed is how a ramp gets verified from
  // the outside: `no-store` below means every poll re-runs the worker and reports
  // the version that actually handled it. That is why the canary sampler in
  // tools/deploy-promote.mjs reads THIS route rather than /updates.json, which
  // reports the D1 changelog both versions share and so cannot tell them apart.
  //
  // Omitted entirely when unbound (local dev, the contract tests) rather than
  // filled with a placeholder, same nullable discipline as the photo pipeline.
  const server = version ? [{ k: "Serving version", v: version, mono: true }] : [];

  return [
    { title: "Network adapter", fields: net.filter(Boolean) },
    { title: "Transport & security", fields: transport.filter(Boolean) },
    { title: "Computer", fields: computer.filter(Boolean) },
    { title: "This session", fields: session.filter(Boolean) },
    ...(server.length ? [{ title: "Server", fields: server }] : []),
  ];
}

export async function handleWhoareyouJson(request, env, ctx) {
  const { data, ua, rdap } = await gatherWhoareyou(request, ctx);
  const version = env?.CF_VERSION_METADATA?.id;
  const body = JSON.stringify({ groups: buildWhoareyouGroups(data, ua, rdap, version) });
  return new Response(body, {
    headers: {
      "content-type":    "application/json; charset=utf-8",
      "cache-control":   "no-store, must-revalidate",
      "x-robots-tag":    "noindex",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

export async function handleWhoareyou(request, env, ctx) {
  // The twin DESCRIBES this page rather than mirroring it: every value here is
  // per-request, so there is nothing fixed to publish. An agent that wants the
  // actual values for its own request should GET /whoareyou.json, which the twin
  // points at. Markdown negotiation is still worth answering, because "what does
  // this page tell you about yourself" is a question worth reading in prose.
  if (wantsMarkdown(request)) {
    const md = await serveMarkdownTwin(request, env, "/whoareyou.md");
    if (md) return md;
  }

  const { data, ua, rdap } = await gatherWhoareyou(request, ctx);

  return lunaPage({
    title: "System Properties · aadhar.sh/whoareyou",
    path: "System Properties",
    route: "/whoareyou",
    width: 720,
    description: "what one HTTP request to aadhar.sh reveals about you. read-only, never stored.",
    robots: "noindex",
    css: `
/* ─── /whoareyou, circa 2003 ──────────────────────────────────────────
   matches the holding page chrome: light-blue gradient body, white
   window panel, fake XP title bar, verdana body, trebuchet headings,
   beveled data tables that feel like a Windows properties dialog.
   ────────────────────────────────────────────────────────────────── */

/* whoareyou-specific title-bar extra: the boxed _ □ × controls get a touch
   more letter-spacing. (title flex comes from xpChromeCss site-wide.) */
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
`,
    body: `

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
      ${data.clientQuicRtt !== null ? `<dt>QUIC round-trip</dt><dd>${esc(data.clientQuicRtt)} ms <span class="dim">(only set on HTTP/3, so it and the TCP row never both appear)</span></dd>` : ""}
      ${data.deliveryRate !== null ? `<dt>Delivery rate</dt><dd>${esc(data.deliveryRate)} B/s <span class="dim">(most recent edge estimate for this connection)</span></dd>` : ""}
    </dl>

    <h2>Transport and security</h2>
    <dl class="field-grid">
      <dt>HTTP version</dt>         <dd>${esc(data.httpProtocol)} ${data.httpProtocol === "HTTP/3" ? `<span class="pill">over QUIC</span>` : ""}</dd>
      <dt>TLS version</dt>          <dd>${esc(data.tlsVersion)}</dd>
      <dt>TLS cipher</dt>           <dd>${esc(data.tlsCipher)}</dd>
      <dt>Accept-Encoding</dt>      <dd>${esc(data.acceptEncoding)}</dd>
      ${data.requestPriority ? `<dt>Stream priority</dt><dd class="muted">${esc(data.requestPriority)}</dd>` : ""}
      ${data.ja3Hash ? `<dt>JA3 fingerprint</dt><dd>${esc(data.ja3Hash)} <span class="dim">(TLS ClientHello hash)</span></dd>` : ""}
      ${data.ja4 ? `<dt>JA4 fingerprint</dt><dd>${esc(data.ja4)}</dd>` : ""}
      ${data.tlsExtensions ? `<dt>TLS extensions</dt><dd class="muted">${esc(data.tlsExtensions)} <span class="dim">(SHA-1 of the extension list)</span></dd>` : ""}
    </dl>

    <h2>Edge Trace</h2>
    <p class="lede">Seven things Cloudflare's edge knows about this connection that
    it never tells the worker. <code>request.cf</code> carries geography, TLS
    version and protocol, but not whether your SNI was encrypted, nor whether you
    arrived through WARP. Those live only in
    <a href="/cdn-cgi/trace"><code>/cdn-cgi/trace</code></a>, so this section is
    the one part of the page your browser fetches for itself, from this same
    origin, after the page has loaded.</p>
    <dl class="field-grid" id="trace-grid">
      <dt>Encrypted SNI</dt>        <dd data-trace="sni">…</dd>
      <dt>Key exchange</dt>         <dd data-trace="kex">…</dd>
      <dt>HTTP version seen</dt>    <dd data-trace="http">…</dd>
      <dt>Through WARP</dt>         <dd data-trace="warp">…</dd>
      <dt>Through Zero Trust</dt>   <dd data-trace="gateway">…</dd>
      <dt>Browser isolation</dt>    <dd data-trace="rbi">…</dd>
      <dt>Edge sliver</dt>          <dd data-trace="sliver">…</dd>
    </dl>
    <p class="dim" id="trace-note">Fetching…</p>

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
      <dt>Cloudflare ray</dt>       <dd class="muted">${esc(data.ray)} <span class="dim">(the edge's id for this one request)</span></dd>
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
      browser never speaks to a third party. There are exactly two outbound
      calls: one server-side RDAP lookup to your IP's registry, which the edge
      caches for 24h so visitors from the same block don't re-hit ARIN, and the
      Edge Trace section's fetch of <code>/cdn-cgi/trace</code>, which your own
      browser makes to this same origin because those seven fields are the ones
      the worker is never told. The data above lives for as long as
      it takes to render, then nothing writes it to storage. View-source if you
      want, since it's a single JavaScript file you can read end-to-end.
      <br><br>
      <strong>One script on every page is not mine:</strong> since 2026-08-06 the
      Cloudflare edge injects
      <code>&lt;script type="module" src="/.webmcp/bridge.js"&gt;</code> into every
      HTML document here, after this worker has finished with it. It is 47KB of
      Cloudflare's code, served from this origin, and it is the reason View Source
      shows a tag no file in the repository contains. What it does: if your browser
      implements <code>document.modelContext</code> &mdash; today that means Chrome
      146 with experimental web platform features on &mdash; it reads this site's own
      <a href="/mcp">/mcp</a> server and registers those tools into the page, so an
      agent browsing here can call them instead of scraping. Every other browser,
      which is nearly all of them, downloads it, finds no such API, writes one
      warning to the console, and stops. So the honest description is that most
      visitors pay 47KB for nothing, and the site is betting that changes.
      <br><br>
      <strong>Analytics:</strong> none. No page loads a Web Analytics or RUM beacon,
      and this Worker exposes no browser-timing collector. Page-load timings are not
      sent to Cloudflare.
    </div>

    <footer>
      <p>
        &larr; Back to <a href="/">aadhar.sh</a>
        &middot; Built as a Cloudflare Worker
      </p>
      <p class="signature">
        <small>&copy; 2026 Aadharsh Pannirselvam &middot; Best viewed in any browser made since 2001.</small>
      </p>
    </footer>

`,
    // The one script on the page. It fills the Edge Trace section from
    // /cdn-cgi/trace, which is the only source for those fields: request.cf
    // never carries them, so the worker cannot render them and would have to
    // guess. Same-origin, no third party, and the page states plainly that this
    // second request happens. Failure is reported rather than hidden, because a
    // page whose whole subject is what a request reveals should not quietly
    // show blanks where it could not look.
    scripts: `<script>
(function () {
  var grid = document.getElementById("trace-grid");
  var note = document.getElementById("trace-note");
  if (!grid || !note || !window.fetch) return;
  var PRETTY = { plaintext: "no, sent in the clear", encrypted: "yes (ECH)", off: "no", on: "yes", none: "none" };
  fetch("/cdn-cgi/trace", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
    .then(function (text) {
      var kv = {};
      text.trim().split("\\n").forEach(function (line) {
        var i = line.indexOf("=");
        if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
      });
      var missing = 0;
      grid.querySelectorAll("[data-trace]").forEach(function (cell) {
        var raw = kv[cell.getAttribute("data-trace")];
        if (raw === undefined) { cell.textContent = "not reported"; cell.className = "dim"; missing++; return; }
        cell.textContent = PRETTY[raw] || raw;
      });
      note.textContent = "Read from /cdn-cgi/trace by your browser at " + new Date().toISOString() +
        (missing ? " (" + missing + " field(s) absent from the response)" : "") + ".";
    })
    .catch(function (e) {
      grid.querySelectorAll("[data-trace]").forEach(function (cell) { cell.textContent = "unavailable"; cell.className = "dim"; });
      note.textContent = "Could not reach /cdn-cgi/trace (" + e.message + "), so these seven fields are unknown rather than assumed.";
    });
})();
</script>`,
    cache: "no-store, must-revalidate",
    headers: {
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
