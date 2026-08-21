// ── link integrity ──────────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  test,
} from "./contract-shared.mjs";

// ── link integrity ──────────────────────────────────────────────────────────
// The resolver behind build.mjs's link-integrity invariant. Tested for TEETH
// rather than for agreement: the invariant runs over a tree that currently has
// zero dangling refs, so a test that only asserted "the real site passes" would
// keep passing after the resolver was accidentally reduced to `() => true`.
test("the link resolver accepts what the site serves", async () => {
  const { makeResolver } = await import("./lib/link-integrity.mjs");
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
  const { makeResolver } = await import("./lib/link-integrity.mjs");
  const resolves = makeResolver({
    files: new Set(["/index.html", "/garage/horizon.html"]),
    routeKeys: new Set(["/whoareyou"]),
    allow: ["/garage/*", "/lwe/*"],
    // Both sections need a registered surface for the registry to GOVERN them.
    // Leaving /lwe out of this set is not a smaller fixture, it is a different
    // one: an ungoverned /lwe correctly falls through to the run_worker_first
    // glob, which is what the first draft of this test asserted against and lost.
    surfaces: new Set(["/garage/horizon", "/garage/wire", "/lwe/fhe"]),
  });

  // The case the invariant exists for: a link left behind by a rename.
  assert.ok(!resolves("/whoami"), "a renamed top-level route must not resolve");
  assert.ok(!resolves("/terminal-moved"), "an invented top-level path must not resolve");

  // The case prototype 2 silently passed, and the reason `governed` exists.
  // /garage/* is in run_worker_first, so a glob-only resolver called this fine.
  assert.ok(!resolves("/garage/renamed-page"),
    "a dangling path inside a registry-governed namespace must not be excused by a run_worker_first glob");
  assert.ok(!resolves("/lwe/deleted-chat"), "same, for the other governed section");
});

test("the ref scanner reads unquoted attributes, which is how the site ships", async () => {
  const { internalRefs } = await import("./lib/link-integrity.mjs");
  // minify-html unquotes what it can, so the served bytes look like the first two.
  // A scanner written against href="..." reported 33 refs where there were 2645.
  const refs = await internalRefs('<a href=/coffee>x</a><img src=/i/a.avif><a href="/garage/wire">y</a>'
    + "<a href='/terminal'>z</a><a href=/updates#now>w</a><a href=/rn?v=2>v</a>");
  assert.deepEqual(refs, ["/coffee", "/i/a.avif", "/garage/wire", "/terminal", "/updates", "/rn"]);

  // data-src was covered by ACCIDENT before this parsed: `src=` is a substring
  // of `data-src=`, and this site defers photo loading through it. srcset was
  // never covered at all, because neither it nor data-srcset ends in `src=`.
  // Both are named explicitly now, and the descriptor is not part of the URL.
  assert.deepEqual(await internalRefs('<img data-src=/i/deferred.avif>'), ["/i/deferred.avif"]);
  assert.deepEqual(
    await internalRefs('<img srcset="/i/a-200.avif 200w, /i/a-400.avif 400w" data-srcset=/i/b.avif>'),
    ["/i/a-200.avif", "/i/a-400.avif", "/i/b.avif"],
  );

  // Off-origin and in-page refs are not this check's business.
  assert.deepEqual(await internalRefs('<a href=https://x.test/a>1</a><a href=#top>2</a>'
    + '<a href=mailto:a@b.test>3</a><a href=//cdn.test/x.js>4</a><a href=../rel>5</a>'), []);
});
