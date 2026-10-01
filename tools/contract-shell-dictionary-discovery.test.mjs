import { assert, test } from "./contract-shared.ts";
import { shellAssetRefs } from "./lib/shell-roots.ts";

test("dictionary discovery keeps complete JS, CSS and SVG filenames", () => {
  assert.deepEqual(shellAssetRefs(`
    <script src="/a/nav.1234abcd.js"></script>
    <link href="/a/luna.abcdef12.css?v=2">
    <img src="/a/icons.0123abcd.svg#pin-garage">
    import("/a/nav-run.01234567.js");
  `), ["nav.1234abcd.js", "luna.abcdef12.css", "icons.0123abcd.svg", "nav-run.01234567.js"]);
});

test("dictionary discovery never turns JSON data or source maps into scripts", () => {
  assert.deepEqual(shellAssetRefs(`
    <script type="application/json" src="/a/quiz-lwe-utf8.94c40998.json"></script>
    fetch("/a/pixel-peeper-manifest.119c850a.json");
    /a/nav.1234abcd.js.map /a/nav.1234abcd.javascript
    /a/nav.1234abc.js /a/nav.1234abcde.js
  `), []);
});
