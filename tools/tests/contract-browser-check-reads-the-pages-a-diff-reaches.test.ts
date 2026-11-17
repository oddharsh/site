// ── browser:check --changed reads the pages a diff reaches, or all of them ───
import { assert, test } from "./contract-shared.ts";
import { pageOf, reach, rereadsEverything } from "../lib/browser-pages.ts";

const sources = new Map([
  ["src/pages/lwe/dac.html", '<link href="/luna.css"><script src="/lwe/ask.js"></script><script src="/nav.js"></script>'],
  ["src/pages/lwe/knots.html", '<link href="/luna.css"><script src="/nav.js"></script>'],
  ["src/pages/garage/htmx.html", '<link href="/luna.css"><link href="/prose.css"><script src="/nav.js"></script>'],
  ["src/client/lwe/ask.ts", "export {};"],
  ["src/client/nav.ts", 'import "./nav-tips.ts";'],
  ["src/client/nav-tips.ts", "export {};"],
  ["src/client/orphan.ts", "export {};"],
  ["src/styles/luna.css", "body {}"],
  ["src/styles/prose.css", "p {}"],
  ["src/worker/home.ts", 'const css = "/luna.css";'],
]);

test("browser:check: a page's own document reaches that page", () => {
  assert.deepEqual(reach(["src/pages/lwe/dac.html", "src/pages/lwe/knots.html"], sources), { pages: ["/lwe/dac", "/lwe/knots"] });
  assert.equal(pageOf("src/pages/index.html"), "/");
  assert.equal(pageOf("src/pages/lwe/index.html"), "/lwe");
});

test("browser:check: an asset reaches the pages that load it, through imports", () => {
  assert.deepEqual(reach(["src/client/lwe/ask.ts"], sources), { pages: ["/lwe/dac"] });
  assert.deepEqual(reach(["src/styles/prose.css"], sources), { pages: ["/garage/htmx"] });
  assert.deepEqual(reach(["src/client/nav-tips.ts"], sources), { pages: ["/garage/htmx", "/lwe/dac", "/lwe/knots"] });
});

test("browser:check: what it can't place reaches every page", () => {
  assert.deepEqual(reach(["src/styles/luna.css"], sources), { all: "src/worker/home.ts names src/styles/luna.css" });
  assert.deepEqual(reach(["src/client/orphan.ts"], sources), { all: "nothing under src/ names src/client/orphan.ts" });
  assert.deepEqual(reach(["src/worker/home.ts"], sources), { all: "src/worker/home.ts can reach any page" });
  assert.deepEqual(reach([".github/workflows/ci.yml"], sources), { all: ".github/workflows/ci.yml can reach any page" });
});

test("browser:check: docs, tests and other workflows reach no page", () => {
  assert.deepEqual(reach(["docs/GOTCHAS.md", "tools/tests/x.test.ts", ".github/workflows/photos.yml", "README.md"], sources), { pages: [] });
  assert.deepEqual(reach(["docs/GOTCHAS.md", "src/pages/lwe/knots.html"], sources), { pages: ["/lwe/knots"] });
});

test("browser:check: a change to the check itself rereads every page, whatever the served diff says", () => {
  assert.equal(rereadsEverything(["src/worker/home.ts", "config/browser-budget.json"]), "config/browser-budget.json changes how pages are read");
  assert.equal(rereadsEverything(["config/bun-pin.json"]), "config/bun-pin.json changes how pages are read");
  assert.equal(rereadsEverything(["tools/lib/browser-channel.ts"]), "tools/lib/browser-channel.ts changes how pages are read");
  assert.equal(rereadsEverything(["src/worker/home.ts", "src/dict/p-dict/about.dict", "bun.lock", "tools/served-pages.ts"]), undefined);
});
