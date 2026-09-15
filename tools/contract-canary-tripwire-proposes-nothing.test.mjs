// The canary tripwire (canary.yml and the four tools/canary-*.ts it runs) is
// an INSTRUMENT: it runs moving targets through gates this repository already
// holds its pins to, and files at most one quiet issue per leg. Every
// assertion here is about the ways an instrument turns into something else.
//
//   1. it never writes a pin, opens a PR, or holds a Cloudflare credential
//   2. the gates are shared with the bumper rather than copied
//   3. every Playwright launch reads the channel from one place
//   4. the legs' reports flow through timbrado's reporter unchanged: the
//      verdict strings, the signature, the browsers leg's tables
//   5. the honest-false detector matches the page's own convention, and the
//      shipped-card scanner finds the cards
//   6. every upstream watch names a thread, RUNS on the pinned bun, and
//      answers a boolean rather than "did not run"
//   7. timbrado itself is pinned to a full commit sha, so the frozen lockfile
//      is the whole guarantee about which reporter runs
//
// The reporter's decision table and the digest parser are timbrado's and are
// asserted in its conformance suite, so nothing here restates them. 5 and 6
// are the ones that could pass while measuring nothing, which is why each
// carries a control that has to come back non-empty.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { marker, plan, render, title } from "timbrado/report";
import { checkWatch } from "timbrado/watch";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { chromeChannel, DEFAULT_CHROME_CHANNEL } from "./lib/browser-channel.ts";
import { DEFAULT_PAIRS, HONEST_FALSE, JXL_2X2, LIVE_PROBES, familyOf, shippedCaps, tablesFor } from "./canary-browsers.ts";
import { BUN_WATCHES, WRANGLER_WATCHES, runWatch } from "./lib/upstream-watches.ts";

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
  assert.equal((yml.match(/bun run timbrado report --target (\w+)/g) ?? []).length, 3, "every leg reports through timbrado's reporter");
  for (const leg of jobs) assert.match(yml, new RegExp(`timbrado report --target ${leg} .*--reproduce "bun run canary:${leg}"`), `${leg} reports under its own name and says how to reproduce`);
  assert.doesNotMatch(yml, /canary:report|canary-report/, "the site's own reporter is gone");
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
  assert.equal(chromeChannel({ CHROME_CHANNEL: " chrome-beta " }), "chrome-beta");
});

test("the legs' reports flow through timbrado's reporter: leg-shaped JSON, the verdict strings, the browsers tables", () => {
  // A leg writes `leg`; the workflow passes `--target <leg>`, and the reporter
  // reads `target`. The join is one word, so it is pinned here.
  const asTimbrado = (report, target) => ({ ...report, target });
  const red = asTimbrado({ leg: "bun", verdict: "red", signature: "red:zstd honours `dictionary`", subject: { revision: "1.4.3-canary.1+b820c70d6" }, gates: [{ name: "zstd honours `dictionary`", ok: false, detail: "73 none / 73 good | 73 wrong" }] }, "bun");
  assert.deepEqual(plan(red, null), { kind: "create" });
  const body = render(red, undefined, "bun run canary:bun");
  assert.ok(body.includes(marker("bun", red.signature)), "the rendered body carries the marker the next night dedupes on");
  assert.ok(body.includes("73 none / 73 good \\| 73 wrong"), "a pipe in a detail survives the table");
  assert.ok(body.includes("Reproduce with `bun run canary:bun`"));
  assert.deepEqual(plan(red, { number: 7, text: body }), { kind: "none" }, "the same signature already on the issue stays quiet");
  assert.equal(title("bun"), "timbrado: bun", "the issue title moved with the reporter; nothing open carried the old one");

  const tables = tablesFor(
    [{ name: "chrome", version: "153.0.8010.37", probes: 87, true: 64 }, { name: "chrome-canary", version: "155.0.8057.0", probes: 87, true: 66 }],
    [{ cap: "live:jxl-decode", stable: false, prerelease: true, pair: "chrome:chrome-canary" }, { cap: "margin-trim", stable: true, prerelease: false, pair: "chrome:chrome-canary" }],
    [{ cap: "popover", trueIn: ["chromium"] }],
  );
  const browsers = render(asTimbrado({ leg: "browsers", verdict: "changed", signature: "changed:x", subject: { page: "/src/pages/garage/horizon.html" }, tables }, "browsers"), undefined);
  assert.ok(browsers.includes("| chrome-canary | 155.0.8057.0 | 66 / 87 |"), "the engine table");
  assert.ok(browsers.includes("| `live:jxl-decode` | chrome:chrome-canary | false | true |"), "a flip");
  assert.ok(browsers.includes("| `margin-trim` | chrome:chrome-canary | true | false (gone) |"), "a regression is marked gone");
  assert.ok(browsers.includes("| `popover` | chromium |"), "the two-engine bar");
  assert.ok(!browsers.includes("[object Object]"), "no structured field leaks through the subject list");
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

  assert.equal(familyOf("chrome-beta"), "chromium");
  assert.equal(familyOf("msedge-dev"), "chromium");
  assert.equal(familyOf("chrome-canary"), "chromium");
  assert.equal(familyOf("firefox"), "firefox");
  assert.equal(familyOf("webkit"), "webkit");
});

test("every upstream watch names a thread, and every bun watch RUNS on the pinned bun and answers a boolean", () => {
  const names = new Set();
  for (const w of [...BUN_WATCHES, ...WRANGLER_WATCHES]) {
    const problems = checkWatch({ script: "x", ...w });
    assert.deepEqual(problems, [], `${w.name}: ${problems.join("; ")}`);
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
    assert.equal(w.runtime, "bun", `${w.name} must name its runtime for timbrado's runner`);
    const r = runWatch(bun, w);
    assert.ok(r.landed === true || r.landed === false, `${w.name} did not run under the pinned bun: ${r.detail}`);
    assert.ok(r.detail.length > 0, `${w.name} answered with no detail`);
  }
});

test("timbrado is pinned to a full commit sha, so the frozen lockfile is the whole guarantee about which reporter runs", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const spec = pkg.devDependencies?.timbrado ?? "";
  assert.match(spec, /^github:oddharsh\/timbrado#[0-9a-f]{40}$/, `timbrado is ${JSON.stringify(spec)}; a branch or a short sha floats`);
  const lock = await readFile(new URL("bun.lock", ROOT), "utf8");
  assert.ok(lock.includes(`timbrado@github:oddharsh/timbrado#${spec.slice(-40, -33)}`), "bun.lock records the same commit");
});

test("the JXL fixture is a real codestream and the live probes are named where the reporter can find them", () => {

  const bytes = Buffer.from(JXL_2X2, "base64");
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0x0a], "a bare JPEG XL codestream starts ff 0a");
  assert.ok(bytes.length > 100 && bytes.length < 400, `a 2x2 lossless JXL is a couple of hundred bytes, got ${bytes.length}`);
  assert.deepEqual([...LIVE_PROBES], ["live:jxl-decode", "live:dictionary-transport"]);
  const src = readdirSync(fileURLToPath(new URL("tools/", ROOT))).includes("canary-browsers.ts");
  assert.ok(src);
});

test("every name in the browsers leg's default pairs is an installation target the pinned playwright accepts", () => {
  // The installer's target list is narrower than its launch channels and it
  // moves: `chromium-tip-of-tree` and `firefox-beta` were valid when the leg
  // was written and refused by playwright-core 1.63, which killed the first
  // scheduled run at the install step. `--dry-run` answers without a download.
  const { spawnSync } = require("node:child_process");
  const names = [...new Set(DEFAULT_PAIRS.split(",").flatMap((p) => p.split(":")))];
  assert.ok(names.length >= 4, "the default pairs collapsed");
  for (const name of names) {
    const run = spawnSync("node", ["node_modules/playwright-core/cli.js", "install", "--dry-run", name], { cwd: fileURLToPath(ROOT), encoding: "utf8", timeout: 60_000 });
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /Invalid installation targets/, `${name} is not an installation target of the pinned playwright-core`);
  }
});
