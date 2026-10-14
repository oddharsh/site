import { span } from "./lib/trace.ts";
import { BOT_UA } from "./lib/botauth.ts";
import { BROWSER_FREE_PLAN } from "./lens.ts";
import { defineLens, lensErrorText } from "./lens-pipeline.ts";
import { EXECUTION_PROBE } from "./lib/agent-execution.ts";
import { WEBMCP_PROBE, readWebmcpProbe } from "./lib/agent-webmcp.ts";
import { asText } from "./lib/parse.ts";

const CDP_BASE = "https://localhost/v1/devtools/browser";

export const WIRE_TIMING = {
  cdpCommandMs: 20000,
  navigateMs: 20000,
  settleAfterLoadMs: 2500,
  hardCapMs: 28000,
};

const WIRE_CACHE_TTL = 21600;

const WIRE_MAX_ROWS = 60;

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

const TYPE_BUCKETS = {
  Document: "document", Stylesheet: "css", Script: "js", Image: "image",
  Font: "font", XHR: "xhr", Fetch: "xhr", Media: "media", Manifest: "other",
  TextTrack: "other", EventSource: "xhr", WebSocket: "other", Ping: "beacon",
  CSPViolationReport: "beacon", Preflight: "other", Other: "other",
};

export function bucketFor(cdpType) { return TYPE_BUCKETS[cdpType] || "other"; }

export function summariseWire(events, pageUrl) {
  const pageHost = hostOf(pageUrl);
  const pageSite = siteOf(pageHost);
  const byId = new Map();

  for (const ev of events) {
    const p = ev.params || {};
    const id = p.requestId;
    if (!id) continue;
    const row = byId.getOrInsertComputed(id, () => ({ id, bytes: 0, status: null, cached: false, failed: false }));

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
  const byType: Record<string, { count: number; bytes: number }> = {};
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

    const h = hosts.getOrInsertComputed(host, () => ({ host, count: 0, bytes: 0, third }));
    h.count++; h.bytes += r.bytes;
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
  const die = (why) => {
    closed = closed || new Error(why);
    for (const [, { reject }] of pending) reject(closed);
    pending.clear();
  };
  ws.addEventListener("close", () => die("CDP socket closed"));
  ws.addEventListener("error", () => die("CDP socket error"));

  const send = (method: string, params?: unknown, sessionId?: string): Promise<Record<string, any>> =>
    new Promise<Record<string, any>>((resolve, reject) => {
    if (closed) return reject(closed);
    const id = nextId++;
    pending.set(id, { resolve, reject });
    const frame: { id: number; method: string; params: unknown; sessionId?: string } = { id, method, params: params || {} };
    if (sessionId) frame.sessionId = sessionId;
    try { ws.send(JSON.stringify(frame)); } catch (e) { pending.delete(id); return reject(e); }
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)); }, WIRE_TIMING.cdpCommandMs);
  });

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

type PageCdpSend = (method: string, params?: unknown) => Promise<Record<string, any>>;

export async function enableWireDomains(send: PageCdpSend) {
  await Promise.all([send("Network.enable", {}), send("Page.enable", {})]);
  const execution = await Promise.allSettled([send("Runtime.enable", {}), send("Log.enable", {})]);
  return execution.every((result) => result.status === "fulfilled");
}

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

    let uaApplied = true;
    try {
      await cdp.send("Network.setUserAgentOverride", { userAgent: BOT_UA }, pageSession);
    } catch (_e) {
      try { await cdp.send("Emulation.setUserAgentOverride", { userAgent: BOT_UA }, pageSession); }
      catch (_e2) { uaApplied = false; }
    }
    const execDomains = await enableWireDomains((method, params) =>
      cdp.send(method, params, pageSession));

    const t0 = Date.now();
    await cdp.send("Page.navigate", { url }, pageSession);
    const loaded = await cdp.waitFor("Page.loadEventFired", WIRE_TIMING.navigateMs);
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

    // awaitPromise is the load-bearing option: getTools() is async, and without
    // it the evaluate resolves to a pending Promise handle and the catalog reads
    // as empty on every origin, which is indistinguishable from a site that has
    // no tools.
    let webmcp: ReturnType<typeof readWebmcpProbe> = null;
    if (execDomains) {
      try {
        const w = await cdp.send("Runtime.evaluate", { expression: WEBMCP_PROBE, returnByValue: true, awaitPromise: true }, pageSession);
        const value = w && w.result ? asText(w.result.value) : null;
        webmcp = value === null ? null : readWebmcpProbe(JSON.parse(value));
        if (webmcp) {
          try {
            const ver = await cdp.send("Browser.getVersion");
            const product = ver && asText(ver.product);
            if (product) webmcp = { ...webmcp, engine: product.slice(0, 120) };
          } catch (_e) { }
        }
      } catch (_e) { webmcp = null; }
    }

    return { events: cdp.events, navMs: Date.now() - t0, loadFired: Boolean(loaded), uaApplied, execution, webmcp, sessionId };
  } finally {
    // Fire and forget would be wrong: a leaked session holds one of three
    // concurrent slots and blacks out every browser lens on the site.
    try { await env.BROWSER.fetch(`${CDP_BASE}/${sessionId}`, { method: "DELETE" }); } catch (_e) {}
  }
}

const LENS_WIRE = defineLens({
  span: "lens.wire",
  budget: "wire",
  browser: "cdp",
  targets: (params: URLSearchParams) => params.get("url") || "",
  cache: { prefix: "lens:wire:", ttl: WIRE_CACHE_TTL },
  run: async ({ target, env, span: s }) => {
    let out;
    try {
      out = await span("lens.wire.session", () => runWireSession(env, target));
    } catch (e) {
      s.setAttribute("lens.error", lensErrorText(e));
      return { ok: false, status: 502, outcome: "session_threw", payload: { ok: false, error: "The CDP session failed: " + lensErrorText(e) } };
    }

    if (out.budget) {
      return {
        ok: false, status: 429, outcome: "browser_budget_spent",
        payload: {
          ok: false,
          error: `Browser Run is rate-limited right now (free plan: one new browser every 20s, ${BROWSER_FREE_PLAN.perDayMinutes} min/day account-wide). Every other lens still works.`,
        },
      };
    }
    if (out.error) {
      if (out.status) s.setAttribute("http.response.status_code", out.status);
      return { ok: false, status: 502, outcome: "session_failed", payload: { ok: false, error: out.error, detail: out.detail } };
    }

    const summary = summariseWire(out.events, target);
    const payload = {
      ok: true,
      url: target,
      fetchedBy: "Cloudflare Browser Run (CDP)",
      engine: "chromium-cdp",
      navMs: out.navMs,
      loadFired: out.loadFired,
      identifiedAs: out.uaApplied ? BOT_UA : null,
      execution: out.execution || null,
      webmcp: out.webmcp || null,
      ...summary,
    };

    s.setAttribute("lens.wire_requests", summary.requests);
    s.setAttribute("lens.wire_bytes", summary.bytes);
    s.setAttribute("lens.wire_third_pct", summary.thirdParty.bytesPct);
    s.setAttribute("lens.wire_hosts", summary.hostTotal);
    if (out.execution) {
      s.setAttribute("lens.exec_script_errors", (out.execution.consoleErrors || 0) + (out.execution.pageErrors || 0));
      s.setAttribute("lens.exec_images_broken", out.execution.brokenImages || 0);
      s.setAttribute("lens.exec_images_total", out.execution.totalImages || 0);
    }
    if (out.webmcp && out.webmcp.present === true) {
      s.setAttribute("lens.webmcp_tools", out.webmcp.count || 0);
      s.setAttribute("lens.webmcp_write", out.webmcp.write || 0);
    }
    return { ok: true, value: payload };
  },
});

export function handleLensWire(request, env, ctx) {
  return LENS_WIRE.handle(request, env, ctx);
}
