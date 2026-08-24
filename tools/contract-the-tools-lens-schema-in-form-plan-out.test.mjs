// ── the Tools lens: schema in, form plan out ────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

// ── the Tools lens: schema in, form plan out ────────────────────────────────
//
// The planner is a browser IIFE, so it is loaded here the way a browser would
// and then exercised directly. Only the DOM builders touch `document`, and they
// are never reached at module scope, so a bare `window` object is enough. The
// alternative was a structural test, and a structural test cannot tell whether a
// numeric enum survives — which is the one property this thing exists to have.
function loadLensTools() {
  const src = readFileSync("./src/client/lens-tools.js", "utf8");
  const win = {};
  new Function("window", "document", src)(win, undefined);
  return win.LensTools;
}

test("the Tools planner keeps an enum's ORIGINAL type, so a numeric enum stays numeric", () => {
  const { _plan } = loadLensTools();
  // The site's own image_transform ships exactly this.
  const plan = _plan({ type: "object", properties: { rotate: { type: "integer", enum: [0, 90, 180, 270] } } });
  const field = plan.fields[0];
  assert.equal(field.kind, "select");
  assert.deepEqual(field.options.map((o) => o.value), [0, 90, 180, 270]);
  assert.equal(typeof field.options[1].value, "number",
    'a select that hands back "90" has misdescribed the call it is previewing');
});

test("every shape a control cannot carry degrades to JSON and names the reason", () => {
  const { _plan } = loadLensTools();
  const plan = _plan({ type: "object", properties: {
    // anyOf is not hypothetical: mcp.deepwiki.com's ask_question.repoName is one.
    either: { anyOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }] },
    linked: { $ref: "#/definitions/Thing" },
    loose: { type: "object" },
    tuple: { type: "array", items: [{ type: "string" }] },
    mystery: { description: "no type at all" },
    both: { type: ["string", "number"] },
  } });
  for (const field of plan.fields) {
    assert.equal(field.kind, "json", `${field.name} must degrade rather than be guessed at`);
    assert.ok(field.why && field.why.length, `${field.name} must say why`);
  }
  assert.match(plan.fields[0].why, /anyOf/);
  assert.match(plan.fields[5].why, /union/);
});

test("the Tools planner bounds recursion and reports the boundary", () => {
  const { _plan } = loadLensTools();
  const leaf = { type: "object", properties: { e: { type: "string" } } };
  const deep = { type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: {
    c: { type: "object", properties: { d: leaf } } } } } } } };
  let field = _plan(deep).fields[0], depth = 0;
  while (field && field.kind === "group") { depth += 1; field = field.fields[0]; }
  assert.ok(depth <= 3, `stopped nesting at ${depth}`);
  assert.equal(field.kind, "json");
  assert.match(field.why, /nesting deeper/);
});

test("a tool with no arguments says so instead of rendering an empty form", () => {
  const { _plan } = loadLensTools();
  assert.match(_plan({ type: "object" }).notes[0], /no arguments/);
  assert.match(_plan(undefined).notes[0], /no inputSchema/);
  assert.ok(_plan({ type: "object", additionalProperties: true, properties: { a: { type: "string" } } })
    .notes.some((n) => /additionalProperties/.test(n)));
});

test("a blank optional is omitted from the frame, never sent as an empty string", () => {
  const { _frame, _validate, _plan } = loadLensTools();
  const frame = _frame("search_site", { q: "photos", limit: undefined, note: "" });
  assert.deepEqual(frame.params.arguments, { q: "photos" });
  assert.equal(frame.method, "tools/call");
  assert.equal(frame.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  const plan = _plan({ type: "object", properties: { q: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["q"] });
  assert.deepEqual(_validate(plan, { limit: 99 }), [
    { at: "q", why: "required" }, { at: "limit", why: "above maximum 50" }]);
});

test("the Tools pane builds foreign strings as NODES, never as markup", () => {
  // Tool names, descriptions and enum labels all come from a stranger's server.
  // public/terminal.js follows the same rule for third-party page titles; this is
  // that rule made checkable, because the failure is a stored XSS and the diff
  // that introduces it looks like ordinary convenience.
  const src = readFileSync("./src/client/lens-tools.js", "utf8");
  const forms = src.slice(src.indexOf("function buildField"));
  assert.ok(!/\.innerHTML\s*=/.test(forms), "the form builders must not assign innerHTML");
  assert.ok(/createElement/.test(src) && /textContent/.test(src), "the builders create nodes and set text");
});

test("the Tools lens reads a catalogue and has NO path to calling a tool", () => {
  // The whole safety argument: /lens must never become a public button that
  // fires strangers' tools from this account's IP and under AadharshBot's
  // signature. Same shape as lens-wire's single-params.get assertion.
  const client = readFileSync("./src/client/lens-tools.js", "utf8");
  const fetches = client.match(/fetch\(/g) || [];
  assert.equal(fetches.length, 1, "the pane makes exactly one request, to our own route");
  assert.ok(client.includes('fetch("/lens/tools?url="'), "and that request is /lens/tools");

  const worker = readFileSync("./src/worker/lens-tools.ts", "utf8");
  assert.ok(worker.includes("foreignMcpTools"), "the route reaches the network only through lib/doors.js");
  assert.ok(!/["'`]tools\/call["'`]/.test(worker), "the route must never name tools/call");
  assert.ok(!/\bfetch\(/.test(worker), "the route adds no new way out to the network");
});

test("foreignMcpTools carries schemas ONLY when asked, and drops one it cannot bound", async () => {
  const { DOOR_LIMITS } = await import("../src/worker/lib/doors.ts");
  const doors = readFileSync("./src/worker/lib/doors.ts", "utf8");
  assert.ok(DOOR_LIMITS.schemaBytes > 0, "a foreign schema is bounded like every other foreign string");
  // Truncating JSON is not an option: half a schema is not a schema, and a form
  // built from one silently describes the wrong contract. So the cap drops the
  // schema whole and flags it, and the pane says "too large to carry" rather
  // than the opposite claim, "takes no arguments".
  assert.ok(/oversize/.test(doors), "an over-cap schema is reported rather than silently absent");
  assert.ok(/if \(!opts\.schemas\) return row;/.test(doors),
    "the three prose callers keep the catalogue they already had");
});
