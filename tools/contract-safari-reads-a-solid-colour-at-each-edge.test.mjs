// Safari 26 tints its status bar and toolbars from the page: it hit-tests just
// inside each obscured edge, takes the frontmost fixed box, and extends that
// box's COMPUTED background-color (LocalFrameView::fixedContainerEdges). A
// gradient or image reads as transparent, a box 10px tall or less gets its
// pixels sampled instead, and backdrop-filter disqualifies it. None of that
// shows on screen, so the mistake comes back silently: the taskbar goes back to
// the `background:` shorthand and the toolbar under it turns grey. This pins
// the two boxes luna.css hands Safari (gotcha 67).
import { readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";

const css = readFileSync(new URL("src/styles/luna.css", ROOT), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration block whose selector list names `sel` exactly. */
function blocks(sel) {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(",").some((s) => s.trim() === sel)) out.push(m[2]);
  }
  return out;
}

test("html defines both edge colours", () => {
  const html = blocks("html").join(";");
  assert.match(html, /--edge-top:\s*oklch\(/);
  assert.match(html, /--edge-bottom:\s*oklch\(/);
});

test("the top sampler is a fixed, full-width box over 10px with an opaque colour and no paint", () => {
  const [b] = blocks("html::before");
  assert.ok(b, "luna.css has no html::before sampler");
  assert.match(b, /position:\s*fixed/);
  assert.match(b, /left:\s*0/);
  assert.match(b, /right:\s*0/);
  assert.match(b, /top:\s*0/);
  const h = Number(/(?:^|;)height:\s*(\d+)px/.exec(b)?.[1]);
  assert.ok(h > 10, `sampler is ${h}px; WebKit reads the colour only above 10px`);
  assert.match(b, /background-color:\s*var\(--edge-top\)/);
  assert.match(b, /(?:^|;)background-clip:\s*text/, "without the text clip the sampler paints a strip");
  assert.doesNotMatch(b, /backdrop-filter|opacity|visibility/);
});

test("the taskbar carries a solid background-color for the bottom edge", () => {
  const all = blocks("#axp-taskbar");
  assert.ok(all.length, "no #axp-taskbar rule");
  assert.ok(all.some((b) => /background-color:\s*var\(--edge-bottom\)/.test(b)), "#axp-taskbar lost its background-color");
  for (const b of all) {
    assert.doesNotMatch(b, /(?:^|;)\s*background:/, "the background shorthand resets background-color to transparent");
    assert.doesNotMatch(b, /backdrop-filter/, "backdrop-filter stops Safari sampling the taskbar (WebKit 319479)");
  }
});
