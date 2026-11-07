// ── deploy:promote --rollback picks a target (tools/lib/rollback-target.ts) ──
// Since 2026-09-28 (#1002) a release deploys at 100%, so the ordinary
// production shape is ONE active version that is also the newest production
// build. The rollback used to look only for an older version among the active
// ones, found none, and refused: the documented undo failed on every normal
// release. These fixtures are the shapes the live API returns, trimmed.
import { assert, test } from "./contract-shared.ts";
import { ROLLBACK_FLOOR, pickRollbackTarget } from "../lib/rollback-target.ts";

const prod = (id: string, created_on: string) => ({ id, created_on, annotations: { "workers/alias": "production" } });
const branch = (id: string, created_on: string, alias: string) => ({ id, created_on, annotations: { "workers/alias": alias } });

// API order is not newest-first on purpose: the picker must sort on created_on.
const VERSIONS = [
  prod("bbbbbbbb-0000-0000-0000-000000000002", "2026-11-05T10:00:00Z"),
  branch("eeeeeeee-0000-0000-0000-000000000009", "2026-11-06T09:00:00Z", "claude-some-branch"),
  prod("cccccccc-0000-0000-0000-000000000003", "2026-11-06T08:00:00Z"),
  branch("dddddddd-0000-0000-0000-000000000008", "2026-11-05T12:00:00Z", "fix-something"),
  prod("aaaaaaaa-0000-0000-0000-000000000001", "2026-11-04T10:00:00Z"),
];

test("one version serving: roll back to the production build before it, skipping branch builds", () => {
  const pick = pickRollbackTarget({ active: [{ id: "cccccccc-0000-0000-0000-000000000003", pct: 100 }], versions: VERSIONS, alias: "production" });
  // dddddddd sits between the two releases in time but is a branch build.
  assert.equal("to" in pick && pick.to, "bbbbbbbb-0000-0000-0000-000000000002");

  // A second rollback, now that bbbbbbbb serves, walks one more release back.
  const again = pickRollbackTarget({ active: [{ id: "bbbbbbbb-0000-0000-0000-000000000002", pct: 100 }], versions: VERSIONS, alias: "production" });
  assert.equal("to" in again && again.to, "aaaaaaaa-0000-0000-0000-000000000001");

  // The oldest listed release has nothing before it.
  const oldest = pickRollbackTarget({ active: [{ id: "aaaaaaaa-0000-0000-0000-000000000001", pct: 100 }], versions: VERSIONS, alias: "production" });
  assert.match("refuse" in oldest ? oldest.refuse : "", /aaaaaaaa is the oldest `production` build/);
});

test("a split keeps its old answer: the largest incumbent that is not the newest build", () => {
  const pick = pickRollbackTarget({
    active: [
      { id: "cccccccc-0000-0000-0000-000000000003", pct: 10 },
      { id: "aaaaaaaa-0000-0000-0000-000000000001", pct: 90 },
    ],
    versions: VERSIONS,
    alias: "production",
  });
  assert.equal("to" in pick && pick.to, "aaaaaaaa-0000-0000-0000-000000000001");
});

test("no production alias on any version fails closed, while the same list with one does not", () => {
  const unaliased = VERSIONS.map(({ id, created_on }) => ({ id, created_on }));
  const pick = pickRollbackTarget({ active: [{ id: "cccccccc-0000-0000-0000-000000000003", pct: 100 }], versions: unaliased, alias: "production" });
  assert.match("refuse" in pick ? pick.refuse : "", /no `production` build among the 5 most recent versions/);

  // Control: the split path refuses on the same list too, since it also needs the newest build.
  const split = pickRollbackTarget({
    active: [
      { id: "cccccccc-0000-0000-0000-000000000003", pct: 10 },
      { id: "aaaaaaaa-0000-0000-0000-000000000001", pct: 90 },
    ],
    versions: unaliased,
    alias: "production",
  });
  assert.equal("refuse" in split, true);
});

test("a serving version the list cannot place is refused rather than guessed around", () => {
  const pick = pickRollbackTarget({ active: [{ id: "eeeeeeee-0000-0000-0000-000000000009", pct: 100 }], versions: VERSIONS, alias: "production" });
  assert.match("refuse" in pick ? pick.refuse : "", /eeeeeeee holds all traffic but is not a `production` build/);
});

test(`never roll back past ${ROLLBACK_FLOOR.id}`, () => {
  // The release of #1006 and the one before it, a minute either side of its merge.
  const versions = [prod("fc50de44-0000-0000-0000-000000000000", "2026-09-29T04:30:00Z"), prod("9a9a9a9a-0000-0000-0000-000000000000", "2026-09-29T02:30:00Z")];
  const pick = pickRollbackTarget({ active: [{ id: "fc50de44-0000-0000-0000-000000000000", pct: 100 }], versions, alias: "production" });
  assert.match("refuse" in pick ? pick.refuse : "", /9a9a9a9a .*predates fc50de44/);

  // Control: one build later, fc50de44 itself is a legal target.
  const later = [prod("12121212-0000-0000-0000-000000000000", "2026-09-29T06:00:00Z"), ...versions];
  const ok = pickRollbackTarget({ active: [{ id: "12121212-0000-0000-0000-000000000000", pct: 100 }], versions: later, alias: "production" });
  assert.equal("to" in ok && ok.to, "fc50de44-0000-0000-0000-000000000000");

  // A previous build with no created_on cannot be checked against the floor, so it is refused.
  const undated = [
    prod("12121212-0000-0000-0000-000000000000", "2026-09-29T06:00:00Z"),
    { id: "34343434-0000", annotations: { "workers/alias": "production" } },
  ];
  const blind = pickRollbackTarget({ active: [{ id: "12121212-0000-0000-0000-000000000000", pct: 100 }], versions: undated, alias: "production" });
  assert.match("refuse" in blind ? blind.refuse : "", /predates fc50de44/);
});
