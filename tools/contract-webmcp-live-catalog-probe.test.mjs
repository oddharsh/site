// ── the live WebMCP catalog probe: its rules, without a browser ─────────────
import {
  SITE_MCP_TOOLS,
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";
import { diffCatalog, expectedCatalog, lensPageToolNames } from "./lib/webmcp-catalog.ts";

const LENS_WEBMCP = readFileSync("./src/client/lens-webmcp.js", "utf8");
const SITE = SITE_MCP_TOOLS.map((t) => t.name);

test("the Lens page-tool list reads six names from lens-webmcp.js", () => {
  const names = lensPageToolNames(LENS_WEBMCP);
  assert.equal(names.length, 6, `expected 6 Lens page tools, read ${names.length}: ${names.join(" ")}`);
  assert.throws(() => lensPageToolNames("export const nothing = [];"), /const defs = \[/);
});

test("/lens expects the /mcp catalog plus its page tools; every other page expects /mcp only", () => {
  const lens = lensPageToolNames(LENS_WEBMCP);
  assert.equal(expectedCatalog("/lens", SITE, lens).length, SITE.length + lens.length);
  for (const route of ["/lens/", "/lens?u=x", "/lens#a"]) {
    assert.equal(expectedCatalog(route, SITE, lens).length, SITE.length + lens.length, `${route} is /lens`);
  }
  for (const route of ["/", "/garage", "/whoareyou", "/lensx"]) {
    assert.deepEqual(expectedCatalog(route, SITE, lens), [...SITE].sort(), `${route} should expect /mcp only`);
  }
});

test("the diff reports a dropped tool and an unexpected one, and nothing when they agree", () => {
  const expected = ["a", "b", "c"];
  assert.deepEqual(diffCatalog(expected, ["a", "b", "c"]), { missing: [], extra: [] });
  assert.deepEqual(diffCatalog(expected, ["c", "a"]), { missing: ["b"], extra: [] });
  assert.deepEqual(diffCatalog(expected, ["a", "b", "c", "z"]), { missing: [], extra: ["z"] });
  assert.deepEqual(diffCatalog(expected, []), { missing: ["a", "b", "c"], extra: [] });
});
