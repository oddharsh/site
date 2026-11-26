// ── every /mcp tool and /openapi.json operation says what it takes and returns ─
import { assert, context, fakeImages, readFileSync, representationD1, schemaViolations, staticAssets, test } from "../../../tools/tests/contract-shared.ts";
import { routeFetch } from "../../../tools/lib/fetch-routes.ts";

// An agent picks a tool from its description, fills it from its inputSchema
// and reads the result through its outputSchema. A parameter with no
// description, or an output that is `{ type: "object" }` and nothing else,
// leaves the agent to guess. The orank scan of 2026-11-24 counted 52% of
// parameters described and 6 of 25 tools with an outputSchema; this walks the
// served tool list and the built OpenAPI document and names every gap.

type Schema = Record<string, any>;
const typed = (s: Schema) => "type" in s || "anyOf" in s || "oneOf" in s || "const" in s || "enum" in s;
const isObject = (s: Schema) => [s.type].flat().includes("object");

/** Every input property, at any depth, carries a description. */
function undescribed(schema: Schema, at: string, out: string[]) {
  for (const [name, prop] of Object.entries<Schema>(schema.properties ?? {})) {
    if (!String(prop.description ?? "").trim()) out.push(`${at}.${name}: no description`);
    undescribed(prop, `${at}.${name}`, out);
  }
  if (schema.items) undescribed(schema.items, `${at}[]`, out);
}

/** Every output node has a type, and every object names its fields. */
function untyped(schema: Schema, at: string, out: string[], resolve: (s: Schema) => Schema = (s) => s) {
  const s = resolve(schema);
  if (!typed(s)) out.push(`${at}: no type`);
  if (isObject(s) && !Object.keys(s.properties ?? {}).length && typeof s.additionalProperties !== "object") out.push(`${at}: an object with no fields`);
  for (const branch of [...(s.anyOf ?? []), ...(s.oneOf ?? [])]) untyped(branch, at, out, resolve);
  for (const [name, prop] of Object.entries<Schema>(s.properties ?? {})) untyped(prop, `${at}.${name}`, out, resolve);
  if (s.items) untyped(s.items, `${at}[]`, out, resolve);
  if (typeof s.additionalProperties === "object") untyped(s.additionalProperties, `${at}{}`, out, resolve);
}

test("every /mcp tool describes each parameter and types its output", async () => {
  const { MCP_TOOLS } = await import("../mcp.ts");
  const gaps: string[] = [];
  for (const tool of MCP_TOOLS) {
    // 80 characters is orank's floor for a description that can say both when
    // to use the tool and what it returns.
    if (tool.description.length < 80) gaps.push(`${tool.name}: a ${tool.description.length}-character description`);
    undescribed(tool.inputSchema, `${tool.name} input`, gaps);
    // MCP requires an object at the root of an outputSchema.
    if (tool.outputSchema.type !== "object") gaps.push(`${tool.name} output: the root is not an object`);
    untyped(tool.outputSchema, `${tool.name} output`, gaps);
  }
  assert.deepEqual(gaps, [], "MCP tools with a schema gap");
  assert.equal(MCP_TOOLS.length, 25, "a tool was added or removed; the walk still covers it, so update the count");

  // CONTROL. Each walker fires on the gap it exists for, so the empty list
  // above means no gaps rather than a walk that saw nothing.
  const probe: string[] = [];
  undescribed({ properties: { url: { type: "string" }, n: { type: "integer", description: "count" } } }, "probe", probe);
  untyped({ type: "object", properties: { open: { type: "object" }, x: {} } }, "probe", probe);
  assert.deepEqual(probe, ["probe.url: no description", "probe.open: an object with no fields", "probe.x: no type"]);
});

test("every /openapi.json operation describes its parameters and types every response", async () => {
  const { openApiDocument } = await import("../lib/openapi.ts");
  const doc: Schema = openApiDocument();
  const resolve = (s: Schema): Schema => (s.$ref ? doc.components.schemas[s.$ref.replace("#/components/schemas/", "")] : s);
  const gaps: string[] = [];
  let operations = 0;
  for (const [path, item] of Object.entries<Schema>(doc.paths)) {
    for (const [method, op] of Object.entries<Schema>(item)) {
      if (!op?.responses) continue;
      operations++;
      const id = `${method.toUpperCase()} ${path}`;
      for (const p of op.parameters ?? []) if (!String(p.description ?? "").trim()) gaps.push(`${id} ?${p.name}: no description`);
      if (!op.responses["200"]?.content?.["application/json"]) gaps.push(`${id}: no JSON 200 body`);
      for (const [status, response] of Object.entries<Schema>(op.responses)) {
        for (const [type, media] of Object.entries<Schema>(response.content ?? {})) {
          if (!media.schema) gaps.push(`${id} ${status} ${type}: no schema`);
          else untyped(media.schema, `${id} ${status} ${type}`, gaps, resolve);
        }
      }
    }
  }
  assert.deepEqual(gaps, [], "OpenAPI operations with a schema gap");
  assert.equal(operations, 14, "an operation was added or removed; the walk still covers it, so update the count");
});

// The oracle for the hosted tools' schemas is each tool's real result: one call
// apiece through tools/call, on the same fixtures their own tests use, checked
// against the outputSchema tools/list serves. The data tools get the same check
// in contract-mcp-tools-share-their-rest-schemas.
async function call(env, name: string, args: Record<string, unknown>) {
  const { handleSiteMcp } = await import("../mcp.ts");
  const res = await handleSiteMcp(
    new Request("https://aadhar.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    context(),
  );
  const { result } = await res.json();
  assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.content)}`);
  return result;
}

test("each hosted tool's structuredContent satisfies its outputSchema and matches its text", async () => {
  const { MCP_TOOLS } = await import("../mcp.ts");
  const schemaOf = (name: string) => MCP_TOOLS.find((t) => t.name === name)!.outputSchema;
  const checked = new Set<string>();
  const check = (name: string, result) => {
    assert.deepEqual(schemaViolations(schemaOf(name), result.structuredContent), [], `${name} returned a shape its outputSchema doesn't describe`);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent, `${name}'s text content is its structuredContent`);
    checked.add(name);
  };

  const images = { IMAGES: fakeImages() };
  check("image_inspect", await call(images, "image_inspect", { image_data: "aGVsbG8=" }));
  check("image_transform", await call(images, "image_transform", { image_data: "aGVsbG8=", preset: "thumbnail" }));
  check("image_compare", await call(images, "image_compare", { image_data: "aGVsbG8=", formats: ["avif", "jpeg"] }));

  const metadata = JSON.parse(readFileSync("public/images/metadata.json", "utf8"));
  const photos = {
    ASSETS: staticAssets({
      "/images/metadata.json": metadata,
      "/images/hashes.json": JSON.parse(readFileSync("public/images/hashes.json", "utf8")),
      "/images/alt.json": JSON.parse(readFileSync("public/images/alt.json", "utf8")),
      "/images/fingerprints.json": {},
    }),
  };
  // Every published photo, so a metadata field PhotoMetadata leaves untyped
  // fails here rather than on the first agent to ask about that photo.
  for (const stem of Object.keys(metadata)) {
    const hit = await call(photos, "photo_recipe", { stem });
    assert.equal(hit.structuredContent.matched, true, stem);
    check("photo_recipe", hit);
  }
  const miss = await call(photos, "photo_recipe", { image_data: "aGVsbG8=" });
  assert.equal(miss.structuredContent.matched, false);
  check("photo_recipe", miss);

  const vault = { RESTORE_DB: representationD1() };
  let version = "one";
  using _fetch = routeFetch({
    "https://example.com/page": () =>
      new Response(`<!doctype html><title>${version}</title><p>${version}</p>`, { headers: { "content-type": "text/html", etag: `"${version}"` } }),
  });
  const captured = await call(vault, "representation_capture", { url: "https://example.com/page", profiles: ["browser", "markdown"] });
  check("representation_capture", captured);
  const id = captured.structuredContent.snapshots[0].id;
  check("representation_read", await call(vault, "representation_read", { snapshot_id: id }));
  version = "two";
  const compared = await call(vault, "representation_compare", { snapshot_id: id });
  assert.equal(compared.structuredContent.changed, true, "the fixture changed, so the changes map was walked");
  check("representation_compare", compared);

  check("radar", await call({}, "radar", { samples: [{ name: "phone", rssi: -58 }] }));
  assert.deepEqual([...checked].sort(), [
    "image_compare",
    "image_inspect",
    "image_transform",
    "photo_recipe",
    "radar",
    "representation_capture",
    "representation_compare",
    "representation_read",
  ]);
});

test("lens_inspect and lens_page declare the summary lensObservationSummary returns", async () => {
  const { MCP_TOOLS } = await import("../mcp.ts");
  const { lensObservationSummary } = await import("../lens.ts");
  const schema = MCP_TOOLS.find((t) => t.name === "lens_inspect")!.outputSchema;
  assert.deepEqual(MCP_TOOLS.find((t) => t.name === "lens_page")!.outputSchema, schema);
  // Both arms: a page-only scan, whose discovery fields are null, and a full one.
  const page = lensObservationSummary({ url: "https://example.com/", status: 200, phases: { page: true, discovery: false, botViews: false } });
  const full = lensObservationSummary({
    url: "https://example.com/",
    status: 200,
    readiness: { overall: 61, level: 2, levelName: "Readable" },
    agent: { mcp: { verdict: "yes" } },
    cost: { tiers: [{ tokens: 1200 }], rates: [{ model: "a model", usdPerMtok: 3 }] },
  });
  assert.equal(page.doors, null);
  assert.equal(full.doors, 1);
  assert.deepEqual(schemaViolations(schema, page), [], "page-only summary");
  assert.deepEqual(schemaViolations(schema, full), [], "full summary");
});
