// ── a control that says it's a button takes the keyboard like one ───────────
// The Clock accessory's close was `<span class="x" role="button">`: announced
// as a button, but with no tabindex a keyboard never reached it, and nothing
// handled Enter, Space or Escape. Run, Tip of the Day and the tray balloon all
// close with a native <button>, so the Clock was the one window a keyboard user
// could open from Run and not shut. Found by the second specification.website
// audit, 2026-10-17.
//
// Two checks. Anything given role="button" must also be focusable, since a
// native <button> already is. And the accessory window closes on Escape, the
// way Run does.
import { readFileSync } from "node:fs";
import { repoFiles } from "../lib/repo-files.ts";
import { assert, test } from "./contract-shared.ts";

// A role="button" open tag that isn't a <button> and carries no tabindex.
function unreachable(source) {
  return [...source.matchAll(/<([a-z][a-z0-9]*)\b[^<>]*\brole=\\?["']button\\?["'][^<>]*>/g)]
    .filter(([tag, name]) => name !== "button" && !/\btabindex=/.test(tag))
    .map(([tag]) => tag.slice(0, 80));
}

test("the check flags the old Clock close and passes a focusable one (control)", () => {
  assert.equal(unreachable(`'<span class="x" role="button" title="close" aria-label="close">✕</span>'`).length, 1);
  assert.equal(unreachable(`"<span class=\\"x\\" role=\\"button\\">"`).length, 1, "escaped quotes in a JS string");
  assert.deepEqual(unreachable('<div class="drop" tabindex="0" role="button">'), []);
  assert.deepEqual(unreachable('<button type="button" class="x" role="button">'), []);
});

test("no source gives role=button to an element the keyboard can't reach", () => {
  const files = repoFiles(["src/client", "src/pages", "src/worker", "serendipity", "cal/src"]).filter((f) => /\.(js|ts|html)$/.test(f));
  assert.ok(files.length >= 100, `only ${files.length} source files listed`);
  const found = files.flatMap((f) => unreachable(readFileSync(f, "utf8")).map((t) => `${f}: ${t}`));
  assert.deepEqual(found, []);
});

test("the accessory window closes with a native button and on Escape", () => {
  const run = readFileSync("src/client/nav-run.ts", "utf8");
  const open = run.slice(run.indexOf("function openAccessory("), run.indexOf("var tb = win.querySelector"));
  assert.ok(open.length > 200, "openAccessory moved; point this test at it");
  assert.match(open, /<button type="button" class="x"[^>]* aria-label="Close">/);
  assert.match(open, /win\.addEventListener\("keydown"[\s\S]{0,80}e\.key !== "Escape"/, "the accessory must close on Escape");
  // The button is a <button> now, so its rule has to undo the UA's padding,
  // font and colour or the glyph shifts and turns black.
  const luna = readFileSync("src/styles/luna.css", "utf8");
  const rule = /\.axp-acc>\.tb \.x\{([^}]*)\}/.exec(luna)?.[1] ?? "";
  for (const decl of ["padding:0", "font:inherit", "color:inherit"]) assert.ok(rule.includes(decl), `.axp-acc>.tb .x lacks ${decl}`);
});
