// ── asset rewrites only skip files they cannot match ────────────────────────
// hashClientAssets (build step 6) skips a staged file before running a loader's
// patterns unless the file holds one of loaderNeedles(): the asset's path, or
// an import()'s `also` specifiers. That cut step 6 from about 610 to 140 ms of
// CPU, and it is only sound while every pattern contains one of those literals
// verbatim. A loader shape whose pattern could match without one would leave a
// reference unrewritten, pointing at a URL that is not content-addressed.
import {
  assert,
  test,
} from "./contract-shared.ts";

const { CLIENT_ASSETS, loaderNeedles, loaderRewrites } = await import("./lib/client-assets.ts");
// the escaping a RegExp source carries for a literal, as client-assets.ts writes it
const esc = (s) => s.replace(/[\\/.*+?^${}()|[\]]/g, "\\$&");

test("every rewrite pattern contains one of its loader's needles", () => {
  let checked = 0;
  for (const a of CLIENT_ASSETS) {
    for (const loader of a.load) {
      const needles = loaderNeedles(a, loader);
      for (const [re] of loaderRewrites(a, loader, "/a/x.00000000.js")) {
        assert.ok(needles.some((n) => re.source.includes(esc(n))), `${a.file} via ${loader.via}: /${re.source}/ holds none of ${JSON.stringify(needles)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 30, `checked ${checked} patterns`);
});

test("an import with also-specifiers is found by either spelling", () => {
  const pairs = CLIENT_ASSETS.flatMap((a) => a.load.flatMap((l) => (l.via === "import" && l.also?.length ? [{ a, l }] : [])));
  assert.ok(pairs.length, "the registry still has an import() with an alternative specifier");
  for (const { a, l } of pairs) {
    const needles = loaderNeedles(a, l);
    for (const spec of l.also ?? []) {
      const text = `import("${spec}${l.query ?? ""}")`;
      const [[re]] = loaderRewrites(a, l, "/a/x.00000000.js");
      assert.ok(re.test(text), `the pattern rewrites ${text}`);
      assert.ok(needles.some((n) => text.includes(n)), `and the needles let ${text} through`);
    }
  }
});
