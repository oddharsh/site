// ── NLWeb ───────────────────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  assert,
  readFile,
  readFileSync,
  test,
} from "./contract-shared.ts";

// ── NLWeb ───────────────────────────────────────────────────────────────────
// The endpoint half. These drive the real handler; where a specific record
// matters they test the pure projections instead, because search.ts caches its
// index in a MODULE-LEVEL singleton with no reset, so the first test in this
// file to touch it pins the corpus for every test after. Stubbing a fourth one
// here would quietly assert against somebody else's records.
const nlwebEnv = () => ({ ASSETS: { fetch: async () => new Response(JSON.stringify({ version: 1, records: [
  { url: "/writing/agents", title: "Agents", description: "Notes on agents", text: "Cloudflare agents and tools", kind: "writing" },
] })) } });
const NLWEB_HIT = "cloudflare";
const askGet = async (query) => {
  const { handleAsk } = await import("../src/worker/nlweb.ts");
  return handleAsk(new Request("https://aadhar.sh/ask" + query), nlwebEnv());
};

// `headers.get()` is `string | null`, and handing that null straight to
// assert.match throws `TypeError: The "string" argument must be of type string`
// rather than failing on the thing being asserted — so a route that answered
// with NO content-type reported as a broken test instead of a broken route.
// The type only started saying so once span() stopped returning `any`, which is
// how handleAsk's Response became a Response.
const contentType = (res) => {
  const value = res.headers.get("content-type");
  assert.ok(value, "response carries no content-type at all");
  return value;
};

test("/ask streams by default and answers JSON only when asked", async () => {
  // The spec's own default, and the one thing about this endpoint that reads as
  // a bug the first time somebody curls it. A regression flipping it would
  // leave every other assertion here passing.
  const streamed = await askGet(`?query=${NLWEB_HIT}`);
  assert.equal(streamed.status, 200);
  assert.match(contentType(streamed), /text\/event-stream/);

  for (const off of ["0", "false", "FALSE", "off"]) {
    const res = await askGet(`?query=${NLWEB_HIT}&streaming=${off}`);
    assert.match(contentType(res), /application\/json/, `streaming=${off} must turn streaming off`);
  }
  // Anything that is not an off-switch is streaming, per the spec's wording.
  const odd = await askGet(`?query=${NLWEB_HIT}&streaming=yes-please`);
  assert.match(contentType(odd), /text\/event-stream/);
});

test("/ask returns NLWeb's six result fields, with a real schema.org object", async () => {
  const payload = await (await askGet(`?query=${NLWEB_HIT}&streaming=0`)).json();
  assert.ok(payload.query_id, "every answer carries a query_id");
  // The revision the server speaks and the dialect this request was read as are
  // two claims. A legacy GET is answered by a server that does speak 0.55, so
  // one field carrying both would be ambiguous exactly where it matters most.
  assert.equal(payload._meta.version, "0.55");
  assert.equal(payload._meta.dialect, "legacy");
  assert.ok(payload.results.length >= 1, "the cached corpus must answer this query");
  for (const row of payload.results) {
    for (const field of ["url", "name", "site", "score", "description", "schema_object"]) {
      assert.ok(row[field] !== undefined && row[field] !== "", `result is missing ${field}`);
    }
    // Absolute, because a result travels away from this origin and a relative
    // URL in somebody else's agent is not resolvable.
    assert.match(row.url, /^https:\/\/aadhar\.sh\//);
    assert.equal(row.site, "aadhar.sh");
    assert.equal(row.schema_object["@context"], "https://schema.org");
    assert.equal(row.schema_object["@id"], row.url);
    assert.ok(row.score >= 1 && row.score <= 100, `score ${row.score} out of range`);
  }
  // A query nothing answers is still a well-formed NLWeb answer rather than an
  // error: zero results is a result.
  const empty = await (await askGet("?query=zzzqqqxxnothingmatches&streaming=0")).json();
  assert.equal(empty.results.length, 0);
  assert.equal(empty.total, 0);
  assert.ok(empty.query_id);
});

test("/ask maps a record kind to the schema.org type it actually is", async () => {
  // Pure and tested directly, the way classifyDoor is: this mapping is the whole
  // claim `schema_object` makes, and a wrong @type publishes structured data
  // that is confidently mislabelled.
  const { askSchemaObject } = await import("../src/worker/nlweb.ts");
  const typeOf = (kind) => askSchemaObject({ url: "/x", title: "T", description: "D", kind })["@type"];
  assert.equal(typeOf("page"), "WebPage");
  assert.equal(typeOf("writing"), "BlogPosting");
  assert.equal(typeOf("document"), "DigitalDocument");
  assert.equal(typeOf("utility"), "WebAPI");
  // An unknown kind falls back rather than emitting an undefined @type, which
  // would be invalid structured data.
  assert.equal(typeOf("something-new-later"), "WebPage");

  const node = askSchemaObject({ url: "/lwe/fhe", title: "FHE", description: "d", kind: "page" });
  assert.equal(node["@id"], "https://aadhar.sh/lwe/fhe");
  assert.equal(node.url, "https://aadhar.sh/lwe/fhe");
  // Joined by @id to the WebSite node the homepage's own JSON-LD declares, so a
  // crawler that has read both can connect them. Asserted against the homepage
  // rather than trusted, because a dangling @id is a silent dead reference.
  assert.equal(node.isPartOf["@id"], "https://aadhar.sh/#website");
  const homepage = readFileSync(new URL("../src/pages/index.html", import.meta.url), "utf8");
  assert.ok(homepage.includes('"@id": "https://aadhar.sh/#website"'), "the WebSite node this points at must exist");
});

test("/ask scores against what the query could have scored, not against the set", async () => {
  // Normalising against the response's own top score would hand every query a
  // 100 and make the number comparable only inside one answer. This is
  // absolute: the same raw score means less when the query had more to satisfy.
  const { askRelevance } = await import("../src/worker/nlweb.ts");
  assert.equal(askRelevance(13, 1), 100, "one term hitting title, description and body is a perfect match");
  assert.equal(askRelevance(13, 2), 50, "the same raw score is half as good against twice the query");
  assert.equal(askRelevance(8, 1), 62);
  // Bounded at both ends: never 0, because a returned result did match
  // something, and never over 100, which would be a nonsense relevance.
  assert.equal(askRelevance(0, 3), 1);
  assert.equal(askRelevance(999, 1), 100);
  assert.equal(askRelevance(5, 0), 38, "a zero term count must not divide by zero");
});

test("/ask refuses the modes it cannot serve instead of degrading to list", async () => {
  for (const mode of ["summarize", "generate"]) {
    const res = await askGet(`?query=${NLWEB_HIT}&mode=${mode}&streaming=0`);
    assert.equal(res.status, 501, `${mode} must be refused`);
    const body = await res.json();
    assert.deepEqual(body.supported_modes, ["list"]);
    assert.ok(body.known_modes.includes(mode), "the refusal names the mode as one the protocol defines");
    assert.equal(body.results.length, 0, "a refusal carries no results");
  }
  // A mode the protocol never defined is a different error from one it defines
  // and this origin cannot serve.
  assert.equal((await askGet("?query=x&mode=interpretive-dance&streaming=0")).status, 400);
});

test("/ask says when it took a follow-up query literally", async () => {
  const plain = await (await askGet(`?query=${NLWEB_HIT}&streaming=0`)).json();
  assert.ok(!plain._meta.decontextualization, "a query with no history says nothing about history");
  assert.equal(plain.decontextualized_query, NLWEB_HIT, "the searched string is always reported");

  const followUp = await (await askGet(`?query=${NLWEB_HIT}&prev=tell%20me%20about%20it&streaming=0`)).json();
  assert.match(followUp._meta.decontextualization, /no language model/i);

  // A caller who resolved the follow-up themselves is believed, and the searched
  // string is reported either way so the two can be compared.
  const resolved = await (await askGet(`?query=what%20about%20it&prev=x&decontextualized_query=${NLWEB_HIT}&streaming=0`)).json();
  assert.equal(resolved.decontextualized_query, NLWEB_HIT);
  assert.ok(!resolved._meta.decontextualization);
  assert.ok(resolved.results.length, "the resolved query is what actually gets searched");
});

test("/ask accepts the v0.55 structured body and answers in named SSE events", async () => {
  // The dialect is selected by `query` arriving as an OBJECT and by nothing
  // else: not a header, not a parameter. A server that emits named events to a
  // legacy caller is talking to nobody, so the two must not be reachable from
  // the same request shape.
  const { handleAsk } = await import("../src/worker/nlweb.ts");
  const res = await handleAsk(new Request("https://aadhar.sh/ask", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: { text: NLWEB_HIT, site: "aadhar.sh" }, prefer: { mode: "list" }, meta: { version: "0.55" } }),
  }), nlwebEnv());
  const body = await res.text();
  assert.match(body, /^event: start\n/);
  assert.match(body, /\nevent: result\ndata: \{"index":0,"item":\{/);
  assert.match(body, /event: complete/);

  // The legacy GET must not gain named events from this change.
  const legacy = await (await askGet(`?query=${NLWEB_HIT}`)).text();
  assert.ok(!legacy.includes("event: "), "a legacy caller gets unnamed frames");
  assert.match(legacy, /"message_type":"result"/);
});

test("/ask refuses a site token it does not serve", async () => {
  for (const token of ["", "&site=all", "&site=aadhar.sh", "&site=AADHAR.SH"]) {
    const res = await askGet(`?query=${NLWEB_HIT}&streaming=0${token}`);
    assert.equal(res.status, 200, `site "${token}" should resolve to this origin`);
  }
  const res = await askGet(`?query=${NLWEB_HIT}&site=example.com&streaming=0`);
  assert.equal(res.status, 400);
  assert.deepEqual((await res.json()).available_sites, ["aadhar.sh", "all"]);
});

test("the ask MCP tool and /ask are the same answer", async () => {
  // The protocol specifies both doors carrying the same arguments and the same
  // result. Two rankings under one name is the drift this asserts against.
  const { callDataTool, DATA_TOOL_NAMES } = await import("../src/worker/lib/tools.ts");
  assert.ok(DATA_TOOL_NAMES.has("ask"));
  const req = new Request("https://aadhar.sh/mcp");
  const viaTool = await callDataTool("ask", { query: NLWEB_HIT, top_k: 5 }, req, nlwebEnv(), undefined);
  const viaRoute = await (await askGet(`?query=${NLWEB_HIT}&top_k=5&streaming=0`)).json();
  // query_id is per-call by design, so it is the one field that must differ.
  assert.notEqual(viaTool.query_id, viaRoute.query_id);
  assert.deepEqual(viaTool.results, viaRoute.results);
  // The tool inherits the route's refusals rather than re-implementing them.
  const refused = await callDataTool("ask", { query: NLWEB_HIT, mode: "generate" }, req, nlwebEnv(), undefined);
  assert.match(refused._error, /language model/i);
});

// The lens half. foreignNlwebAsk reaches a foreign origin, which no test can do
// (every external probe fails at signing before a stub could answer), so these
// drive it through the SELF_FETCH loopback the self-scan already uses. That is
// the same door a visitor scanning aadhar.sh goes through, so it is the real
// path rather than a mock of one.
const lensNlweb = async (env, url = "https://aadhar.sh/lens/nlweb?url=https://aadhar.sh") => {
  const { handleLensNlweb } = await import("../src/worker/lens-nlweb.ts");
  return (await handleLensNlweb(new Request(url), env)).json();
};
const sseEnv = (body) => ({ SELF_FETCH: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
const jsonEnv = (payload) => ({ SELF_FETCH: async () => new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } }) });
const askItem = (url, extra = {}) => ({
  url, name: "N", site: "example.com", score: 71, description: "d",
  schema_object: { "@context": "https://schema.org", "@type": "Recipe", name: "R" }, ...extra,
});

test("the NLWeb lens reads both streaming dialects and names which one it got", async () => {
  const legacy = await lensNlweb(sseEnv(
    `data: ${JSON.stringify({ message_type: "begin-nlweb-response", conversation_id: "c1" })}\n\n` +
    `data: ${JSON.stringify({ message_type: "result", query_id: "c1", content: [askItem("/a"), askItem("/b")] })}\n\n` +
    `data: ${JSON.stringify({ message_type: "end-nlweb-response", conversation_id: "c1" })}\n\n`));
  assert.equal(legacy.ok, true);
  assert.equal(legacy.framing, "sse");
  assert.equal(legacy.dialect, "legacy");
  assert.equal(legacy.total, 2);
  assert.equal(legacy.conformant, true);

  const modern = await lensNlweb(sseEnv(
    `event: start\ndata: ${JSON.stringify({ _meta: { version: "0.55" } })}\n\n` +
    `event: result\ndata: ${JSON.stringify({ index: 0, item: askItem("/x") })}\n\n` +
    `event: result\ndata: ${JSON.stringify({ index: 1, item: { url: "/y", name: "bare" } })}\n\n` +
    `event: complete\ndata: ${JSON.stringify({ _meta: { version: "0.55" } })}\n\n`));
  assert.equal(modern.dialect, "v0.55");
  assert.deepEqual(modern.events, ["start", "result", "complete"]);
  // The whole point of this lens: partial conformance is reported per FIELD
  // rather than as a pass. One of these two results is a link with prose on it,
  // and a knock at the door cannot tell you that.
  assert.equal(modern.total, 2);
  assert.equal(modern.coverage.url, 2);
  assert.equal(modern.coverage.schema_object, 1);
  assert.equal(modern.conformant, false);
  assert.deepEqual(modern.schemaTypes, [{ name: "Recipe", count: 1 }]);
});

test("the NLWeb lens keeps a shut door, an unreadable one and a locked one apart", async () => {
  const shut = await lensNlweb({ SELF_FETCH: async () => new Response("", { status: 404 }) });
  assert.equal(shut.ok, false);
  assert.equal(shut.unreadable, false, "404 is a door that is not there, which we did establish");
  assert.match(shut.error, /no \/ask/);

  // The most common false positive in a knock-only probe: a PAGE at /ask. It is
  // a shut door rather than a broken one.
  const page = await lensNlweb({ SELF_FETCH: async () => new Response("<!doctype html><p>hi", { headers: { "content-type": "text/html" } }) });
  assert.equal(page.ok, false);
  assert.equal(page.unreadable, false);
  assert.match(page.error, /a page, not an endpoint/);

  const locked = await lensNlweb({ SELF_FETCH: async () => new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="x"' } }) });
  assert.equal(locked.gated, true);
  assert.equal(locked.unreadable, true, "a locked door is one we never got to look through");

  const broken = await lensNlweb({ SELF_FETCH: async () => { throw new Error("connection reset"); } });
  assert.equal(broken.unreadable, true, "a transport failure says nothing about whether the endpoint exists");
});

test("the NLWeb lens grades every result and carries back only a bounded slice", async () => {
  const many = Array.from({ length: 40 }, (_, i) => askItem(`/r${i}`));
  const read = await lensNlweb(jsonEnv({ query_id: "q", results: many }));
  // A reader must never be shown "10 of 10" for a server that sent 40.
  assert.equal(read.total, 40);
  assert.equal(read.shown, 10);
  assert.equal(read.results.length, 10);
  assert.equal(read.coverage.schema_object, 40, "coverage grades the whole answer, not the slice");

  // An oversize schema is DROPPED and reported, never truncated: half a
  // schema.org object describes something that does not exist.
  const capped = await lensNlweb(jsonEnv({ results: [askItem("/big", { schema_object: { "@type": "Thing", blob: "x".repeat(9000) } })] }));
  assert.equal(capped.results[0].schema_object, undefined);
  assert.ok(capped.results[0].schemaOversize > 4000);

  // ItemList is the richer structure the spec says results are moving to, so a
  // server that has already moved is read rather than called malformed.
  const itemList = await lensNlweb(jsonEnv({ query_id: "q", itemListElement: [askItem("/one")] }));
  assert.equal(itemList.ok, true);
  assert.equal(itemList.total, 1);
});

test("the NLWeb lens sends the cheapest mode and never a caller's own script", async () => {
  // Asking a stranger's retrieval endpoint a question costs them compute, and
  // `generate` costs them a model call. mode=list is pinned EXPLICITLY rather
  // than left to whatever their default happens to be.
  let seen;
  await lensNlweb(
    { SELF_FETCH: async (req) => { seen = req.url; return new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } }); } },
    "https://aadhar.sh/lens/nlweb?url=https://aadhar.sh&q=" + encodeURIComponent("what is this"));
  const sent = new URL(seen);
  assert.equal(sent.pathname, "/ask");
  assert.equal(sent.searchParams.get("mode"), "list");
  assert.equal(sent.searchParams.get("streaming"), "0");
  assert.equal(sent.searchParams.get("query"), "what is this");
  // Exactly one caller-supplied value reaches the target, and it is a search
  // string. Same boundary lens-recipes.js draws against a `js=` parameter.
  assert.deepEqual([...sent.searchParams.keys()].sort(), ["mode", "query", "streaming"]);

  const source = await readFile(new URL("../src/worker/lens-nlweb.ts", import.meta.url), "utf8");
  assert.equal((source.match(/params\.get\(/g) || []).length, 2, "only `url` and `q` may be read from the caller");
});


test("discovery caching is scoped by Worker version for THIS origin only", async () => {
  // Pure and tested directly, the way classifyDoor is. The whole claim is which
  // origin gets version-scoped and which does not, and driving it through the
  // Cache API would test workerd rather than the rule.
  const { discoveryScope } = await import("../src/worker/lens.ts");
  const withVersion = { CF_VERSION_METADATA: { id: "006569fd-44df-4ddd-bb15-0a0339ebd2d2" } };

  // A stranger's discovery answers have nothing to do with our deploys, and
  // busting their entry means re-asking them 23 questions.
  for (const foreign of ["https://example.com", "https://stripe.com", "http://nlweb.ai"]) {
    const s = discoveryScope(foreign, withVersion);
    assert.equal(s.scope, null, `${foreign} must not be version-scoped`);
    assert.equal(s.cacheable, true);
  }

  // Ours is the opposite: every probe self-dispatches, so the answers ARE this
  // Worker and a deploy changes them at the instant it lands.
  const self = discoveryScope("https://aadhar.sh", withVersion);
  assert.equal(self.scope, "006569fd-44df-4ddd-bb15-0a0339ebd2d2");
  assert.equal(self.cacheable, true);
  // Case in the host must not decide it.
  assert.equal(discoveryScope("https://AADHAR.SH", withVersion).scope, self.scope);

  // Two versions must not share an entry — this is the whole fix. Measured
  // behaviourally against a booted Worker on 2026-08-19: across a restart that
  // moved the version from b1a93186 to 6b366f05, the first self-scan reported
  // phases.discoveryCached false and the second reported true.
  const otherVersion = { CF_VERSION_METADATA: { id: "deadbeef-0000-0000-0000-000000000000" } };
  assert.notEqual(discoveryScope("https://aadhar.sh", otherVersion).scope, self.scope);

  // And the other half, which is the one a regression would silently break: a
  // FOREIGN origin must keep its entry across our deploys. Busting it on every
  // release means re-asking a stranger 23 questions for no reason.
  assert.equal(discoveryScope("https://example.com", otherVersion).scope,
    discoveryScope("https://example.com", withVersion).scope,
    "a deploy must not invalidate a foreign origin's discovery cache");

  // No version to key on means no safe cache: that is exactly the state where a
  // stale entry outlives the change that should have invalidated it.
  for (const env of [{}, undefined, { CF_VERSION_METADATA: {} }, { CF_VERSION_METADATA: null }]) {
    assert.equal(discoveryScope("https://aadhar.sh", env).cacheable, false, "an unversioned self-scan must not cache");
  }
  // A foreign origin still caches with no version, because its scope never
  // depended on one.
  assert.equal(discoveryScope("https://example.com", {}).cacheable, true);

  // An origin that does not parse falls back to the foreign path rather than
  // throwing: a scan must not die on a malformed target it was going to refuse.
  assert.equal(discoveryScope("not a url at all", withVersion).cacheable, true);
});

test("the /ask door probe reads a real NLWeb server as present", async () => {
  // This probe KNOCKS: it sends no query, so it has to classify whatever a
  // server says to a bare request. Two shapes a CONFORMING instance returns
  // were both being graded absent, which undercounts the census the /lens
  // spectrum is built from. Driven through the SELF_FETCH loopback, the same
  // path a self-scan takes.
  const { lensProbeNlweb } = await import("../src/worker/lens.ts");
  const probe = (body, init) => lensProbeNlweb("https://aadhar.sh", { SELF_FETCH: async () => new Response(body, init) });

  // 1. The protocol streams by DEFAULT, so a server answering a bare knock with
  // an event stream is behaving correctly. A bot wall does not stream.
  const streamed = await probe('data: {"message_type":"begin-nlweb-response"}\n\n', { headers: { "content-type": "text/event-stream" } });
  assert.equal(streamed.verdict, "likely");
  assert.match(streamed.detail, /event stream/);

  // 2. `query` is REQUIRED, so a conforming server must refuse a bare knock.
  // Ours answers exactly this, and its own lens called it no endpoint at all.
  const asks = await probe(JSON.stringify({ error: "query is required", parameter: "query", endpoint: "/ask", results: [] }),
    { status: 400, headers: { "content-type": "application/json" } });
  assert.equal(asks.verdict, "likely");
  assert.match(asks.detail, /asking for `query` by name/);

  // The tightening this probe already carried must survive both: a bot wall
  // refuses the REQUEST and never names a parameter it has no concept of.
  // These four are the exact statuses that put 4 of 6 origins on the top rung.
  for (const status of [410, 412, 429]) {
    const wall = await probe(JSON.stringify({ error: "Gone" }), { status, headers: { "content-type": "application/json" } });
    assert.equal(wall.verdict, "no", `HTTP ${status} must not read as a door`);
  }
  const bare401 = await probe("", { status: 401, headers: { "content-type": "application/json" } });
  assert.equal(bare401.verdict, "no", "a 401 with no WWW-Authenticate does not say how to open the door");

  // And a 400 that is merely a 400 stays absent: the parameter name is the
  // whole discriminator, not the status.
  const generic = await probe(JSON.stringify({ error: "bad request" }), { status: 400, headers: { "content-type": "application/json" } });
  assert.equal(generic.verdict, "no");

  // Unchanged rungs.
  assert.equal((await probe("{}", { headers: { "content-type": "application/json" } })).verdict, "maybe");
  assert.equal((await probe("<!doctype html>", { headers: { "content-type": "text/html" } })).verdict, "no");
  assert.equal((await probe("", { status: 404 })).verdict, "no");
  assert.equal((await probe("", { status: 503 })).verdict, "unknown");
  assert.equal((await probe("{}", { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } })).verdict, "likely");
});

test("this origin's own /ask is not graded absent by its own door probe", async () => {
  // The control that motivated the change above, wired end to end: the real
  // handler answers the real probe. A site that serves NLWeb and reports itself
  // as not serving it is the one result this lens must never produce.
  const { lensProbeNlweb } = await import("../src/worker/lens.ts");
  const { handleAsk } = await import("../src/worker/nlweb.ts");
  const env = { ASSETS: { fetch: async () => new Response(JSON.stringify({ version: 1, records: [] })) } };
  env.SELF_FETCH = async (req) => handleAsk(req, env);
  const verdict = await lensProbeNlweb("https://aadhar.sh", env);
  assert.equal(verdict.verdict, "likely");
});

test("the MCP client sends Mcp-Method, and it agrees with the body", async () => {
  // Being a permissive SERVER does not license being a lax CLIENT. /mcp
  // validates this header only when present, because requiring it would reject
  // every legacy client; the strict half of the ecosystem does require it, and
  // mcp.context7.com and docs.mcp.cloudflare.com both answered 400 -32020
  // without it (measured 2026-08-14) — three live servers reading as broken.
  //
  // Driven through the self-dispatch hatch, which is the only door into this
  // function that needs neither the network nor the AadharshBot signing key.
  const { foreignMcpTools } = await import("../src/worker/lib/doors.ts");

  let seen = null;
  const env = { SELF_FETCH: (req) => {
    seen = req;
    return new Response(
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"now_playing","description":"d"}]}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  } };
  const out = await foreignMcpTools("https://aadhar.sh", env);

  assert.equal(seen.headers.get("mcp-method"), "tools/list");
  const sent = JSON.parse(await seen.text());
  assert.equal(sent.method, seen.headers.get("mcp-method"), "a header that disagrees with the body is what -32020 refuses");
  // Both framings offered, because the server picks. DeepWiki answers 406 to a
  // JSON-only Accept rather than downgrading to what we said we could read.
  const accept = seen.headers.get("accept");
  assert.match(accept, /application\/json/);
  assert.match(accept, /text\/event-stream/);

  // The SSE answer above is read, not reported as a door that would not open.
  assert.equal(out.ok, true);
  assert.equal(out.count, 1);
  assert.equal(out.tools[0].name, "now_playing");
});

test("a refusal that carries a reason reports the reason, not its status code", async () => {
  // -32020 and -32022 both arrive on a 400 and both carry the one sentence
  // that says what to fix. Reading the status first would throw it away and
  // leave the frame saying "HTTP 400" about a server that had just explained
  // itself.
  const { foreignMcpTools } = await import("../src/worker/lib/doors.ts");
  const answer = (body, init) => ({ SELF_FETCH: () => new Response(body, init) });

  const refused = await foreignMcpTools("https://aadhar.sh", answer(
    '{"jsonrpc":"2.0","id":1,"error":{"code":-32020,"message":"the request headers and body disagree"}}',
    { status: 400, headers: { "content-type": "application/json" } },
  ));
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /-32020: the request headers and body disagree/);
  assert.ok(!refused.unreadable, "a server that answered is not an unread door");

  // Not every refusal is JSON-RPC shaped. mcp.stripe.com answers a 400 carrying
  // {error:{message}} with no code, which the old renderer printed as
  // "undefined: Unrecognized request URL". Measured 2026-08-14.
  const vendor = await foreignMcpTools("https://aadhar.sh", answer(
    '{"error":{"message":"Unrecognized request URL (POST: /mcp)","type":"invalid_request_error"}}',
    { status: 400, headers: { "content-type": "application/json" } },
  ));
  assert.equal(vendor.ok, false);
  assert.equal(vendor.detail, "Unrecognized request URL (POST: /mcp)");
  assert.ok(!/undefined/.test(vendor.detail), "the reader printed its own undefined into the frame");

  // A body we DID receive and could not parse is a finding about them. A
  // request that never arrived says nothing about whether the server exists,
  // and the two must not merge — same rule as classifyDoor above.
  const shell = await foreignMcpTools("https://aadhar.sh", answer("<!doctype html>", { headers: { "content-type": "text/html" } }));
  assert.equal(shell.ok, false);
  assert.ok(!shell.unreadable, "a 200 that is not JSON-RPC is a shut door, not an unreadable one");

  const dead = await foreignMcpTools("https://aadhar.sh", { SELF_FETCH: () => { throw new Error("connection reset"); } });
  assert.equal(dead.ok, false);
  assert.equal(dead.unreadable, true, "a failed check was reported as a negative result");
});

test("a foreign catalogue is read from the stream with a ceiling, and the ceiling is reported as ours", async () => {
  // A catalogue is text a stranger controls. Every other crawl path here reads
  // through readResponseCapped; this one is a POST, so it could not go through
  // lensFetch and had quietly inherited none of its bounds.
  const { foreignMcpTools } = await import("../src/worker/lib/doors.ts");

  // The cap is well clear of anything real: this site's own 24-tool catalogue
  // measured 28,471 bytes on 2026-08-14, the largest on hand.
  const wide = { jsonrpc: "2.0", id: 1, result: { tools: Array.from({ length: 40 }, (_, i) => ({
    name: `tool_${i}`, description: "d".repeat(400), inputSchema: { type: "object" },
  })) } };
  const ordinary = await foreignMcpTools("https://aadhar.sh", { SELF_FETCH: () => new Response(
    JSON.stringify(wide), { headers: { "content-type": "application/json" } }) });
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.count, 40);

  // Past the ceiling the read stops. It is OUR limit, so it is reported as
  // ours: a truncated body would fail to parse and read out as "that is not
  // JSON", which blames a server that answered correctly at a length we
  // declined to read. Same rule as the browser lens reporting a spent render
  // budget as our own budget rather than as the target failing.
  const flood = "x".repeat(300 * 1024);
  const huge = await foreignMcpTools("https://aadhar.sh", { SELF_FETCH: () => new Response(
    `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a","description":"${flood}"}]}}`,
    { headers: { "content-type": "application/json" } }) });
  assert.equal(huge.ok, false);
  assert.equal(huge.unreadable, true, "our own ceiling was reported as the server's failure");
  assert.match(huge.detail, /256 KB/);
  assert.ok(!/JSON/.test(huge.detail), "a truncated read must not read out as a malformed answer");
});

test("a redirect off a vetted origin is validated per hop, not followed blindly", async () => {
  // validateLensTarget vetted the origin the visitor typed. A 302 from there is
  // a NEW target nobody vetted, and under redirect:"follow" that hop was taken
  // and its body read — the same hole lensFetch closed for the GET path, which
  // this POST could not share because lensFetch forwards no body.
  //
  // What a test can pin is that the guard is IN the path: the platform's own
  // fetch is what follows a redirect, so a stubbed fetch cannot reproduce the
  // vulnerable behaviour, only the routing that prevents it. Reverted to
  // redirect:"follow", this fails on the verdict rather than on the hop count.
  const { foreignMcpTools } = await import("../src/worker/lib/doors.ts");

  // A real key, because every external probe signs before it fetches and the
  // whole external branch is unreachable without one.
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const env = { RN_SIGNING_KEY_JWK: JSON.stringify({ ...await crypto.subtle.exportKey("jwk", pair.privateKey), kid: "test" }) };

  const realFetch = globalThis.fetch;
  const run = async (location, second) => {
    const hops = [];
    testGlobals.fetch = async (url) => {
      hops.push(String(url));
      return hops.length === 1
        ? new Response(null, { status: 302, headers: { location } })
        : second();
    };
    try { return { out: await foreignMcpTools("https://example.com", env), hops }; }
    finally { testGlobals.fetch = realFetch; }
  };

  const blocked = await run("http://169.254.169.254/mcp", () => new Response(
    '{"jsonrpc":"2.0","result":{"tools":[{"name":"leaked"}]}}', { headers: { "content-type": "application/json" } }));
  assert.deepEqual(blocked.hops, ["https://example.com/mcp"], "the blocked hop was requested anyway");
  assert.equal(blocked.out.ok, false);
  // Ours, not theirs: we declined to look, which is not the same as finding
  // nothing there.
  assert.equal(blocked.out.unreadable, true);
  assert.match(blocked.out.detail, /redirect/);

  // And a redirect to another PUBLIC host is still followed, so this is a guard
  // rather than a blanket refusal to move.
  const moved = await run("https://elsewhere.example/mcp", () => new Response(
    '{"jsonrpc":"2.0","result":{"tools":[{"name":"moved"}]}}', { headers: { "content-type": "application/json" } }));
  assert.deepEqual(moved.hops, ["https://example.com/mcp", "https://elsewhere.example/mcp"]);
  assert.equal(moved.out.ok, true);
  assert.equal(moved.out.tools[0].name, "moved");
});

test("a locked door is reported as locked, in whatever dialect the server refuses in", async () => {
  // A 401 is neither a broken server nor an absent one. lens already reports
  // this status as an OAuth-protected server when it KNOCKS, and doors
  // contradicted it one line later, in two different ways depending on what the
  // server put in the body. Both shapes measured across 16 live servers on
  // 2026-08-14: Cloudflare's six answer an empty-bodied 401 and used to read as
  // "answered no content-type, not JSON", while Notion, Sentry, Linear, PayPal,
  // Neon, Webflow, Canva, Grafana and Wix answer an OAuth challenge body and
  // used to read as the literal string "undefined: undefined".
  const { foreignMcpTools, rpcErrorDetail } = await import("../src/worker/lib/doors.ts");
  const answer = (body, init) => ({ SELF_FETCH: () => new Response(body, init) });

  const empty = await foreignMcpTools("https://aadhar.sh", answer(null, { status: 401, headers: {
    "www-authenticate": 'Bearer realm="OAuth", resource_metadata="https://x/.well-known/oauth-protected-resource"' } }));
  assert.equal(empty.ok, false);
  assert.equal(empty.gated, true);
  assert.equal(empty.unreadable, true, "a door we were not let through is not a door that is shut");
  assert.match(empty.detail, /needs OAuth \(HTTP 401\)/);

  // The OAuth challenge BODY, which is not JSON-RPC and never was.
  const challenge = await foreignMcpTools("https://aadhar.sh", answer(
    '{"error":"invalid_token","error_description":"Missing or invalid access token"}',
    { status: 401, headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="OAuth"' } }));
  assert.equal(challenge.gated, true);
  assert.ok(!/undefined/.test(challenge.detail), "the reader printed its own undefined into the frame");

  // No challenge header, and a 403: say what is true rather than naming a
  // scheme the server never claimed. mcp.hf.co answers exactly this.
  const bare = await foreignMcpTools("https://aadhar.sh", answer("", { status: 403 }));
  assert.match(bare.detail, /needs credentials \(HTTP 403\)/);

  // The renderer reads .error off a JSON-RPC error, and plenty of things that
  // answer an MCP endpoint speak their own dialect instead.
  assert.equal(rpcErrorDetail({ error: { code: -32020, message: "header mismatch" } }), "-32020: header mismatch");
  assert.equal(rpcErrorDetail({ error: "invalid_token", error_description: "Missing or invalid access token" }),
    "Missing or invalid access token");
  // Stripe's shape: a message, no code. It used to print "undefined: <message>".
  assert.equal(rpcErrorDetail({ error: { message: "Unrecognized request URL" } }), "Unrecognized request URL");
  for (const odd of [{ error: {} }, { error: [] }, { error: 7 }, { error: true }]) {
    assert.ok(!/undefined/.test(rpcErrorDetail(odd)), `rpcErrorDetail leaked undefined for ${JSON.stringify(odd)}`);
  }
});

test("the version header goes only to a server that asked for one", async () => {
  // Three live servers, all measured 2026-08-14, and they cannot be satisfied
  // by one fixed request. mcp.svelte.dev refuses without MCP-Protocol-Version
  // (-32020 "MCP-Protocol-Version is required"). mcp.deepwiki.com and
  // mcp.exa.ai serve happily WITHOUT it and refuse the byte-identical request
  // WITH it, because they validate the header against their own supported list
  // and neither speaks 2026-07-28. So the header is a reply to a refusal, never
  // an opener.
  const { foreignMcpTools, wantsProtocolHeader } = await import("../src/worker/lib/doors.ts");
  const CATALOGUE = '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"get-documentation","description":"d"}]}}';

  // The server that works without it must never be sent one. This is the
  // regression guard: sending it unconditionally reads MORE servers in a naive
  // count and BREAKS two that already worked.
  const easy = [];
  const openOut = await foreignMcpTools("https://aadhar.sh", { SELF_FETCH: (req) => {
    easy.push(req.headers.get("mcp-protocol-version"));
    return new Response(CATALOGUE, { headers: { "content-type": "application/json" } });
  } });
  assert.equal(openOut.ok, true);
  assert.deepEqual(easy, [null], "a server that never asked was sent a version header anyway");

  // The server that asks gets exactly one retry, carrying the SAME revision the
  // body declares — a header disagreeing with the body is the other half of
  // what -32020 refuses.
  const strict = [];
  const strictOut = await foreignMcpTools("https://aadhar.sh", { SELF_FETCH: async (req) => {
    const sent = req.headers.get("mcp-protocol-version");
    strict.push({ sent, body: JSON.parse(await req.text()) });
    return sent
      ? new Response(CATALOGUE, { headers: { "content-type": "application/json" } })
      : new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32020,"message":"MCP error -32020: Header mismatch: MCP-Protocol-Version is required"}}',
        { status: 400, headers: { "content-type": "application/json" } });
  } });
  assert.equal(strict.length, 2, "the refusal that names the header should be answered exactly once");
  assert.equal(strict[0].sent, null);
  assert.equal(strict[1].sent, strict[1].body.params._meta["io.modelcontextprotocol/protocolVersion"]);
  assert.equal(strictOut.ok, true);
  assert.equal(strictOut.tools[0].name, "get-documentation");

  // Narrow on purpose: a refusal that is an ANSWER rather than an instruction
  // gets no retry, because the second request would be identical to the first.
  assert.equal(wantsProtocolHeader({ error: { code: -32020, message: "MCP-Protocol-Version is required" } }), true);
  assert.equal(wantsProtocolHeader({ error: { code: -32020, message: "the body names method tools/list but the required Mcp-Method header is absent" } }), false);
  assert.equal(wantsProtocolHeader({ error: { code: -32022, message: "Unsupported protocol version: 2026-07-28" } }), false);
  assert.equal(wantsProtocolHeader({ result: { tools: [] } }), false);

  // And a server that keeps refusing is reported, not retried again.
  let calls = 0;
  const stubborn = await foreignMcpTools("https://aadhar.sh", { SELF_FETCH: () => {
    calls++;
    return new Response('{"jsonrpc":"2.0","id":1,"error":{"code":-32020,"message":"MCP-Protocol-Version is required"}}',
      { status: 400, headers: { "content-type": "application/json" } });
  } });
  assert.equal(calls, 2, "one retry, not a loop");
  assert.equal(stubborn.ok, false);
  assert.match(stubborn.detail, /-32020/);
});
