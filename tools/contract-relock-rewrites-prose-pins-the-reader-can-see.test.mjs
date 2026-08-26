// `bun run deps:relock` rewrites the version claims in docs/DEPENDENCIES.md, and
// the audit beside it reads them back. The two share findClaims on purpose, so
// what this pins is that the WRITER lands on the same spans the READER matches.
//
// The wrapped-sentence case is the one that earned the test. A `\s+` between the
// prose name and the version means a claim can straddle a newline, which a
// line-oriented sweep silently skips: measured 2026-08-26 on the oxlint 1.80.0
// bump, a sed fixed three mentions of four and CI caught the fourth.
import test from "node:test";
import assert from "node:assert/strict";

import { BASELINE_HEADING, auditDependencyDocs, planDocPinRewrites } from "./lib/dependency-docs.ts";

const ALIASES = [{ prose: "Oxlint", pkg: "oxlint" }, { prose: "Wrangler", pkg: "wrangler" }];

// Prose ABOVE the baseline heading is out of scope for the reader, so it must be
// out of scope for the writer too.
const DOC = `# Dependencies

Oxlint 1.79.0 is mentioned up here, outside the baseline section.

${BASELINE_HEADING}

- Oxlint 1.79.0 and Wrangler 4.125.0 are exact root pins.
- The pinned Oxlint
  1.79.0 does support custom plugins.
`;

test("rewrites every claim the reader can see, including one that wraps", () => {
  const { updated, edits } = planDocPinRewrites({
    doc: DOC,
    pins: { oxlint: "1.80.0", wrangler: "4.125.0" },
    aliases: ALIASES,
    versionless: new Map(),
  });

  assert.equal(edits.length, 2, "both in-scope Oxlint claims move; Wrangler already agrees");
  assert.deepEqual(edits.map((e) => [e.from, e.to]), [["1.79.0", "1.80.0"], ["1.79.0", "1.80.0"]]);

  // The wrapped mention is the whole point.
  assert.match(updated, /The pinned Oxlint\n {2}1\.80\.0 does support/);
  // Untouched: above the heading, and a pin that already agreed.
  assert.match(updated, /Oxlint 1\.79\.0 is mentioned up here/);
  assert.match(updated, /Wrangler 4\.125\.0 are exact root pins/);
});

test("the rewrite satisfies the audit that gates CI", () => {
  const pins = { oxlint: "1.80.0", wrangler: "4.125.0" };
  const before = auditDependencyDocs({ doc: DOC, pins, aliases: ALIASES, versionless: new Map(), floor: 0 });
  assert.ok(before.problems.length > 0, "control: the un-rewritten doc must actually fail");

  const { updated } = planDocPinRewrites({ doc: DOC, pins, aliases: ALIASES, versionless: new Map() });
  const after = auditDependencyDocs({ doc: updated, pins, aliases: ALIASES, versionless: new Map(), floor: 0 });
  assert.deepEqual(after.problems, [], after.problems.join("\n"));
});

test("leaves alone what it cannot know a pin for", () => {
  const doc = `${BASELINE_HEADING}\n\n- Oxlint 1.79.0 and Wrangler 4.125.0.\n`;
  // A range pin names no single version the prose could be wrong about, and an
  // absent pin names none at all. Guessing either invents a claim.
  const { edits } = planDocPinRewrites({
    doc,
    pins: { oxlint: "^1.80.0" },
    aliases: ALIASES,
    versionless: new Map(),
  });
  assert.deepEqual(edits, []);
});

test("a doc with no baseline heading is returned untouched", () => {
  const doc = "# Dependencies\n\nOxlint 1.79.0 with no baseline section.\n";
  const { updated, edits } = planDocPinRewrites({ doc, pins: { oxlint: "1.80.0" }, aliases: ALIASES, versionless: new Map() });
  assert.equal(updated, doc);
  assert.deepEqual(edits, []);
});
