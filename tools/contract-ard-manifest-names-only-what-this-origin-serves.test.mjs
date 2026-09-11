// ── the ARD manifest names only what this origin serves ─────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, existsSync, readFile, test } from "./contract-shared.ts";

// /.well-known/ard.json is the ARD (Agentic Resource Discovery) manifest: one
// document naming every agentic resource here as a urn:air:aadhar.sh:… entry
// with 2-5 representative queries, which is the signal a registry builds its
// semantic index from. It is hand-authored, because the queries are prose and
// every url in it already exists; what a test can hold is that each entry
// points at something this origin serves and that each MCP entry's
// `capabilities` are the tool names its card actually lists. The cards are
// deep-equalled against each server's live tools/list elsewhere, so pinning to
// the card is pinning to the server.
//
// The same bytes ship at /.well-known/ai-catalog.json. ARD v0.91 §5.1 makes
// ard.json + rel="ard" the path a consumer MUST fetch and names ai-catalog.json
// + rel="ai-catalog" as the predecessor a consumer MAY still consult, so the
// two are one document at two URLs rather than two documents, and the first
// assertion below is what keeps that true after somebody edits one of them.
const ARD = "public/.well-known/ard.json";
const ALIAS = "public/.well-known/ai-catalog.json";
const ORIGIN = "https://aadhar.sh";
const URN = /^urn:air:aadhar\.sh:[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;
const MEDIA_TYPE = /^(?:application|text)\/[a-z0-9][a-z0-9.+-]*$/;

// Route literals in the dispatcher table, so a url with no file behind it
// (/ask) still has to be something the Worker answers. Reading the source
// rather than importing ROUTES keeps this file free of the Worker's module
// graph, which is the same choice the link-integrity invariant makes.
async function workerRoutes() {
  const src = await readFile(new URL("src/worker/index.ts", ROOT), "utf8");
  return new Set([...src.matchAll(/^\s*\["(\/[^"]*)",/gm)].map((m) => m[1]));
}

// The validator, as a function, so the control below can prove it rejects.
function validate(manifest, { routes, publicDir }) {
  assert.equal(manifest.specVersion, "1.0", "specVersion is the ai-catalog data model version");
  assert.equal(typeof manifest.host?.displayName, "string", "host.displayName is required");
  assert.equal(manifest.host.identifier, "aadhar.sh", "host.identifier is the domain the URNs are anchored to");
  assert.ok(Array.isArray(manifest.entries) && manifest.entries.length > 0, "entries is a non-empty array");

  const seen = new Set();
  for (const entry of manifest.entries) {
    const id = entry.identifier;
    assert.match(id, URN, `${id} must be urn:air:aadhar.sh:<namespace>:<name>`);
    assert.ok(!seen.has(id), `${id} is declared twice`);
    seen.add(id);
    assert.ok(typeof entry.displayName === "string" && entry.displayName.length > 0, `${id} needs a displayName`);
    assert.match(entry.type, MEDIA_TYPE, `${id} type must be an IANA media type`);
    assert.equal(("url" in entry) !== ("data" in entry), true, `${id} must carry exactly one of url or data`);

    const queries = entry.representativeQueries;
    assert.ok(Array.isArray(queries) && queries.length >= 2 && queries.length <= 5,
      `${id} needs 2-5 representativeQueries, has ${Array.isArray(queries) ? queries.length : "none"}`);
    assert.equal(new Set(queries).size, queries.length, `${id} repeats a representative query`);
    for (const q of queries) assert.ok(typeof q === "string" && q.trim().length > 8, `${id} has an empty or trivial query`);

    if (entry.url) {
      assert.ok(entry.url.startsWith(`${ORIGIN}/`), `${id} points off-origin: ${entry.url}`);
      const pathname = new URL(entry.url).pathname;
      const file = new URL(`${publicDir}${pathname}`, ROOT);
      assert.ok(existsSync(file) || routes.has(pathname),
        `${id} points at ${pathname}, which is neither a file under ${publicDir} nor a Worker route`);
    }
  }
  return seen;
}

test("the ARD manifest is one document at two well-known paths", async () => {
  const [ard, alias] = await Promise.all([ARD, ALIAS].map((p) => readFile(new URL(p, ROOT), "utf8")));
  assert.equal(alias, ard, `${ALIAS} must be byte-identical to ${ARD} (edit ard.json, then cp it over)`);
});

test("every ARD entry is well-formed and points at something this origin serves", async () => {
  const manifest = JSON.parse(await readFile(new URL(ARD, ROOT), "utf8"));
  const ctx = { routes: await workerRoutes(), publicDir: "public" };
  const ids = validate(manifest, ctx);

  // The floor: the two MCP servers, the agent card, the skill and NLWeb are the
  // resources the whole discovery story here rests on. Dropping one is a
  // deliberate act, and it should fail here first.
  for (const must of [
    "urn:air:aadhar.sh:mcp:site",
    "urn:air:aadhar.sh:mcp:serendipity",
    "urn:air:aadhar.sh:agent:site",
    "urn:air:aadhar.sh:skill:serendipity-events",
    "urn:air:aadhar.sh:nlweb:ask",
  ]) assert.ok(ids.has(must), `${must} left the manifest`);

  // CONTROL. A validator that has never gone red is decoration: the two
  // failure shapes the spec cares most about (both url and data; one query)
  // must each be refused by name.
  const clone = () => JSON.parse(JSON.stringify(manifest));
  const both = clone(); both.entries[0].data = {};
  assert.throws(() => validate(both, ctx), /exactly one of url or data/);
  const thin = clone(); thin.entries[0].representativeQueries = ["only one"];
  assert.throws(() => validate(thin, ctx), /2-5 representativeQueries/);
  const stray = clone(); stray.entries[0].url = `${ORIGIN}/.well-known/no-such-card.json`;
  assert.throws(() => validate(stray, ctx), /neither a file/);
});

test("each MCP entry's capabilities are the tool names on the card it points at", async () => {
  const manifest = JSON.parse(await readFile(new URL(ARD, ROOT), "utf8"));
  const mcp = manifest.entries.filter((e) => e.type === "application/mcp-server-card+json");
  assert.equal(mcp.length, 2, "both MCP servers are listed");
  for (const entry of mcp) {
    const card = JSON.parse(await readFile(new URL(`public${new URL(entry.url).pathname}`, ROOT), "utf8"));
    assert.deepEqual(entry.capabilities, card.tools.map((t) => t.name),
      `${entry.identifier} capabilities drifted from ${entry.url} (which is itself pinned to tools/list)`);
  }
});

test("both manifest paths are served with CORS, and every discovery surface names the manifest", async () => {
  const headers = await readFile(new URL("public/_headers", ROOT), "utf8");
  for (const path of ["/.well-known/ard.json", "/.well-known/ai-catalog.json"]) {
    const block = headers.split(/\n(?=\S)/).find((b) => b.startsWith(`${path}\n`));
    assert.ok(block, `_headers has no rule for ${path}`);
    assert.match(block, /^\s+Access-Control-Allow-Origin: \*$/m, `${path} must allow any origin; the spec requires it`);
    assert.match(block, /^\s+Content-Type: application\/json/m, `${path} must be application/json`);
  }

  // rel="ard" is the link relation a conformant consumer honours. It has to be
  // on the homepage in BOTH copies of that header set (the static one in
  // _headers and the Worker's, which serves the markdown twin and the preview).
  const { HOMEPAGE_DISCOVERY_LINK } = await import("../src/worker/lib/security.ts");
  const rel = /<\/\.well-known\/ard\.json>;\s*rel="ard"/;
  assert.match(HOMEPAGE_DISCOVERY_LINK, rel, "the Worker's homepage Link set must carry rel=ard");
  const home = headers.split(/\n(?=\S)/).find((b) => b.startsWith("/\n")) ?? "";
  assert.match(home, rel, "the _headers homepage Link set must carry rel=ard");

  // The other advertising surfaces. Each is a different door an agent arrives
  // through, and an agent that came in through one should not have to guess
  // that the manifest exists.
  const read = (p) => readFile(new URL(p, ROOT), "utf8");
  const surfaces = [
    { name: "robots.txt Agentmap directive", text: await read("public/robots.txt"), pattern: /^Agentmap: https:\/\/aadhar\.sh\/\.well-known\/ard\.json$/m },
    { name: "llms.txt", text: await read("public/llms.txt"), pattern: /https:\/\/aadhar\.sh\/\.well-known\/ard\.json/ },
    { name: "api-catalog", text: await read("public/.well-known/api-catalog"), pattern: /"href": "https:\/\/aadhar\.sh\/\.well-known\/ard\.json"/ },
    { name: "agent-card discovery block", text: await read("public/.well-known/agent-card.json"), pattern: /"ard": "https:\/\/aadhar\.sh\/\.well-known\/ard\.json"/ },
  ];
  for (const { name, text, pattern } of surfaces) assert.match(text, pattern, `${name} does not name the ARD manifest`);
});
