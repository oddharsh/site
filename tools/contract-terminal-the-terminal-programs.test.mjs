// ── /terminal — the terminal programs ─────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  MODERN_META,
  TERMINAL_ASSETS,
  assert,
  context,
  handleSiteMcp,
  handleTerminal,
  handleTool,
  mcpPost,
  staticAssets,
  terminalEnv,
  terminalGet,
  terminalReq,
  test,
  testGlobals,
  tokenizeKeys,
} from "./contract-shared.mjs";

// ── /terminal — the terminal programs ─────────────────────────────────────────
// The renderer is pure and the apps are readers, so these run with stub assets
// and no network. What they pin is the handful of properties a frame stops
// being a frame without.

// /terminal stopped being a frame when the console became the wire view; it is
// an HTML page now and has its own tests below.
// Every state worth drawing, so a width regression cannot hide in the one pane
// nobody exercised. Panes that need network (reading, listening, around,
// coffee) still render here — their loaders fail closed to an empty list, which
// is itself the case worth pinning.
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
  // What replaced "every row is EXACTLY 80 columns". That invariant existed to
  // keep a drawn border lining up; the border is gone (2026-08-06), because a
  // window drawn in ASCII — [_][#][X] and all — inside a real window that
  // already had those controls was chrome pretending to be content.
  //
  // The useful half survives: a line that overflows 80 wraps in a terminal and
  // silently destroys the alignment of everything a tool laid out in columns.
  for (const path of TERMINAL_STATES) {
    const res = await terminalGet(path);
    assert.equal(res.status, 200, path);
    const text = await res.text();
    const lines = text.split("\n").filter((line) => line.length);
    // Was `> 3`, which only held because five of those lines were border. A
    // rejected target legitimately answers in two lines now.
    assert.ok(lines.length >= 2, `${path} produced no output`);
    for (const line of lines) {
      assert.ok([...line].length <= 80, `${path} drew a ${[...line].length}-column row: ${line}`);
    }
    // The chrome, named so it cannot creep back one glyph at a time.
    for (const glyph of ["╔", "╚", "║", "╟", "[_][#][X]"]) {
      assert.ok(!text.includes(glyph), `${path} is drawing frame chrome again (${glyph})`);
    }
  }
});

test("a tool frame never emits an escape byte, in any mode", async () => {
  // There is no colour mode left to get wrong. The audience for these routes is
  // curl and a model, and an escape sequence in a context window is noise the
  // model then has to be robust to. `?plain=1` used to be the opt-OUT; plain is
  // now the only thing there is, and the parameter is inert rather than removed
  // so old links keep working.
  for (const path of ["/finger", "/finger?plain=1", "/finger?plain=0", "/dict", "/photos"]) {
    const text = await (await terminalGet(path)).text();
    assert.ok(!text.includes("\x1b"), `${path} leaked an escape sequence`);
  }
  const a = await (await terminalGet("/finger?plain=1")).text();
  const b = await (await terminalGet("/finger")).text();
  assert.equal(a, b, "plain=1 and the default must be the same bytes now");
});

test("a frame's printed state is a URL that reproduces it", async () => {
  // The whole session model rests on this. State is a link rather than a stored
  // object, so a frame that prints a URL which does NOT come back to the same
  // frame has broken resume, fork, and every "pass the url back" instruction in
  // the MCP tool descriptions — while still looking completely correct.
  for (const path of ["/finger?pane=writing&keys=jj", "/finger?pane=deploys&keys=G", "/photos?film=acros&keys=j"]) {
    const first = await (await terminalGet(`${path}&plain=1`)).text();
    const printed = first.match(/state (\/[a-z]+(?:\?[^\s│║]*)?)/)?.[1];
    assert.ok(printed, `${path} printed no state URL`);
    // Replay the printed state with NO keys: same frame, minus the keystrokes.
    const replayed = await (await terminalGet(printed + (printed.includes("?") ? "&" : "?") + "plain=1")).text();
    assert.equal(replayed, first, `${path} does not reproduce from the URL it printed`);
  }
});

test("key sequences are bounded and named keys parse", () => {
  assert.deepEqual(tokenizeKeys("2jj<cr>"), ["2", "j", "j", "\r"]);
  assert.deepEqual(tokenizeKeys("<esc><tab><sp>"), ["\x1b", "\t", " "]);
  // An unknown <name> is not a key — it falls through to its literal characters
  // rather than being silently dropped, so a typo shows up in the frame.
  assert.deepEqual(tokenizeKeys("<nope>"), ["<", "n", "o", "p", "e", ">"]);
  // The bound is what stops one request driving the pane loader indefinitely.
  assert.equal(tokenizeKeys("j".repeat(500)).length, 32);
  assert.deepEqual(tokenizeKeys(""), []);
  assert.deepEqual(tokenizeKeys(null), []);
});

test(".plan is a real hidden finger pane: reachable, undocumented, falls back like any other bad pane", async () => {
  // The whole point is that a real finger daemon had no menu — you asked for a
  // name and got whatever was in its .plan file. This pins that shape: the pane
  // works when addressed directly, never appears in the numbered list or help,
  // and an actual typo still falls back to the overview like any other unknown
  // pane rather than the "plan" prefix matching loosely.
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

test("/terminal shows the wire, and renders it through the real MCP handler", async () => {
  // The page exists to show a VIEWER what an agent gets. That is only true if it
  // runs the actual handler: a second code path that merely agreed with /mcp
  // today is precisely the thing this page is supposed to not be.
  const res = await handleTerminal(new Request("https://aadhar.sh/terminal", {
    headers: { accept: "text/html" },
  }), terminalEnv(), context());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /^text\/html/);
  const html = await res.text();

  // The exchange itself: both halves of the request, and a catalogue that came
  // back from tools/list rather than from a hand-written list in this file.
  assert.match(html, /tools\/list/);
  assert.match(html, /tools\/call/);
  assert.match(html, /jsonrpc/);
  for (const tool of ["finger", "dict", "encode", "lens_inspect"]) {
    assert.ok(html.includes(tool), `the catalogue is missing ${tool}`);
  }

  // And it is not the emulator again. Named glyph by glyph and class by class,
  // because this regressed once already by being rebuilt one layer down: the
  // frames drew [_][#][X] in ASCII inside a real window that had those buttons.
  for (const ghost of ["ps-line", "ps-console", "PowerShell", "[_][#][X]", "╔", "terminal.js"]) {
    assert.ok(!html.includes(ghost), `/terminal is drawing the old console again (${ghost})`);
  }
});

test("a browser gets the same text a terminal does, not a second layout", async () => {
  // The claim survived the console's deletion, in a simpler form. A tool route
  // asked for HTML wraps the SAME frameText a .txt request gets in a <pre>; if
  // the HTML arm ever grew its own layout, what a person sees and what an agent
  // reads would start to differ and the page would be claiming something untrue.
  //
  // This used to compare console scrollback rows and assert on <span class="c-*">
  // colouring. Both are gone: there is no console, and no colour to lose.
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
  const res = await terminalGet("/terminal/nope");
  assert.equal(res.status, 404);
  assert.match(await res.text(), /\/terminal/);
  const post = await handleTool(new Request("https://aadhar.sh/finger", { method: "POST" }), terminalEnv(), context());
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
});

test("every frame tool the MCP server lists is one the server can actually call", async () => {
  // tools/list is a promise. A tool advertised but not dispatched fails only
  // when a client believes the list and calls it — which is exactly the caller
  // this surface exists for.
  const env = terminalEnv();
  const listed = (await (await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { ...MODERN_META } }), env, context())).json())
    .result.tools.map((tool) => tool.name);
  // The MCP tool name IS the route name. One vocabulary: what you type in the
  // console, what you curl, and what an agent calls are the same word.
  const FRAME_TOOLS = ["finger", "photos", "radar", "dict", "cache", "lens", "agent_ready"];
  for (const name of FRAME_TOOLS) assert.ok(listed.includes(name), `${name} has a route but is not an MCP tool`);
  assert.ok(!listed.some((n) => n.startsWith("terminal_")), "tool names must match their routes, not the console");

  // `agent_ready` with no arguments audits THIS origin, which fans out to 26
  // door probes plus 4 DNS-AID lookups. Measured 2026-08-21 with a fetch
  // counter, that was 30 real requests to production aadhar.sh on every run of
  // the one required check on main, and not one assertion below reads what they
  // answered. The doors are stubbed shut instead. Same frame, same assertions.
  //
  // The failure this avoids is the TIMEOUT rather than a bad answer, which is
  // worth stating because the obvious guess is wrong. Every probe here is
  // individually caught, so a dead network degrades to `unreadable` and the
  // suite still passes: measured by running all 47 files with `fetch` throwing,
  // 338 pass on this commit AND on the one before it. What a slow production
  // costs is wall clock against bun's 5000ms per-test default, which is a hard
  // fail. Cold, on a healthy workstation, the sibling agent-ready body spent
  // 3328ms of that 5000 on connection setup alone. A CI runner has no warm
  // route to aadhar.sh either.
  //
  // `lens` is inside the stub for symmetry alone. It fails at signing before it
  // reaches a fetch, measured at 0 escapes with the stub and without it.
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
      // terminal_lens reaches a real fetch it cannot make here, so it is allowed to
      // come back as a rendered failure — what it may NOT do is come back unknown.
      const frame = result.structuredContent?.frame ?? "";
      // Was `frame.includes("╔")`. The box is gone; what still has to be true is
      // that a frame came back at all and that it names the tool that drew it.
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
  // photos.js keeps GPS and unlisted EXIF behind PHOTO_PUBLIC_FIELDS. The frame
  // renders `photo.metadata`, so it inherits that projection — but it renders
  // the RECIPE card by iterating keys, and an iteration is exactly the shape
  // that picks up a field somebody adds later without meaning to publish it.
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
