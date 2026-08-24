// ── the perf probe ──────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  assert,
  cronHomeProbe,
  cronJob,
  fetchFollowingPublicRedirects,
  parseServerTiming,
  privateHostBlocked,
  readFileSync,
  reservationName,
  test,
  validateLensTarget,
} from "./contract-shared.mjs";

// ── the perf probe ──────────────────────────────────────────────────
// The probe's value is that its numbers mean what home.js's Server-Timing
// means. The parser is the seam: if it misreads a span or drops a deadline
// mark, the AE series lies quietly. The datapoint's column order is part of
// the contract too — AE columns are positional, so a reorder here scrambles
// every already-written row's meaning.
test("parseServerTiming reads spans, deadline marks, and survives junk", () => {
  const { spans, deadlined } = parseServerTiming(
    "assets;dur=5, tracks;dur=25;desc=deadline, alt;dur=0, counter;dur=7, total;dur=25",
  );
  assert.deepEqual(spans, { assets: 5, tracks: 25, alt: 0, counter: 7, total: 25 });
  assert.deepEqual(deadlined, ["tracks"]);
  // junk in, nothing invented out
  assert.deepEqual(parseServerTiming(null), { spans: {}, deadlined: [] });
  assert.deepEqual(parseServerTiming("garbage"), { spans: {}, deadlined: [] });
  assert.deepEqual(parseServerTiming("x;dur=NaN, ;dur=3").spans, {});
});

test("the probe writes one positionally-stable datapoint and never throws", async () => {
  // no PERF_PROBE binding -> a clean no-op, so preview/dev without the dataset
  // cannot crash the scheduled() handler
  await cronHomeProbe({}, { waitUntil() {} });

  // The probe used to dispatch the homepage SSR, which needed ASSETS +
  // HTMLRewriter, so a bindingless env was itself the "broken render" case and
  // this asserted the resulting gap. `/` is a static document now and the probe
  // follows the two fragments instead; the photo grid answers from the BUNDLED
  // pool, so it succeeds with no bindings at all and there is no longer an env
  // that fails both arms by omission. The write-nothing rule still holds in the
  // code (both arms null -> early return), it just cannot be provoked this way.
  //
  // So assert what this env can actually prove: exactly one datapoint, with the
  // positional arity Analytics Engine reads by index. A column silently
  // appearing or vanishing is the failure that corrupts a whole dataset.
  const written = [];
  const env = { PERF_PROBE: { writeDataPoint: (d) => written.push(d) } };
  await cronHomeProbe(env, { waitUntil() {} });
  assert.equal(written.length, 1, "a working probe writes exactly one datapoint");
  const [dp] = written;
  assert.equal(dp.doubles.length, 5, "doubles are positional: [assets, tracks, alt, counter, total]");
  assert.ok(dp.doubles.every((v) => typeof v === "number"), "every double must be a real number");
  assert.equal(dp.blobs.length, 2, "blobs are positional: [deadlined CSV, version id]");
  assert.deepEqual(dp.indexes, ["home"]);
});

test("cron dispatch survives Cloudflare's expression normalization", () => {
  // The dispatcher used to exact-match event.cron against the strings in
  // wrangler.jsonc, but Cloudflare normalizes expressions between declaration
  // and delivery (day-of-week tokens especially), and the census schedule is
  // the only one carrying a day-of-week token: three straight Monday sweeps
  // fell into the else-branch and ran the /around crawl with nothing logged.
  // The rule now matches minute+hour signatures, which normalization leaves
  // alone. Both spellings of Monday must land on the census.
  assert.equal(cronJob("17 8 * * 1"), "census");
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
    const blocked = await fetchFollowingPublicRedirects("https://example.com/start", {}, check);
    assert.equal(blocked.ok, false, "a hop into link-local space must be refused");
    assert.ok(!seen.includes("http://169.254.169.254/latest/meta-data/"), "the blocked host must never be requested");
    assert.equal(seen.length, 2, "it stops at the refusal instead of continuing");

    const fine = await fetchFollowingPublicRedirects("https://example.com/ok", {}, check);
    assert.equal(fine.ok, true);
    assert.equal(fine.finalUrl, "https://example.com/ok");

    testGlobals.fetch = async (url) => new Response(null, { status: 302, headers: { location: `${url}x` } });
    const looping = await fetchFollowingPublicRedirects("https://example.com/loop", {}, check, 3);
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
