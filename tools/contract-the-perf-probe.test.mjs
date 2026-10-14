// ── the perf probe ──────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  configText,
  testGlobals,
  assert,
  cronHomeProbe,
  cronJob,
  fetchFollowingPublicRedirects,
  privateHostBlocked,
  readFileSync,
  reservationName,
  test,
  validateLensTarget,
} from "./contract-shared.ts";

test("the probe writes one positionally-stable datapoint and never throws", async () => {
  await cronHomeProbe({}, { waitUntil() {} });

  const written = [];
  const env = { PERF_PROBE: { writeDataPoint: (d) => written.push(d) } };
  await cronHomeProbe(env, { waitUntil() {} });
  assert.equal(written.length, 1, "a working probe writes exactly one datapoint");
  const [dp] = written;
  assert.equal(dp.doubles.length, 5, "doubles are positional: [assets, tracks, alt, counter, total]");
  assert.ok(dp.doubles.every((v) => typeof v === "number"), "every double must be a real number");
  assert.deepEqual([dp.doubles[0], dp.doubles[2], dp.doubles[3]], [-1, -1, -1]);
  assert.ok(dp.doubles[1] >= 0 && dp.doubles[4] >= dp.doubles[1]);
  assert.deepEqual(dp.blobs, ["", "dev"]);
  assert.deepEqual(dp.indexes, ["home"]);
});

test("fragment probe preserves timings, missing values, cancellation and version identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "fragment-probe-"));
  const now = Date.now;
  try {
    await mkdir(join(root, "lib"));
    await copyFile(new URL("../src/worker/perf-probe.ts", import.meta.url), join(root, "perf-probe.ts"));
    await writeFile(join(root, "lib/const.ts"), 'export const CANONICAL_HOST = "fixture.example";');
    await writeFile(join(root, "home.ts"), 'import { fragment } from "./fixture.mjs"; export const handlePhotoGrid = (...args) => fragment("grid", ...args);');
    await writeFile(join(root, "rn.ts"), 'import { fragment } from "./fixture.mjs"; export const rnTracksHtml = (...args) => fragment("tracks", ...args);');
    await writeFile(join(root, "fixture.mjs"), `
      export const state = { clock: 100, phases: {}, events: [], requests: [] };
      export async function fragment(kind, request, env, ctx, opts) {
        const phase = state.phases[kind];
        state.events.push(kind);
        state.requests.push({ request, env, ctx, opts });
        state.clock += phase.ms;
        if (phase.error) throw new Error(kind);
        return new Response(phase.noBody ? null : new ReadableStream({
          cancel() {
            state.events.push("cancel:" + kind);
            state.clock += phase.cancelMs || 0;
            if (phase.cancelError) throw new Error("cancel " + kind);
          }
        }));
      }
    `);
    const { state } = await import(pathToFileURL(join(root, "fixture.mjs")).href);
    const { cronHomeProbe: probe } = await import(pathToFileURL(join(root, "perf-probe.ts")).href);
    Date.now = () => state.clock;
    /** @typedef {{ms: number, cancelMs?: number, error?: boolean, noBody?: boolean, cancelError?: boolean}} Phase */
    /** @type {Array<[string, Phase, Phase, number[] | null]>} */
    const cases = [
      ["both measured", { ms: 5, cancelMs: 2 }, { ms: 11, cancelMs: 3 }, [-1, 7, -1, -1, 21]],
      ["tracks failed", { ms: 5, error: true }, { ms: 11, cancelMs: 3 }, [-1, -1, -1, -1, 14]],
      ["grid failed", { ms: 5, cancelMs: 2 }, { ms: 11, error: true }, [-1, 7, -1, -1, 7]],
      ["both failed", { ms: 5, error: true }, { ms: 11, error: true }, null],
      ["real zero", { ms: 0 }, { ms: 0 }, [-1, 0, -1, -1, 0]],
      ["empty bodies", { ms: 5, noBody: true }, { ms: 11, noBody: true }, [-1, 5, -1, -1, 16]],
      ["cancellation failed", { ms: 5, cancelMs: 2, cancelError: true }, { ms: 11, cancelMs: 3, cancelError: true }, [-1, 7, -1, -1, 21]],
    ];
    for (const [label, tracks, grid, doubles] of cases) {
      Object.assign(state, { clock: 100, phases: { tracks, grid }, events: [], requests: [] });
      const written = [];
      const env = { PERF_PROBE: { writeDataPoint: (point) => written.push(point) }, CF_VERSION_METADATA: { id: "version-fixture" } };
      const ctx = { waitUntil() {} };
      await probe(env, ctx);
      assert.deepEqual(written, doubles ? [{ doubles, blobs: ["", "version-fixture"], indexes: ["home"] }] : [], label);
      assert.deepEqual(state.events, ["tracks", ...(!tracks.error && !tracks.noBody ? ["cancel:tracks"] : []), "grid", ...(!grid.error && !grid.noBody ? ["cancel:grid"] : [])], label);
      for (const { request, env: received } of state.requests) {
        assert.equal(request.url, "https://fixture.example/");
        assert.equal(request.headers.get("user-agent"), "AadharshBot/1.0 (+https://aadhar.sh/bot) perf-probe");
        assert.equal(received, env);
      }
      assert.equal(state.requests[0].ctx, ctx);
      assert.deepEqual(state.requests[0].opts, { warm: false }, `${label}: the probe must not warm the art cache`);
    }
    for (const id of [undefined, ""]) {
      const written = [];
      await probe({ PERF_PROBE: { writeDataPoint: (p) => written.push(p) }, CF_VERSION_METADATA: { id } }, {});
      assert.deepEqual(written[0].blobs, ["", "dev"]);
    }
    let writeAttempts = 0;
    await probe({ PERF_PROBE: { writeDataPoint() { writeAttempts++; throw new Error("dataset unavailable"); } } }, {});
    assert.equal(writeAttempts, 1, "a dataset failure is swallowed only after attempting the write");
    state.events = [];
    await probe({}, {});
    assert.deepEqual(state.events, [], "no dataset means no fragment reads");
  } finally {
    Date.now = now;
    await rm(root, { recursive: true, force: true });
  }
});

test("cron dispatch survives Cloudflare's expression normalization", () => {
  // The dispatcher used to exact-match event.cron against the strings in
  // cloudflare.config.ts, but Cloudflare normalizes expressions between declaration
  // and delivery (day-of-week tokens especially), and the census schedule is
  // the only one carrying a day-of-week token: three straight weekly sweeps
  // fell into the else-branch and ran the /around crawl with nothing logged.
  // The rule now matches minute+hour signatures, which normalization leaves
  // alone, so EVERY spelling must land on the census.
  assert.equal(cronJob("17 8 * * 1"), "census");
  assert.equal(cronJob("17 8 * * SUN"), "census");
  assert.equal(cronJob("17 8 * * MON"), "census");
  assert.equal(cronJob("7,37 * * * *"), "home_probe");
  assert.equal(cronJob("41 5 * * *"), "around");
  assert.equal(cronJob("53 5 * * *"), "webmention_send");
  assert.equal(cronJob("23 */6 * * *"), "serendipity");
  assert.equal(cronJob("*/30 * * * *"), null);
  assert.equal(cronJob("0 0 * * *"), null);
  assert.equal(cronJob(""), null);
  assert.equal(cronJob(null), null);
});

test("the shared SSRF host floor blocks every non-public shape", () => {
  const blocked = [
    "localhost", "app.localhost", "printer.local", "db.internal", "x.onion",
    "::1", "[::1]", "fc00::1", "fd12::9", "fe80::1",
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "192.168.1.1",
    "169.254.169.254",                    // cloud metadata, the one that matters most
    "172.16.0.1", "172.31.255.254",       // RFC1918 lower + upper edge
    "100.64.0.1", "100.127.255.255",      // CGNAT lower + upper edge
    "224.0.0.1", "255.255.255.255",       // multicast / reserved
  ];
  for (const h of blocked) assert.equal(privateHostBlocked(h), true, `should block ${h}`);

  const allowed = [
    "aadhar.sh", "example.com", "8.8.8.8", "1.1.1.1",
    "172.15.0.1", "172.32.0.1",           // just OUTSIDE RFC1918's 172.16-31
    "100.63.0.1", "100.128.0.1",          // just OUTSIDE CGNAT's 100.64-127
    "223.255.255.255",                    // just below the multicast floor
    "localhost.example.com",
  ];
  for (const h of allowed) assert.equal(privateHostBlocked(h), false, `should allow ${h}`);
});

test("the SSRF floor covers the alternate spellings of a blocked host", () => {
  const blocked = [
    "localhost.", "127.0.0.1.", "db.internal.",     // trailing dot is a legal FQDN
    "::", "[::]",                                    // unspecified address
    "::ffff:127.0.0.1", "[::ffff:169.254.169.254]",  // v4-mapped IPv6
    "::ffff:10.0.0.1", "::ffff:192.168.1.1",
    "fe81::1", "fe9f::1", "fea0::1", "febf::1",      // fe80::/10 is 64 prefixes, not one
    "LOCALHOST", "169.254.169.254.",
    "",
  ];
  for (const h of blocked) assert.equal(privateHostBlocked(h), true, `should block ${h}`);

  const mappedHex = ["::ffff:a9fe:a9fe", "::ffff:7f00:1", "::ffff:a00:1", "::ffff:c0a8:101"];
  for (const h of mappedHex) assert.equal(privateHostBlocked(h), true, `should block ${h}`);

  const allowed = ["fec0::1", "ff00::1".replace("ff00", "2001"), "::ffff:8.8.8.8", "::ffff:808:808", "example.com."];
  for (const h of allowed) assert.equal(privateHostBlocked(h), false, `should allow ${h}`);
});

// `new URL("https://[::ffff:169.254.169.254]/").hostname` is `[::ffff:a9fe:a9fe]`
// — the WHATWG parser rewrites the dotted tail into hex groups. So the host this
// guard actually receives is never the host anybody types, and a floor tested
// only on the typed form reported a hole closed while it was open. Production
// answered `ok: true` for the metadata address on 2026-08-08, hours after the
// unit test above went green.
test("a blocked address stays blocked through the URL parser that rewrites it", () => {
  const refused = [
    "https://[::ffff:169.254.169.254]/",   // cloud metadata, the one that matters
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:10.0.0.1]/",
    "https://[::ffff:192.168.1.1]/",
    "https://[::]/",
    "https://[fe9f::1]/",
    "https://localhost./x",
  ];
  for (const raw of refused) {
    const verdict = validateLensTarget(raw);
    assert.equal(verdict.ok, false, `${raw} normalizes to ${(() => { try { return new URL(raw).hostname; } catch { return "unparseable"; } })()} and must be refused`);
  }
  assert.equal(validateLensTarget("https://[::ffff:8.8.8.8]/").ok, true);
});

test("lens targets refuse embedded credentials", () => {
  for (const raw of ["https://user:pass@example.com/", "https://user@example.com/", "https://:pass@example.com/"]) {
    assert.equal(validateLensTarget(raw).ok, false, `should refuse ${raw}`);
  }
  assert.equal(validateLensTarget("https://example.com/user:pass@notauth").ok, true, "a colon in the PATH is not a credential");
});

test("redirect following validates every hop, not just the landing", async () => {
  const seen = [];
  const chain = {
    "https://example.com/start": { status: 302, location: "https://example.com/second" },
    "https://example.com/second": { status: 302, location: "http://169.254.169.254/latest/meta-data/" },
    "https://example.com/ok": { status: 200 },
  };
  const originalFetch = globalThis.fetch;
  testGlobals.fetch = async (url) => {
    seen.push(String(url));
    const hop = chain[String(url)] ?? { status: 200 };
    return new Response(null, { status: hop.status, headers: hop.location ? { location: hop.location } : {} });
  };
  try {
    const check = (candidate) => validateLensTarget(candidate);
    const blocked = await fetchFollowingPublicRedirects("https://example.com/start", () => ({}), check);
    assert.equal(blocked.ok, false, "a hop into link-local space must be refused");
    assert.ok(!seen.includes("http://169.254.169.254/latest/meta-data/"), "the blocked host must never be requested");
    assert.equal(seen.length, 2, "it stops at the refusal instead of continuing");

    const fine = await fetchFollowingPublicRedirects("https://example.com/ok", () => ({}), check);
    assert.equal(fine.ok, true);
    assert.equal(fine.finalUrl, "https://example.com/ok");

    testGlobals.fetch = async (url) => new Response(null, { status: 302, headers: { location: `${url}x` } });
    const looping = await fetchFollowingPublicRedirects("https://example.com/loop", () => ({}), check, 3);
    assert.equal(looping.ok, false, "an endless redirect chain is bounded");
  } finally {
    testGlobals.fetch = originalFetch;
  }
});

test("production binds the Durable Object the slot claim needs", async () => {
  const { parseJsonc } = await import("./lib/jsonc.ts");
  const config = "cloudflare.config.ts";
  const parsed = parseJsonc(await configText(config));
  const bindings = parsed.durable_objects?.bindings ?? [];
  const counter = bindings.find((b) => b.name === "COUNTER");
  assert.ok(counter, `${config} must bind COUNTER for the coffee slot claim`);
  assert.equal(counter.class_name, "Counter");
  assert.equal(counter.script_name, "aadhar-counter",
    `${config} must bind COUNTER in aadhar-counter, which owns the class since step 3`);

  // THE SITE IMPLEMENTS NO DURABLE OBJECT, which is the invariant the whole
  // "Moving Counter out" sequence (CLAUDE.md) bought: a Worker that implements
  // one gets no preview URLs. Counter lives in aadhar-counter since 2026-09-29.
  // A class reappearing here, in exports or through a migrations array, takes
  // the previews away again without a single other symptom.
  assert.equal(parsed.migrations, undefined,
    `${config} carries a migrations array, which would make this Worker implement a Durable Object`);
  const classes = Object.entries(parsed.exports ?? {})
    .filter(([, e]) => e?.type === "durable-object")
    .map(([name]) => name);
  assert.deepEqual(classes, [],
    `${config} declares Durable Object classes ${JSON.stringify(classes)}; aadhar-sh must implement none, or it loses preview URLs`);

  const target = parseJsonc(readFileSync("counter/wrangler.jsonc", "utf8"));
  assert.equal(target.name, "aadhar-counter");
  assert.deepEqual(target.exports?.Counter, { type: "durable-object", storage: "sqlite" },
    "counter/wrangler.jsonc must implement Counter as a plain sqlite class");
  const targetClasses = Object.entries(target.exports ?? {}).filter(([, e]) => e?.type === "durable-object").map(([n]) => n);
  assert.deepEqual(targetClasses, ["Counter"],
    `counter/wrangler.jsonc declares Durable Object classes ${JSON.stringify(targetClasses)}; the slot claim assumes Counter is the only one`);
});

test("slot reservations name one Durable Object instance per slot", () => {
  const start = Date.UTC(2026, 7, 10, 14);
  const end = start + 30 * 60_000;
  assert.equal(reservationName(start, end), reservationName(start, end));
  assert.notEqual(reservationName(start, end), reservationName(start + 1, end));
  assert.notEqual(reservationName(start, end), reservationName(start, end + 1));
  assert.notEqual(reservationName(start, end), "homepage-visits");
  assert.match(reservationName(start, end), /^coffee-slot:\d+:\d+$/);
});

test("the census cron's weekday token and the prose about it agree", async () => {
  // SIX WEEKS OF PROSE SAID MONDAY WHILE PRODUCTION FIRED ON SUNDAY. Cloudflare
  // numbers weekdays Quartz-style, 1 = Sunday to 7 = Saturday, where most cron
  // systems use 0 = Sunday, so "17 8 * * 1" is SUNDAY 08:17 UTC. Confirmed
  // against the live lens_census table, whose every cron-written row lands at
  // 08:17 UTC on a Sunday, back to the first sweep on 2026-07-19.
  const CF_WEEKDAYS = { 1: "Sunday", 2: "Monday", 3: "Tuesday", 4: "Wednesday", 5: "Thursday", 6: "Friday", 7: "Saturday" };

  const { parseJsonc } = await import("./lib/jsonc.ts");
  const crons = parseJsonc(await configText("cloudflare.config.ts")).triggers?.crons ?? [];
  assert.ok(crons.length >= 4, `read only ${crons.length} crons from cloudflare.config.ts; the reader is broken`);
  const census = crons.find((expr) => expr.startsWith("17 8 "));
  assert.ok(census, `no census cron found among ${crons.length} expressions`);

  const token = census.split(/\s+/)[4];
  const day = CF_WEEKDAYS[token] || { SUN: "Sunday", MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday" }[token.toUpperCase()];
  assert.ok(day, `unrecognised weekday token ${token}; Cloudflare takes 1-7 or a 3-letter name`);
  assert.equal(day, "Sunday", `the census cron declares ${token}, which Cloudflare fires on ${day}`);

  const claims = (day) => new RegExp(`\\b${day}s\\b|\\b${day}s?\\s+(?:cron|census|sweep|sweeps|pass|08:17)\\b`, "i");

  const scanned = ["src/worker/census.ts", "src/worker/index.ts", "src/worker/lib/cron.ts"];
  const wrong = Object.values(CF_WEEKDAYS).filter((d) => d !== day);
  const findClaims = (src, label) => {
    const hits = [];
    for (const line of src.split("\n")) {
      for (const d of wrong) if (claims(d).test(line)) hits.push(`${label}: ${line.trim().slice(0, 90)}`);
    }
    return hits;
  };

  const control = [
    'await cron("cron.census", () => cronCensus(env));   // Mondays 08:17 UTC',
    "// The Monday cron is now AWAITED by scheduled() and sweeps the whole roster",
  ].join("\n");
  assert.equal(findClaims(control, "control").length, 2, "the matcher no longer catches the claims this test exists for");
  const innocent = [
    "// 1 = Sunday to 7 = Saturday, where most cron systems use 0 = Sunday, so",
    "// Nine comments here said Monday and production fired on Sunday.",
  ].join("\n");
  assert.deepEqual(findClaims(innocent, "innocent"), [], "prose explaining the mapping is not a claim about the schedule");

  const offenders = scanned.flatMap((rel) => findClaims(readFileSync(rel, "utf8"), rel));
  assert.deepEqual(offenders, [], `the census fires on ${day}; these say otherwise:\n  ${offenders.join("\n  ")}`);
});
