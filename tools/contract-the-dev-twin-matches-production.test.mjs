// wrangler.dev.jsonc is the hand-kept twin of cloudflare.config.ts, and its
// header says the two MUST agree on bindings, crons and routing. build.ts
// invariant #6 compares them on every build, and it WARNS, on purpose: build.ts
// runs on the deploy path, and failing a production release over a file only
// `bun run dev` reads would gate the site on bytes that never ship.
//
// A warning on the deploy path is also a warning nobody reads. #876 added
// "/dotfiles" and "/dotfiles/*" to production's run_worker_first and not to the
// twin, and every `bun run build` after it printed the drift while CI stayed
// green. So the same four comparisons fail HERE, in `validate`, where they gate
// the PR that introduces the drift rather than the release that ships it.
//
// Both sides are read with real parsers (siteConfig's projection and
// parseJsonc) rather than build.ts's regex, so the two checks do not share a
// failure mode. Each comparison is floored, because two empty lists agree.
import { configText, assert, test } from "./contract-shared.ts";
import { parseJsonc } from "./lib/jsonc.ts";

const load = async () => ({
  prod: JSON.parse(await configText("cloudflare.config.ts")),
  dev: parseJsonc(await configText("wrangler.dev.jsonc")),
});

// Set difference in both directions. An entry only the twin has is the more
// dangerous half: local dev then exercises a path production serves statically.
const drift = (prod, dev) => ({
  missingFromDev: [...new Set(prod)].filter((x) => !dev.includes(x)),
  onlyInDev: [...new Set(dev)].filter((x) => !prod.includes(x)),
});
const NONE = { missingFromDev: [], onlyInDev: [] };

// The same identifiers build.ts scans for, read off the parsed structure
// re-serialized, so comments and formatting in the twin cannot move the result.
const bindingNames = (config) =>
  [...JSON.stringify(config).matchAll(/"(?:binding|name|database_name|bucket_name|dataset)":"([^"]+)"/g)].map((m) => m[1]);

test("run_worker_first: the dev twin claims exactly the paths production claims", async () => {
  const { prod, dev } = await load();
  const p = prod.assets.run_worker_first, d = dev.assets.run_worker_first;
  // 96 today; a reader that lost the block would report two empty lists agreeing.
  assert.ok(p.length >= 60, `cloudflare.config.ts: read only ${p.length} run_worker_first rules`);
  assert.deepEqual(drift(p, d), NONE, "add the rows to wrangler.dev.jsonc at the position cloudflare.config.ts uses");
  // The cap counts RAW entries, duplicates included (gotcha 26).
  for (const [name, list] of [["cloudflare.config.ts", p], ["wrangler.dev.jsonc", d]]) {
    assert.ok(list.length <= 100, `${name}: ${list.length} run_worker_first rules, over wrangler's cap of 100`);
  }
});

test("the drift check can see a missing row, which is what #876 shipped", async () => {
  // The control. Without it, a `drift` that always returned NONE would pass.
  const { prod } = await load();
  const p = prod.assets.run_worker_first;
  assert.ok(p.includes("/dotfiles"), "the control needs a real row to remove");
  const d = p.filter((x) => x !== "/dotfiles" && x !== "/dotfiles/*");
  assert.deepEqual(drift(p, d), { missingFromDev: ["/dotfiles", "/dotfiles/*"], onlyInDev: [] });
  assert.deepEqual(drift(d, p), { missingFromDev: [], onlyInDev: ["/dotfiles", "/dotfiles/*"] });
});

test("crons and compatibility_flags match, as sets, because the runtime reads them as sets", async () => {
  const { prod, dev } = await load();
  const lists = {
    crons: [prod.triggers?.crons ?? [], dev.triggers?.crons ?? []],
    compatibility_flags: [prod.compatibility_flags ?? [], dev.compatibility_flags ?? []],
  };
  for (const [label, [p, d]] of Object.entries(lists)) {
    assert.ok(p.length, `cloudflare.config.ts: read 0 ${label}`);
    assert.deepEqual(drift(p, d), NONE, `${label} differ between cloudflare.config.ts and wrangler.dev.jsonc`);
    // Sets hide a duplicate, which a runtime still sees twice.
    assert.equal(d.length, new Set(d).size, `wrangler.dev.jsonc: duplicated ${label}`);
  }
});

test("both configs declare the same binding names", async () => {
  const { prod, dev } = await load();
  const p = bindingNames(prod), d = bindingNames(dev);
  assert.ok(p.length >= 20, `cloudflare.config.ts: read only ${p.length} binding names`);
  assert.deepEqual(drift(p, d), NONE, "a binding was added to one config and not the other");
});
