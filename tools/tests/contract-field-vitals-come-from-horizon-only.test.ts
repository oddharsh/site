// ── field vitals come from horizon only ──────────────────────────────────────
import { runInNewContext } from "node:vm";
import { ROOT, assert, readFileSync, readdir, test } from "./contract-shared.ts";

const HORIZON = JSON.stringify({ p: "/garage/horizon", lcp: 1234.5, cls: 0.02, inp: 88 });

function vitalsEnv() {
  const points: any[] = [];
  return {
    env: { VITALS: { writeDataPoint: (p) => points.push(p) }, CF_VERSION_METADATA: { id: "abcdef1234", tag: "", timestamp: "" } },
    points,
  };
}

const post = (body: string) => new Request("https://aadhar.sh/ledger/vitals", { method: "POST", body });

test("a horizon beacon parses to its three metrics", async () => {
  const { parseVitals } = await import("../../src/worker/vitals.ts");
  assert.deepEqual(parseVitals(HORIZON), { path: "/garage/horizon", values: { LCP: 1234.5, CLS: 0.02, INP: 88 } });
  // nobody interacted: no INP, and CLS 0 is a real value
  assert.deepEqual(parseVitals(JSON.stringify({ p: "/garage/horizon", lcp: 900, cls: 0 })), {
    path: "/garage/horizon",
    values: { LCP: 900, CLS: 0 },
  });
});

test("the receiver drops other pages, junk bodies, and impossible values", async () => {
  const { parseVitals } = await import("../../src/worker/vitals.ts");
  assert.equal(parseVitals(JSON.stringify({ p: "/", lcp: 900, cls: 0 })), null);
  assert.equal(parseVitals(JSON.stringify({ p: "/garage", lcp: 900, cls: 0 })), null);
  assert.equal(parseVitals("not json"), null);
  assert.equal(parseVitals("null"), null);
  assert.equal(parseVitals(JSON.stringify({ p: "/garage/horizon", pad: "x".repeat(600) })), null);
  // a negative LCP, a string CLS and an hour-long INP each drop alone
  assert.deepEqual(parseVitals(JSON.stringify({ p: "/garage/horizon", lcp: -1, cls: "0.1", inp: 61_000 })), {
    path: "/garage/horizon",
    values: {},
  });
  assert.deepEqual(parseVitals(JSON.stringify({ p: "/garage/horizon", lcp: -1, cls: 0.1, inp: 61_000 })), {
    path: "/garage/horizon",
    values: { CLS: 0.1 },
  });
});

test("one data point per metric, indexed by metric, stamped with the version", async () => {
  const { handleVitals } = await import("../../src/worker/vitals.ts");
  const { env, points } = vitalsEnv();
  const res = await handleVitals(post(HORIZON), env as any);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(points, [
    { blobs: ["LCP", "/garage/horizon", "abcdef12"], doubles: [1234.5], indexes: ["LCP"] },
    { blobs: ["CLS", "/garage/horizon", "abcdef12"], doubles: [0.02], indexes: ["CLS"] },
    { blobs: ["INP", "/garage/horizon", "abcdef12"], doubles: [88], indexes: ["INP"] },
  ]);
});

test("a beacon the receiver can't use still answers 204 and writes nothing", async () => {
  const { handleVitals } = await import("../../src/worker/vitals.ts");
  const { env, points } = vitalsEnv();
  assert.equal((await handleVitals(post(JSON.stringify({ p: "/", lcp: 900 })), env as any)).status, 204);
  assert.equal(points.length, 0);

  const get = await handleVitals(new Request("https://aadhar.sh/ledger/vitals"), env as any);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal(points.length, 0);

  // a dataset that throws must not turn into a 500 for the browser
  const throwing = {
    VITALS: {
      writeDataPoint: () => {
        throw new Error("AE down");
      },
    },
    CF_VERSION_METADATA: undefined,
  };
  assert.equal((await handleVitals(post(HORIZON), throwing as any)).status, 204);
});

test("only the pages VITALS_PATHS names ship the beacon", async () => {
  const { VITALS_PATHS } = await import("../../src/worker/vitals.ts");
  const pagesDir = new URL("src/pages/", ROOT);
  const entries = await readdir(pagesDir, { recursive: true });
  const shipping = entries
    .filter((f) => f.endsWith(".html") && readFileSync(new URL(f, pagesDir), "utf8").includes('sendBeacon("/ledger/vitals"'))
    .map((f) => "/" + f.replace(/\.html$/, "").replace(/\/index$/, ""));
  assert.deepEqual(shipping, ["/garage/horizon"]);
  assert.deepEqual([...VITALS_PATHS], ["/garage/horizon"]);
});

// The observer is inline in horizon.html, so these run that exact script
// against a stubbed browser: visibility, the four entry types, sendBeacon,
// and fetchLater where a case says the browser has it.
function horizonVitals(o: { fetchLater?: "works" | "throws"; startHidden?: boolean; prerendering?: boolean; activationStart?: number }) {
  const html = readFileSync(new URL("src/pages/garage/horizon.html", ROOT), "utf8");
  // our own page, so slice around the endpoint rather than parse the document
  const at = html.indexOf('"/ledger/vitals"');
  const open = html.lastIndexOf("<script>", at);
  const close = html.indexOf("</script>", at);
  assert.ok(at > 0 && open > 0 && close > at, "horizon.html no longer has an inline script posting to /ledger/vitals");
  const script = html.slice(open + "<script>".length, close);

  const document = { visibilityState: o.startHidden ? "hidden" : "visible", prerendering: !!o.prerendering };
  const onVisibility: (() => void)[] = [];
  const deliver = new Map<string, (entry: object) => void>();
  const beacons: string[] = [];
  const deferred: { body: string; aborted: boolean; activated: boolean }[] = [];
  let now = 0;
  class PerformanceObserver {
    static supportedEntryTypes = ["largest-contentful-paint", "layout-shift", "event", "first-input"];
    readonly callback: (list: { getEntries(): object[] }) => void;
    constructor(callback: (list: { getEntries(): object[] }) => void) {
      this.callback = callback;
    }
    observe(opts: { type: string }) {
      deliver.set(opts.type, (entry) => this.callback({ getEntries: () => [entry] }));
    }
  }
  const context: Record<string, unknown> = {
    window: { PerformanceObserver },
    PerformanceObserver,
    AbortController,
    document,
    location: { pathname: "/garage/horizon" },
    navigator: { sendBeacon: (_url: string, body: string) => beacons.push(body) > 0 },
    performance: { getEntriesByType: () => [{ activationStart: o.activationStart ?? 0 }], now: () => now },
    addEventListener: (type: string, fn: () => void) => {
      if (type === "visibilitychange") onVisibility.push(fn);
    },
  };
  if (o.fetchLater)
    context.fetchLater = (_url: string, init: { body: string; signal: AbortSignal }) => {
      if (o.fetchLater === "throws") throw new Error("QuotaExceededError");
      const request = { body: init.body, aborted: false, activated: false };
      init.signal.addEventListener("abort", () => (request.aborted = true));
      deferred.push(request);
      return request;
    };
  runInNewContext(script, context);

  const flip = (state: string) => {
    document.visibilityState = state;
    for (const fn of onVisibility) fn();
  };
  return {
    at: (ms: number) => (now = ms),
    entry: (type: string, entry: object) => {
      const fire = deliver.get(type);
      assert.ok(fire, `the script never observed ${type}`);
      fire(entry);
    },
    hide: () => flip("hidden"),
    show: () => flip("visible"),
    activate: () => {
      document.prerendering = false;
      document.visibilityState = "visible";
    },
    beacons: () => beacons.map((b) => JSON.parse(b)),
    pending: () => deferred.filter((d) => !d.aborted).map((d) => JSON.parse(d.body)),
    deferred,
  };
}

const click = (duration: number) => ({ interactionId: 1, duration });
const shift = (value: number, startTime: number) => ({ value, startTime, hadRecentInput: false });

test("without fetchLater, one beacon on the first hide carries the view", () => {
  const page = horizonVitals({});
  page.entry("largest-contentful-paint", { startTime: 1200 });
  page.entry("event", click(80));
  page.at(4000);
  page.hide();
  page.show();
  page.entry("event", click(300));
  page.hide();
  // one row per metric per view: the second hide sends nothing
  assert.deepEqual(page.beacons(), [{ p: "/garage/horizon", lcp: 1200, cls: 0, inp: 80 }]);
});

test("with fetchLater, the browser sends what the last hide measured, once", () => {
  const page = horizonVitals({ fetchLater: "works" });
  page.entry("largest-contentful-paint", { startTime: 1200 });
  page.entry("event", click(80));
  page.at(4000);
  page.hide();
  assert.deepEqual(page.pending(), [{ p: "/garage/horizon", lcp: 1200, cls: 0, inp: 80 }]);
  page.show();
  page.entry("event", click(300));
  page.entry("layout-shift", shift(0.05, 9000));
  page.hide();
  assert.deepEqual(page.pending(), [{ p: "/garage/horizon", lcp: 1200, cls: 0.05, inp: 300 }]);
  assert.equal(page.deferred.length, 2, "the first hide's request is replaced, not kept beside the second");
  assert.deepEqual(page.beacons(), []);
});

test("after the browser has sent the deferred report, a later hide adds no second row", () => {
  const page = horizonVitals({ fetchLater: "works" });
  page.entry("largest-contentful-paint", { startTime: 1200 });
  page.hide();
  page.deferred[0].activated = true; // sent on bfcache entry, say, then restored
  page.show();
  page.entry("event", click(300));
  page.hide();
  assert.equal(page.deferred.length, 1);
  assert.equal(page.deferred[0].aborted, false);
  assert.deepEqual(page.beacons(), []);
});

test("a fetchLater that refuses the request falls back to the one beacon", () => {
  const page = horizonVitals({ fetchLater: "throws" });
  page.entry("largest-contentful-paint", { startTime: 1200 });
  page.hide();
  page.show();
  page.hide();
  assert.deepEqual(page.beacons(), [{ p: "/garage/horizon", lcp: 1200, cls: 0 }]);
});

test("a view that loaded in a background tab reports no LCP, but keeps CLS and INP", () => {
  const page = horizonVitals({ startHidden: true });
  page.show();
  page.entry("largest-contentful-paint", { startTime: 5000 });
  page.entry("event", click(120));
  page.hide();
  assert.deepEqual(page.beacons(), [{ p: "/garage/horizon", cls: 0, inp: 120 }]);
});

test("a prerendered view is hidden on purpose, so it still reports LCP from activation", () => {
  const page = horizonVitals({ startHidden: true, prerendering: true, activationStart: 800 });
  page.activate();
  page.entry("largest-contentful-paint", { startTime: 2000 });
  page.hide();
  assert.deepEqual(page.beacons(), [{ p: "/garage/horizon", lcp: 1200, cls: 0 }]);
});
