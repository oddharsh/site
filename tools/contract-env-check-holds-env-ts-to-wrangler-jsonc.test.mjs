// env.ts is hand-written on purpose (its header says why) and check-env.ts is
// what keeps it honest against wrangler.jsonc. A check that exists but is not
// wired is the shape env.ts's header had for three weeks: it NAMED
// `bun run env:check` while no such script existed. So this pins the wiring,
// not the check's logic, which the script's own controls cover.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

test("env:check exists, runs inside typecheck, and env.ts names it", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  assert.equal(pkg.scripts["env:check"], "bun tools/check-env.ts");
  assert.match(pkg.scripts.typecheck, /bun tools\/check-env\.ts/, "typecheck must run check-env.ts, or a drifted env.ts reaches main");
  const env = await readFile(new URL("src/worker/lib/env.ts", ROOT), "utf8");
  assert.match(env, /bun run env:check/, "env.ts's header must name the check that holds it");
  // The five tiers the check reads by name; renaming one silently empties a tier.
  for (const t of ["EnvBindings", "EnvVars", "EnvSecrets", "EnvOptionalSecrets", "EnvInjected"]) {
    assert.match(env, new RegExp(`export interface ${t} \\{`), `env.ts no longer exports ${t}, which check-env.ts reads by that name`);
  }
});
