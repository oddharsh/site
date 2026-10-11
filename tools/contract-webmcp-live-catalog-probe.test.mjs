// ── the live WebMCP catalog probe: its rules, without a browser ─────────────
//
// tools/webmcp-catalog.ts reads what a page actually registered (page.webmcp,
// Playwright 1.64) and diffs it against what should be there. The browser half
// can't run here (no network, no WebMCP Chrome), so this pins the half that
// decides pass or fail: the expected set per route, and the diff. A diff that
// can't report a missing tool would turn the probe green on exactly the
// failure it exists for.
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
  // Six on 2026-10-11, matching the live /lens catalog (31 = 25 + 6). A change
  // here is fine; a ZERO is the scanner losing the array, which this refuses.
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
  // The failure the probe exists for: a registrar that never booted.
  assert.deepEqual(diffCatalog(expected, []), { missing: ["a", "b", "c"], extra: [] });
});
