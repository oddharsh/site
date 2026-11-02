// typography.css has carried a pt scale and three family stacks since the
// design system was written, and DESIGN.md has said "three stacks, and ONLY
// these three" the whole time. On 2026-10-06 the scale had 23 consumers
// against 1,072 hand-written sizes in 70 distinct values, and 55 family
// stacks were spelled out by hand. The scale now covers what the site
// actually sets (7pt to 14pt, half-point steps where it uses them), off-grid
// sizes were snapped to it, and this holds the line at zero.
//
// What is not a finding, and why, lives in tools/lib/type-literals.ts: px
// (pixel-exact chrome, SVG text), relative units, display sizes over 14pt,
// var() with a fallback list, and a rule that says `@type demo`.
import { readFileSync } from "node:fs";
import { ROOT, assert, test } from "./contract-shared.ts";
import { cssSources } from "../lib/token-literals.ts";
import { typeFindings } from "../lib/type-literals.ts";

test("the matcher finds a hand-written size or family, and only that", () => {
  const lits = (css) => typeFindings(css).map((f) => `${f.kind}:${f.literal}`);
  // A finding in a fixture IS found, so an empty report below means clean and not blind.
  assert.deepEqual(lits(".a{font-size:9pt}"), ["size:9pt"]);
  assert.deepEqual(lits('.a{font:bold 8.6pt/1.3 "Courier New",monospace}'), ["size:8.6pt", 'family:"Courier New",monospace']);
  assert.deepEqual(lits(".a{font-family:Tahoma,Verdana,sans-serif}"), ["family:Tahoma,Verdana,sans-serif"]);
  assert.deepEqual(lits('<p style="font-size:9.5pt">'), ["size:9.5pt"], "an inline style attribute counts, without its closing quote");
  assert.deepEqual(lits(".a{font:bold var(--text-xs) var(--font-caption)}"), [], "tokens are the rule");
  assert.deepEqual(lits(".a{font-family:var(--font-ui,Tahoma,Verdana,Geneva,sans-serif)}"), [], "a fallback list inside var() is allowed");
  assert.deepEqual(lits(".a{font-size:11px} .b{font-size:.9em} .c{font-size:120%}"), [], "px and relative units are not the pt scale");
  assert.deepEqual(lits(".a{font-size:26pt}"), [], "display type over 14pt is composed per page");
  assert.deepEqual(lits(".a{/* @type demo: handwriting */ font-family:Georgia,serif}"), [], "an exhibit says so in its rule");
  assert.deepEqual(lits(":root{--text-xs: 9pt;}"), [], "the token's own definition is a custom property");
});

test("the homepage defines every token it reads, at the token files' value", () => {
  // The homepage loads luna.css without blocking first paint, so a token it reads
  // through var() has to be defined in its own inline :root or the rule falls
  // back to the browser default and jumps when luna lands. Colour tokens went
  // undefined here from #1196 (2026-10-06) to 2026-11-02 because this checked
  // only --text-* and --font-*: no window frame, no title gradient, CLS 0.116.
  const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");
  // First definition wins, so a @media (--p3) override never stands in for the base value.
  const decls = (css) => {
    const out = new Map();
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
      if (!out.has(m[1])) out.set(m[1], m[2].replace(/\s+/g, ""));
    return out;
  };
  const tokens = new Map(["colors", "bevels", "typography"].flatMap((f) => [...decls(read(`design/tokens/${f}.css`))]));
  const page = read("src/pages/index.html");
  const inline = decls(/:root\{([^}]*)\}/.exec(page)?.[1] ?? "");
  const used = new Set([...page.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]).filter((t) => tokens.has(t)));
  assert.ok(used.size >= 30, `the homepage reads ${used.size} tokens`);
  for (const t of used) {
    assert.ok(inline.has(t), `src/pages/index.html reads var(${t}) but its inline :root does not define it`);
    assert.equal(inline.get(t), tokens.get(t), `src/pages/index.html inlines ${t} as ${inline.get(t)}; design/tokens says ${tokens.get(t)}`);
  }
});

test("every served pt size and font family names a typography token", () => {
  const sources = cssSources(ROOT);
  assert.ok(new Set(sources.map((s) => s.file)).size >= 100, `walked ${sources.length} sources`);
  const offenders = sources.flatMap((s) => typeFindings(s.css).map((f) => `${s.file}: ${f.literal} in \`${f.prop}: ${f.value.slice(0, 70)}\``));
  assert.deepEqual(
    offenders,
    [],
    `hand-written type; use a --text-* size and a --font-* family from design/tokens/typography.css:\n  ${offenders.join("\n  ")}`,
  );
});
