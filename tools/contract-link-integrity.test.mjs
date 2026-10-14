// ── link integrity ──────────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  test,
} from "./contract-shared.ts";

test("the link resolver accepts what the site serves", async () => {
  const { makeResolver } = await import("./lib/link-integrity.ts");
  const resolves = makeResolver({
    files: new Set(["/index.html", "/luna.css", "/garage/horizon.html", "/i/x.avif"]),
    routeKeys: new Set(["/whoareyou", "/updates"]),
    allow: ["/images/full/*", "/coffee/*", "/garage/*"],
    surfaces: new Set(["/garage/horizon", "/garage/wire", "/terminal"]),
  });

  assert.ok(resolves("/luna.css"), "a real static file");
  assert.ok(resolves("/garage/horizon"), "an extensionless page backed by <path>.html");
  assert.ok(resolves("/whoareyou"), "a Worker ROUTES key with no file behind it");
  assert.ok(resolves("/terminal"), "a registered surface");
  assert.ok(resolves("/images/full/XT500010.jpg"), "a dynamic namespace, resolved by the glob");
  assert.ok(resolves("/coffee/anything"), "an app namespace the registry does not govern");
});

test("the link resolver rejects a page that moved", async () => {
  const { makeResolver } = await import("./lib/link-integrity.ts");
  const resolves = makeResolver({
    files: new Set(["/index.html", "/garage/horizon.html"]),
    routeKeys: new Set(["/whoareyou"]),
    allow: ["/garage/*", "/lwe/*"],
    surfaces: new Set(["/garage/horizon", "/garage/wire", "/lwe/fhe"]),
  });

  assert.ok(!resolves("/whoami"), "a renamed top-level route must not resolve");
  assert.ok(!resolves("/terminal-moved"), "an invented top-level path must not resolve");

  assert.ok(!resolves("/garage/renamed-page"),
    "a dangling path inside a registry-governed namespace must not be excused by a run_worker_first glob");
  assert.ok(!resolves("/lwe/deleted-chat"), "same, for the other governed section");
});

test("the ref scanner reads unquoted attributes, which is how the site ships", { skip: typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter" }, async () => {
  const { internalRefs } = await import("./lib/link-integrity.ts");
  const refs = await internalRefs('<a href=/coffee>x</a><img src=/i/a.avif><a href="/garage/wire">y</a>'
    + "<a href='/terminal'>z</a><a href=/updates#now>w</a><a href=/rn?v=2>v</a>");
  assert.deepEqual(refs, ["/coffee", "/i/a.avif", "/garage/wire", "/terminal", "/updates", "/rn"]);

  assert.deepEqual(await internalRefs('<img data-src=/i/deferred.avif>'), ["/i/deferred.avif"]);
  assert.deepEqual(
    await internalRefs('<img srcset="/i/a-200.avif 200w, /i/a-400.avif 400w" data-srcset=/i/b.avif>'),
    ["/i/a-200.avif", "/i/a-400.avif", "/i/b.avif"],
  );

  assert.deepEqual(await internalRefs('<a href=https://x.test/a>1</a><a href=#top>2</a>'
    + '<a href=mailto:a@b.test>3</a><a href=//cdn.test/x.js>4</a><a href=../rel>5</a>'), []);
});
