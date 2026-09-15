// The canary tripwire (canary.yml and the four tools/canary-*.ts it runs) is
// an INSTRUMENT: it runs moving targets through gates this repository already
// holds its pins to, and files at most one quiet issue per leg. Every
// assertion here is about the ways an instrument turns into something else.
//
//   1. it never writes a pin, opens a PR, or holds a Cloudflare credential
//   2. the gates are shared with the bumper rather than copied
//   3. every Playwright launch reads the channel from one place
//   4. the reporter's decision table is the one written on its header
//   5. the honest-false detector matches the page's own convention, and the
//      shipped-card scanner finds the cards
//   6. every upstream watch names a thread, RUNS on the pinned bun, and
//      answers a boolean rather than "did not run"
//   7. the pin digest parses changesets out of a compare payload and never
//      raises on a payload with none
//
// The last three are the ones that could pass while measuring nothing, which
// is why each carries a control that has to come back non-empty.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { chromeChannel, DEFAULT_CHROME_CHANNEL } from "./lib/browser-channel.ts";
import { HONEST_FALSE, JXL_2X2, LIVE_PROBES, familyOf, shippedCaps } from "./canary-browsers.ts";
import { marker, plan, render, title } from "./canary-report.ts";
import { BUN_WATCHES, WRANGLER_WATCHES, runBunWatch, watchMoved, watchRow, watchSignature } from "./lib/upstream-watches.ts";
import { changesets, renderDigest } from "./pin-digest.ts";

const LEGS = ["tools/canary-bun.ts", "tools/canary-wrangler.ts", "tools/canary-browsers.ts"];
const strip = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

test("no canary leg can write the pin, and none knows the bumper's write flag", async () => {
  for (const file of LEGS) {
    const code = strip(await readFile(new URL(file, ROOT), "utf8"));
    assert.doesNotMatch(code, /writePin|--write/, `${file} reaches for the pin writer`);
    assert.doesNotMatch(code, /package\.json"\)\s*,\s*[^)]*\)\s*;?\s*$/m, `${file} looks like it writes package.json`);
  }
  const bumper = await readFile(new URL("tools/bump-bun-pin.ts", ROOT), "utf8");
  assert.match(bumper, /writePin\(/, "the bumper is the one writer, which is what makes the assertion above mean something");
});

test("canary.yml holds no Cloudflare credential, writes only issues, and installs bun once through setup-bun", async () => {
  const yml = await readFile(new URL(".github/workflows/canary.yml", ROOT), "utf8");
  assert.doesNotMatch(yml, /CLOUDFLARE|secrets\./, "a tripwire that can reach Cloudflare is a fifth deploy path");
  assert.doesNotMatch(yml, /pull-requests:\s*write|contents:\s*write/, "the tripwire opens no PR and pushes no branch");
  assert.match(yml, /issues:\s*write/, "it has to be able to file the one issue per leg");
  const jobs = [...yml.matchAll(/^  (\w+):\n    name:/gm)].map((m) => m[1]);
  assert.deepEqual(jobs, ["bun", "wrangler", "browsers"], "three legs, named for what they run");
  assert.equal((yml.match(/uses: \.\/\.github\/actions\/setup-bun/g) ?? []).length, 3, "each leg installs the PINNED bun through the shared action, once");
  assert.doesNotMatch(yml, /oven-sh\/setup-bun|bun-version:|releases\/download\/canary/, "the canary binary is fetched by the script, never by the workflow");
  assert.equal((yml.match(/canary:report -- --leg (\w+)/g) ?? []).length, 3, "every leg reports through the same reporter");
  for (const leg of jobs) assert.match(yml, new RegExp(`canary:report -- --leg ${leg} `), `${leg} reports under its own name`);
});

test("the bumper and the canary share the gates rather than each carrying a copy", async () => {
  const lib = await readFile(new URL("tools/lib/bun-gates.ts", ROOT), "utf8");
  for (const fn of ["byteIdenticalBuildGate", "lockfileFormatGate", "lockfileReadGate", "zstdGate", "contractSuiteGate", "hashTree"]) {
    assert.match(lib, new RegExp(`export function ${fn}\\(`), `lib/bun-gates.ts must export ${fn}`);
  }
  for (const file of ["tools/bump-bun-pin.ts", "tools/canary-bun.ts"]) {
    const code = strip(await readFile(new URL(file, ROOT), "utf8"));
    assert.match(code, /from "\.\/lib\/bun-gates\.ts"/, `${file} must import the shared gates`);
    assert.doesNotMatch(code, /function hashTree|renameSync\(BUILD|\.build\.pinned-baseline"\)/, `${file} re-implements the build comparison instead of calling byteIdenticalBuildGate`);
  }
});

test("every Playwright launch in tools reads its channel from browser-channel.ts", async () => {
  const dir = fileURLToPath(new URL("tools/", ROOT));
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules" || e.name === "zenc" || e.name === "libavif" || e.name === ".venv") return [];
    const p = `${d}${e.name}`;
    return e.isDirectory() ? walk(`${p}/`) : /\.(ts|mjs)$/.test(e.name) ? [p] : [];
  });
  const launchers = [];
  for (const file of walk(dir)) {
    const src = await readFile(file, "utf8");
    if (!/from "playwright-core"/.test(src)) continue;
    const rel = file.slice(dir.length);
    if (rel === "canary-browsers.ts") continue; // it launches every engine by name; the channel IS its input
    assert.doesNotMatch(src, /channel:\s*"chrome/, `tools/${rel} hardcodes a Chrome channel; use chromeChannel()`);
    if (/chromium\.launch\(/.test(src)) {
      assert.match(src, /channel: chromeChannel\(\)/, `tools/${rel} launches Chromium without chromeChannel()`);
      launchers.push(rel);
    }
  }
  assert.ok(launchers.length >= 8, `only ${launchers.length} launch sites found; the scanner has stopped matching (there were 9 on 2026-09-14)`);
});

test("chromeChannel() reads CHROME_CHANNEL and defaults to stable Chrome", () => {
  assert.equal(chromeChannel({}), DEFAULT_CHROME_CHANNEL);
  assert.equal(chromeChannel({ CHROME_CHANNEL: "" }), "chrome");
  assert.equal(chromeChannel({ CHROME_CHANNEL: "  " }), "chrome");
  assert.equal(chromeChannel({ CHROME_CHANNEL: "chrome-canary" }), "chrome-canary");
  assert.equal(chromeChannel({ CHROME_CHANNEL: " chromium-tip-of-tree " }), "chromium-tip-of-tree");
});

test("the reporter's decision table is the one on its header", () => {
  // `.mjs` infers `verdict: string`, so each report is cast to the reporter's own
  // parameter type rather than a copy of it.
  const rep = (leg, verdict, signature) => /** @type {Parameters<typeof plan>[0]} */ ({ leg, verdict, signature });
  const red = rep("bun", "red", "red:zstd honours `dictionary`");
  const green = rep("bun", "green", "green");
  const broken = rep("bun", "instrument", "instrument:download failed");
  const open = (text) => ({ number: 7, text });

  assert.deepEqual(plan(red, null), { kind: "create" }, "red with nothing open files the issue");
  assert.deepEqual(plan(red, open("some body")), { kind: "comment", number: 7 }, "red with a new signature comments");
  assert.deepEqual(plan(red, open(`x\n${marker("bun", red.signature)}\ny`)), { kind: "none" }, "red with the same signature already on the issue stays quiet");
  assert.deepEqual(plan(rep("bun", "changed", red.signature), null), { kind: "create" }, "changed is filed like red");
  assert.deepEqual(plan(green, open("body")), { kind: "close", number: 7 }, "green closes the open issue");
  assert.deepEqual(plan(green, null), { kind: "none" }, "green with nothing open is silence");
  assert.deepEqual(plan(broken, null), { kind: "none" }, "an instrument failure files nothing");
  assert.deepEqual(plan(broken, open("body")), { kind: "none" }, "and never touches an open issue either");

  // The marker is what dedupes, so it has to survive a rendered body and be
  // leg-scoped: bun's signature on the wrangler issue must not silence wrangler.
  const body = render(/** @type {Parameters<typeof render>[0]} */ ({ ...red, subject: { version: "1.4.3", revision: "1.4.3-canary.1+b820c70d6" }, gates: [{ name: "zstd honours `dictionary`", ok: false, detail: "73 none / 73 good | 73 wrong" }], ms: 1 }), undefined);
  assert.ok(body.includes(marker("bun", red.signature)), "the rendered body carries the marker");
  assert.ok(body.includes("73 none / 73 good \\| 73 wrong"), "a pipe in a detail is escaped so the table survives");
  assert.deepEqual(plan(rep("wrangler", "red", red.signature), open(body)), { kind: "comment", number: 7 }, "another leg's marker does not silence this one");
  assert.equal(title("bun"), "canary tripwire: bun");
});

test("canary gate details preserve backslashes and cannot split table rows", () => {
  // GFM resolves the pipe escape before inline backslash escapes. These bytes
  // preserve the input through both stages, including a backslash before a pipe.
  const cases = [
    ["x|y", "x\\|y"],
    ["i\\|j", "i\\\\\\|j"],
    ["m\\\\|n", "m\\\\\\\\\\|n"],
    ["g\\h", "g\\\\h"],
    ["t\\", "t\\\\"],
    ["line one\r\n| injected |\nline two", "line one \\| injected \\| line two"],
  ];
  for (const [detail, expected] of cases) {
    const body = render({ leg: "bun", verdict: "red", signature: "red:gate", subject: {}, gates: [{ name: "gate", ok: false, detail }], ms: 1 }, undefined);
    const rows = body.split("\n").filter((line) => line.startsWith("|"));
    assert.deepEqual(rows, ["| gate | result | detail |", "|---|---|---|", `| gate | FAIL | ${expected} |`], detail);
  }
});

test("the honest-false detector matches the page's own convention, and finds the shipped cards", async () => {
  const html = await readFile(new URL("src/pages/garage/horizon.html", ROOT), "utf8");
  const probes = [...html.matchAll(/^\s*"([a-z0-9-]+)": function \(\) \{ return \(false\); \},?$/gm)].map((m) => m[1]);
  assert.ok(probes.length >= 5, `only ${probes.length} one-line honest-false probes found in horizon.html; the page's convention moved or the scanner stopped matching`);
  for (const cap of probes) assert.ok(HONEST_FALSE.test(`function () { return (false); }`), `${cap}'s probe shape is not detected`);
  assert.ok(HONEST_FALSE.test("function () { return false }"), "the bare form counts too");
  assert.ok(!HONEST_FALSE.test('function () { return CSS.supports("color: AccentColor"); }'), "a real probe is not honest-false");
  assert.ok(!HONEST_FALSE.test("function () { if (x) return false; return true; }"), "a probe that CAN return true is not honest-false");

  const shipped = shippedCaps(html);
  assert.ok(shipped.length >= 5, `only ${shipped.length} shipped cards found; the card markup moved`);
  assert.ok(shipped.includes("text-box-trim"), "text-box-trim is shipped on the site and must be found");
  assert.ok(!shipped.includes("interestfor"), "interestfor is a demo card and must not read as shipped");

  assert.equal(familyOf("chromium-tip-of-tree"), "chromium");
  assert.equal(familyOf("chrome-canary"), "chromium");
  assert.equal(familyOf("firefox-beta"), "firefox");
  assert.equal(familyOf("webkit"), "webkit");
});

test("every upstream watch names a thread, and every bun watch RUNS on the pinned bun and answers a boolean", () => {
  const thread = /^https:\/\/github\.com\/(oven-sh\/bun|cloudflare\/(workerd|workers-sdk))(\/(issues|pull)\/\d+)?$/;
  const names = new Set();
  for (const w of [...BUN_WATCHES, ...WRANGLER_WATCHES]) {
    assert.match(w.issue, thread, `${w.name} must point at the upstream thread it waits on`);
    assert.match(w.name, /^[a-z0-9-]+$/, `${w.name} is part of a signature and must be kebab-case`);
    assert.match(w.measured, /^\d{4}-\d{2}-\d{2}, /, `${w.name} must record when it was measured false`);
    assert.ok(!names.has(w.name), `${w.name} is declared twice`);
    names.add(w.name);
  }
  assert.ok(BUN_WATCHES.length >= 5, `only ${BUN_WATCHES.length} bun watches; the list collapsed`);
  // The control: each probe has to RUN, here, under the pinned bun. The suite
  // also runs under node (test:node), where `process.execPath` is node, so the
  // bun on PATH is the runtime then; CI's setup-bun puts the pin there. A
  // watch that reads `null` is decoration, whichever way the fix goes.
  const bun = process.versions.bun ? process.execPath : "bun";
  for (const w of BUN_WATCHES) {
    const r = runBunWatch(bun, w);
    assert.ok(r.landed === true || r.landed === false, `${w.name} did not run under the pinned bun: ${r.detail}`);
    assert.ok(r.detail.length > 0, `${w.name} answered with no detail`);
  }
});

test("a watch moves only when both readings are real and differ, and the reporter renders every row", () => {
  const w = { name: "x-lands", issue: "https://github.com/oven-sh/bun/issues/1", landed: "x is fixed" };
  const yes = { landed: true, detail: "yes" };
  const no = { landed: false, detail: "no" };
  const none = { landed: null, detail: "did not run: boom" };
  assert.equal(watchMoved(watchRow(w, no, yes)), true, "false in the pin, true in the candidate is the fix arriving");
  assert.equal(watchMoved(watchRow(w, yes, no)), true, "true in the pin, false in the candidate is a regression, and still a move");
  assert.equal(watchMoved(watchRow(w, no, no)), false);
  assert.equal(watchMoved(watchRow(w, yes, yes)), false, "landed in both is retire-me, never a move");
  assert.equal(watchMoved(watchRow(w, none, yes)), false, "a probe that did not run never flips a verdict");
  assert.equal(watchSignature(watchRow(w, no, yes)), "watch:x-lands:f>t");

  const report = /** @type {Parameters<typeof render>[0]} */ ({
    leg: "bun", verdict: "changed", signature: "changed:watch:x-lands:f>t", subject: {}, gates: [], ms: 1,
    watches: [watchRow(w, no, yes), watchRow(w, yes, yes), watchRow({ ...w, name: "y-lands" }, none, no)],
  });
  const body = render(report, undefined);
  assert.ok(body.includes("| watch | pinned | candidate | reading |"), "a watches table");
  assert.ok(body.includes("| [`x-lands`](https://github.com/oven-sh/bun/issues/1) | not yet | landed **MOVED** |"), "the moved row is marked");
  assert.ok(body.includes("landed | landed (in the pin too: retire this watch)"), "a row landed in the pin says to retire it");
  assert.ok(body.includes("| did not run | not yet |"), "a probe that did not run says so rather than reading as either answer");
  assert.ok(body.includes("`x-lands` landed means: x is fixed"), "a moved row explains what landed means");
});

test("the pin digest parses changesets out of a compare payload, caps the subjects, and says nothing about changesets where none exist", () => {
  const patch = (text) => text.split("\n").map((l) => `+${l}`).join("\n");
  const cmp = {
    total_commits: 3,
    commits: [
      { sha: "a", commit: { message: "perf(wrangler): remove execa (#1)\n\nbody", author: { name: "someone" } }, author: { login: "someone" } },
      { sha: "b", commit: { message: "chore: bump", author: { name: "robobun" } }, author: { login: "robobun" } },
      { sha: "c", commit: { message: "<script>x</script> subject", author: { name: "z" } }, author: null },
    ],
    files: [
      { filename: ".changeset/nice-cats.md", status: "added", patch: patch('---\n"wrangler": patch\n"miniflare": minor\n---\n\nReplace execa with tinyexec.\nSecond line.') },
      { filename: ".changeset/old.md", status: "removed", patch: "-gone" },
      { filename: "packages/wrangler/src/x.ts", status: "modified", patch: "+x" },
    ],
  };
  const sets = changesets(cmp.files);
  assert.deepEqual(sets, [{ file: ".changeset/nice-cats.md", packages: [{ name: "wrangler", bump: "patch" }, { name: "miniflare", bump: "minor" }], note: "Replace execa with tinyexec.\nSecond line." }]);
  const md = renderDigest("cloudflare/workers-sdk", "aaaaaaa", "bbbbbbb", cmp);
  assert.ok(md.includes("- **wrangler** patch, **miniflare** minor: Replace execa with tinyexec."), "one line per changeset, first line of the note");
  assert.ok(md.includes("3 commit subjects, 1 by bots"), "bots are counted");
  assert.ok(md.includes("- scriptx/script subject (z)"), "angle brackets are stripped from subjects and a null author falls back to the commit author");
  assert.ok(!md.includes("No changeset"), "a range that added one does not also claim it added none");

  const bun = renderDigest("oven-sh/bun", "1111111", "2222222", { total_commits: 300, commits: Array.from({ length: 250 }, (_, i) => ({ sha: String(i), commit: { message: `commit ${i}`, author: { name: "robobun" } }, author: { login: "robobun" } })), files: [] });
  assert.ok(bun.includes("(the API returned 250 of 300)"), "a truncated compare says so");
  assert.ok(bun.includes("- and 210 more"), "subjects are capped at 40");
  assert.ok(!bun.includes("changeset"), "a repository with no changeset directory gets no sentence about changesets");
});

test("the JXL fixture is a real codestream and the live probes are named where the reporter can find them", () => {
  const bytes = Buffer.from(JXL_2X2, "base64");
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0x0a], "a bare JPEG XL codestream starts ff 0a");
  assert.ok(bytes.length > 100 && bytes.length < 400, `a 2x2 lossless JXL is a couple of hundred bytes, got ${bytes.length}`);
  assert.deepEqual([...LIVE_PROBES], ["live:jxl-decode", "live:dictionary-transport"]);
  const src = readdirSync(fileURLToPath(new URL("tools/", ROOT))).includes("canary-browsers.ts");
  assert.ok(src);
});
