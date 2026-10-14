// The HyperCam 2 watermark was never antialiased type. HyperCam drew it in
// Windows' bold System font, black on a white box the size of the 16px cell,
// and the first version here (2026-10-14) set it as Tahoma text instead: wrong
// weight, smoothed edges, a third too small. luna.css now draws it as an SVG of
// rectangles. This pins those rectangles to the bitmap below, which is the 16px
// strike of Wine's System font clone (fonts/system.sfd, LGPL) set as
// "Unregistered HyperCam 2", and pins the homepage's first-paint copy of the
// pixel steps to luna's, so the window and icons don't move when luna lands.
import { readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";

const BITMAP = `
  ........................................................................................................................................................................
  ........................................................................................................................................................................
  ........................................................................................................................................................................
  .##....##...............................##.......................................##......##....##.................................####............................####..
  .##....##...............................##..........##...........................##......##....##................................##..##..........................##..##.
  .##....##...........................................##...........................##......##....##...............................##....##.........................##..##.
  .##....##..#####...####..####....#####..##...####..####..####...####..####....#####......##....##.##....##.#####....####...####.##........####...#########...........##.
  .##....##..##..##..###..##..##..##..##..##..##..##..##..##..##..###..##..##..##..##......########.##....##.##..##..##..##..###..##.......##..##..##..##..##.........##..
  .##....##..##..##..##...##..##..##..##..##...##.....##..##..##..##...##..##..##..##......##....##..##..##..##..##..##..##..##...##...........##..##..##..##........##...
  .##....##..##..##..##...#####...##..##..##....##....##..#####...##...#####...##..##......##....##..##..##..##..##..#####...##...##........#####..##..##..##.......##....
  .##....##..##..##..##...##......##..##..##.....##...##..##......##...##......##..##......##....##...####...##..##..##......##...##....##.##..##..##..##..##......##.....
  ..##..##...##..##..##...##..##..##..##..##..##..##..##..##..##..##...##..##..##..##......##....##...####...##..##..##..##..##....##..##..##..##..##..##..##......##.....
  ...####....##..##..##....####....#####..##...####....##..####...##....####....#####......##....##....##....#####....####...##.....####....#####..##..##..##......######.
  ....................................##...............................................................##....##...........................................................
  ................................##..##..............................................................##.....##...........................................................
  .................................####..............................................................##......##...........................................................
`.trim().split("\n").map((r) => r.trim());

const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

/** Rasterize the path luna.css ships: rectangles spelled `M{x} {y}h{w}v{h}h-{w}z`. */
function rasterize(d, w, h) {
  const grid = Array.from({ length: h }, () => Array(w).fill("."));
  const rect = /M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g;
  let seen = 0;
  for (const m of d.matchAll(rect)) {
    const [x, y, rw, rh, back] = m.slice(1).map(Number);
    assert.equal(back, rw, `rectangle at ${x},${y} does not close`);
    for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) grid[yy][xx] = "#";
    seen += m[0].length;
  }
  assert.equal(seen, d.length, "the path holds only M/h/v/z rectangles, so this raster is the whole picture");
  return grid.map((r) => r.join(""));
}

function watermark(css) {
  const rule = /body::before\{[^}]*url\("data:image\/svg\+xml,([^"]+)"\)[^}]*\}/.exec(css);
  assert.ok(rule, "luna.css draws body::before from an SVG data URI");
  const svg = decodeURIComponent(rule[1]);
  const [, vw, vh] = /viewBox='0 0 (\d+) (\d+)'/.exec(svg) ?? [];
  return { rule: rule[0], svg, w: Number(vw), h: Number(vh), d: /<path d='([^']+)'\/>/.exec(svg)?.[1] ?? "" };
}

/** `--hypercam-px` per min-width step, as a stylesheet or an inline <style> spells it. */
function steps(text) {
  const out = {};
  for (const m of text.matchAll(/(?:@media \(min-width: ?(\d+)px\) ?\{ ?)?html ?\{ ?--hypercam-px: ?(\d+)px/g)) out[m[1] ?? 0] = Number(m[2]);
  return out;
}

test("the rasterizer sees a single wrong pixel", () => {
  // A finding in a fixture IS found, so an exact match below means equal and not blind.
  assert.deepEqual(rasterize("M1 0h2v1h-2z", 4, 2), [".##.", "...."]);
  const { d, w, h } = watermark(read("src/styles/luna.css"));
  const nudged = d.replace(/^M(\d+)/, (_, x) => `M${Number(x) + 1}`);
  assert.notDeepEqual(rasterize(nudged, w, h), BITMAP);
});

test("the watermark is the System font's bitmap, pixel for pixel", () => {
  const { svg, w, h, d } = watermark(read("src/styles/luna.css"));
  assert.equal(BITMAP.length, 16);
  assert.ok(BITMAP.every((r) => r.length === 168));
  assert.deepEqual([w, h], [168, 16], "one viewBox unit per bitmap pixel");
  assert.match(svg, /shape-rendering='crispEdges'/, "crisp edges, so a fractional device pixel ratio doesn't grey the stems");
  assert.doesNotMatch(svg, /fill=/, "the glyphs take SVG's default fill, pure black, as HyperCam's did");
  assert.deepEqual(rasterize(d, w, h), BITMAP);
});

test("the box scales by whole CSS pixels and holds no text", () => {
  const { rule } = watermark(read("src/styles/luna.css"));
  assert.match(rule, /content:""/, "empty content: the glyphs are a picture, outside the accessibility tree");
  assert.match(rule, /width:calc\(168 \* var\(--hypercam-px\)\)/);
  assert.match(rule, /height:var\(--hypercam-h\)/);
  const luna = steps(read("src/styles/luna.css"));
  assert.ok(Object.keys(luna).length >= 2, `luna.css sets --hypercam-px at ${Object.keys(luna).length} steps`);
  for (const [at, px] of Object.entries(luna)) assert.ok(Number.isInteger(px) && px >= 1, `${px}px at ${at}px wide is not a whole pixel`);
});

test("the homepage reserves the same band at first paint", () => {
  const page = read("src/pages/index.html");
  assert.deepEqual(steps(page), steps(read("src/styles/luna.css")), "index.html's inline --hypercam-px steps drifted from luna.css");
  assert.match(page, /--hypercam-h: calc\(16 \* var\(--hypercam-px\)\)/);
  assert.match(page, /padding-top: calc\(var\(--hypercam-h\) \+ 8px\)/, "the window column starts below the band before luna lands");
  assert.match(page, /#axp-icons\s*\{[^}]*inset: var\(--hypercam-h\) 0 0/, "so does the icon layer");
});
