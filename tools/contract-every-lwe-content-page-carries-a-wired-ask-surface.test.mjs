// ── the LWE ask surface ─────────────────────────────────────────────────────
// Split-file convention: shared imports live in contract-shared.mjs.
import {
  ROOT,
  assert,
  readFile,
  readdir,
  test,
} from "./contract-shared.mjs";

test("every LWE content page carries a wired ask surface", async () => {
  // "All LWE pages have an ask surface" is a definition rather than a habit, and it
  // held only by hand until 2026-08-21. /lwe/lean shipped ask.js, rendered the compose
  // bar, and silently no-opped for weeks, because ask.js returns early on any path
  // missing from its generated CONCEPTS map and lean had never reached concepts.json.
  //
  // The failure is an ABSENCE (a decorative compose bar that never becomes an ask box),
  // so nothing errored and no other check looked. Four registries had been hand-patched
  // around it: the sitemap, the buddy list, its stale "Online · 10" count, and nav-run.
  // Root cause was generate.mjs resolving three of its four wire targets against
  // src/pages/ after the 2026-08-18 layout split moved them, then failing SOFT.
  //
  // This asserts the whole chain per page, derived from the directory, so a new page
  // that forgets any link in it fails here instead of shipping a dead widget.
  const askJs = await readFile(new URL("public/lwe/ask.js", ROOT), "utf8");
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
    // ask.js mounts by replacing .compose and appending into .log. Missing either
    // makes it return early, which looks identical to the page having no ask feature.
    assert.match(html, /class="compose"/, `${id}: ask.js needs a .compose bar to replace`);
    assert.match(html, /class="log"/, `${id}: ask.js needs a .log to append answers into`);
    assert.equal(concepts[`/lwe/${id}`], id,
      `${id}: absent from ask.js CONCEPTS, so the widget no-ops. Run: node pipelines/lwe/generate.mjs wire`);
    const entry = registry.find((c) => c.id === id);
    assert.ok(entry, `${id}: missing from pipelines/lwe/concepts.json, the source wire reads`);
    assert.equal(entry.hasAsk, true, `${id}: hasAsk must be true to reach the CONCEPTS map`);
    // An indexed concept with no passages retrieves nothing, so the box accepts a
    // question and answers with silence. That is worse than having no box at all.
    assert.ok(passages.includes(`concept: "${id}"`),
      `${id}: no passages in the corpus. Add lwe-ask/corpus/${id}.json, then run build-corpus.mjs`);
  }

  // Reverse direction: a CONCEPTS entry whose page has gone away sends a real question
  // at a corpus filter that can never match.
  for (const path of Object.keys(concepts)) {
    assert.ok(pages.includes(path.replace("/lwe/", "")),
      `${path} is indexed for ask but has no page under src/pages/lwe/`);
  }
});
