// ── the perf probe ──────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
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
  // no PERF_PROBE binding -> a clean no-op, so preview/dev without the dataset
  // cannot crash the scheduled() handler
  await cronHomeProbe({}, { waitUntil() {} });

  // Integration with the real handlers: the grid uses the bundled photo pool,
  // while tracks returns an error response without KV. Both returns are timed.
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
  // Load the unchanged module against controlled fragment handlers. This makes
  // both failure paths reachable without adding a test-only production API.
  const root = await mkdtemp(join(tmpdir(), "fragment-probe-"));
  const now = Date.now;
  try {
    await mkdir(join(root, "lib"));
    await copyFile(new URL("../src/worker/perf-probe.ts", import.meta.url), join(root, "perf-probe.ts"));
    await writeFile(join(root, "lib/const.ts"), 'export const CANONICAL_HOST = "fixture.example";');
    await writeFile(join(root, "home.ts"), 'import { fragment } from "./fixture.mjs"; export const handlePhotoGrid = (...args) => fragment("grid", ...args);');
    await writeFile(join(root, "rn.ts"), 'import { fragment } from "./fixture.mjs"; export const handleRnTracksHtml = (...args) => fragment("tracks", ...args);');
    await writeFile(join(root, "fixture.mjs"), `
      export const state = { clock: 100, phases: {}, events: [], requests: [] };
      export async function fragment(kind, request, env, ctx) {
        const phase = state.phases[kind];
        state.events.push(kind);
        state.requests.push({ request, env, ctx });
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
  // wrangler.jsonc, but Cloudflare normalizes expressions between declaration
  // and delivery (day-of-week tokens especially), and the census schedule is
  // the only one carrying a day-of-week token: three straight weekly sweeps
  // fell into the else-branch and ran the /around crawl with nothing logged.
  // The rule now matches minute+hour signatures, which normalization leaves
  // alone, so EVERY spelling must land on the census.
  //
  // "17 8 * * 1" IS SUNDAY, and this test used to assert MON as its alias,
  // which is what a reader would reach for when checking the pairing. Both are
  // asserted now, because the property is that the matcher ignores the weekday
  // field entirely; pinning one "correct" alias is what let the wrong one sit
  // here unquestioned.
  assert.equal(cronJob("17 8 * * 1"), "census");
  assert.equal(cronJob("17 8 * * SUN"), "census");
  assert.equal(cronJob("17 8 * * MON"), "census");
  assert.equal(cronJob("7,37 * * * *"), "home_probe");
  assert.equal(cronJob("41 5 * * *"), "daily_outbound");
  assert.equal(cronJob("23 */6 * * *"), "serendipity");
  // "*/30 * * * *" was the /around crawl until 2026-08-14, when it folded onto
  // the daily outbound tick. It must now be UNMATCHED rather than quietly
  // running somebody else's job, which is the same property the census bug
  // above is about: a retired expression is exactly as dangerous as a
  // normalized one if the else-chain catches it.
  assert.equal(cronJob("*/30 * * * *"), null);
  // Unknown expressions surface as null (a traced cron.unmatched event), never
  // as somebody else's job — that silent fallback is the bug class this fixes.
  assert.equal(cronJob("0 0 * * *"), null);
  assert.equal(cronJob(""), null);
  assert.equal(cronJob(null), null);
});

// The SSRF host floor is shared by /lens, webmention verification, and
// serendipity's cover proxy. It used to be two byte-identical copies
// (lensHostBlocked + coverHostBlocked); this pins the set so the one that is
// left cannot quietly narrow, which is the failure the duplication invited.
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
    "localhost.example.com",              // ends in a real TLD, not a bare localhost
  ];
  for (const h of allowed) assert.equal(privateHostBlocked(h), false, `should allow ${h}`);
});

// Each shape below was measured passing this floor on 2026-08-07, so these are
// closed holes rather than hypotheticals. The v4-mapped rows are the ones worth
// keeping honest: the whole dotted-quad table was being skipped for an address
// spelled ::ffff:169.254.169.254, which is the metadata endpoint by another name.
test("the SSRF floor covers the alternate spellings of a blocked host", () => {
  const blocked = [
    "localhost.", "127.0.0.1.", "db.internal.",     // trailing dot is a legal FQDN
    "::", "[::]",                                    // unspecified address
    "::ffff:127.0.0.1", "[::ffff:169.254.169.254]",  // v4-mapped IPv6
    "::ffff:10.0.0.1", "::ffff:192.168.1.1",
    "fe81::1", "fe9f::1", "fea0::1", "febf::1",      // fe80::/10 is 64 prefixes, not one
    "LOCALHOST", "169.254.169.254.",                 // case and dot together
    "",                                              // an empty host resolves to nothing good
  ];
  for (const h of blocked) assert.equal(privateHostBlocked(h), true, `should block ${h}`);

  // Both spellings of a v4-mapped address, because the caller decides which one
  // this function sees and it is NOT the one written above.
  const mappedHex = ["::ffff:a9fe:a9fe", "::ffff:7f00:1", "::ffff:a00:1", "::ffff:c0a8:101"];
  for (const h of mappedHex) assert.equal(privateHostBlocked(h), true, `should block ${h}`);

  // The neighbours of the widened rules must still pass, or the fix overreached.
  const allowed = ["fec0::1", "ff00::1".replace("ff00", "2001"), "::ffff:8.8.8.8", "::ffff:808:808", "example.com."];
  for (const h of allowed) assert.equal(privateHostBlocked(h), false, `should allow ${h}`);
});

// THE regression, and the reason this test exists separately from the one above.
//
// `new URL("https://[::ffff:169.254.169.254]/").hostname` is `[::ffff:a9fe:a9fe]`
// — the WHATWG parser rewrites the dotted tail into hex groups. So the host this
// guard actually receives is never the host anybody types, and a floor tested
// only on the typed form reported a hole closed while it was open. Production
// answered `ok: true` for the metadata address on 2026-08-08, hours after the
// unit test above went green.
//
// Assert through validateLensTarget, which is the door every scan really uses.
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
  // A public v4-mapped address is still a public address.
  assert.equal(validateLensTarget("https://[::ffff:8.8.8.8]/").ok, true);
});

// A scan republishes what it fetched, so a URL carrying credentials is refused
// rather than stripped: stripping would scan a different resource than the one
// that was typed, and pass the secret to the third party on the way.
test("lens targets refuse embedded credentials", () => {
  for (const raw of ["https://user:pass@example.com/", "https://user@example.com/", "https://:pass@example.com/"]) {
    assert.equal(validateLensTarget(raw).ok, false, `should refuse ${raw}`);
  }
  assert.equal(validateLensTarget("https://example.com/user:pass@notauth").ok, true, "a colon in the PATH is not a credential");
});

// The guard follows redirects one hop at a time so a public URL cannot bounce
// into private space. Before this, the request to the blocked host was still
// made; only the discovery fan-out that came after it was skipped.
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

// Booking degrades to the old behaviour without a COUNTER binding, so that cal
// stays runnable and testable with no Durable Object, the same way a missing
// BOOKING_WORKFLOW only costs the expiry timer. That fallback is only acceptable
// while production genuinely binds it: unbound, two simultaneous bookings take
// the same slot again and nothing says so. This is the assertion that keeps the
// degraded path from quietly becoming the real one.
test("production binds the Durable Object the slot claim needs", async () => {
  const { parseJsonc } = await import("./lib/jsonc.ts");
  for (const config of ["wrangler.jsonc", "wrangler.dev.jsonc"]) {
    const parsed = parseJsonc(readFileSync(config, "utf8"));
    const bindings = parsed.durable_objects?.bindings ?? [];
    const counter = bindings.find((b) => b.name === "COUNTER");
    assert.ok(counter, `${config} must bind COUNTER for the coffee slot claim`);
    assert.equal(counter.class_name, "Counter");

    // The claim rides the EXISTING class on purpose: a second class needs a
    // new_sqlite_classes migration, and `wrangler versions upload` cannot apply
    // one. If someone adds that migration later this assertion should be
    // revisited deliberately rather than silently outgrown.
    const classes = (parsed.migrations ?? []).flatMap((m) => m.new_sqlite_classes ?? []);
    assert.deepEqual(classes, ["Counter"],
      `${config} declares Durable Object classes ${JSON.stringify(classes)}; the slot claim assumes Counter is the only one`);
  }
});

// One instance per slot is the entire exclusivity argument: two different times
// must never share an instance, and one time must always resolve to the same
// one. It also must not collide with the visit counter's instance name.
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
  //
  // Nothing in this repo could catch that: the dispatcher matches minute+hour
  // and so is correct either way, and the day survived only in comments and in
  // one line of shipped banner copy. This is the check that makes the pairing
  // fail loudly instead of drifting, and it fires in both directions, so
  // changing the SCHEDULE without changing the copy is caught too.
  const CF_WEEKDAYS = { 1: "Sunday", 2: "Monday", 3: "Tuesday", 4: "Wednesday", 5: "Thursday", 6: "Friday", 7: "Saturday" };

  const { parseJsonc } = await import("./lib/jsonc.ts");
  const crons = parseJsonc(readFileSync("wrangler.jsonc", "utf8")).triggers?.crons ?? [];
  assert.ok(crons.length >= 4, `read only ${crons.length} crons from wrangler.jsonc; the reader is broken`);
  const census = crons.find((expr) => expr.startsWith("17 8 "));
  assert.ok(census, `no census cron found among ${crons.length} expressions`);

  const token = census.split(/\s+/)[4];
  const day = CF_WEEKDAYS[token] || { SUN: "Sunday", MON: "Monday", TUE: "Tuesday", WED: "Wednesday", THU: "Thursday", FRI: "Friday", SAT: "Saturday" }[token.toUpperCase()];
  assert.ok(day, `unrecognised weekday token ${token}; Cloudflare takes 1-7 or a 3-letter name`);
  assert.equal(day, "Sunday", `the census cron declares ${token}, which Cloudflare fires on ${day}`);

  // No source file may CLAIM a different weekday for this cron. The matcher
  // reads a claim rather than a mention, because the fix for this bug has to be
  // able to explain the mapping it is fixing: "1 = Sunday to 7 = Saturday" names
  // five wrong days and asserts nothing about when the census runs. A claim is
  // the plural ("Mondays"), or the day sitting directly on the thing it
  // schedules ("the Monday cron", "Monday sweeps", "Monday 08:17").
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

  // CONTROL, because a matcher that has stopped matching reports a clean pass
  // and this one is deliberately narrow. Every shape the repair removed must
  // still be caught, and the explanatory prose beside it must not be.
  //
  // Only SCHEDULE claims are in scope. The ninth thing this repair fixed was
  // "both spellings of Monday must land on the census", a claim about which
  // alias means 1 rather than about when the job runs, and it is deliberately
  // not covered: the matcher that would catch it also catches the prose two
  // lines above explaining the mapping. It is fixed directly in the test above.
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
