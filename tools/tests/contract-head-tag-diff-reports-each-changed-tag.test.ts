// ── the head-tag diff reports each changed tag, and nothing else ───────────
// tools/head-snapshot.ts is advisory, so nothing downstream fails when it goes
// blind: a parser that stops reading og:* reports "No change" on every PR. This
// pins it to a real authored page, minified the way build.ts ships it, since
// the minifier's unquoted attributes are what a regex reader would miss.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { minifyHtml } from "../lib/html-minify.ts";
import { oracleStatuses } from "../head-snapshot.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = join(ROOT, "tools/head-snapshot.ts");
// HTMLRewriter is a bun global; `test:node` has none, as in contract-og-images-resolve.
const noRewriter = typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter";

const PAGE = minifyHtml(readFileSync(join(ROOT, "src/pages/garage/horizon.html"), "utf8"));
const DESCRIPTION = "Test-driving text-box-trim, contrast-color, interestfor and anchor positioning before any of them touch the live aadhar.sh homepage.";

/** Record `html` as /garage/horizon, compare against the unedited page, and
 *  return the table rows and the whole report. */
function diffAgainstPage(html: string) {
  const dir = mkdtempSync(join(tmpdir(), "head-tags-"));
  try {
    for (const [side, body] of [
      ["base", PAGE],
      ["head", html],
    ]) {
      mkdirSync(join(dir, side, "garage"), { recursive: true });
      writeFileSync(join(dir, side, "garage/horizon.html"), body);
      execFileSync(process.execPath, [SCRIPT, "record", join(dir, `${side}.json`), "--root", join(dir, side), "--label", side], { cwd: ROOT });
    }
    const report = execFileSync(process.execPath, [SCRIPT, "compare", join(dir, "base.json"), join(dir, "head.json")], { encoding: "utf8" });
    const snapshot = JSON.parse(readFileSync(join(dir, "base.json"), "utf8"));
    return { report, rows: report.split("\n").filter((l) => l.startsWith("| `")), facts: snapshot.pages["/garage/horizon"] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("an unchanged page diffs as nothing", { skip: noRewriter }, () => {
  const { report, rows, facts } = diffAgainstPage(PAGE);
  assert.deepEqual(rows, []);
  assert.match(report, /^No change\. 1 documents/m);
  // The presence half: the empty diff is two full recordings, not two blind ones.
  assert.equal(facts.description, DESCRIPTION);
  assert.equal(facts.canonical, "https://aadhar.sh/garage/horizon");
  assert.equal(facts["og:image"], "https://aadhar.sh/og/garage-horizon.jpg");
  assert.equal(facts["twitter:card"], "summary_large_image");
});

test("an edited description is exactly one row", { skip: noRewriter }, () => {
  assert.ok(PAGE.includes(DESCRIPTION), "the fixture page no longer carries the description this test edits");
  const { rows } = diffAgainstPage(PAGE.replace(DESCRIPTION, "Five new CSS features, tried here first."));
  assert.deepEqual(rows, [`| \`/garage/horizon\` | \`description\` | ${DESCRIPTION} | Five new CSS features, tried here first. |`]);
});

test("a dropped og:image is exactly one row", { skip: noRewriter }, () => {
  const tag = /<meta content=https:\/\/aadhar\.sh\/og\/garage-horizon\.jpg property=og:image>/;
  assert.match(PAGE, tag, "the minified fixture no longer writes og:image unquoted");
  const { rows } = diffAgainstPage(PAGE.replace(tag, ""));
  assert.deepEqual(rows, ["| `/garage/horizon` | `og:image` | https://aadhar.sh/og/garage-horizon.jpg | — |"], "a dropped og:image must be one row");
});

test("a JSON-LD block diffs by its @type list", { skip: noRewriter }, () => {
  const ld = `<script type=application/ld+json>{"@context":"https://schema.org","@graph":[{"@type":"Person"},{"@type":"WebSite"}]}</script>`;
  const { rows } = diffAgainstPage(PAGE.replace("</title>", `</title>${ld}`));
  assert.deepEqual(rows, ["| `/garage/horizon` | `ld+json[1]` | — | Person, WebSite |"]);
});

test("status comes from the oracle's plain HTML rows", () => {
  const statuses = oracleStatuses(readFileSync(join(ROOT, "tools/verify-routes.ts"), "utf8"));
  assert.equal(statuses.get("/"), 200);
  assert.equal(statuses.get("/garage"), 200);
  assert.equal(statuses.get("/garage/"), 301);
  // Every /garage/horizon row sends an Accept header, so none answers a plain GET.
  assert.equal(statuses.has("/garage/horizon"), false);
});
