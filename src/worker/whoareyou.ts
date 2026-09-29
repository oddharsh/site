// whoareyou.ts — /whoareyou (System Properties), its values island, and the
// /whoareyou.json feed the tray and the release canary read. Bundled by wrangler.
import { BOT_UA } from "./lib/botauth.ts";
import { deadline } from "./lib/cache.ts";
import { lunaPage } from "./lib/chrome.ts";
import { html, unsafeHtml } from "./lib/html.ts";
import { islandMount, islandPreload, islandResponse, islandScript } from "./lib/island.ts";
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
    // MEASURED 2026-09-21 in Chrome over a real HTTP/3 connection: cf.clientTcpRtt
    // is 0 rather than absent on QUIC, so `?? null` alone rendered "TCP
    // round-trip 0 ms" beside a 40 ms QUIC row on the page whose own copy says
    // the two never both appear. The transport decides which row is real.
    clientTcpRtt:   cf.httpProtocol === "HTTP/3" ? null : (cf.clientTcpRtt ?? null),
    // QUIC's counterpart, and the same bug in the other direction. MEASURED
    // 2026-09-25 over curl on HTTP/2: cf.clientQuicRtt is 0 rather than absent
    // on TCP, so the page showed "QUIC round-trip 0 ms" beside a real 8 ms TCP
    // row. The transport decides here too, which is what finally makes the two
    // mutually exclusive, the way the page's own copy always said they were.
    clientQuicRtt:  cf.httpProtocol === "HTTP/3" ? (cf.clientQuicRtt ?? null) : null,
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
  // tools/deploy-promote.ts reads THIS route rather than /updates.json, which
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

// ── /whoareyou: a built shell and one island ─────────────────────────
// The page rendered per request until 2026-09-25, which cost it everything a
// built document gets: it went out at the edge's roughly-q4 brotli (8,293 B
// against 6,836 B at q11, measured that day), with no dcz delta, no ETag, and
// the loose 'unsafe-inline' script policy every unhashed page falls back to.
// About half the body is fixed prose, so it takes lib/island.ts's shape: the
// document is baked by build.ts step 5b, and the values are a fragment from
// /whoareyou/values.html, fetched once after load by the same request pattern
// the homepage uses for its photo grid.
//
// What moved is worth stating, because this page's subject is what a request
// reveals. The values now describe the FRAGMENT request, which is normally the
// same connection (one IP, one TLS session, one HTTP version) with a slightly
// later clock and its own ray id. The one field that genuinely differs is the
// referrer: the fragment request's Referer is this page, so that row is filled
// in the browser from document.referrer, which is what the browser sent with
// the page request. The callout says all of this in the page's own copy.
export const VALUES_URL = "/whoareyou/values.html";
const PENDING = "…";

// The placeholder model. The same renderer draws the baked placeholder and the
// live fragment, so the swap moves only what the live values add. Optional
// fields a browser visitor normally has (coords, a round-trip, delivery rate,
// stream priority, the TLS extensions hash) are PENDING rather than null, so
// their rows are already standing when the values land. Fields most visitors
// never carry (RDAP until the colo is warm, JA3/JA4, a bot score) stay null.
const PLACEHOLDER_DATA = {
  host: "aadhar.sh", scheme: "https", ray: PENDING, ip: PENDING, asn: PENDING, asOrg: PENDING,
  country: PENDING, continent: "—", isEU: false, region: PENDING, city: PENDING, postalCode: "—",
  latitude: PENDING, longitude: PENDING, timezone: PENDING, colo: PENDING,
  clientTcpRtt: PENDING, clientQuicRtt: null, deliveryRate: PENDING, requestPriority: PENDING,
  httpProtocol: PENDING, tlsVersion: PENDING, tlsCipher: PENDING, tlsExtensions: PENDING,
  acceptEncoding: PENDING, userAgent: PENDING, acceptLanguage: PENDING, dnt: PENDING,
  referer: PENDING, cookies: PENDING, botScore: null, verifiedBot: false, detectionIds: null,
  corporateProxy: null, ja3Hash: null, ja4: null, when: PENDING,
};
const PLACEHOLDER_UA = { browser: PENDING, os: PENDING, device: "" };

const unit = (v, u) => (v === PENDING ? v : `${v} ${u}`);

export function renderWhoareyouValues(data, ua, rdap) {
  const pending = data.ip === PENDING;
  const dim = (text) => html` <span class="dim">(${text})</span>`;
  return html`
    <div style="border:1px solid #9aa7bd;background:#fff;box-shadow:inset 1px 1px 0 #eef2f8;margin:8px 0 2px">
      <div style="background:linear-gradient(#fbfdff,#eaf0f9);border-bottom:1px solid #cfd8e6;padding:5px 9px;font-weight:bold;color:#0a246a">🖥 Device Manager &middot; this connection</div>
      <ul style="list-style:none;margin:0;padding:7px 12px;line-height:1.95;font-size:9.5pt">
        <li>🖧 <b>Network adapter</b> &nbsp;Anycast edge, colo <b>${data.colo}</b> <span class="dim">(${data.asOrg}, AS${data.asn})</span></li>
        <li>🔒 <b>Security coprocessor</b> &nbsp;<b>${data.tlsVersion}</b> <span class="dim">${data.tlsCipher}</span></li>
        <li>🌐 <b>Transport</b> &nbsp;<b>${data.httpProtocol}</b>${data.httpProtocol === "HTTP/3" ? html` <span class="dim">over QUIC</span>` : ""}</li>
        <li>🌍 <b>Region</b> &nbsp;${data.city}, ${data.country} <span class="dim">(${data.timezone})</span></li>
        <li>🖥 <b>Client</b> &nbsp;${ua.browser} on ${ua.os} <span class="dim">${ua.device}</span></li>
      </ul>
      <div style="border-top:1px solid #cfd8e6;padding:5px 10px;font-size:8.5pt;color:#6b7280">What guards all this: <a href="/security">Security Center</a></div>
    </div>

    <hr>

    <h2>Network adapter</h2>
    <dl class="field-grid">
      <dt>IP address</dt>           <dd>${data.ip}</dd>
      <dt>ISP / ASN</dt>            <dd>${data.asOrg} (AS${data.asn})</dd>
      ${rdap?.owner ? html`<dt>Registered to</dt>       <dd>${rdap.owner}${dim("per RDAP, usually more specific than the ASN operator")}</dd>` : ""}
      ${rdap?.networkName ? html`<dt>Network name</dt>        <dd>${rdap.networkName}${rdap.allocType ? dim(rdap.allocType.toLowerCase()) : ""}</dd>` : ""}
      ${rdap?.cidr ? html`<dt>Allocated range</dt>     <dd>${rdap.cidr}</dd>` : ""}
      ${rdap?.registered ? html`<dt>Block registered</dt>    <dd>${rdap.registered.slice(0, 10)}${rdap.lastChanged && rdap.lastChanged.slice(0, 10) !== rdap.registered.slice(0, 10) ? dim(`last changed ${rdap.lastChanged.slice(0, 10)}`) : ""}</dd>` : ""}
      <dt>Country</dt>              <dd>${data.country}${data.continent !== "—" ? dim(`${data.continent}${data.isEU ? ", EU" : ""}`) : ""}</dd>
      <dt>Region</dt>               <dd>${data.region}</dd>
      <dt>City</dt>                 <dd>${data.city} ${data.postalCode !== "—" ? `(${data.postalCode})` : ""}</dd>
      <dt>Timezone</dt>             <dd>${data.timezone}</dd>
      ${data.latitude ? html`<dt>Approx. coords</dt><dd>${data.latitude}, ${data.longitude}${pending ? "" : html` <a href="https://www.openstreetmap.org/?mlat=${data.latitude}&amp;mlon=${data.longitude}&amp;zoom=10" target="_blank" rel="noopener">(see on map)</a>`}</dd>` : ""}
      <dt>Cloudflare colo</dt>      <dd>${data.colo}${dim("nearest CF data center serving you")}</dd>
      ${pending ? html`<dt>Round-trip</dt><dd>${PENDING}</dd>` : ""}
      ${!pending && data.clientTcpRtt !== null ? html`<dt>TCP round-trip</dt><dd>${data.clientTcpRtt} ms</dd>` : ""}
      ${!pending && data.clientQuicRtt !== null ? html`<dt>QUIC round-trip</dt><dd>${data.clientQuicRtt} ms${dim("only set on HTTP/3, so it and the TCP row never both appear")}</dd>` : ""}
      ${data.deliveryRate !== null ? html`<dt>Delivery rate</dt><dd>${unit(data.deliveryRate, "B/s")}${dim("most recent edge estimate for this connection")}</dd>` : ""}
    </dl>

    <h2>Transport and security</h2>
    <dl class="field-grid">
      <dt>HTTP version</dt>         <dd>${data.httpProtocol} ${data.httpProtocol === "HTTP/3" ? html`<span class="pill">over QUIC</span>` : ""}</dd>
      <dt>TLS version</dt>          <dd>${data.tlsVersion}</dd>
      <dt>TLS cipher</dt>           <dd>${data.tlsCipher}</dd>
      <dt>Accept-Encoding</dt>      <dd>${data.acceptEncoding}</dd>
      ${data.requestPriority ? html`<dt>Stream priority</dt><dd class="muted">${data.requestPriority}</dd>` : ""}
      ${data.ja3Hash ? html`<dt>JA3 fingerprint</dt><dd>${data.ja3Hash}${dim("TLS ClientHello hash")}</dd>` : ""}
      ${data.ja4 ? html`<dt>JA4 fingerprint</dt><dd>${data.ja4}</dd>` : ""}
      ${data.tlsExtensions ? html`<dt>TLS extensions</dt><dd class="muted">${data.tlsExtensions}${dim("SHA-1 of the extension list")}</dd>` : ""}
    </dl>

    <h2>Computer</h2>
    <dl class="field-grid">
      <dt>Best guess</dt>           <dd>${ua.browser} on ${ua.os} ${ua.device}</dd>
      <dt>User agent</dt>           <dd class="muted">${data.userAgent}</dd>
      <dt>Languages</dt>            <dd>${data.acceptLanguage}</dd>
      <dt>Do-not-track</dt>         <dd>${data.dnt}</dd>
    </dl>

    <h2>This session</h2>
    <dl class="field-grid">
      <dt>Received at</dt>          <dd>${data.when}${dim("when the edge rendered these values")}</dd>
      <dt>Referrer</dt>             <dd><span data-referrer>${PENDING}</span>${dim("read by your browser from what it sent with this page")}</dd>
      <dt>Cookies sent</dt>         <dd>${data.cookies}</dd>
      <dt>Cloudflare ray</dt>       <dd class="muted">${data.ray}${dim("the edge's id for the request that fetched these values")}</dd>
      ${data.botScore !== null ? html`<dt>CF bot score</dt><dd>${data.botScore} / 99${dim("higher = more human-like")}</dd>` : ""}
      ${data.detectionIds ? html`<dt>Bot detection IDs</dt><dd class="muted">${JSON.stringify(data.detectionIds)}</dd>` : ""}
      ${data.corporateProxy ? html`<dt>Corporate proxy</dt><dd>detected</dd>` : ""}
      ${data.verifiedBot ? html`<dt>Verified bot</dt><dd>yes <span class="pill">CF-signed</span></dd>` : ""}
    </dl>
`;
}

// The island. Everything in it is this one request's, so it is never cached.
export async function handleWhoareyouValues(request, env, ctx) {
  const { data, ua, rdap } = await gatherWhoareyou(request, ctx);
  return islandResponse(renderWhoareyouValues(data, ua, rdap), {
    "referrer-policy": "strict-origin-when-cross-origin",
  });
}

// ── the shell (rendered at BUILD time; see the section header) ────────
export function renderWhoareyouPage() {
  return lunaPage({
    title: "System Properties · aadhar.sh/whoareyou",
    path: "System Properties",
    route: "/whoareyou",
    width: 720,
    description: "what one HTTP request to aadhar.sh reveals about you. read-only, never stored.",
    robots: "noindex",
    head: islandPreload(VALUES_URL),
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
  color: var(--blue-40);
  margin: 0 0 4px;
  font-weight: bold;
  letter-spacing: -0.01em;
}
h2 {
  font-family: "Trebuchet MS", Verdana, Geneva, sans-serif;
  font-size: 12pt;
  color: var(--blue-40);
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

.lede { margin: 0 0 14px; color: var(--ink-soft); font-size: 10.5pt; }
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
  border: 1px solid var(--frame);
  border-top-color: var(--blue-45);
  border-left-color: var(--blue-45);
  font-size: 10pt;
}
.field-grid dt {
  background: var(--surface-desktop);
  color: var(--blue-40);
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
  color: var(--ink);
}
.field-grid dd .dim { color: var(--ink-faint); font-family: Tahoma, Verdana, Geneva, sans-serif; font-size: 9pt; }
.field-grid dd.muted { color: oklch(44.95% 0 0); }

/* little raised "pill" — looks like a tiny 3D button */
.pill {
  display: inline-block;
  padding: 0 5px;
  border: 1px solid var(--frame);
  background: var(--surface-desktop);
  color: var(--blue-40);
  font-family: Tahoma, Verdana, Geneva, sans-serif;
  font-size: 8.5pt;
  font-weight: bold;
  margin-right: 4px;
  border-radius: 2px;
}

/* info callout — beveled like a Windows information dialog */
.callout {
  border: 1px solid var(--frame);
  background: oklch(98.81% 0.0263 99.90);
  padding: 8px 12px;
  margin: 14px 0;
  font-size: 10pt;
  box-shadow: 1px 1px 0 oklch(61.14% 0.0611 253.60 / 0.3);
}
.callout::before {
  content: "ⓘ ";
  color: var(--blue-40);
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

/* the island's failure note, shown only if the values request failed */
.wy-fail { display: none; color: var(--ink-faint); font-size: 9pt; }
#wy-values[data-state="failed"] + .wy-fail { display: block; }
`,
    body: html`

    <h1>System Properties</h1>
    <p class="lede">
      Your machine as the edge sees it: everything one HTTP request from your browser
      revealed to this site. None of it is logged, none of it is stored. Close this tab and it's gone.
    </p>

    ${islandMount("wy-values", VALUES_URL, renderWhoareyouValues(PLACEHOLDER_DATA, PLACEHOLDER_UA, null), html`<p>These values arrive in a second request after the page loads, and that needs a script. Without one, <a href="${VALUES_URL}">${VALUES_URL}</a> shows them for your request as plain HTML, and <a href="/whoareyou.json">/whoareyou.json</a> as JSON.</p>`)}
    <p class="wy-fail">The request for these values failed, so they stay unknown rather than assumed. <a href="${VALUES_URL}">${VALUES_URL}</a> has them for your request.</p>

    <h2>Edge Trace</h2>
    <p class="lede">Seven things Cloudflare's edge knows about this connection that
    it never tells the worker. <code>request.cf</code> carries geography, TLS
    version and protocol, but not whether your SNI was encrypted, nor whether you
    arrived through WARP. Those live only in
    <a href="/cdn-cgi/trace"><code>/cdn-cgi/trace</code></a>, so your browser
    fetches this section for itself, from this same origin, after the page has
    loaded.</p>
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
      <strong>About this page:</strong> The page itself is built once at deploy
      and is byte-identical for everybody, which is what lets it arrive
      compressed against bytes your browser may already hold. Everything above
      that describes you comes from a second request, to
      <code>/whoareyou/values.html</code> on this same origin, which the
      Cloudflare edge renders from that request and nothing else. So the values
      describe the request that fetched them: normally the same connection, IP
      and TLS session as the page, with a slightly later clock and its own ray
      id. The referrer is the one field that request would get wrong, since its
      referrer is this page, so your browser fills that row in from what it sent
      with the page.
      <br><br>
      Your browser never speaks to a third party. Two requests leave this page
      after it loads, both to this same origin: the values, and the Edge Trace
      section's read of <code>/cdn-cgi/trace</code>, because those seven fields
      are the ones the worker is never told. One call leaves the server: an RDAP
      lookup to your IP's registry, which the edge caches for 24h so visitors
      from the same block don't re-hit ARIN. The data above lives for as long as
      it takes to render, then nothing writes it to storage. View-source if you
      want, since it's a single JavaScript file you can read end-to-end.
      <br><br>
      <strong>Every script on this page is mine, and that is newer than it
      sounds.</strong> From 2026-08-06 the Cloudflare edge injected a 47KB WebMCP
      bridge of its own into every document here, after this worker had finished
      with it, which is why View Source used to show a tag no file in the
      repository contained. It is off. What builds the tool catalogue now is
      <code>/webmcp.js</code>, which is in the repository and which you can read
      end-to-end like the rest.
      <br><br>
      Two measurements retired the bridge rather than a preference. It never ran
      on the busiest page here at all: <code>/</code> is served as a compressed
      delta against bytes your browser already holds, and the edge cannot rewrite
      one, so the homepage advertised nothing to anybody while every other page
      advertised 25 tools. And your browser keeps only ONE of the five annotations
      the protocol defines for a tool, <code>readOnlyHint</code>, discarding the
      rest on the way in. So the bridge had no way to tell your agent which of
      these tools WRITE data. <code>/webmcp.js</code> restates that in the
      description an agent reads, and anything that writes stops and asks you,
      by name, showing you the arguments, before it runs.
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
    // Two scripts. The first fills the Edge Trace section from /cdn-cgi/trace,
    // the only source for those fields (request.cf never carries them), and the
    // referrer row from document.referrer, both now and after every island swap.
    // Failure is reported rather than hidden, because a page whose whole subject
    // is what a request reveals should not quietly show blanks where it could not
    // look. The second is lib/island.ts's shared loader, byte-identical on every
    // page that uses it. build.ts hashes both into script-src (step 7c).
    scripts: html`${unsafeHtml(`<script>
(function () {
  // The referrer row. The values request's own Referer is this page, so the
  // Worker cannot report what the page request carried; document.referrer is
  // exactly that, read where it lives.
  function ref() {
    var els = document.querySelectorAll("[data-referrer]");
    for (var i = 0; i < els.length; i++) els[i].textContent = document.referrer || "(none)";
  }
  ref();
  document.addEventListener("island", ref);
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
</script>`)}${islandScript()}`,
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
