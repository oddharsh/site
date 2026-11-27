// ── an inline <script> is minified as the classic script a browser runs ─────
//
// A browser runs an inline <script> without type=module as a sloppy classic
// script, where Annex B hoists a function declared inside a block to the
// enclosing function. Oxc picks the source type from the filename, and the
// build's inline label (`public/lwe/fuse.html inline <script>`) has no
// extension, so until 2026-11-27 Oxc parsed every inline script as a strict
// module. There the block function is block-scoped, the mangler handed its name
// to an outer var, and in the browser the hoisted function overwrote that var:
// /lwe/fuse's "flash this build" threw `e.appendChild is not a function`
// (gotcha 121).
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { minifyJavaScript, OXC_MINIFY_OPTIONS } from "../lib/oxc-minify-options.ts";

// /lwe/fuse's two demos, cut down: `bank` is read later by a closure from the first
// block, and the second block declares a function the mangler may name after it.
const FUSE_DEMOS = `(function () {
  var log = [];
  var bank = { kind: "bank" };
  var click;
  if (bank) {
    function draw() { log.push("draw " + bank.kind); }
    click = function () { draw(); };
  }
  var imgs = { kind: "imgs" };
  if (imgs) {
    function set(v) { log.push("set " + v); }
    set(imgs.kind);
  }
  click();
  result = log.join(", ");
})();`;

const runClassic = (code: string) => {
  const context: { result?: string } = {};
  vm.runInNewContext(code, context);
  return context.result;
};

test("a block function keeps its own name once minified under the build's inline label", () => {
  assert.equal(runClassic(FUSE_DEMOS), "set imgs, draw bank", "control: the source itself");
  const minified = minifyJavaScript("public/lwe/fuse.html inline <script>", FUSE_DEMOS);
  assert.equal(runClassic(minified), "set imgs, draw bank", minified);
});

test("a top-level var under the inline label stays a global, and module: true still makes it private", () => {
  // In a classic script a top-level var is a property of window that a later
  // script can read, so `unused` must keep it. In a module it is private and
  // unread, and dropping it is right: the same source tells the two parses apart.
  assert.equal(minifyJavaScript("public/x.html inline <script>", "var shared = 1;"), "var shared=1;");
  assert.equal(minifyJavaScript("src/client/x.js", "var shared = 1;", { ...OXC_MINIFY_OPTIONS, module: true }), "");
});

test("build.ts minifies inline scripts through this wrapper under that label", () => {
  const build = readFileSync(new URL("../build.ts", import.meta.url), "utf8");
  assert.match(build, /import \{ minifyJavaScript, OXC_MINIFY_OPTIONS \} from "\.\/lib\/oxc-minify-options\.ts"/);
  assert.match(build, /minifyJavaScript\(`\$\{label\} inline <script>`, body\)/);
});
