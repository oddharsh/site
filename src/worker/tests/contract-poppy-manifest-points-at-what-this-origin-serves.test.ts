// ── the Poppy manifest points at what this origin serves ────────────────────
import { ROOT, assert, existsSync, readFile, test } from "../../../tools/tests/contract-shared.ts";

// /.well-known/poppy.json is the Personal Agent Protocol 1.0 discovery
// document (personalagentprotocol.org/docs/spec, section 3). It is
// hand-authored like ard.json: the API descriptions are prose, and every url
// in it already exists. What a test can hold is the spec's shape, that the
// MCP entries are exactly the two servers whose cards are pinned to tools/list
// elsewhere, and that there is no auth block while LEAVES_OUT says the site
// takes no credential. An issuer here would send a personal agent after a
// token nothing checks, which is what #1310 removed.
const POPPY = "public/.well-known/poppy.json";
const ORIGIN = "https://aadhar.sh";
// Spec section 7: the API types this version defines.
const API_TYPES = new Set(["openapi", "mcp"]);

async function context() {
  const { EXACT_PATHS, PREFIX_ROUTES } = await import("../routes.ts");
  const { OPENAPI_PATH } = await import("../lib/public-api.ts");
  const read = async (p: string) => JSON.parse(await readFile(new URL(p, ROOT), "utf8"));
  const cards = [await read("public/.well-known/mcp/server-card.json"), await read("public/.well-known/mcp/serendipity.json")];
  // The Serendipity module owns /serendipity/*, so /serendipity/mcp is a prefix
  // route. The /.well-known/<card> row is left out: it matches any path under
  // /.well-known/, and a card has to be a real file under public/.
  const prefixes = PREFIX_ROUTES.filter((r) => r.label !== "/.well-known/<card>");
  return {
    // /openapi.json is written by build.ts, neither a file under public/ nor a Worker route.
    routes: { has: (pathname: string) => EXACT_PATHS.includes(pathname) || pathname === OPENAPI_PATH || prefixes.some((r) => r.match(pathname)) },
    openapi: `${ORIGIN}${OPENAPI_PATH}`,
    mcpUrls: cards.map((card) => card.transport.url as string),
  };
}

const served = (url: string, routes: { has: (pathname: string) => boolean }) => {
  const { pathname } = new URL(url);
  return existsSync(new URL(`public${pathname}`, ROOT)) || routes.has(pathname);
};

// The validator, as a function, so the control below can prove it rejects.
function validate(manifest: any, ctx: Awaited<ReturnType<typeof context>>) {
  assert.equal(manifest.protocol_version, "1.0", "protocol_version is the spec version the document follows");
  assert.equal(manifest.organization?.name, "Aadharsh Pannirselvam", "organization.name is required");
  assert.equal(manifest.organization.domain, "aadhar.sh", "organization.domain must be the host that serves the file");
  assert.equal("auth" in manifest, false, "no auth block: nothing here takes a credential (LEAVES_OUT)");
  assert.ok(manifest.apis || manifest.agent || manifest.web, "the spec needs at least one of agent, apis or web");
  assert.deepEqual(manifest.web, {}, "web is declared and open to signed-out browsing");

  for (const api of manifest.apis) {
    assert.ok(API_TYPES.has(api.type), `${api.url} has type ${api.type}, which spec section 7 does not define`);
    assert.ok(api.url.startsWith(`${ORIGIN}/`), `${api.url} points off-origin`);
    assert.ok(served(api.url, ctx.routes), `${api.url} is neither a file under public/ nor a Worker route`);
    assert.ok(typeof api.description === "string" && api.description.length > 20, `${api.url} needs a description`);
  }
  assert.deepEqual(
    manifest.apis.filter((a: any) => a.type === "openapi").map((a: any) => a.url),
    [ctx.openapi],
    "the one openapi entry is the description build.ts writes",
  );
  assert.deepEqual(
    manifest.apis.filter((a: any) => a.type === "mcp").map((a: any) => a.url),
    ctx.mcpUrls,
    "the mcp entries are exactly the transports on the two MCP server cards",
  );

  // Spec 3.3: a name that isn't reserved starts with a domain the publisher controls.
  for (const [name, entries] of Object.entries(manifest.extensions ?? {})) {
    assert.ok(name.startsWith("aadhar.sh/"), `extension ${name} must start with aadhar.sh/`);
    for (const entry of entries as any[]) {
      assert.equal(typeof entry.version, "string", `${name} entries carry a version`);
      for (const [key, value] of Object.entries(entry)) {
        if (typeof value === "string" && value.startsWith("https://"))
          assert.ok(served(value, ctx.routes), `${name}.${key} points at ${value}, which this origin does not serve`);
      }
    }
  }
}

test("the Poppy manifest is well-formed and every url in it is served here", async () => {
  const manifest = JSON.parse(await readFile(new URL(POPPY, ROOT), "utf8"));
  const ctx = await context();
  validate(manifest, ctx);

  // CONTROL. Each failure shape the spec or LEAVES_OUT cares about must be
  // refused by name, or the validator above is decoration.
  const clone = () => JSON.parse(JSON.stringify(manifest));
  const issuer = clone();
  issuer.auth = { issuer: "https://aadhar.sh" };
  assert.throws(() => validate(issuer, ctx), /no auth block/);
  const stray = clone();
  stray.apis[1].url = `${ORIGIN}/no-such-mcp`;
  assert.throws(() => validate(stray, ctx), /neither a file/);
  const missing = clone();
  missing.apis = missing.apis.filter((a: any) => a.url !== `${ORIGIN}/serendipity/mcp`);
  assert.throws(() => validate(missing, ctx), /exactly the transports/);
  const unknownType = clone();
  unknownType.apis[0].type = "graphql";
  assert.throws(() => validate(unknownType, ctx), /does not define/);
});

test("the manifest is served as JSON with CORS, and the other discovery docs name it", async () => {
  const headers = await readFile(new URL("public/_headers", ROOT), "utf8");
  const block = headers.split(/\n(?=\S)/).find((b) => b.startsWith("/.well-known/poppy.json\n"));
  assert.ok(block, "_headers has no rule for /.well-known/poppy.json");
  assert.match(block, /^\s+Access-Control-Allow-Origin: \*$/m);
  assert.match(block, /^\s+Content-Type: application\/json/m);

  const read = (p: string) => readFile(new URL(p, ROOT), "utf8");
  assert.match(await read("public/llms.txt"), /https:\/\/aadhar\.sh\/\.well-known\/poppy\.json/, "llms.txt does not name poppy.json");
  assert.match(
    await read("public/.well-known/agent-card.json"),
    /"poppy": "https:\/\/aadhar\.sh\/\.well-known\/poppy\.json"/,
    "the agent card's discovery block does not name poppy.json",
  );
});
