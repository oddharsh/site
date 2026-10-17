// ── tools/lib/cf.ts names the same resources the site config does ───────────
// Split-file convention: shared imports live in contract-shared.ts.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { CF_ACCOUNT, CF_VERSION, D1, cfCommand } from "./lib/cf.ts";

// `cf d1 query` takes a database id where wrangler took the name, so the helper
// carries the ids. They are copies of cloudflare.config.ts's bindings, and a
// copy that drifts would point deploy:promote's changelog write at the wrong
// database. Read as text so this needs no wrangler to load the config.
test("every D1 id the cf helper names is the one cloudflare.config.ts binds", async () => {
  const config = await readFile(new URL("cloudflare.config.ts", ROOT), "utf8");
  assert.ok(Object.keys(D1).length >= 2, "the helper names no databases; this test has stopped checking anything");
  for (const [name, id] of Object.entries(D1)) {
    // includes() rather than match(), so a failure names the pair instead of
    // printing the whole config.
    assert.ok(config.includes(`bindings.d1({ name: "${name}", id: "${id}" })`), `${name} -> ${id} is not what cloudflare.config.ts binds`);
  }
  if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
    assert.ok(config.includes(`accountId: "${CF_ACCOUNT}"`), "the helper's default account is not the site's");
  }
});

// `bun x` fetches what it is told to. An exact version is what makes that a
// pin rather than gotcha 29's registry lookup.
test("cf runs at one exact version, through bun rather than a package manager", () => {
  assert.match(CF_VERSION, /^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/, "CF_VERSION must be exact, never a range or a tag");
  const [cmd, argv] = cfCommand(["auth", "whoami"]);
  assert.equal(cmd, "bun");
  assert.deepEqual(argv, ["x", `cf@${CF_VERSION}`, "auth", "whoami"]);
});
