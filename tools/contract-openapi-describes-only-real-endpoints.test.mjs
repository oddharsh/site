// ── /openapi.json describes only endpoints this origin serves ────────────────
// build.ts writes the spec from lib/public-api.ts, whose numbers are the
// constants the handlers enforce. What can still drift is the description
// itself: a path the Worker no longer answers, or an operation that lost what
// makes it usable for function calling (a unique operationId, a description,
// typed parameters, a response schema). Both are checked here, plus the two
// documents that point agents at it.
import { readFileSync, existsSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { EXACT_PATHS, PREFIX_ROUTES } from "../src/worker/routes.ts";
import { openApiDocument } from "../src/worker/lib/openapi.ts";
import { ASK_LIMITS, PHOTO_QUERY_LIMITS, SEARCH_LIMITS } from "../src/worker/lib/api-limits.ts";
import { LENS_BUDGETS } from "../src/worker/lens-pipeline.ts";

const spec = JSON.parse(JSON.stringify(openApiDocument()));
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const operations = Object.entries(spec.paths).flatMap(([path, item]) => METHODS.filter((m) => item[m]).map((method) => ({ path, method, op: item[method] })));

test("the spec is OpenAPI 3.1 for this origin, keyless", () => {
  assert.match(spec.openapi, /^3\.1\.\d+$/);
  assert.deepEqual(
    spec.servers.map((s) => s.url),
    ["https://aadhar.sh"],
  );
  assert.match(spec.servers[0].description, /sandbox/, "production is named as the sandbox, since it is one");
  assert.deepEqual(spec.security, [], "no endpoint needs a key");
  assert.ok(spec.info.title && spec.info.version && spec.info.description);
  assert.ok(operations.length >= 10);
});

test("every path is one the Worker routes or a file the site ships", () => {
  for (const path of Object.keys(spec.paths)) {
    const routed = EXACT_PATHS.includes(path) || PREFIX_ROUTES.some((r) => r.match(path));
    assert.ok(routed || existsSync(`public${path}`), `${path} is in /openapi.json and nothing serves it`);
  }
  assert.ok(!Object.keys(spec.paths).includes("/hit"), "a GET that writes state stays out of a read-only API");
});

test("every operation is usable for function calling", () => {
  const ids = operations.map((o) => o.op.operationId);
  assert.equal(new Set(ids).size, ids.length, "operationIds are unique");
  for (const { path, method, op } of operations) {
    const at = `${method.toUpperCase()} ${path}`;
    assert.match(op.operationId || "", /^[a-z][A-Za-z0-9]+$/, `${at}: camelCase operationId`);
    assert.ok(op.summary && op.description && op.description.length >= 40, `${at}: a summary and a real description`);
    for (const p of op.parameters || []) {
      assert.ok(p.description, `${at} ?${p.name}: described`);
      assert.ok(p.schema?.type, `${at} ?${p.name}: typed`);
    }
    for (const [status, r] of Object.entries(op.responses)) {
      const content = Object.values(r.content || {});
      assert.ok(content.length && content.every((c) => c.schema), `${at} ${status}: a response schema`);
    }
    assert.ok(
      Object.keys(op.responses).some((s) => s.startsWith("2")),
      `${at}: a success response`,
    );
  }
});

test("every $ref resolves, and the Error shape is the one the site sends", () => {
  const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]);
  for (const name of refs) assert.ok(spec.components.schemas[name], `#/components/schemas/${name} exists`);
  const error = spec.components.schemas.Error;
  assert.deepEqual(error.required, ["error"], "every JSON error carries an error sentence");
  assert.equal(error.properties.error.type, "string", "the site's errors are { error: string }, never an object");
});

test("agents can find it: the API catalog and llms.txt both point at it", () => {
  const catalog = JSON.parse(readFileSync("public/.well-known/api-catalog", "utf8"));
  const hrefs = catalog.linkset.flatMap((l) =>
    Object.values(l)
      .filter(Array.isArray)
      .flat()
      .map((x) => x.href),
  );
  assert.ok(hrefs.includes("https://aadhar.sh/openapi.json"), "api-catalog links the spec");
  assert.match(readFileSync("public/llms.txt", "utf8"), /\(https:\/\/aadhar\.sh\/openapi\.json\)/, "llms.txt links the spec");
  const spec = "https://aadhar.sh/openapi.json";
  const ard = JSON.parse(readFileSync("public/.well-known/ard.json", "utf8"));
  const entry = ard.entries.find((e) => e.url === spec);
  assert.ok(entry, "the ARD manifest names the spec");
  assert.equal(entry.type, "application/vnd.oai.openapi+json", "under OpenAPI's own media type, the one api-catalog uses");
  const card = JSON.parse(readFileSync("public/.well-known/agent-card.json", "utf8"));
  assert.equal(card["x-aadhar-sh"].discovery.openapi, spec, "the agent card's discovery map names the spec");
});

test("the published numbers are the enforced ones", () => {
  const param = (path, name, method = "get") => spec.paths[path][method].parameters.find((p) => p.name === name).schema;
  assert.equal(param("/search.json", "limit").maximum, SEARCH_LIMITS.limitMax);
  assert.equal(param("/search.json", "limit").default, SEARCH_LIMITS.limitDefault);
  assert.equal(param("/search.json", "q").maxLength, SEARCH_LIMITS.queryMax);
  assert.equal(param("/photos/query.json", "offset").maximum, PHOTO_QUERY_LIMITS.offsetMax);
  assert.equal(param("/ask", "top_k").default, ASK_LIMITS.topKDefault);
  assert.match(spec.paths["/lens/fetch"].get.description, new RegExp(`a ${LENS_BUDGETS.inspect.max} per minute`));
  assert.ok(!existsSync("public/openapi.json"), "the spec is build output; a committed copy would be a second source");
  for (const file of ["src/worker/index.ts", "src/worker/trust.ts", "src/worker/lib/public-api.ts"]) {
    assert.ok(!/from "\.\.?\/(lib\/)?openapi\.ts"/.test(readFileSync(file, "utf8")), `${file} keeps the schemas out of the Worker bundle`);
  }
});

test("every 429 the spec documents carries the Retry-After the site sends", async () => {
  const { RATE_WINDOW_S } = await import("../src/worker/lib/ratelimit.ts");
  const limited = operations.filter(({ op }) => op.responses["429"]);
  assert.ok(limited.length >= 2, "the Lens doors document their budgets");
  for (const { path, method, op } of limited) {
    const header = op.responses["429"].headers?.["Retry-After"];
    assert.ok(header, `${method.toUpperCase()} ${path}: 429 documents Retry-After`);
    assert.equal(header.schema.maximum, RATE_WINDOW_S);
  }
});

test("every response schema is typed all the way down", () => {
  // A function-calling client builds its types from these. An empty schema
  // ({}), an object with no properties to name, or additionalProperties: true
  // all read as "anything", which is how 7 of 14 operations scored as untyped.
  /** @returns {string[]} */
  function untyped(node, at, seen = new Set()) {
    if (!node || typeof node !== "object") return [];
    if (node.$ref) {
      const name = node.$ref.split("/").pop();
      if (seen.has(name)) return [];
      return untyped(spec.components.schemas[name], `#${name}`, new Set([...seen, name]));
    }
    const variants = node.anyOf || node.oneOf;
    if (variants) return variants.flatMap((v, i) => untyped(v, `${at}|${i}`, seen));
    const types = [node.type].flat();
    if (!node.type) return [`${at}: no type`];
    const out = [];
    if (types.includes("object")) {
      if (node.additionalProperties === true) out.push(`${at}: additionalProperties: true`);
      const props = Object.entries(node.properties || {});
      if (!props.length && typeof node.additionalProperties !== "object") out.push(`${at}: an object with nothing named`);
      for (const [k, v] of props) out.push(...untyped(v, `${at}.${k}`, seen));
      if (typeof node.additionalProperties === "object") out.push(...untyped(node.additionalProperties, `${at}{}`, seen));
    }
    if (types.includes("array")) out.push(...untyped(node.items, `${at}[]`, seen));
    return out;
  }
  for (const { path, method, op } of operations) {
    for (const [status, r] of Object.entries(op.responses)) {
      for (const [type, c] of Object.entries(r.content || {})) {
        const gaps = untyped(c.schema, `${method.toUpperCase()} ${path} ${status} ${type}`);
        assert.deepEqual(gaps, [], gaps.join("\n"));
      }
    }
  }
  // The control: the walk does see an open object.
  assert.equal(untyped({ type: "object", additionalProperties: true }, "probe").length, 2);
  assert.equal(untyped({}, "probe").length, 1);
});

test("the Lens doors document the RateLimit fields they send", () => {
  for (const path of ["/lens/fetch", "/lens/compare.json"]) {
    const { responses } = spec.paths[path].get;
    assert.ok(responses["200"].headers["RateLimit-Policy"], `${path} 200: RateLimit-Policy`);
    assert.ok(responses["429"].headers.RateLimit && responses["429"].headers["RateLimit-Policy"], `${path} 429: RateLimit and its policy`);
  }
  assert.match(spec.paths["/lens/fetch"].get.responses["200"].headers["RateLimit-Policy"].description, /"inspect";q=\d+;w=60/);
});
