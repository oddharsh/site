// ── the rename refuses a property name built in a template literal ──────────
// Step 5c renames custom properties by find-and-replace over the staged tree.
// `var(--f-${fmt})` is a name the replace can never see whole: the definition
// `--f-jxl:` shrinks to `--2u`, the reference is assembled at runtime as
// `--f-jxl`, nothing defines that any more, and the colour is gone. Unbuilt,
// the page looks right. /pixel-peeper's format ladder shipped that way to a
// preview on 2026-10-23 (gotcha 86). These pin that the build now stops.
import { assert, test } from "./contract-shared.ts";

const { assertNoDynamicPropertyNames } = await import("./lib/mangle-custom-properties.ts");
const check = (text) => () => assertNoDynamicPropertyNames(new Map([["page.html", text]]));

test("a template-built property name fails the build", () => {
  assert.throws(check("<script>const c=`var(--f-${fmt})`</script>"), /built at runtime[\s\S]*page\.html: --f-\$\{fmt\}/);
  assert.throws(check("<script>el.style.cssText=`--${k}:1`</script>"), /built at runtime/);
});

test("a literal name in a script passes, since the rename rewrites it", () => {
  assert.doesNotThrow(check('<script>const LCOL={jxl:"var(--f-jxl)",avif:`var(--f-avif)`}</script>'));
  // a template that only interpolates the VALUE is fine: the name is whole
  assert.doesNotThrow(check("<script>const s=`--ink:${v}`</script>"));
});

test("the setProperty rule still holds beside it", () => {
  assert.throws(check("<script>el.style.setProperty(name,1)</script>"), /built at runtime/);
  assert.doesNotThrow(check('<script>el.style.setProperty("--x",1)</script>'));
});
