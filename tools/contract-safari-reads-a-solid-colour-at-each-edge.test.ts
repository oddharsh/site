// Safari 26 tints its status bar and toolbars from the page: it hit-tests just
// inside each obscured edge, takes the frontmost fixed box, and extends that
// box's COMPUTED background-color (LocalFrameView::fixedContainerEdges). A
// gradient or image reads as transparent, a box 10px tall or less gets its
// pixels sampled instead, and backdrop-filter disqualifies it. None of that
// shows on screen, so the mistake comes back silently: the taskbar goes back to
// the `background:` shorthand and the toolbar under it turns grey. This pins
// the two boxes luna.css hands Safari (gotcha 70).
import { readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";

const css = readFileSync(new URL("src/styles/luna.css", ROOT), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration block whose selector list names `sel` exactly. */
function blocks(sel) {
  const out: any[] = [];
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

// On iPhone the top edge only borders Safari's obscured inset when the page asks
// for viewport-fit=cover, so every document the site serves asks for it. Cover
// also runs the page under the status bar, the notch and the home indicator, so
// the shell steps in by luna.css's SAFE AREAS insets wherever it meets an edge.
const VIEWPORT = /name=\\?"viewport\\?" content=\\?"([^"\\]*)/g;
const EMITTERS = [
  "src/worker/lib/chrome.ts", "src/worker/writing.ts", "cal/src/templates.ts",
  "serendipity/serendipity.ts", "pipelines/garage/generate.ts", "pipelines/lwe/generate.ts",
];

test("every page and page template asks for viewport-fit=cover", async () => {
  const { readdirSync } = await import("node:fs");
  const pages: any[] = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}${e.name}/`);
      else if (e.name.endsWith(".html")) pages.push(`${dir}${e.name}`);
    }
  };
  walk("src/pages/");
  assert.ok(pages.length > 40, `found only ${pages.length} pages under src/pages`);
  const missing: any[] = [];
  for (const rel of [...pages, ...EMITTERS]) {
    const text = readFileSync(new URL(rel, ROOT), "utf8");
    const metas = [...text.matchAll(VIEWPORT)].map((m) => m[1]);
    if (!metas.length && EMITTERS.includes(rel)) missing.push(`${rel}: no viewport meta`);
    for (const content of metas) if (!/viewport-fit=cover/.test(content)) missing.push(`${rel}: ${content}`);
    // a page with no OS window gets no help from the shell's insets, so it has to
    // step in by them itself (the /garage/vt-* probes, which load no luna.css)
    const windowed = /class="[^"]*\b(?:window|np-window)\b/.test(text);
    if (pages.includes(rel) && !windowed && !/env\(safe-area-inset-top/.test(text)) missing.push(`${rel}: no window and no safe-area inset`);
  }
  assert.deepEqual(missing, []);
});

test("the shell steps in by the safe-area insets wherever it meets an edge", () => {
  const html = blocks("html").join(";");
  for (const side of ["top", "right", "bottom", "left"]) {
    assert.match(html, new RegExp(`--sa-${side[0]}:\\s*env\\(safe-area-inset-${side},\\s*0px\\)`));
    assert.match(css, new RegExp(`@property --sa-${side[0]}\\{syntax:"<length>"`), `--sa-${side[0]} must be registered so nav.js reads pixels`);
  }
  assert.match(html, /--taskbar-h:\s*calc\(30px \+ var\(--sa-b\)\)/);
  const bar = blocks("#axp-taskbar").join(";");
  assert.match(bar, /height:\s*var\(--taskbar-h\)/);
  assert.match(bar, /padding:\s*0 var\(--sa-r\) var\(--sa-b\) var\(--sa-l\)/, "the bar's row stays above the home indicator");
  assert.match(bar, /background-size:\s*100% 30px/, "the gradient keeps its 30px row; the solid colour fills the strip under it");
  assert.match(blocks("body::before").join(";"), /top:\s*var\(--sa-t\)/, "the HyperCam band clears the status bar");
  assert.match(blocks("#axp-icons").join(";"), /top:\s*calc\(var\(--sa-t\) \+ var\(--hypercam-h\)\)/);
  assert.match(blocks("body:has(.window)").join(";"), /padding-top:\s*calc\(var\(--sa-t\) \+ var\(--hypercam-h\) \+ 8px\)/);
  assert.match(blocks(".window.axp-max").join(";"), /inset:\s*0 var\(--sa-r\) var\(--taskbar-h\) var\(--sa-l\)/);
  assert.doesNotMatch(css, /100d?vh - 30px/, "the desktop floor is --taskbar-h, never a bare 30px");
});
