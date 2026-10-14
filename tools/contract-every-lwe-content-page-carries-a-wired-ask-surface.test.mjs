// ── the LWE ask surface ─────────────────────────────────────────────────────
// Split-file convention: shared imports live in contract-shared.mjs.
import {
  ROOT,
  assert,
  readFile,
  readdir,
  test,
} from "./contract-shared.ts";

test("every LWE content page carries a wired ask surface", async () => {
  const askJs = await readFile(new URL("src/client/lwe/ask.js", ROOT), "utf8");
  const concepts = JSON.parse(askJs.match(/var CONCEPTS = (\{[^;]*?\});/)[1]);
  const registry = JSON.parse(
    await readFile(new URL("pipelines/lwe/concepts.json", ROOT), "utf8")).concepts;
  const passages = await readFile(new URL("lwe-ask/src/passages.ts", ROOT), "utf8");

  const pages = (await readdir(new URL("src/pages/lwe/", ROOT)))
    .filter((f) => f.endsWith(".html") && f !== "index.html")
    .map((f) => f.replace(/\.html$/, ""));
  assert.ok(pages.length >= 11, `expected LWE content pages, saw ${pages.length}`);

  for (const id of pages) {
    const html = await readFile(new URL(`src/pages/lwe/${id}.html`, ROOT), "utf8");
    assert.match(html, /src="\/lwe\/ask\.js"/, `${id}: must ship ask.js`);
    assert.match(html, /class="compose"/, `${id}: ask.js needs a .compose bar to replace`);
    assert.match(html, /class="log"/, `${id}: ask.js needs a .log to append answers into`);
    assert.equal(concepts[`/lwe/${id}`], id,
      `${id}: absent from ask.js CONCEPTS, so the widget no-ops. Run: node pipelines/lwe/generate.mjs wire`);
    const entry = registry.find((c) => c.id === id);
    assert.ok(entry, `${id}: missing from pipelines/lwe/concepts.json, the source wire reads`);
    assert.equal(entry.hasAsk, true, `${id}: hasAsk must be true to reach the CONCEPTS map`);
    assert.ok(passages.includes(`concept: "${id}"`),
      `${id}: no passages in the corpus. Add lwe-ask/corpus/${id}.json, then run build-corpus.mjs`);
  }

  for (const path of Object.keys(concepts)) {
    assert.ok(pages.includes(path.replace("/lwe/", "")),
      `${path} is indexed for ask but has no page under src/pages/lwe/`);
  }
});
