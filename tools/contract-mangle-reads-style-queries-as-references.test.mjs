// Step 5c renames every custom property in the staged tree, and the one
// assertion it rests on is that the set of DANGLING references (read somewhere,
// defined nowhere) is unchanged across the rename. That set is only as good as
// the collector. `@container style(--flag: true)` has the exact shape of a
// definition, `--flag:`, and is a read: the flag's value is compared, never
// set. Measured 2026-09-15 on the fixture below, before the collectors were
// taught the form: a query on a flag nothing defines never reached the
// dangling set, and was still planned a short name as if the tree defined it.
//
// This matters for the one shape a style query is FOR here: a shell flag that
// nav.js sets with `setProperty` and page CSS reads, which by construction has
// no `--flag:` definition in any stylesheet. The reference has to be counted
// or the pass cannot see a missed file on that flag.
import { assert, test } from "./contract-shared.ts";
import { applyMangle, definitionsIn, planNames, referencesIn, unresolved } from "./lib/mangle-custom-properties.ts";

const query = `.pane{@container style(--shell-maximized: true){columns:2}}`;
const ifValue = `.x{width:if(style(--shell-maximized: true): 2px; else: 1px)}`;
const definition = `:root{--shell-maximized:false}`;
const setter = `document.documentElement.style.setProperty("--shell-maximized", "true");`;

test("a style() query is a reference and not a definition", () => {
  assert.deepEqual(definitionsIn(query), [], "the query's `--name:` is a comparison, not a declaration");
  assert.deepEqual(referencesIn(query), ["--shell-maximized"]);
  assert.deepEqual(definitionsIn(ifValue), [], "if(style(--name: v)) is the same read one level down");
  assert.deepEqual(referencesIn(ifValue), ["--shell-maximized"]);
  // Controls: a real declaration still counts, and var() still counts.
  assert.deepEqual(definitionsIn(definition), ["--shell-maximized"]);
  assert.deepEqual(referencesIn(`.w{color:var(--shell-maximized)}`), ["--shell-maximized"]);
});

test("a flag only a setProperty call sets is DANGLING, and is planned no name", () => {
  const files = new Map([["a.css", query], ["b.js", setter]]);
  assert.deepEqual([...unresolved(files)], ["--shell-maximized"], "read in CSS, defined in no stylesheet: that is the dangling set's job");
  assert.equal(planNames(files).size, 0, "nothing defines it, so nothing may rename it");
});

test("a flag the tree defines is renamed consistently across the query, the declaration and the JS literal", () => {
  const files = new Map([["a.css", definition + query], ["b.js", setter]]);
  const map = planNames(files);
  const short = map.get("--shell-maximized");
  assert.ok(short && short !== "--shell-maximized", "a defined name gets a short one");
  assert.equal(applyMangle(definition + query, map), `:root{${short}:false}.pane{@container style(${short}: true){columns:2}}`);
  assert.equal(applyMangle(setter, map), `document.documentElement.style.setProperty("${short}", "true");`);
  // The rename leaves the dangling set as it was (empty here), which is what step 5c asserts on.
  const after = new Map([...files].map(([n, t]) => [n, applyMangle(t, map)]));
  assert.deepEqual([...unresolved(after)], []);
});
