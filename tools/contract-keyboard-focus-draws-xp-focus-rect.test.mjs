// ── keyboard focus draws XP's dotted focus rectangle ────────────────────────
// XP marked keyboard focus one way everywhere: a 1px dotted rectangle inset
// from the control's face. luna.css had dropped it on two shared controls. The
// caption buttons (.min, .max, .close) showed only their hover tint under
// :focus-visible, and a focused .xp-button drew exactly what a .default button
// draws at rest, so on a dialog with a default button nothing said where focus
// was. Found by the second specification.website audit, 2026-10-17 (WCAG
// 2.4.7). The Back/Forward pair already drew the rectangle; these match it.
//
// Every rule involved is wrapped in :where(), so all carry zero specificity
// and the last one in source order wins. The check resolves that cascade for
// each control rather than looking for a rule, because the old sheet failed by
// a later `outline: none`, not by a missing line.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";

// Split a selector list on its top-level commas.
function splitList(list) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

// A selector with its :where() wrapper dropped and any :is() list expanded,
// so `:where(.a :is(.b, .c):x)` becomes [".a .b:x", ".a .c:x"].
function expand(sel) {
  let s = sel.replace(/^:where\(([\s\S]*)\)$/, "$1").trim();
  const is = /:is\(([^()]*)\)/.exec(s);
  if (!is) return [s.replace(/\s+/g, " ")];
  return splitList(is[1]).flatMap((alt) => expand(s.slice(0, is.index) + alt + s.slice(is.index + is[0].length)));
}

// The outline the cascade settles on for one exact selector, from the rules
// in source order. Only zero-specificity rules can match these targets, so
// source order is the whole cascade.
function resolvedOutline(css, target) {
  let outline = null;
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selectors, body] of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!splitList(selectors).some((s) => expand(s).includes(target))) continue;
    for (const [, value] of body.matchAll(/(?:^|;)\s*outline\s*:\s*([^;]+)/g)) outline = value.trim();
  }
  return outline;
}

const CAPTION = [".min", ".max", ".close"].flatMap((c) => [`.title-bar .controls ${c}:focus-visible`, `.np-controls ${c}:focus-visible`]);

test("the resolver follows source order and expands :is() (control)", () => {
  const old = ":where(.title-bar .controls .max:hover), :where(.title-bar .controls .max:focus-visible) { outline: none; }";
  assert.equal(resolvedOutline(old, ".title-bar .controls .max:focus-visible"), "none");
  const fixed = old + "\n:where(.title-bar .controls :is(.min, .max):focus-visible) { outline: 1px dotted #fff; outline-offset: -4px; }";
  assert.equal(resolvedOutline(fixed, ".title-bar .controls .max:focus-visible"), "1px dotted #fff");
  assert.equal(resolvedOutline(fixed + "\n:where(.title-bar .controls .max:focus-visible){outline:none}", ".title-bar .controls .max:focus-visible"), "none");
});

test("each caption button and .xp-button settle on a dotted rectangle under :focus-visible", () => {
  const luna = readFileSync("src/styles/luna.css", "utf8");
  const misses = [...CAPTION, ".xp-button:focus-visible"]
    .map((target) => ({ target, outline: resolvedOutline(luna, target) }))
    .filter(({ outline }) => !/^1px dotted\b/.test(outline ?? ""))
    .map(({ target, outline }) => `${target} resolves to outline: ${outline ?? "(unset)"}`);
  assert.deepEqual(misses, []);
});

test("a focused .xp-button no longer looks exactly like the default one", () => {
  const luna = readFileSync("src/styles/luna.css", "utf8");
  assert.notEqual(resolvedOutline(luna, ".xp-button:focus-visible"), resolvedOutline(luna, ".xp-button.default"));
});
