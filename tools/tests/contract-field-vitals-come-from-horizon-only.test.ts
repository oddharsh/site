// ── field vitals come from horizon only ──────────────────────────────────────
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
