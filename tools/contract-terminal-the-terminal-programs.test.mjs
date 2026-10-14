// ── the terminal programs (/finger, /photos, /lens, /dict, /cache, /encode, ...) ──
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  MODERN_META,
  TERMINAL_ASSETS,
  assert,
  context,
  handleSiteMcp,
  handleTool,
  mcpPost,
  staticAssets,
  terminalEnv,
  terminalGet,
  terminalReq,
  test,
  testGlobals,
  tokenizeKeys,
} from "./contract-shared.ts";
import { _resetPhotoCaches } from "../src/worker/photos.ts";

const TERMINAL_STATES = [
  "/finger", "/finger?help=1", "/finger?keys=q",
  ...["overview", "writing", "reading", "listening", "photos", "around", "coffee", "deploys", "search"]
    .map((pane) => `/finger?pane=${pane}`),
  "/finger?pane=writing&keys=jj", "/finger?pane=writing&cursor=1&open=two",
  "/finger?pane=search&q=lattice", "/finger?pane=search&q=lattice&open=0",
  "/finger?pane=deploys&keys=G", "/finger?pane=photos",
  "/finger?pane=plan",
  "/photos", "/photos?film=acros", "/photos?keys=j%3Ccr%3E", "/photos?open=A_1",
  "/photos?q=nothingmatchesthis", "/lens", "/lens?url=javascript%3Aalert(1)",
];

test("no frame line runs past 80 columns, and none of them draws a box", async () => {
  for (const path of TERMINAL_STATES) {
    const res = await terminalGet(path);
    assert.equal(res.status, 200, path);
    const text = await res.text();
    const lines = text.split("\n").filter((line) => line.length);
    assert.ok(lines.length >= 2, `${path} produced no output`);
    for (const line of lines) {
      assert.ok([...line].length <= 80, `${path} drew a ${[...line].length}-column row: ${line}`);
    }
    for (const glyph of ["╔", "╚", "║", "╟", "[_][#][X]"]) {
      assert.ok(!text.includes(glyph), `${path} is drawing frame chrome again (${glyph})`);
    }
  }
});

test("a tool frame never emits an escape byte, in any mode", async () => {
  for (const path of ["/finger", "/finger?plain=1", "/finger?plain=0", "/dict", "/photos"]) {
    const text = await (await terminalGet(path)).text();
    assert.ok(!text.includes("\x1b"), `${path} leaked an escape sequence`);
  }
  const a = await (await terminalGet("/finger?plain=1")).text();
  const b = await (await terminalGet("/finger")).text();
  assert.equal(a, b, "plain=1 and the default must be the same bytes now");
});

test("a frame's printed state is a URL that reproduces it", async () => {
  for (const path of ["/finger?pane=writing&keys=jj", "/finger?pane=deploys&keys=G", "/photos?film=acros&keys=j"]) {
    const first = await (await terminalGet(`${path}&plain=1`)).text();
    const printed = first.match(/state (\/[a-z]+(?:\?[^\s│║]*)?)/)?.[1];
    assert.ok(printed, `${path} printed no state URL`);
    const replayed = await (await terminalGet(printed + (printed.includes("?") ? "&" : "?") + "plain=1")).text();
    assert.equal(replayed, first, `${path} does not reproduce from the URL it printed`);
  }
});

test("key sequences are bounded and named keys parse", () => {
  assert.deepEqual(tokenizeKeys("2jj<cr>"), ["2", "j", "j", "\r"]);
  assert.deepEqual(tokenizeKeys("<esc><tab><sp>"), ["\x1b", "\t", " "]);
  assert.deepEqual(tokenizeKeys("<nope>"), ["<", "n", "o", "p", "e", ">"]);
  assert.equal(tokenizeKeys("j".repeat(500)).length, 32);
  assert.deepEqual(tokenizeKeys(""), []);
  assert.deepEqual(tokenizeKeys(null), []);
});

test(".plan is a real hidden finger pane: reachable, undocumented, falls back like any other bad pane", async () => {
  const plan = await (await terminalGet("/finger?pane=plan")).text();
  assert.match(plan, /-- aadharsh/);
  assert.match(plan, /not one of the 9/);

  const help = await (await terminalGet("/finger?help=1")).text();
  assert.ok(!help.includes("plan"), "the help screen must not document the hidden pane");

  const bogus = await (await terminalGet("/finger?pane=plan-typo")).text();
  assert.ok(bogus.includes("pane 1/9 · overview"), "an unknown pane must still fall back to overview");
});

test("the tui routes refuse to be cached or indexed", async () => {
  // A frame is per-query and several are live (playlist, calendar, lens). The
  // route also negotiates on Accept, which a URL-keyed edge cache cannot
  // represent — the same trap lib/cache.js documents for the markdown twins.
  for (const path of ["/finger", "/photos"]) {
    const res = await terminalGet(path);
    assert.equal(res.headers.get("cache-control"), "no-store", path);
    assert.equal(res.headers.get("x-robots-tag"), "noindex", path);
    assert.equal(res.headers.get("vary"), "accept", path);
  }
});

test("a browser gets the same text a terminal does, not a second layout", async () => {
  const htmlReq = new Request("https://aadhar.sh/finger", { headers: { accept: "text/html" } });
  const html = await (await handleTool(htmlReq, terminalEnv(), context())).text();
  const text = await (await terminalGet("/finger")).text();

  const pre = /<pre class="tool-out">([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(pre, "a tool asked for HTML must render the frame in a <pre>");
  const unescaped = pre[1]
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  for (const line of text.split("\n").filter(Boolean)) {
    assert.ok(unescaped.includes(line), `the HTML view dropped or altered a row: ${line}`);
  }
});

test("an unknown program 404s and names the ones that exist", async () => {
  const res = await terminalGet("/nope");
  assert.equal(res.status, 404);
  const body = await res.text();
  for (const tool of ["/finger", "/photos", "/lens", "/dict", "/cache", "/encode", "/agent-ready", "/radar"]) {
    assert.ok(body.includes(`  ${tool}\n`) || body.includes(`  ${tool} `), `the 404 body does not list ${tool}`);
  }
  assert.ok(!body.includes("/terminal"), "the 404 body still points at the retired console");
  const post = await handleTool(new Request("https://aadhar.sh/finger", { method: "POST" }), terminalEnv(), context());
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("every frame tool the MCP server lists is one the server can actually call", async () => {
  const env = terminalEnv();
  const listed = (await (await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { ...MODERN_META } }), env, context())).json())
    .result.tools.map((tool) => tool.name);
  const FRAME_TOOLS = ["finger", "photos", "radar", "dict", "cache", "lens", "agent_ready"];
  for (const name of FRAME_TOOLS) assert.ok(listed.includes(name), `${name} has a route but is not an MCP tool`);
  assert.ok(!listed.some((n) => n.startsWith("terminal_")), "tool names must match their routes, not the console");

  const realFetch = globalThis.fetch;
  try {
    testGlobals.fetch = async () => new Response("not found", { status: 404 });
    for (const name of FRAME_TOOLS) {
      const args = name === "lens" ? { url: "https://example.com" }
        : name === "radar" ? { samples: [{ name: "AP", rssi: -58 }] }
        : {};
      const res = await handleSiteMcp(mcpPost({
        jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args, ...MODERN_META },
      }), env, context());
      const { result, error } = await res.json();
      assert.ok(!error, `${name} is listed but not dispatched: ${JSON.stringify(error)}`);
      const frame = result.structuredContent?.frame ?? "";
      assert.ok(frame.length > 20, `${name} returned no frame`);
      assert.ok(frame.startsWith(name.replace("_", "-")) || frame.includes(name.replace("_", "-")),
        `${name}'s frame does not say which tool drew it: ${frame.slice(0, 60)}`);
      assert.ok(!frame.includes("\x1b"), `${name} returned ANSI escapes into a model context`);
    }
  } finally {
    testGlobals.fetch = realFetch;
  }
});

test("the tui frame never renders a photo field the public projection withholds", async () => {
  _resetPhotoCaches();
  const env = { ASSETS: staticAssets({
    ...TERMINAL_ASSETS,
    "/images/metadata.json": {
      A_1: {
        camera: "FUJIFILM X-T50", film: "Classic Chrome", date: "2026:01:02",
        gps: "40.7128,-74.0060", gpsLatitude: 40.7128, serialNumber: "SECRET123",
        recipe: { "Film Simulation": "Classic Chrome" },
      },
    },
  }) };
  const text = await (await handleTool(terminalReq("/photos?open=A_1&plain=1"), env, context())).text();
  assert.ok(text.includes("Classic Chrome"), "the frame did not render at all");
  for (const secret of ["40.7128", "-74.0060", "SECRET123"]) {
    assert.ok(!text.includes(secret), `the frame leaked a withheld field: ${secret}`);
  }
});
