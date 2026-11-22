// ── each client script's minifier pick behaves like its readable source ─────
//
// config/minify-picks.json names the pipeline and renames each script ships
// with (tools/lib/minify-picks.ts). The build checks only that the renames are
// alpha-equivalent, so this is where the behavior check lives: replay every fresh pick on the build's
// readable twin and run spokeshave's effect-trace oracle on the pair. The
// oracle runs both in node:vm with recording stubs for every global, fires
// every callback, and compares calls, writes, throws and leftover globals.
//
// It is the weaker of the two checks. On 2026-11-21 it caught 17% of seeded
// bugs, where the Chrome page differential (tools/check-minify-diff.ts, run by
// hand before a pick changes) caught 58%. It runs on every push because it
// costs about 2 s; the Chrome one takes about 15 minutes.
//
// pretext.lib.js is left out: it is vendored, its trace takes about 8 s, and
// its pick changes only when the vendored file or an engine does, which is when
// minify:pick and the Chrome differential run.
import { existsSync, readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { minifiedScripts } from "../lib/client-assets.ts";
import { dashTokens, freshness, readPicks, replayPick } from "../lib/minify-picks.ts";

const SLOW = new Set(["garage/pretext.lib.js"]);
const needs = typeof Bun === "undefined" ? "spokeshave's engines need Bun" : !existsSync(".build/public/nav.src.js") && "needs a build";

test("every client script has a pick, and the picks name no other file", () => {
  const rows = minifiedScripts()
    .map((r) => r.file)
    .sort();
  assert.deepEqual(Object.keys(readPicks()).sort(), rows);
});

test("every fresh pick behaves like its source, and a planted bug does not", { skip: needs }, async () => {
  const { engineVersions } = await import("spokeshave");
  const { compare } = await import("spokeshave/oracle");
  const versions = await engineVersions();
  const picks = readPicks();
  const stale: string[] = [];
  let checked = 0;
  for (const row of minifiedScripts()) {
    if (SLOW.has(row.file)) continue;
    const source = readFileSync(`.build/public${row.twin}`, "utf8");
    const state = freshness(picks[row.file], source, versions);
    if (state.kind === "stale") {
      // The build shipped oxc for this one; minify:pick re-picks it.
      stale.push(`${row.file} (${state.reason})`);
      continue;
    }
    const kind = row.module ? "module" : "script";
    // replayPick re-proves its renames alpha-equivalent; this checks the whole
    // shipped file against the readable source.
    const shipped = await replayPick(state.pick, source, { filename: row.file, module: row.module });
    const verdict = await compare({ code: source, kind }, { code: shipped, kind });
    assert.equal(verdict.kind, "same", `${row.file} (${state.pick.pipeline}): ${JSON.stringify(verdict)}`);
    // Renames must not mint a `--name` token, which step 5c would count as a
    // taken custom-property name and shift CSS names site-wide.
    const unrenamed = await replayPick({ ...state.pick, renames: [] }, source, { filename: row.file, module: row.module });
    assert.deepEqual([...dashTokens(shipped)].sort(), [...dashTokens(unrenamed)].sort(), `${row.file}: renames changed its --name tokens`);
    checked++;
  }
  if (stale.length) console.log(`minify picks: stale, so not checked: ${stale.join(", ")}`);
  // Count what was checked, so a run where every pick went stale fails here
  // rather than passing on nothing.
  assert.ok(checked >= 20, `only ${checked} picks were fresh enough to check`);

  // The control: nav.js's guard flag flipped in its shipped bytes must read as
  // a different program, or the oracle above is not looking.
  const source = readFileSync(".build/public/nav.src.js", "utf8");
  const pick = picks["nav.js"]!;
  const shipped = await replayPick(pick, source, { filename: "nav.js", module: false });
  const planted = shipped.replace(/__axpNav=(!0|true)/, "__axpNav=!1");
  assert.notEqual(planted, shipped, "the control's plant site moved; pick another");
  assert.equal((await compare({ code: source, kind: "script" }, { code: planted, kind: "script" })).kind, "different");
});
