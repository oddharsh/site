// ── the site MCP, its image workbench and the representation vault ──────────
import {
  testGlobals,
  MODERN_META,
  SITE_MCP_TOOLS,
  assert,
  context,
  fakeImages,
  handleSiteMcp,
  mcpPost,
  readFileSync,
  representationD1,
  staticAssets,
  test,
} from "./contract-shared.ts";
import { imageCompare, photoRecipe } from "../../src/worker/image-tools.ts";
import { _resetSearchIndex } from "../../src/worker/search.ts";
import { buildImageFingerprints } from "../lib/photo-indexes.ts";
import { createHash } from "node:crypto";

// Moved out of the interaction-recipes file on 2026-10-24, where they had
// accumulated: none of them is about /lens, so a change to /lens must never be
// able to delete them. Each test says what it pins.

test("site MCP exposes one read-only tool catalog and calls shared search", async () => {
  // Its own reset, not a ride on the one above: this corpus happens to match
  // the search test's, so it passed in file order and failed run alone after
  // another corpus had loaded (measured 2026-09-29).
  _resetSearchIndex();
  const env = {
    ASSETS: staticAssets({
      "/search-index.json": {
        records: [{ url: "/writing/agents", title: "Agents", description: "Notes on agents", text: "Cloudflare agents and tools", kind: "writing" }],
      },
    }),
  };
  const initialize = await handleSiteMcp(
    new Request("https://aadhar.sh/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
      headers: { "content-type": "application/json" },
    }),
    env,
    context(),
  );
  assert.equal(initialize.status, 200);
  assert.equal((await initialize.json()).result.serverInfo.name, "aadhar.sh");
  const call = await handleSiteMcp(
    new Request("https://aadhar.sh/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_site", arguments: { q: "cloudflare" } } }),
      headers: { "content-type": "application/json" },
    }),
    env,
    context(),
  );
  const callBody = await call.json();
  assert.equal(callBody.result.structuredContent.returned, 1);
  assert.equal((await handleSiteMcp(new Request("https://aadhar.sh/mcp"), env, context())).status, 405);
});

// The annotations are a CLAIM made to every client that lists this server, so
// the test names the exceptions instead of asserting one shape over all of them.
// A blanket "everything is read-only" assertion passed right up until the vault
// tools landed, and would have kept passing while advertising a tool that writes
// a D1 row as read-only.
const MCP_WRITE_TOOLS = new Set(["representation_capture", "representation_compare"]);

test("MCP tools publish honest client metadata for calling and WebMCP", async () => {
  const response = await handleSiteMcp(
    mcpPost({
      jsonrpc: "2.0",
      id: "metadata",
      method: "tools/list",
      params: { ...MODERN_META },
    }),
    {},
    context(),
  );
  const listed = (await response.json()).result.tools;
  assert.deepEqual(listed, SITE_MCP_TOOLS, "tools/list must expose the canonical decorated registry");
  assert.equal(listed.length, 25);
  for (const tool of listed) {
    assert.ok(tool.title, `${tool.name} needs a human-readable title`);
    const writes = MCP_WRITE_TOOLS.has(tool.name);
    assert.deepEqual(
      tool.annotations,
      {
        readOnlyHint: !writes,
        destructiveHint: false,
        idempotentHint: !writes,
        openWorldHint: tool.annotations.openWorldHint,
      },
      `${tool.name} annotations must be explicit`,
    );
    assert.deepEqual(tool.outputSchema, { type: "object", additionalProperties: true }, `${tool.name} needs an object output schema`);
    // A write must ALSO say so in its description, because Cloudflare's WebMCP
    // bridge registers {name, description, inputSchema, execute} and drops
    // `annotations` entirely — a browser agent never sees the flags asserted
    // above. Description is the only field that reaches it, so the two have to
    // agree. Asserting both directions is the point: prose on a read-only tool
    // would be a false warning, and that rots as quietly as a missing one.
    assert.equal(
      /\bWrites:/.test(tool.description),
      writes,
      writes
        ? `${tool.name} writes, so its description must carry the "Writes:" clause the WebMCP bridge can actually see`
        : `${tool.name} is read-only but its description claims it writes`,
    );
  }
  assert.equal(listed.find((tool) => tool.name === "lens_inspect").annotations.openWorldHint, true);
  assert.equal(listed.find((tool) => tool.name === "search_site").annotations.openWorldHint, false);
  // Every tool that can be handed a caller-supplied URL reaches off this origin,
  // and that is the whole meaning of openWorldHint. Pinning the set here is what
  // makes the omission loud the next time a fetching tool is added.
  for (const name of ["image_transform", "photo_recipe", "representation_capture"]) {
    assert.equal(listed.find((tool) => tool.name === name).annotations.openWorldHint, true, `${name} fetches caller-supplied URLs`);
  }
});

test("site MCP image workbench returns an image content block and exact receipt", async () => {
  const env = { IMAGES: fakeImages() };
  const list = await handleSiteMcp(
    new Request("https://aadhar.sh/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      headers: { "content-type": "application/json" },
    }),
    env,
    context(),
  );
  const names = (await list.json()).result.tools.map((tool) => tool.name);
  assert.ok(names.includes("image_inspect"));
  assert.ok(names.includes("image_transform"));
  assert.ok(names.includes("image_compare"));
  const call = await handleSiteMcp(
    new Request("https://aadhar.sh/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "image_transform", arguments: { image_data: "aGVsbG8=", preset: "thumbnail" } },
      }),
      headers: { "content-type": "application/json" },
    }),
    env,
    context(),
  );
  const body = await call.json();
  assert.equal(body.result.structuredContent.engine, "cloudflare-images");
  assert.equal(body.result.content[1].type, "image");
  assert.equal(body.result.content[1].mimeType, "image/avif");
  const bytes = Buffer.from(body.result.content[1].data, "base64");
  assert.deepEqual(JSON.parse(bytes.toString()), {
    input: 5,
    options: { width: 600, height: 600, fit: "cover" },
    output: { format: "image/avif", quality: 84 },
  });
  assert.equal(body.result.structuredContent.output.bytes, bytes.byteLength);
  assert.equal(body.result.structuredContent.output.sha256, createHash("sha256").update(bytes).digest("hex"));
});

test("image_compare encodes independent formats in one binding latency window", async () => {
  let active = 0;
  let peak = 0;
  // All byte values, across the old 32 KiB chunk boundary and all padding cases.
  const formats = ["avif", "webp", "jpeg"];
  const encoded = Uint8Array.from({ length: 0x8000 + 2 }, (_, i) => i % 256);
  const bytesFor = (format) => encoded.subarray(0, 0x8000 + formats.indexOf(format));
  const env = {
    IMAGES: {
      async info(bytes) {
        return { format: "jpeg", width: 1, height: 1, fileSize: bytes.byteLength };
      },
      input() {
        return {
          transform() {
            return this;
          },
          async output(options) {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active--;
            return { response: () => new Response(bytesFor(options.format.replace("image/", "")), { headers: { "content-type": options.format } }) };
          },
        };
      },
    },
  };

  const result = await imageCompare({ image_data: "aGVsbG8=", formats }, env);
  assert.ok("_mcp" in result);
  assert.equal(result._mcp.structured.variants.length, 3);
  assert.equal(peak, 3, "all three Images pipelines should overlap");
  for (const [i, format] of formats.entries()) {
    const bytes = bytesFor(format);
    const content = result._mcp.content[i + 1];
    assert.equal(content.type, "image");
    assert.equal(content.data, Buffer.from(bytes).toString("base64"));
    assert.equal(result._mcp.structured.variants[i].sha256, createHash("sha256").update(bytes).digest("hex"));
  }
});

test("photo_recipe only claims exact archive identities", async () => {
  const metadata = JSON.parse(readFileSync("public/images/metadata.json", "utf8"));
  const hashes = JSON.parse(readFileSync("public/images/hashes.json", "utf8"));
  const alt = JSON.parse(readFileSync("public/images/alt.json", "utf8"));
  // DERIVED rather than read: images/fingerprints.json is build output as of
  // 2026-08-29, so there is no committed file to load. This is the stronger
  // shape anyway, since it runs photo_recipe against the exact map build.ts
  // stages, rather than against a copy that could have gone stale beside it.
  const { index: fingerprints } = await buildImageFingerprints(".");
  const stem = Object.keys(metadata)[0];
  const env = {
    ASSETS: staticAssets({
      "/images/metadata.json": metadata,
      "/images/hashes.json": hashes,
      "/images/alt.json": alt,
      "/images/fingerprints.json": fingerprints,
    }),
  };
  const exact = await handleSiteMcp(
    new Request("https://aadhar.sh/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "photo_recipe", arguments: { stem } } }),
      headers: { "content-type": "application/json" },
    }),
    env,
    context(),
  );
  const exactBody = await exact.json();
  assert.equal(exactBody.result.structuredContent.matched, true);
  assert.equal(exactBody.result.structuredContent.photo.stem, stem);
  assert.equal("gps" in exactBody.result.structuredContent.photo.metadata, false);
  const jpgPath = `public/i/${stem}.${hashes[stem].j}.jpg`;
  const bytes = readFileSync(jpgPath).toString("base64");
  const byBytes = await handleSiteMcp(
    new Request("https://aadhar.sh/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "photo_recipe", arguments: { image_data: bytes } } }),
      headers: { "content-type": "application/json" },
    }),
    env,
    context(),
  );
  const byBytesBody = await byBytes.json();
  assert.equal(byBytesBody.result.structuredContent.matched, true);
  assert.equal(byBytesBody.result.structuredContent.photo.matchKind, "published-thumbnail");
  assert.equal(byBytesBody.result.structuredContent.photo.matchedTier, "j");
  const miss = await handleSiteMcp(
    new Request("https://aadhar.sh/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "photo_recipe", arguments: { image_data: "aGVsbG8=" } } }),
      headers: { "content-type": "application/json" },
    }),
    env,
    context(),
  );
  const missBody = await miss.json();
  assert.equal(missBody.result.structuredContent.matched, false);
});

test("photo_recipe fetches only the indexes its lookup can use, without a serial asset waterfall", async () => {
  const files = {
    "/images/metadata.json": { L1000069_3: { camera: "Leica M11" } },
    "/images/hashes.json": { L1000069_3: { a: "aaaa", j: "bbbb", s: "cccc" } },
    "/images/alt.json": { L1000069_3: "a test frame" },
    "/images/fingerprints.json": {},
  };
  let active = 0;
  let peak = 0;
  const paths: any[] = [];
  const env = {
    ASSETS: {
      async fetch(input) {
        const path = new URL(input).pathname;
        paths.push(path);
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return Response.json(files[path]);
      },
    },
  };

  const exact = await photoRecipe({ stem: "L1000069_3" }, env);
  assert.ok("matched" in exact);
  assert.equal(exact.matched, true);
  assert.deepEqual(
    paths.slice().sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)),
    ["/images/alt.json", "/images/hashes.json", "/images/metadata.json"],
  );
  assert.equal(peak, 3, "the independent projection reads should overlap");

  paths.length = 0;
  peak = 0;
  const miss = await photoRecipe({ image_data: "aGVsbG8=" }, env);
  assert.ok("matched" in miss);
  assert.equal(miss.matched, false);
  assert.deepEqual(paths, ["/images/fingerprints.json"], "a byte miss should not load an unused projection");
});

test("representation vault stores normalized snapshots and compares digests", async () => {
  const db = representationD1();
  const realFetch = globalThis.fetch;
  let version = "one";
  let active = 0;
  let peak = 0;
  testGlobals.fetch = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return new Response(`<!doctype html><title>${version}</title><p>${version}</p>`, {
      headers: { "content-type": "text/html; charset=utf-8", etag: `"${version}"`, "cache-control": "public, max-age=60" },
    });
  };
  try {
    const env = { RESTORE_DB: db };
    const capture = await handleSiteMcp(
      new Request("https://aadhar.sh/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "representation_capture", arguments: { url: "https://example.com/page", profiles: ["browser", "identity"] } },
        }),
        headers: { "content-type": "application/json" },
      }),
      env,
      context(),
    );
    const captured = (await capture.json()).result.structuredContent;
    const first = captured.snapshots[0];
    assert.equal(captured.snapshots.length, 2);
    assert.equal(peak, 2, "two requested origin profiles should share one network latency window");
    assert.equal(db.batchCount, 1, "successful profile rows should use one D1 batch");
    assert.ok(first.id);
    assert.equal(first.title, "one");
    assert.equal(db.rows[0].body, undefined);
    version = "two";
    const compare = await handleSiteMcp(
      new Request("https://aadhar.sh/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "representation_compare", arguments: { snapshot_id: first.id } } }),
        headers: { "content-type": "application/json" },
      }),
      env,
      context(),
    );
    const compared = (await compare.json()).result.structuredContent;
    assert.equal(compared.changed, true);
    assert.ok(compared.changes.body_hash);
  } finally {
    testGlobals.fetch = realFetch;
  }
});
