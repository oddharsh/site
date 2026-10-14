// ── the WebMCP catalog: read it, never call it ─────────────────────────────
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { WEBMCP_LIMITS, WEBMCP_PROBE, readWebmcpProbe } from "../src/worker/lib/agent-webmcp.ts";

const SOURCE = readFileSync("./src/worker/lib/agent-webmcp.ts", "utf8");
const WIRE = readFileSync("./src/worker/lens-wire.ts", "utf8");

test("the probe reads the catalog and can never call anything in it", () => {
  const code = SOURCE.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  assert.ok(!/executeTool/.test(code),
    "agent-webmcp.ts CALLS executeTool; the probe must only ever read getTools()");
  assert.ok(/getTools\(\)/.test(WEBMCP_PROBE), "the probe should read getTools()");
  assert.ok(!/\$\{(?!WEBMCP_LIMITS)/.test(WEBMCP_PROBE.replace(/\$\{[\d]+\}/g, "")),
    "the probe expression must interpolate nothing but its own caps");
});

test("awaitPromise is set, because getTools() is async", () => {
  // Without it the evaluate resolves to a pending Promise handle and every
  // origin reads as having no tools, which is indistinguishable from the truth
  // on a site that has none. This is the single option the feature rests on.
  const at = WIRE.indexOf("expression: WEBMCP_PROBE");
  assert.ok(at > 0, "lens-wire.ts no longer sends the probe to Runtime.evaluate");
  const call = WIRE.slice(at, at + 200);
  assert.ok(/awaitPromise:\s*true/.test(call),
    "the WebMCP evaluate must set awaitPromise: true");
});

test("a tool that states no readOnlyHint is a THIRD state, never a safe one", () => {
  const out = readWebmcpProbe({
    present: true, count: 3, read: 1, write: 1, unstated: 1,
    origins: ["https://example.com"], tools: [{ name: "a" }, { name: "b" }, { name: "c" }],
  });
  assert.ok(out, "a well-formed probe payload must not read as absent");
  assert.equal(out.read, 1);
  assert.equal(out.write, 1);
  assert.equal(out.unstated, 1);
  assert.equal(out.read + out.write + out.unstated, out.count,
    "the three columns must account for every tool");
});

test("an engine with no WebMCP is UNMEASURABLE, never a site with no tools", () => {
  const out = readWebmcpProbe({ supported: false });
  assert.ok(out, "an unsupported engine must still return a record");
  assert.equal(out.supported, false);
  assert.equal(out.present, null, "an engine that cannot look must not report absence");
  assert.equal(out.count, 0);
  const empty = readWebmcpProbe({ supported: true, present: false });
  assert.ok(empty, "a supported-but-empty probe must still return a record");
  assert.equal(empty.supported, true);
  assert.equal(empty.present, false);
});

test("the engine label comes from CDP, never from the page's user agent", () => {
  assert.ok(!/navigator\.userAgent/.test(WEBMCP_PROBE),
    "the probe must not report navigator.userAgent; this route overrides it");
  assert.ok(/Browser\.getVersion/.test(WIRE),
    "lens-wire.ts should read the engine from CDP");
});

test("a probe that could not run is ABSENT, never an empty catalog", () => {
  assert.equal(readWebmcpProbe(null), null, "no payload is not an empty catalog");
  assert.equal(readWebmcpProbe("nonsense"), null);
  const errored = readWebmcpProbe({ probeError: "boom" });
  assert.ok(errored, "a probe error must still return a record");
  assert.equal(errored.present, null, "a probe error must not read as present:false");
  assert.equal(errored.error, "boom");
  const empty = readWebmcpProbe({ present: false });
  assert.ok(empty, "a ran-and-found-nothing probe must still return a record");
  assert.equal(empty.present, false);
  assert.equal(empty.count, 0);
  assert.equal(empty.supported, true, "reaching this branch means the engine could look");
});

test("every axis of a stranger's catalog is bounded", () => {
  for (const [key, cap] of Object.entries(WEBMCP_LIMITS)) {
    assert.ok(Number.isInteger(cap) && cap > 0 && cap <= 1000, `${key} cap should be a small positive integer`);
  }
  for (const cap of [WEBMCP_LIMITS.tools, WEBMCP_LIMITS.description, WEBMCP_LIMITS.params, WEBMCP_LIMITS.name]) {
    assert.ok(WEBMCP_PROBE.includes(String(cap)), `cap ${cap} never reaches the probe expression`);
  }
  const out = readWebmcpProbe({ present: true, count: 500, origins: Array(50).fill("https://x.test"), tools: [] });
  assert.ok(out && out.origins && out.origins.length <= 8, "origins must be capped on the way out too");
});

test("the wire payload separates 'did not run' from 'registered nothing'", () => {
  assert.ok(/webmcp: out\.webmcp \|\| null/.test(WIRE),
    "the payload should carry webmcp, null when the probe could not run");
});
