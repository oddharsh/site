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
//
// The last two are the ones that could pass while measuring nothing, which
// is why each carries a control that has to come back non-empty.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { chromeChannel, DEFAULT_CHROME_CHANNEL } from "./lib/browser-channel.ts";
import { HONEST_FALSE, familyOf, shippedCaps } from "./canary-browsers.ts";
import { marker, plan, render, title } from "./canary-report.ts";

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
