// lens-wire.js — the WIRE lens: every request a page actually makes.
//
// The eighth machine tab answers the one question /lens could not. Every other
// lens reads a DOCUMENT: the HTTP response, the rendered DOM, an extractor's
// guess at the article. None of them can say that loading a 900-word news story
// fired 312 requests at 84 hosts and that 71% of the bytes belonged to nobody
// who wrote a word of it. That number is the page's actual cost, and it is
// invisible to every representation we already serve.
//
// ── why this needs a different engine, and why that is not a second /lens/rendered
// lens-render.js carries a warning about second rendering routes, earned when a
// /lens/rendered turned out to be a thinner copy of /lens/browser. Read that
// warning before adding a render surface; this is the case it does not cover.
// Quick Actions expose exactly the four artifacts they expose (content,
// screenshot, markdown, accessibility tree) through a CLOSED payload schema, and
// the request waterfall is not one of them, so no parameter to the existing
// route can produce this. The engine below is genuinely different rather than a
// second spelling of the same call.
//
// ── the door, which the binding has had all along ──────────────────────────
// `env.BROWSER` is a Fetcher, and behind it sits the full Chrome DevTools
// Protocol. Measured 2026-08-11 against the production binding through remote
// bindings: 54 domains, Chrome/128.0.6613.137, and a live WebSocket.
//
//   POST   https://localhost/v1/devtools/browser              -> { sessionId }
//   GET    https://localhost/v1/devtools/browser/<id>/json/protocol
//   fetch(<id>, { headers: { Upgrade: "websocket" } })        -> response.webSocket
//   DELETE https://localhost/v1/devtools/browser/<id>
//
// Read out of agents@0.20.1 (dist/connector-*.js) rather than invented. We do
// NOT take the `agents` dependency: it wraps those four calls in an LLM tool
// that writes its own CDP JavaScript, which is precisely the model-authored-code
// door lens-recipes.js exists to refuse. The transport is ~60 lines and the
// script is ours.
//
// ── what this costs, which is the whole design constraint ──────────────────
// A CDP session is a real browser INSTANCE, on the same 10-browser-minutes-a-day
// account-wide allowance /lens/shot and /lens/browser already share. The free
// plan also caps new instances at one per 20 seconds: measured live, a second
// session opened 20s after the first answered `429 Rate limit exceeded` on the
// create. So this route is rationed three ways — a per-IP budget, the shared
// browserAll ceiling every browser route bills against, and a 6h KV cache that
// is the real control. A 429 from the create is a NORMAL outcome here, reported
// as our own budget rather than dressed up as the target site failing, the same
// correction /lens/shot already made.
//
// The session is deleted in a `finally`. A leaked session holds one of three
// concurrent slots until it times out, which would black out every browser lens
// on the site, so cleanup is not tidiness.

import { validateLensTarget } from "./lib/crawl.js";
import { jsonResponse } from "./lib/http.js";
import { span } from "./lib/trace.js";
import { BOT_UA } from "./lib/botauth.js";
// lens.js does not import this file, so the edge runs one way and there is no
// cycle. Budgets live there because that is where every other lens route reads
// them, and a second copy is the drift the LENS_BUDGETS contract test refuses.
import { BROWSER_FREE_PLAN, LENS_BUDGETS, lensSha256Hex, overLensBudget } from "./lens.js";
import { EXECUTION_PROBE } from "./lib/agent-execution.js";
import { isCallable } from "./lib/parse.js";
import { asText } from "./lib/parse.js";

const CDP_BASE = "https://localhost/v1/devtools/browser";

// Wall-clock ceilings. The navigate wait is generous because the point of the
// lens is late-firing third parties, and the settle window after the load event
// is what catches the analytics beacons that fire on load. Both are well inside
// the isolate's budget; the binding's own CDP timeout is 30s.
export const WIRE_TIMING = {
  cdpCommandMs: 20000,
  navigateMs: 20000,
  settleAfterLoadMs: 2500,
  hardCapMs: 28000,
};

// KV, 6h, the same reasoning /lens/shot wrote down: on a ten-minute-a-day
// allowance a MISS costs a slice of the account's budget while a stale
// waterfall costs a slightly old picture of a page that mostly did not change.
const WIRE_CACHE_TTL = 21600;

// How many individual requests travel in the payload. The SUMMARY is computed
// over every request; this caps only the itemised list, because a page that
// fires 300 requests needs its totals more than it needs 300 rows.
const WIRE_MAX_ROWS = 60;

// ── pure summariser ────────────────────────────────────────────────────────
// Split out from the transport on purpose: this half is a pure function of a
// CDP event array, so `node --test` can exercise the interesting logic without
// a browser, a binding, or a network. Everything below the transport line needs
// workerd; everything above it does not.

// Registrable-domain-ish grouping. Deliberately NOT a public-suffix list: PSL is
// ~250KB against a bundle already over budget, and the claim this makes is
// "same site as the page" rather than "same registrable domain", which the
// last-two-labels heuristic gets right for the cases a reader looks at. It is
// wrong for multi-label suffixes (foo.co.uk vs bar.co.uk read as one site), so
// the payload reports HOSTS as the primary fact and the grouping as a
// convenience. Say what a number is worth rather than overstating it.
export function siteOf(hostname) {
  const parts = String(hostname || "").toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const twoLevelSuffix = /^(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/.test(parts.slice(-2).join("."));
  return parts.slice(twoLevelSuffix ? -3 : -2).join(".");
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

// CDP resource types are Chrome's own vocabulary and there are ~20 of them. The
// page's cost story needs about six, so the rest fold into "other" rather than
// producing a histogram with a long tail of ones.
const TYPE_BUCKETS = {
  Document: "document", Stylesheet: "css", Script: "js", Image: "image",
  Font: "font", XHR: "xhr", Fetch: "xhr", Media: "media", Manifest: "other",
  TextTrack: "other", EventSource: "xhr", WebSocket: "other", Ping: "beacon",
  CSPViolationReport: "beacon", Preflight: "other", Other: "other",
};

export function bucketFor(cdpType) { return TYPE_BUCKETS[cdpType] || "other"; }

// Build one row per request id, folding the four events that describe the same
// request into a single record. Ordering is by the CDP timestamp on the
// requestWillBeSent, which is monotonic within a session, so the list reads as
// the actual load order rather than as event-arrival order.
export function summariseWire(events, pageUrl) {
  const pageHost = hostOf(pageUrl);
  const pageSite = siteOf(pageHost);
  const byId = new Map();

  for (const ev of events) {
    const p = ev.params || {};
    const id = p.requestId;
    if (!id) continue;
    let row = byId.get(id);
    if (!row) { row = { id, bytes: 0, status: null, cached: false, failed: false }; byId.set(id, row); }

    switch (ev.method) {
      case "Network.requestWillBeSent": {
        // A redirect arrives as a SECOND requestWillBeSent on the same id
        // carrying redirectResponse. Overwriting would lose the first hop and
        // undercount both the request and its bytes, so the hop is counted and
        // the row moves on to the destination.
        if (p.redirectResponse && row.url) { row.redirects = (row.redirects || 0) + 1; }
        row.url = p.request?.url || row.url;
        row.method = p.request?.method || row.method;
        row.type = bucketFor(p.type);
        if (row.t0 == null) row.t0 = p.timestamp;
        break;
      }
      case "Network.responseReceived":
        row.status = p.response?.status ?? row.status;
        row.mime = p.response?.mimeType || row.mime;
        row.protocol = p.response?.protocol || row.protocol;
        row.type = bucketFor(p.type) || row.type;
        if (p.response?.fromDiskCache || p.response?.fromServiceWorker) row.cached = true;
        break;
      case "Network.requestServedFromCache":
        row.cached = true;
        break;
      case "Network.loadingFinished":
        // encodedDataLength on loadingFinished is the WIRE size, which is the
        // number this lens is about. response.encodedDataLength counts headers
        // only and would report a 400KB image as a few hundred bytes.
        row.bytes = p.encodedDataLength || row.bytes || 0;
        row.t1 = p.timestamp;
        break;
      case "Network.loadingFailed":
        // NOT every loadingFailed is a failure, and getting this wrong was
        // measured rather than imagined: on our own homepage 2026-08-11, the
        // `/hit?tick=1` beacon answered 204 and THEN reported
        // `net::ERR_ABORTED`, because a fire-and-forget fetch nobody awaits is
        // cancelled at teardown. Counting that as a failure put "1 failed" on a
        // page where nothing failed.
        //
        // So the discriminator is whether a response ever arrived. Status set
        // means the server answered and the body was cut short or the caller
        // walked away, which devtools itself renders as "(canceled)". No status
        // means the request genuinely did not complete.
        if (row.status != null || p.canceled) { row.aborted = true; } else { row.failed = true; }
        row.error = p.blockedReason ? "blocked: " + p.blockedReason : (p.errorText || "failed");
        row.t1 = p.timestamp;
        break;
      default: break;
    }
  }

  const rows = [...byId.values()]
    .filter((r) => r.url && !r.url.startsWith("data:"))
    .sort((a, b) => (a.t0 ?? 0) - (b.t0 ?? 0));

  const dataUris = [...byId.values()].filter((r) => r.url && r.url.startsWith("data:")).length;

  const hosts = new Map();
  const byType = {};
  let bytes = 0, thirdBytes = 0, thirdCount = 0, cached = 0, failed = 0, aborted = 0;

  for (const r of rows) {
    const host = hostOf(r.url);
    const third = siteOf(host) !== pageSite;
    r.host = host;
    r.third = third;
    r.ms = r.t0 != null && r.t1 != null ? Math.round((r.t1 - r.t0) * 1000) : null;

    bytes += r.bytes;
    if (third) { thirdBytes += r.bytes; thirdCount++; }
    if (r.cached) cached++;
    if (r.failed) failed++;
    if (r.aborted) aborted++;

    const t = r.type || "other";
    byType[t] = byType[t] || { count: 0, bytes: 0 };
    byType[t].count++;
    byType[t].bytes += r.bytes;

    const h = hosts.get(host) || { host, count: 0, bytes: 0, third };
    h.count++; h.bytes += r.bytes;
    hosts.set(host, h);
  }

  const hostList = [...hosts.values()].sort((a, b) => b.bytes - a.bytes || b.count - a.count);

  return {
    pageHost,
    pageSite,
    requests: rows.length,
    dataUris,
    bytes,
    thirdParty: {
      requests: thirdCount,
      bytes: thirdBytes,
      // The headline. Guarded against a zero-byte load so the demo never shows
      // NaN% on a page that failed to fetch anything.
      bytesPct: bytes > 0 ? Math.round((thirdBytes / bytes) * 100) : 0,
      requestsPct: rows.length > 0 ? Math.round((thirdCount / rows.length) * 100) : 0,
      hosts: hostList.filter((h) => h.third).length,
    },
    hosts: hostList.slice(0, 25),
    hostTotal: hostList.length,
    byType,
    cached,
    failed,
    aborted,
    truncated: rows.length > WIRE_MAX_ROWS,
    rows: rows.slice(0, WIRE_MAX_ROWS).map((r) => ({
      url: r.url.length > 160 ? r.url.slice(0, 160) + "…" : r.url,
      host: r.host,
      third: r.third,
      type: r.type,
      status: r.status,
      bytes: r.bytes,
      ms: r.ms,
      protocol: r.protocol,
      cached: r.cached || undefined,
      failed: r.failed || undefined,
      aborted: r.aborted || undefined,
      error: r.error,
      redirects: r.redirects,
    })),
  };
}

// ── transport ──────────────────────────────────────────────────────────────

// A minimal CDP client over the binding's WebSocket. Replies are matched by the
// id we assigned; anything with a `method` is an event and goes in the log.
// `sessionId` on a frame addresses the attached page target (flatten mode).
function cdpClient(ws) {
  let nextId = 1;
  const pending = new Map();
  const events = [];
  let closed = null;

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(asText(ev.data, "")); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "CDP error"));
      else resolve(msg.result);
      return;
    }
    if (msg.method) events.push(msg);
  });
  // A socket that dies mid-navigation must reject every outstanding command
  // rather than let them all sit until their individual timeouts, which would
  // hold the isolate open for 20s per pending call for no reason.
  const die = (why) => {
    closed = closed || new Error(why);
    for (const [, { reject }] of pending) reject(closed);
    pending.clear();
  };
  ws.addEventListener("close", () => die("CDP socket closed"));
  ws.addEventListener("error", () => die("CDP socket error"));

  const send = (method, params, sessionId) => new Promise((resolve, reject) => {
    if (closed) return reject(closed);
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const frame = { id, method, params: params || {} };
    if (sessionId) frame.sessionId = sessionId;
    try { ws.send(JSON.stringify(frame)); } catch (e) { pending.delete(id); return reject(e); }
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, WIRE_TIMING.cdpCommandMs);
  });

  // Resolves on the first matching event, or on timeout WITHOUT throwing: a page
  // that never fires its load event is a real page with a real waterfall, and
  // refusing to report it would throw away the observation we just paid for.
  const waitFor = (method, ms) => new Promise((resolve) => {
    const seen = events.find((e) => e.method === method);
    if (seen) return resolve(seen);
    const t = setTimeout(() => { ws.removeEventListener("message", onMsg); resolve(null); }, ms);
    function onMsg(ev) {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.method === method) { clearTimeout(t); ws.removeEventListener("message", onMsg); resolve(m); }
    }
    ws.addEventListener("message", onMsg);
  });

  return { send, waitFor, events };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Open a session, drive one navigation, return the raw events. Every exit path
// runs the DELETE.
async function runWireSession(env, url) {
  const created = await env.BROWSER.fetch(CDP_BASE, { method: "POST" });
  if (created.status === 429) return { budget: true };
  if (!created.ok) {
    let detail = ""; try { detail = (await created.text()).slice(0, 200); } catch (_e) {}
    return { error: `Browser Run refused a CDP session (${created.status}).`, detail, status: created.status };
  }
  const { sessionId } = await created.json();
  if (!sessionId) return { error: "Browser Run returned no sessionId." };

  try {
    const wsRes = await env.BROWSER.fetch(`${CDP_BASE}/${sessionId}`, { headers: { Upgrade: "websocket" } });
    const ws = wsRes.webSocket;
    if (!ws) return { error: `Browser Run did not upgrade to a CDP WebSocket (status ${wsRes.status}).` };
    ws.accept();
    const cdp = cdpClient(ws);

    const { targetInfos } = await cdp.send("Target.getTargets");
    const page = (targetInfos || []).find((t) => t.type === "page");
    if (!page) return { error: "The CDP session exposed no page target." };
    const { sessionId: pageSession } = await cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });

    // Identify honestly, exactly like every other outbound fetch on this site.
    // A page that wants to refuse AadharshBot must be able to see it is
    // AadharshBot; a stealth crawl would make this lens a lie about itself.
    //
    // Tolerated rather than awaited-or-die: the override is deprecated in favour
    // of Emulation.setUserAgentOverride and the two have swapped primacy before,
    // so a binding that drops it should cost the honest UA string and not the
    // whole observation. `uaApplied` carries the fact into the payload instead of
    // letting the page silently claim an identity it did not send.
    let uaApplied = true;
    try {
      await cdp.send("Network.setUserAgentOverride", { userAgent: BOT_UA }, pageSession);
    } catch (_e) {
      try { await cdp.send("Emulation.setUserAgentOverride", { userAgent: BOT_UA }, pageSession); }
      catch (_e2) { uaApplied = false; }
    }
    await cdp.send("Network.enable", {}, pageSession);
    await cdp.send("Page.enable", {}, pageSession);
    // Runtime and Log carry the EXECUTION evidence, and both are enabled before
    // the navigation because an exception thrown during load is the interesting
    // case. This costs no extra browser instance and no extra minute: it is the
    // session this lens already opens, answering two more questions on the way
    // past. `agentScripts` and `agentMedia` in the readiness rubric are fed from
    // here, and they are the two questions a declaration audit structurally
    // cannot answer.
    //
    // Tolerated rather than awaited-or-die, exactly like the UA override above.
    // A binding that refuses either domain should cost the execution checks and
    // leave them neutral, not lose the whole request waterfall this route
    // exists for.
    let execDomains = true;
    try {
      await cdp.send("Runtime.enable", {}, pageSession);
      await cdp.send("Log.enable", {}, pageSession);
    } catch (_e) { execDomains = false; }

    const t0 = Date.now();
    await cdp.send("Page.navigate", { url }, pageSession);
    const loaded = await cdp.waitFor("Page.loadEventFired", WIRE_TIMING.navigateMs);
    // The settle window is where the third parties this lens exists to count
    // actually show up: beacons and tag managers fire ON load, so stopping at
    // the load event would systematically under-report the thing being measured.
    await sleep(Math.min(WIRE_TIMING.settleAfterLoadMs, Math.max(0, WIRE_TIMING.hardCapMs - (Date.now() - t0))));

    // The census runs AFTER the settle window on purpose: an image that has not
    // finished loading yet reports naturalWidth 0 and is not broken, so probing
    // at the load event would invent failures. EXECUTION_PROBE only counts an
    // image once `complete` is true.
    let execution = null;
    if (execDomains) {
      try {
        const r = await cdp.send("Runtime.evaluate", { expression: EXECUTION_PROBE, returnByValue: true, awaitPromise: false }, pageSession);
        const raw = r && r.result && asText(r.result.value) !== null ? JSON.parse(r.result.value) : null;
        if (raw && !raw.probeError) {
          // Uncaught errors, counted off the events this session already
          // collected. Runtime.exceptionThrown is the page's own throw;
          // Log.entryAdded at error level catches what the console reports
          // without an exception object, which is how Kitesurf reports a
          // callback that threw inside requestAnimationFrame.
          const thrown = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown");
          const logged = cdp.events.filter((e) => e.method === "Log.entryAdded" && e.params && e.params.entry && e.params.entry.level === "error");
          const first = thrown[0]
            ? String((thrown[0].params && thrown[0].params.exceptionDetails && thrown[0].params.exceptionDetails.text) || "").slice(0, 120)
            : logged[0] ? String((logged[0].params.entry.text) || "").slice(0, 120) : "";
          execution = { ran: true, engine: "chromium-cdp", pageErrors: thrown.length, consoleErrors: logged.length, firstError: first || undefined, ...raw };
        }
      } catch (_e) { execution = null; }
    }

    return { events: cdp.events, navMs: Date.now() - t0, loadFired: Boolean(loaded), uaApplied, execution, sessionId };
  } finally {
    // Fire and forget would be wrong: a leaked session holds one of three
    // concurrent slots and blacks out every browser lens on the site.
    try { await env.BROWSER.fetch(`${CDP_BASE}/${sessionId}`, { method: "DELETE" }); } catch (_e) {}
  }
}

// ── route ──────────────────────────────────────────────────────────────────

export async function handleLensWire(request, env, ctx) {
  const params = new URL(request.url).searchParams;

  const v = validateLensTarget(params.get("url") || "");
  if (!v.ok) return jsonResponse({ ok: false, error: v.error }, 400);

  if (!env.BROWSER || !isCallable(env.BROWSER.fetch)) {
    return jsonResponse({ ok: false, error: "Browser Run is not configured on this deployment." }, 503);
  }

  const cacheKey = "lens:wire:" + (await lensSha256Hex(v.url));
  if (env.RN_KV) {
    const hit = await env.RN_KV.get(cacheKey, "json");
    if (hit) {
      // One span name for hit and miss, differing on lens.cache, so the hit rate
      // stays a group-by rather than a join. Same convention as lens.shot.
      return span("lens.wire", (s) => {
        s.setAttribute("lens.target_host", hit.pageHost);
        s.setAttribute("lens.cache", "hit");
        // `fromCache`, NEVER `cached`. The summary already owns `cached` as the
        // number of the TARGET's requests the browser served from ITS cache, and
        // spelling this one the same way overwrote that count with a boolean —
        // the pane rendered "true served from cache". Two different subjects, so
        // two different keys.
        return jsonResponse({ ...hit, fromCache: true });
      });
    }
  }

  // Per-IP first, then the ceiling every browser-consuming route shares. A
  // visitor politely under their own limit still must not spend the account's.
  if (await overLensBudget(LENS_BUDGETS.wire, request, env)) {
    return jsonResponse({ ok: false, error: `Wire traces are rate-limited to ${LENS_BUDGETS.wire.max}/min. Hang on a moment.` }, 429);
  }
  if (await overLensBudget(LENS_BUDGETS.browserAll, request, env)) {
    return jsonResponse({ ok: false, error: "The shared browser budget for this minute is spent. Try again shortly." }, 429);
  }

  return span("lens.wire", async (s) => {
    s.setAttribute("lens.target_host", (() => { try { return new URL(v.url).hostname; } catch { return undefined; } })());
    s.setAttribute("lens.cache", "miss");

    let out;
    try {
      out = await span("lens.wire.session", () => runWireSession(env, v.url));
    } catch (e) {
      s.setAttribute("lens.outcome", "session_threw");
      s.setAttribute("lens.error", (e && e.message) || String(e));
      return jsonResponse({ ok: false, error: "The CDP session failed: " + ((e && e.message) || e) }, 502);
    }

    // Our own budget, not the target site's fault. /lens/shot already made this
    // correction and the reasoning transfers exactly: on the free plan this is
    // the single most likely non-success here.
    if (out.budget) {
      s.setAttribute("lens.outcome", "browser_budget_spent");
      return jsonResponse({
        ok: false,
        error: `Browser Run is rate-limited right now (free plan: one new browser every 20s, ${BROWSER_FREE_PLAN.perDayMinutes} min/day account-wide). Every other lens still works.`,
      }, 429);
    }
    if (out.error) {
      s.setAttribute("lens.outcome", "session_failed");
      if (out.status) s.setAttribute("http.response.status_code", out.status);
      return jsonResponse({ ok: false, error: out.error, detail: out.detail }, 502);
    }

    const summary = summariseWire(out.events, v.url);
    const payload = {
      ok: true,
      url: v.url,
      fetchedBy: "Cloudflare Browser Run (CDP)",
      engine: "chromium-cdp",
      navMs: out.navMs,
      // A page that never fired load is still reported, and says so, rather than
      // being thrown away after the budget was already spent on it.
      loadFired: out.loadFired,
      identifiedAs: out.uaApplied ? BOT_UA : null,
      // The execution evidence the readiness rubric's `execution` category
      // consumes. Null when the probe could not run, which keeps those checks
      // neutral rather than turning our own failure into the site's fail.
      execution: out.execution || null,
      ...summary,
    };

    s.setAttribute("lens.outcome", "ok");
    s.setAttribute("lens.wire_requests", summary.requests);
    s.setAttribute("lens.wire_bytes", summary.bytes);
    s.setAttribute("lens.wire_third_pct", summary.thirdParty.bytesPct);
    s.setAttribute("lens.wire_hosts", summary.hostTotal);
    // Attributes follow the pipeline rule: an undefined value is SKIPPED, never
    // coerced. A scan with no execution evidence records nothing here rather
    // than a zero that reads like a clean page.
    if (out.execution) {
      s.setAttribute("lens.exec_script_errors", (out.execution.consoleErrors || 0) + (out.execution.pageErrors || 0));
      s.setAttribute("lens.exec_images_broken", out.execution.brokenImages || 0);
      s.setAttribute("lens.exec_images_total", out.execution.totalImages || 0);
    }

    if (env.RN_KV) ctx.waitUntil(env.RN_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: WIRE_CACHE_TTL }));
    return jsonResponse(payload);
  });
}
