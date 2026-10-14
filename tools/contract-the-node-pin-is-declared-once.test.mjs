// ── the node pin is declared once ────────────────────────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, readdir, test } from "./contract-shared.ts";

test(".node-version holds a bare major, which is why there is no bumper", async () => {
  const raw = await readFile(new URL(".node-version", ROOT), "utf8");
  assert.match(raw, /^\d+\n$/, `.node-version is ${JSON.stringify(raw)}; it must be a bare major and a newline`);

  assert.doesNotMatch(raw, /\./, ".node-version names a minor or patch, which freezes the runtime at one release");
});

test("the engines floor sits between the zstd floor and the pin", async () => {
  const raw = await readFile(new URL(".node-version", ROOT), "utf8");
  const pinned = Number(raw.trim());
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const floorMatch = /(\d+)/.exec(pkg.engines.node);
  assert.ok(floorMatch, `engines.node is ${pkg.engines.node}, which names no version`);
  const floor = Number(floorMatch[1]);

  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  const zstdMatch = /ZSTD_DICTIONARY_NODE_FLOOR = (\d+)/.exec(build);
  assert.ok(zstdMatch, "tools/build.ts declares no ZSTD_DICTIONARY_NODE_FLOOR");
  const zstdFloor = Number(zstdMatch[1]);

  assert.ok(zstdFloor <= floor,
    `engines.node floors at ${floor}, below the zstd dictionary floor of ${zstdFloor}; the build would throw on a runtime this repo says it supports`);
  assert.ok(floor <= pinned,
    `engines.node floors at ${floor} while .node-version pins ${pinned}`);

  assert.match(build, /Node \$\{ZSTD_DICTIONARY_NODE_FLOOR\}\+ is required/,
    "build.ts's zstd tripwire hardcodes a version instead of interpolating ZSTD_DICTIONARY_NODE_FLOOR");
});

test("every workflow reads .node-version rather than naming a version", async () => {
  const dir = new URL(".github/workflows/", ROOT);
  const files = (await readdir(dir)).filter((n) => n.endsWith(".yml"));
  assert.ok(files.length >= 5, `expected the workflow set, found ${files.length}`);

  let checked = 0;
  for (const file of files) {
    const body = await readFile(new URL(file, dir), "utf8");
    if (!/uses: actions\/setup-node@/.test(body)) continue;
    assert.match(body, /node-version-file: \.node-version/,
      `.github/workflows/${file} sets up node without reading .node-version`);
    assert.ok(!/^\s*node-version: *['"]?\d/m.test(body),
      `.github/workflows/${file} names a node version inline instead of reading .node-version`);
    checked++;
  }
  assert.ok(checked >= 5, `expected several setup-node steps, matched ${checked}`);
});

const RUNS_THE_SUITE = /\bbun run (?:test|bun:pin|canary:bun|canary:wrangler|wrangler:pin)(?![\w:-])/;

function workflowJobs(body) {
  const at = body.search(/^jobs:\s*$/m);
  if (at < 0) return [];
  const heads = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].filter((m) => m.index > at);
  return heads.map((m, k) => ({ name: m[1], body: body.slice(m.index, heads[k + 1]?.index ?? body.length) }));
}

test("every job that runs the contract suite sets up the pinned node", async () => {
  const dir = new URL(".github/workflows/", ROOT);
  const files = (await readdir(dir)).filter((n) => n.endsWith(".yml"));
  const missing = [];
  let checked = 0;
  for (const file of files) {
    const body = await readFile(new URL(file, dir), "utf8");
    for (const job of workflowJobs(body)) {
      if (!RUNS_THE_SUITE.test(job.body)) continue;
      checked++;
      if (!/uses: actions\/setup-node@/.test(job.body)) missing.push(`${file}#${job.name}`);
    }
  }
  assert.deepEqual(missing, [], `jobs that run the contract suite without setting up node: ${missing.join(", ")}`);
  assert.ok(checked >= 5, `expected at least 5 suite-running jobs, matched ${checked}`);
});

test("the job splitter is per job, which is what the node check rests on", () => {
  const body = "on: push\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@x\n  b:\n    steps:\n      - run: bun run canary:bun\n";
  const jobs = workflowJobs(body);
  assert.deepEqual(jobs.map((j) => j.name), ["a", "b"]);
  const b = jobs[1];
  assert.ok(RUNS_THE_SUITE.test(b.body) && !/setup-node/.test(b.body), "job b must read as running the suite without node");
});

test("node:pin refuses to double as a bumper", async () => {
  const body = await readFile(new URL("tools/check-node-pin.ts", ROOT), "utf8");

  assert.ok(!/writeFileSync|--write/.test(body), "check-node-pin.ts writes something; it must only report");

  assert.match(body, /phaseOf\(v\) === "active-lts"/, "the suggested move must be filtered to Active LTS");

  assert.match(body, /nodejs\/Release\/main\/schedule\.json/, "the dates must come from node's own schedule");
});
