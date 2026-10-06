// XP is instant, and DESIGN.md has said so the whole time ("❌ smooth modern
// easing / long transitions"). bevels.css carried two motion tokens to hold the
// line, `--xp-transition` (60ms) and `--xp-transition-fade` (90ms), and on
// 2026-10-06 neither had a single consumer. The site wrote 53 durations by
// hand instead: 14 distinct values from 60ms to 800ms, every popover fading at
// 120ms where the token said 90, and benchmark bars tweening for a third of a
// second. Same shape as `--grad-title` before 2026-09-15: a token nobody read,
// and the pages drifting away from it one reasonable number at a time.
//
// The rule now: a transition or animation duration names a motion token.
// Two kinds of motion are exempt because they are not about responsiveness:
//   - ambient: an `infinite` loop (a spinner, marching ants, a screensaver)
//   - exhibits: a rule whose motion IS what a garage page demonstrates
//     (interpolate-size, @starting-style, sibling-index stagger) says so with
//     an `@motion demo` comment inside the rule, where a reviewer will see it.
// Scroll-driven animations carry no duration, so they never trip this.
import { ROOT, assert, test } from "./contract-shared.ts";
import { cssSources } from "./lib/token-literals.ts";

/** A motion declaration: transition, animation, or their -duration / -delay longhands. Custom properties are not. */
const DECL = /(?<![\w-])(transition|animation)(-duration|-delay)?\s*:\s*([^;{}]+)/g;
/** A non-zero time literal. `0s` is no motion at all, so it is never a finding. */
const TIME = /(?<![\w.#-])(?!0+(?:\.0+)?m?s\b)(\d*\.?\d+)(ms|s)\b/g;

/** Every hand-written duration in `css` that no exemption covers. */
export function literalDurations(css) {
  const out = [];
  for (const m of css.matchAll(DECL)) {
    const value = m[3];
    if (/\binfinite\b/.test(value)) continue;
    const open = css.lastIndexOf("{", m.index);
    const close = css.indexOf("}", m.index);
    const rule = css.slice(open + 1, close === -1 ? undefined : close);
    if (rule.includes("@motion demo")) continue;
    for (const t of value.matchAll(TIME)) out.push({ decl: `${m[1]}${m[2] ?? ""}: ${value.trim()}`, literal: t[0], index: m.index });
  }
  return out;
}

test("the matcher finds a hand-written duration, and only that", () => {
  // A finding in a fixture IS found, so an empty report below means clean and not blind.
  assert.deepEqual(literalDurations(".t{transition:opacity 120ms ease-out}").map((f) => f.literal), ["120ms"]);
  assert.deepEqual(literalDurations(".b{animation:axp-pop .09s ease-out}").map((f) => f.literal), [".09s"]);
  assert.deepEqual(literalDurations(".d{animation-delay:calc(sibling-index() * 90ms)}").map((f) => f.literal), ["90ms"]);
  assert.deepEqual(literalDurations(".t{transition:opacity var(--xp-transition-fade), display var(--xp-transition-fade) allow-discrete}"), [], "a token is the rule");
  assert.deepEqual(literalDurations(":root{--xp-transition: 60ms ease-out;}"), [], "the token's own definition is a custom property, not a declaration");
  assert.deepEqual(literalDurations(".s{animation:spin 1.1s linear infinite}"), [], "ambient motion is exempt");
  assert.deepEqual(literalDurations(".x{/* @motion demo: the tween is the exhibit */ transition:height .35s ease}"), [], "an exhibit says so in its rule");
  assert.deepEqual(literalDurations(".n{transition:none} .z{transition:opacity 0s}"), [], "no motion is never a finding");
  assert.deepEqual(literalDurations(".c{color:#0054e3; transition:filter 60ms ease-out}").map((f) => f.literal), ["60ms"], "a hex colour is not a time");
});

test("every served transition and animation names a motion token", () => {
  const sources = cssSources(ROOT);
  assert.ok(new Set(sources.map((s) => s.file)).size >= 100, `walked ${sources.length} sources`);
  const offenders = sources.flatMap((s) => literalDurations(s.css).map((f) => `${s.file}: ${f.literal} in \`${f.decl.slice(0, 90)}\``));
  assert.deepEqual(
    offenders,
    [],
    `hand-written durations; use var(--xp-transition) for press feedback, var(--xp-transition-fade) for anything appearing, var(--xp-transition-move) for a value moving in place:\n  ${offenders.join("\n  ")}`,
  );
});
