import { runInNewContext } from "node:vm";
// A dragged window keeps its translate() after the drag ends, and WebKit's
// PointerEvent.clientX is a double, so a trackpad drag used to leave the window
// at offsets like translate(127.297px, 176.617px). In Search, a WKWebView
// browser, the screen then showed the whole window resampled: text sharpness
// fell 30% (gotcha 77). WebKit's own snapshots draw it crisp, so a screenshot
// test can't catch the regression. This runs nav.js's own snapping helper and
// pins that the drag routes both axes through it.
import { readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";

const src = readFileSync(new URL("src/client/nav.ts", ROOT), "utf8");
const start = src.indexOf("function initDrag()");
const drag = src.slice(start, src.indexOf("D.addEventListener(\"pointerdown\"", start));

/** nav.js's onGrid, evaluated against a stubbed devicePixelRatio. */
function onGridAt(dpr) {
  const m = /function onGrid\(v\) \{[^}]*\}/.exec(drag);
  assert.ok(m, "initDrag lost its onGrid helper");
  return runInNewContext(`${m[0]}; onGrid;`, { devicePixelRatio: dpr });
}

test("onGrid lands any coordinate on the device-pixel grid", () => {
  for (const dpr of [1, 1.5, 2, 3]) {
    const onGrid = onGridAt(dpr);
    for (const v of [127.296875, 176.6171875, -5.1, 0.24, 1033.71]) {
      const px = onGrid(v) * dpr;
      assert.ok(Math.abs(px - Math.round(px)) < 1e-9, `dpr ${dpr}: ${v} snapped to ${onGrid(v)}, off the grid`);
      assert.ok(Math.abs(onGrid(v) - v) <= 0.5 / dpr + 1e-9, `dpr ${dpr}: ${v} moved more than half a device pixel`);
    }
  }
  assert.equal(onGridAt(undefined)(127.296875), 127, "no devicePixelRatio falls back to whole CSS pixels");
});

test("the window drag snaps both axes before it writes the transform", () => {
  const write = drag.indexOf("win.style.transform =");
  assert.ok(write > 0, "initDrag no longer writes the transform");
  const before = drag.slice(0, write);
  assert.match(before, /dx = onGrid\(r\.left \+ dx\) - r\.left/, "dx reaches the transform unsnapped");
  assert.match(before, /dy = onGrid\(r\.top \+ dy\) - r\.top/, "dy reaches the transform unsnapped");
});
