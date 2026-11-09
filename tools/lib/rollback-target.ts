// Which version `deploy:promote --rollback` puts on 100% of traffic.
//
// Two cases, because production serves one of two shapes:
//
//   SPLIT (two or more versions active). Mid-ramp, or parked with --to. The
//   target is the largest incumbent that is not the newest production build,
//   which is what the rollback did before this file existed.
//
//   SINGLE (one version active). The normal shape since 2026-09-28 (#1002):
//   Workers Builds deploys `production` with `wrangler deploy` at 100%, so after
//   every release exactly one version serves and it IS the newest production
//   build. Until 2026-11-06 the rollback only knew the split case, found nothing
//   "older" here, and refused, so the documented undo did nothing for every
//   normal release. The target is the production build uploaded just before the
//   serving one. A second --rollback walks one more release back.
//
// Every refusal is a reason string rather than a throw, so the caller prints it
// and the contract test reads it without spawning the credentialed script.

// The rollback floor. Version fc50de44 was the release of #1006 (merged
// 2026-09-29T04:23:20Z), which handed the Counter Durable Object to
// aadhar-counter. Production builds uploaded before that merge bind a class this
// Worker no longer owns, and a version that exports a Durable Object also loses
// its preview URLs (#1009). CLAUDE.md, "Release path": roll forward instead.
// Compared on created_on because fc50de44 itself has long since aged out of the
// newest-100 version list, so its id is not there to compare against.
export const ROLLBACK_FLOOR = { id: "fc50de44", notBefore: "2026-09-29T04:23:20Z" };

export type ListedVersion = { id: string; created_on?: string; annotations?: Record<string, string> };
export type ActiveVersion = { id: string; pct: number };
export type RollbackPick = { to: string; why: string } | { refuse: string };

const short = (id: string) => String(id).slice(0, 8);
export const aliasOf = (v: ListedVersion) => v.annotations?.["workers/alias"] || "(no alias)";

/** Production-alias builds, newest first, sorted on created_on rather than trusting the API's order. */
export function productionVersions(list: ListedVersion[], alias: string) {
  return [...list].sort((a, b) => String(b.created_on || "").localeCompare(String(a.created_on || ""))).filter((v) => aliasOf(v) === alias);
}

export function pickRollbackTarget(input: { active: ActiveVersion[]; versions: ListedVersion[]; alias: string }): RollbackPick {
  const { active, versions, alias } = input;
  const production = productionVersions(versions, alias);

  // FAIL CLOSED, as newestVersion() does: without the alias annotation nothing
  // here can tell a production build from a feature branch, and guessing is how
  // a branch build reaches 100%.
  if (!production.length) {
    const seen = versions
      .slice(0, 20)
      .map((v) => `    ${short(v.id)}  ${aliasOf(v)}`)
      .join("\n");
    return {
      refuse:
        `no \`${alias}\` build among the ${versions.length} most recent versions, so a rollback target cannot be told apart from a branch build.\n\n` +
        `  The newest of what is listed:\n\n${seen}\n\n` +
        `  Pick the one you mean and pass it explicitly:\n    bun run deploy:promote --version <id> --to 100`,
    };
  }
  if (!active.length) return { refuse: "nothing is serving, so there is nothing to roll back from" };

  if (active.length > 1) {
    const newest = short(production[0].id);
    const older = active.filter((v) => short(v.id) !== newest).sort((a, b) => b.pct - a.pct);
    // Two or more active and every one of them the newest build cannot happen
    // with distinct ids; refuse rather than deploy whatever is first.
    if (!older.length) return { refuse: `every active version is ${newest}; nothing to roll back to` };
    return { to: older[0].id, why: `the largest incumbent of the split (${older[0].pct}%), off the newest build ${newest}` };
  }

  const serving = short(active[0].id);
  const at = production.findIndex((v) => short(v.id) === serving);
  if (at === -1) {
    // A version passed by hand with --version, a branch build, or one older than
    // the listed window: "the build before it" has no meaning here.
    return {
      refuse:
        `${serving} holds all traffic but is not a \`${alias}\` build among the ${versions.length} listed, so there is no "previous release" to compute.\n` +
        `  Pick a version explicitly with \`bun run deploy:promote --version <id> --to 100\`.`,
    };
  }
  const previous = production[at + 1];
  if (!previous) {
    return { refuse: `${serving} is the oldest \`${alias}\` build among the ${versions.length} listed; there is no earlier release to roll back to` };
  }

  // Missing or unparseable created_on fails closed too: the floor cannot be
  // checked without it.
  const built = Date.parse(previous.created_on ?? "");
  if (!Number.isFinite(built) || built < Date.parse(ROLLBACK_FLOOR.notBefore)) {
    return {
      refuse:
        `the previous \`${alias}\` build, ${short(previous.id)} (created ${previous.created_on ?? "unknown"}), predates ${ROLLBACK_FLOOR.id}.\n` +
        `  Versions before ${ROLLBACK_FLOOR.id} bind a Durable Object this Worker no longer owns. Roll forward instead.`,
    };
  }
  return { to: previous.id, why: `the \`${alias}\` build uploaded before ${serving}, created ${previous.created_on}` };
}
