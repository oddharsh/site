// ── the WebMCP catalog: read it, never call it ─────────────────────────────
//
// The Tools tab reads /mcp, a SERVER catalog anything can POST to. This one is
// the other kind: tools a page registers into document.modelContext with its own
// JavaScript, which nothing you can fetch will ever reveal. Reading them means
// running the page, so the probe rides the CDP session /lens/wire already opens.
//
// Two invariants, and the first is a security boundary rather than a preference.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { WEBMCP_LIMITS, WEBMCP_PROBE, readWebmcpProbe } from "../src/worker/lib/agent-webmcp.ts";

const SOURCE = readFileSync("./src/worker/lib/agent-webmcp.ts", "utf8");
const WIRE = readFileSync("./src/worker/lens-wire.ts", "utf8");

test("the probe reads the catalog and can never call anything in it", () => {
  // Executing a stranger's tool from a render this site initiated is the
  // remote-code-execution proxy lens-recipes.ts refuses to become, one layer in.
  // The tool being named `delete_document` would not stop it.
  // Comments are stripped first: this module's own header EXPLAINS the rule by
  // naming the method, and a scanner that cannot tell prose from code would
  // either fail on that sentence or have to be silenced into uselessness. Same
  // shape as the modelContext ownership check next door.
  const code = SOURCE.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  assert.ok(!/executeTool/.test(code),
    "agent-webmcp.ts CALLS executeTool; the probe must only ever read getTools()");
  assert.ok(/getTools\(\)/.test(WEBMCP_PROBE), "the probe should read getTools()");
  // No caller byte reaches the evaluated expression: it is a constant.
  assert.ok(!/\$\{(?!WEBMCP_LIMITS)/.test(WEBMCP_PROBE.replace(/\$\{[\d]+\}/g, "")),
    "the probe expression must interpolate nothing but its own caps");
});

test("awaitPromise is set, because getTools() is async", () => {
  // Without it the evaluate resolves to a pending Promise handle and every
  // origin reads as having no tools, which is indistinguishable from the truth
  // on a site that has none. This is the single option the feature rests on.
  // indexOf finds the IMPORT first, which is not the call site.
  const at = WIRE.indexOf("expression: WEBMCP_PROBE");
  assert.ok(at > 0, "lens-wire.ts no longer sends the probe to Runtime.evaluate");
  const call = WIRE.slice(at, at + 200);
  assert.ok(/awaitPromise:\s*true/.test(call),
    "the WebMCP evaluate must set awaitPromise: true");
});

test("a tool that states no readOnlyHint is a THIRD state, never a safe one", () => {
  // Chrome carries exactly one of MCP's five annotations across registration, so
  // read-vs-write is the most a visitor can be told. Folding "the page never
  // said" into either column invents a claim the page did not make.
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
  // Measured 2026-08-25 against the real binding: Browser Run renders in
  // Chrome/128.0.6613.137, and WebMCP's origin trial is Chrome 149-156. So this
  // engine cannot see a catalogue on ANY origin, and the first version of this
  // probe reported that as `present: false` for aadhar.sh/whoareyou, a page
  // measured at 25 registered tools minutes earlier. On the one surface whose
  // premise is never reporting a failed check as a negative result, that is the
  // worst bug it could have shipped.
  const out = readWebmcpProbe({ supported: false });
  assert.ok(out, "an unsupported engine must still return a record");
  assert.equal(out.supported, false);
  assert.equal(out.present, null, "an engine that cannot look must not report absence");
  assert.equal(out.count, 0);
  // Supported and genuinely empty is a DIFFERENT claim.
  const empty = readWebmcpProbe({ supported: true, present: false });
  assert.ok(empty, "a supported-but-empty probe must still return a record");
  assert.equal(empty.supported, true);
  assert.equal(empty.present, false);
});

test("the engine label comes from CDP, never from the page's user agent", () => {
  // /lens/wire overrides navigator.userAgent to AadharshBot, so asking the page
  // which browser it is returns this site's own mask. It did, once: the reading
  // came back `engine: "AadharshBot/1.0 (+https://aadhar.sh/bot)"`.
  assert.ok(!/navigator\.userAgent/.test(WEBMCP_PROBE),
    "the probe must not report navigator.userAgent; this route overrides it");
  assert.ok(/Browser\.getVersion/.test(WIRE),
    "lens-wire.ts should read the engine from CDP");
});

test("a probe that could not run is ABSENT, never an empty catalog", () => {
  // /lens's standing rule: never report a failed check as a negative result.
  assert.equal(readWebmcpProbe(null), null, "no payload is not an empty catalog");
  assert.equal(readWebmcpProbe("nonsense"), null);
  const errored = readWebmcpProbe({ probeError: "boom" });
  assert.ok(errored, "a probe error must still return a record");
  assert.equal(errored.present, null, "a probe error must not read as present:false");
  assert.equal(errored.error, "boom");
  // Ran, and the page really registered nothing. A different claim.
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
  // The caps have to reach the probe, or they are documentation.
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
