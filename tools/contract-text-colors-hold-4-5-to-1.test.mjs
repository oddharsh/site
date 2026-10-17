// ── text colours hold WCAG 1.4.3's 4.5:1 on the window ──────────────────────
// Luna's own greys fail today's bar: XP's GrayText was #808080, 3.95:1 on white,
// and it painted disabled controls, which 1.4.3 exempts. This site used those
// greys for live text (track durations, dates, table notes), which it doesn't.
// Nothing checked: the token tests measure distance from the XP hex a token
// names, never contrast. Audited 2026-10-17 against specification.website:
// --ink-faint was 3.54:1 (18 text uses), --grey-60 3.95:1 (13), --slate-67
// 2.94:1 (3), --slate-71 2.54:1 (6), and --link-hover's web-safe red 4.0:1.
//
// The ratio is WCAG 2's, from relative luminance in sRGB. It doesn't move with
// the display: a brighter panel scales both colours, so a pair that fails on a
// CRT fails on an OLED. The P3 block is checked too, since it re-chromas the
// link states on wide-gamut screens and chroma shifts luminance a little.
import { readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";
import { cssSources, loadTokenValueMap, parseOklch } from "./lib/token-literals.ts";

const AA = 4.5;

// Relative luminance from OKLab, through linear sRGB without clipping, so a P3
// colour outside sRGB still gets its real luminance.
function luminance({ L, a, b }) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return Math.max(0, 0.2126 * r + 0.7152 * g + 0.0722 * bl);
}
const onWhite = (oklch) => {
  const parsed = parseOklch(oklch);
  assert.ok(parsed, `could not parse ${oklch}`);
  return 1.05 / (luminance(parsed.lab) + 0.05);
};

const byName = new Map([...loadTokenValueMap(ROOT)].map(([value, name]) => [name, value]));
const ratioOf = (name) => {
  const value = byName.get(name);
  assert.ok(value, `${name} did not resolve from design/tokens/colors.css`);
  return onWhite(value);
};

// The tokens text is written in on the white window and paper.
const TEXT_TOKENS = ["--ink", "--ink-soft", "--ink-quiet", "--ink-dim", "--ink-faint", "--link", "--link-visited", "--link-hover", "--blue-40", "--blue-45", "--slate-38", "--slate-55", "--go", "--warn"];

// Tokens under 4.5:1 on white that colour text on purpose, each on a dark ground
// or as an aria-hidden glyph (1.4.11's 3:1 non-text bar, not 1.4.3's). Keyed by
// file, so the same token reaching a new file is a new decision.
const REVIEWED = new Map([
  ["--gold src/pages/index.html", "the odometer's LCD digits, on black"],
  ["--grey-70 src/pages/garage/tooltips.html", "the LCD tooltip's meta line, on its dark face"],
  ["--grey-95 src/pages/garage/tooltips.html", "the LCD tooltip's filename, on its dark face"],
  ["--grey-88 src/pages/garage/horizon.html", "a label on a --go green button"],
  ["--slate-90 src/worker/writing.ts", "hover text on the blue selection"],
  ["--slate-96 src/pages/garage/encoding.html", "a badge on the title-bar gradient"],
  ["--green-95 src/worker/lens.ts", "trace lines on the dark terminal panel"],
  ["--amber-74 *", "the aria-hidden ✦ in a garage title-bar icon"],
  ["--blue-55 src/styles/luna.css", "the task pane's aria-hidden row glyph"],
]);

test("the text tokens hold 4.5:1 on white", () => {
  const misses = TEXT_TOKENS.map((name) => ({ name, ratio: ratioOf(name) }))
    .filter(({ ratio }) => ratio < AA)
    .map(({ name, ratio }) => `${name} is ${ratio.toFixed(2)}:1`);
  assert.deepEqual(misses, []);
});

test("the wide-gamut overrides hold 4.5:1 too", () => {
  const css = readFileSync(new URL("design/tokens/colors.css", ROOT), "utf8");
  const p3 = css.slice(css.indexOf("@media (color-gamut: p3)"));
  const overrides = [...p3.matchAll(/(--[a-z0-9-]+)\s*:\s*(oklch\([\d.%\s]+\))\s*;/g)].filter(([, n]) => TEXT_TOKENS.includes(n));
  assert.ok(overrides.length >= 3, `found ${overrides.length} link overrides in the P3 block; its format changed`);
  const misses = overrides.filter(([, , v]) => onWhite(v) < AA).map(([, n, v]) => `${n} is ${onWhite(v).toFixed(2)}:1 on P3`);
  assert.deepEqual(misses, []);
});

test("no text is coloured with a token under 4.5:1 unless it was reviewed", () => {
  const found = [];
  let uses = 0;
  for (const src of cssSources(ROOT)) {
    for (const m of src.css.matchAll(/(?<![-\w])color\s*:\s*var\((--[a-z0-9-]+)\)/g)) {
      const value = byName.get(m[1]);
      if (!value) continue;
      uses++;
      if (onWhite(value) >= AA) continue;
      if (REVIEWED.has(`${m[1]} ${src.file}`) || REVIEWED.has(`${m[1]} *`)) continue;
      found.push(`${src.file}: color: var(${m[1]}) is ${onWhite(value).toFixed(2)}:1 on white`);
    }
  }
  // A walk that stopped finding rules would pass over nothing.
  assert.ok(uses >= 300, `only ${uses} token text colours found; did cssSources change shape?`);
  assert.deepEqual([...new Set(found)], []);
});

test("the contrast maths matches WCAG's own reference points (control)", () => {
  // #767676 is the lightest neutral grey at 4.5:1 on white, and #777777 the
  // first that misses, so the line sits between two adjacent hex steps.
  assert.ok(onWhite("oklch(56.58% 0 0)") >= AA, "#767676 passes");
  assert.ok(onWhite("oklch(56.94% 0 0)") < AA, "#777777 fails");
  assert.equal(onWhite("oklch(0% 0 0)").toFixed(0), "21", "black on white is 21:1");
});
