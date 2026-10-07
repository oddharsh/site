// `flags.agents` puts a surface in MCP resources/list, which is the registry
// telling agents to read it. Until 2026-09-30 six of those surfaces (/ledger,
// /inbox, /reading, /lens/census, /serendipity, /search) answered `Accept:
// text/markdown` with HTML and 404ed at their `.md` URL, and three checks each
// missed them a different way: build.ts baked them after the twin step and only
// logged the miss, the route oracle listed Markdown rows by hand, and
// check-infra's production tier read `kind === "page"` alone.
//
// One rule now (tools/lib/agent-representation.ts) and three enforcers. This
// file proves the rule separates the cases it has to, and that each enforcer
// reads it rather than a private copy that can drift.
import { fileURLToPath } from "node:url";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { agentSurfacesWithoutTwin, buildTwins, readManifest, twinPath } from "./gen-md-twins.ts";
import { agentRepresentation, needsBuiltTwin } from "./lib/agent-representation.ts";

const root = fileURLToPath(ROOT);
const src = (rel) => readFile(new URL(rel, ROOT), "utf8");

test("the rule flags an agents surface with no twin and no declared representation, and nothing else", () => {
  const surfaces = [
    { path: "/twinned", flags: { agents: true } },
    { path: "/missing", flags: { agents: true } },
    { path: "/frame", mimeType: "text/plain", flags: { agents: true } },
    { path: "/live-md", mimeType: "text/markdown", flags: { agents: true } },
    { path: "/explicit-html", mimeType: "text/html", flags: { agents: true } },
    { path: "/human-only", flags: { agents: false } },
  ];
  assert.deepEqual(agentSurfacesWithoutTwin(surfaces, [twinPath("/twinned")]), ["/missing", "/explicit-html"]);
  // The control: the same registry with every twin present flags nothing.
  assert.deepEqual(agentSurfacesWithoutTwin(surfaces, surfaces.map((s) => twinPath(s.path))), []);

  assert.equal(agentRepresentation({ path: "/a" }), "text/markdown");
  assert.equal(agentRepresentation({ path: "/a", mimeType: "text/html" }), "text/markdown");
  assert.equal(agentRepresentation({ path: "/a", mimeType: "text/plain" }), "text/plain");
  assert.equal(needsBuiltTwin({ path: "/a", mimeType: "text/markdown" }), false);
});

test("the six island pages baked after the twin step each have a hand twin", () => {
  const { files } = buildTwins(root);
  for (const p of ["/ledger", "/inbox", "/reading", "/lens/census", "/serendipity", "/search"]) {
    assert.ok(files.has(twinPath(p)), `${p} has no twin from source; build.ts bakes it after step 1g, so only a hand twin in src/content/md/ can reach it`);
  }
});

test("every agents surface the source tree cannot twin is one the build generates before the twin step", () => {
  // From source alone, the only misses are pages build.ts renders at 1d-1f and
  // twins from the staged tree. The build's own throw covers the full set; this
  // pins the source-side list so a new miss shows up here without a build.
  const { files, committed } = buildTwins(root);
  const missing = agentSurfacesWithoutTwin(readManifest(root).surfaces, [...files.keys(), ...committed]).sort();
  assert.deepEqual(missing, ["/photos", "/restore", "/updates"],
    "a new agents:true surface has no Markdown twin: add a hand twin in src/content/md/, declare mimeType for a live representation, or drop flags.agents");
});

test("the terminal tools declare the text/plain frame they answer agents with", () => {
  const { surfaces } = readManifest(root);
  for (const p of ["/finger", "/radar", "/dict", "/cache", "/encode", "/agent-ready"]) {
    const s = surfaces.find((x) => x.path === p);
    assert.ok(s?.flags?.agents, `${p} is no longer an agents surface`);
    assert.equal(s.mimeType, "text/plain", `${p} answers agents with its frame, so the registry must say text/plain`);
  }
});

test("build.ts, the route oracle and check-infra all enforce the shared rule", async () => {
  const build = await src("tools/build.ts");
  assert.match(build, /const untwinned = agentSurfacesWithoutTwin\(readManifest\("\."\)\.surfaces, \[\.\.\.files\.keys\(\), \.\.\.committed\]\)/);
  assert.match(build, /if \(untwinned\.length\) \{\s*throw new Error/);

  const oracle = await src("tools/verify-routes.ts");
  assert.match(oracle, /from "\.\/lib\/agent-representation\.ts"/);
  assert.match(oracle, /agentSurfaces\(surfaces\)[\s\S]*?ct: agentRepresentation\(s\)/);
  assert.match(oracle, /\.\.\.ROUTES, \.\.\.AGENT_ROWS/);

  const infra = await src("tools/check-infra.ts");
  const body = infra.slice(infra.indexOf("async function checkAgentMarkdown"));
  assert.ok(body.length > 100, "checkAgentMarkdown is gone");
  const fn = body.slice(0, body.indexOf("\n}\n"));
  assert.match(fn, /agentSurfaces\(surfaces\)/);
  assert.match(fn, /agentRepresentation\(p\)/);
  assert.doesNotMatch(fn, /kind === "page"/, "the production tier must cover every agents surface whatever its kind");
});
