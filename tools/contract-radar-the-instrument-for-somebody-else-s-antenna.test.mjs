// ── /radar — the instrument for somebody else's antenna ─────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  context,
  handleTool,
  terminalEnv,
  test,
} from "./contract-shared.mjs";

// ── /radar — the instrument for somebody else's antenna ─────────

test("radar drops readings that are not dBm, and bounds the rest", async () => {
  // The caller is a shell script somebody wrote in five minutes, so a bad sample
  // is dropped rather than fatal. dBm is negative by definition: a positive
  // number is a unit mistake, not a very strong signal, and plotting it would
  // put a device inside the centre ring.
  const { readSamples, RADAR_LIMITS } = await import("../src/worker/radar.ts");
  const parsed = readSamples({ samples: [
    { name: "ok", rssi: -58 },
    { name: "positive", rssi: 5 },
    { name: "absurd", rssi: -900 },
    { name: "nan", rssi: "loud" },
    { rssi: -70 },
  ] });
  assert.deepEqual(parsed.map((p) => p.name), ["ok", "unknown"]);
  assert.equal(parsed[0].rssi, -58);
  // Strongest first: the thing you are hunting belongs at the top.
  assert.ok(parsed[0].rssi > parsed[1].rssi);
  // Bounded on count and name length.
  const many = readSamples({ samples: Array.from({ length: 200 }, (_, i) => ({ name: "x".repeat(300), rssi: -50 - i % 40 })) });
  assert.equal(many.length, RADAR_LIMITS.samples);
  assert.equal(many[0].name.length, RADAR_LIMITS.name);
});

test("radar bands match findphone's field calibration", async () => {
  const { bandOf } = await import("../src/worker/radar.ts");
  assert.equal(bandOf(-40).label, "arm's reach");
  assert.equal(bandOf(-45).label, "arm's reach");
  assert.equal(bandOf(-55).label, "same table");
  assert.equal(bandOf(-70).label, "same room");
  assert.equal(bandOf(-80).label, "next room");
  assert.equal(bandOf(-95).label, "far / noise");
});

test("the radar frame fits 80 columns and says its angles are meaningless", async () => {
  // The honesty line is load-bearing, not decoration: RSSI is a scalar and a
  // plot with angles invites a reader to infer a direction that is not there.
  const res = await handleTool(new Request("https://aadhar.sh/radar?plain=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ samples: [{ name: "AP", rssi: -58, kind: "wifi", history: [-70, -62, -58] }, { name: "Buds", rssi: -44 }] }),
  }), terminalEnv(), context());
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const line of text.split("\n").filter(Boolean)) {
    assert.ok([...line].length <= 80, `radar drew a ${[...line].length}-column row`);
  }
  // The honesty line is the point of this test and survives the chrome strip
  // untouched — it was never part of the border.
  assert.match(text, /ANGLES ARE DECORATIVE/);
  assert.match(text, /-58 dBm/);
  assert.match(text, /arm's reach/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("radar is the only program that accepts a POST", async () => {
  // The surface stays read-only apart from the one route whose input this server
  // structurally cannot produce. A new POST-shaped program should have to argue
  // for itself here rather than arrive by accident.
  for (const app of ["finger", "photos", "lens", "dict"]) {
    const res = await handleTool(new Request(`https://aadhar.sh/${app}`, { method: "POST" }), terminalEnv(), context());
    assert.equal(res.status, 405, `${app} accepted a POST`);
    assert.equal(res.headers.get("allow"), "GET, HEAD");
  }
  const radar = await handleTool(new Request("https://aadhar.sh/radar", { method: "PUT" }), terminalEnv(), context());
  assert.equal(radar.status, 405);
  assert.equal(radar.headers.get("allow"), "GET, HEAD, POST");
});

test("an empty or malformed radar payload explains itself instead of 500ing", async () => {
  for (const body of ["", "not json", JSON.stringify({ samples: [] })]) {
    const res = await handleTool(new Request("https://aadhar.sh/radar?plain=1", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }), terminalEnv(), context());
    assert.equal(res.status, 200);
    assert.match(await res.text(), /no usable readings|needs a name and an rssi/i);
  }
});
