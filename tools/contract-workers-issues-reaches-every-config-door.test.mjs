// Workers Issues is on for the site Worker (cloudflare.config.ts has the
// history: #950 turned it on, the account gate blocked five ramps, #961 took it
// out, and the gate lifted with the open beta on 2026-09-30).
//
// Two things can lose it without a word. The projection in tools/lib/site-config.ts
// rebuilds `observability` field by field for every command that reads the
// legacy shape through `-c`, and it dropped every field it did not name, so a
// block added to the TS config reached `--x-new-config` commands and nothing
// else. And a later edit to the observability block can drop `issues` the way
// #961 did on purpose, which reads in a diff as tidying.
import { assert, configText, test } from "./contract-shared.ts";
import { project, REPO } from "./lib/site-config.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const raw = async (file) => (await import(pathToFileURL(join(REPO, file)).href)).default;
const withObservability = (top, observability) => ({ ...top, worker: { ...top.worker, observability } });
// Round-tripped the way siteConfig() hands it to every caller: plain JSON data.
const projected = (top, tooling) => JSON.parse(JSON.stringify(project(top, tooling)));

test("production turns Issues on, and the legacy projection says so too", async () => {
  const top = await raw("cloudflare.config.ts");
  assert.deepEqual(top.worker.observability.issues, { enabled: true }, "cloudflare.config.ts dropped observability.issues");
  const legacy = JSON.parse(await configText("cloudflare.config.ts"));
  assert.deepEqual(legacy.observability.issues, { enabled: true }, "the projection lost observability.issues");
  // The neighbours it sits beside survive the rewrite of that block.
  assert.equal(legacy.observability.enabled, true);
  assert.deepEqual(legacy.observability.traces, { enabled: true, head_sampling_rate: 1 });
});

test("the projection carries issues as authored and never invents it", async () => {
  // The control: a projection that hard-coded `issues: { enabled: true }` would
  // pass the test above, so both other states have to come back as written.
  const top = await raw("cloudflare.config.ts");
  const tooling = await raw("wrangler.config.ts");
  const traces = { enabled: true, headSamplingRate: 1 };
  const off = projected(withObservability(top, { enabled: true, traces, issues: { enabled: false } }), tooling);
  assert.deepEqual(off.observability.issues, { enabled: false });
  const absent = projected(withObservability(top, { enabled: true, traces }), tooling);
  assert.ok(!("issues" in absent.observability), "the projection added an issues block nobody declared");
});
