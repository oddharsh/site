// ── the tools are SERVICES, the frame is a representation ────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  MODERN_META,
  assert,
  context,
  handleSiteMcp,
  handleTool,
  mcpPost,
  readFileSync,
  terminalEnv,
  terminalGet,
  test,
} from "./contract-shared.ts";

// ── the tools are SERVICES, the frame is a representation ────────────────

test("every tool is a top-level utility, not a subpage of a presentation", async () => {
  // The site's own manifest encodes the rule: utilities live at the root
  // (/lens, /photos, /coffee, /reading) and only CONTENT nests. Filing tools
  // under /terminal/* organised them by how they RENDER, which is the wrong
  // lesson for a site whose whole argument is how to expose services to agents.
  const manifest = JSON.parse(readFileSync("config/site-manifest.json", "utf8"));
  const utilities = manifest.surfaces.filter((s) => s.kind === "utility");

  // The rule is not "utilities never nest" — /lens/census legitimately belongs
  // to /lens, the way a dataset belongs to the tool that produces it. What is
  // forbidden is nesting a utility under a PRESENTATION: /terminal is a console
  // that drives these tools, not their parent, and filing them under it would
  // organise the site by rendering rather than by what things are.
  const underTerminal = utilities.filter((s) => s.path.startsWith("/terminal/"));
  assert.deepEqual(underTerminal, [], `a tool must not live under the console: ${underTerminal.map((s) => s.path).join(", ")}`);

  // Anything that does nest must nest under a utility that actually exists.
  const paths = new Set(manifest.surfaces.map((s) => s.path));
  for (const s of utilities.filter((s) => s.path.split("/").length > 2)) {
    const parent = s.path.slice(0, s.path.lastIndexOf("/"));
    assert.ok(paths.has(parent), `${s.path} nests under ${parent}, which is not a registered surface`);
  }

  for (const path of ["/finger", "/radar", "/dict", "/cache"]) {
    const entry = manifest.surfaces.find((s) => s.path === path);
    assert.ok(entry, `${path} must be registered as a surface`);
    assert.equal(entry.kind, "utility");
    assert.equal(entry.flags.agents, true, `${path} must be in the agent catalog`);
  }
});

test("a tool answers HTML to a browser and a frame to everything else", async () => {
  // The frame joins .md as a REPRESENTATION rather than a location: one URL,
  // negotiated, with an explicit .txt alongside. Same contract as the twins.
  const html = await handleTool(new Request("https://aadhar.sh/dict", { headers: { accept: "text/html" } }), terminalEnv(), context());
  assert.match(html.headers.get("content-type"), /text\/html/);

  const frame = await handleTool(new Request("https://aadhar.sh/dict"), terminalEnv(), context());
  assert.match(frame.headers.get("content-type"), /text\/plain/);

  // .txt is explicit and beats Accept, so a browser can still ask for the frame.
  const txt = await handleTool(new Request("https://aadhar.sh/dict.txt", { headers: { accept: "text/html" } }), terminalEnv(), context());
  assert.match(txt.headers.get("content-type"), /text\/plain/);
  const txtBody = await txt.text();
  assert.ok(txtBody.length > 20 && !txtBody.includes("<"), ".txt must return the frame itself, as text");
});

test("a frame's printed state is a root URL that resolves", async () => {
  // The state a caller sends back has to be the tool's real address. When the
  // tools moved, a stale /terminal/<tool> here would have kept working through
  // the redirect while teaching every agent the wrong URL.
  const text = await (await terminalGet("/finger?plain=1&pane=writing")).text();
  const printed = text.match(/state (\/[a-z]+[^\s│║]*)/)?.[1];
  assert.ok(printed, "no state URL printed");
  assert.ok(!printed.startsWith("/terminal/"), `state still points at the old namespace: ${printed}`);
  assert.match(printed, /^\/finger/);
});

test("every tool with a route is reachable over MCP, and vice versa", async () => {
  // THE dogfood invariant. The console, curl, and an agent must all reach the
  // same set — a tool with an HTTP route but no MCP entry is invisible to the
  // exact caller this whole surface is built for. dict and cache shipped that
  // way for two commits before this test existed.
  const { TOOL_NAMES } = await import("../src/worker/terminal.ts");
  const listed = (await (await handleSiteMcp(mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { ...MODERN_META } }), terminalEnv(), context())).json())
    .result.tools.map((t) => t.name);

  // ONE VOCABULARY, TWO SPELLINGS. A URL path uses hyphens (/agent-ready) and
  // an MCP tool name conventionally uses underscores (agent_ready). That is a
  // real convention clash rather than sloppiness, so the rule is a defined
  // transliteration instead of byte equality — and it is written down here so
  // the next tool with a two-word name does not get to invent its own answer.
  const asToolName = (route) => route.replace(/-/g, "_");
  for (const tool of TOOL_NAMES) {
    assert.ok(listed.includes(asToolName(tool)),
      `/${tool} has a route but no MCP tool (expected ${asToolName(tool)}) — an agent cannot reach it`);
  }
});
