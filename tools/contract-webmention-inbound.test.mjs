// ── webmention (inbound) ────────────────────────────────────────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  testGlobals,
  WEBMENTION_PATHS,
  WM_SECRET,
  assert,
  context,
  deferredContext,
  fakeD1,
  handleInbox,
  handleWebmention,
  handleWebmentionDecision,
  handleWritingIndex,
  readFile,
  sign,
  staticAssets,
  test,
  wmEnv,
  wmPost,
} from "./contract-shared.ts";

// ── webmention (inbound) ────────────────────────────────────────────────────
// A tiny in-memory D1 stand-in: enough SQL surface for the handful of statements
// webmention.js issues, so the verify → store → approve → display path runs end
// to end without a real database.

// the shared context() discards waitUntil promises; webmention does its real
// work there (verification is deliberately off the request path), so the test
// needs a context it can await.

test("webmention rejects targets that do not accept mentions", async () => {
  const env = wmEnv(fakeD1());
  // /ledger is a real page but is not flagged webmention in the registry.
  for (const target of ["https://aadhar.sh/ledger", "https://elsewhere.example/post", "https://aadhar.sh/writing/nope"]) {
    const res = await handleWebmention(wmPost("https://mari.example/post", target), env, context());
    assert.equal(res.status, 400, `should reject target ${target}`);
  }
});

test("webmention rejects private, non-http, and same-origin sources", async () => {
  const env = wmEnv(fakeD1());
  const target = "https://aadhar.sh/garage/chunks";
  for (const source of ["http://127.0.0.1/x", "http://169.254.169.254/latest/meta-data", "javascript:alert(1)", "https://aadhar.sh/writing/in-flux"]) {
    const res = await handleWebmention(wmPost(source, target), env, context());
    assert.equal(res.status, 400, `should reject source ${source}`);
  }
});

test("webmention verifies the source really links back, then moderates before publishing", async () => {
  const db = fakeD1();
  const env = wmEnv(db);
  const target = "https://aadhar.sh/writing/in-flux";   // a post, via the /writing section flag
  const source = "https://mari.example/resto-mod-web";
  const realFetch = globalThis.fetch;

  // 1. a source that does NOT link back is verified away and never stored.
  testGlobals.fetch = async () => new Response("<html><a href='https://example.com'>elsewhere</a></html>", { headers: { "content-type": "text/html" } });
  try {
    let ctx1 = deferredContext();
    let res = await handleWebmention(wmPost(source, target), env, ctx1);
    assert.equal(res.status, 202, "the sender is always accepted; verification is async");
    await ctx1.settle();
    assert.equal(db.rows.length, 0, "an unverified mention must never be stored");

    // 2. a source that DOES link back is stored, but only as pending.
    testGlobals.fetch = async () => new Response(
      `<html><head><title>Resto-mod web</title><meta name="author" content="Mari"></head>
       <body><p class="e-content">A lovely note about <a class="u-in-reply-to" href="${target}">in flux</a> and its ideas.</p></body></html>`,
      { headers: { "content-type": "text/html" } });
    const ctx2 = deferredContext();
    res = await handleWebmention(wmPost(source, target), env, ctx2);
    assert.equal(res.status, 202);
    await ctx2.settle();
    assert.equal(db.rows.length, 1);
    assert.equal(db.rows[0].status, "pending", "nothing is displayed unmoderated");
    assert.equal(db.rows[0].kind, "reply", "u-in-reply-to reads as a reply");
    assert.equal(db.rows[0].author, "Mari");

    // 3. it stays out of /inbox until approved.
    let inbox = await handleInbox(new Request("https://aadhar.sh/inbox"), env, context());
    let html = await inbox.text();
    assert.ok(!html.includes("Resto-mod web"), "a pending mention must not render");
    assert.match(inbox.headers.get("link") || "", /rel="webmention"/, "the inbox advertises the endpoint");

    // 4. a forged approval is refused; only the HMAC-signed one works.
    const id = db.rows[0].id;
    const badUrl = new URL(`https://aadhar.sh/webmention/approve?t=${id}&sig=nope`);
    const forged = await handleWebmentionDecision(new Request(badUrl), env, context(), badUrl);
    assert.equal(forged.status, 403, "nobody can approve their own mention");
    assert.equal(db.rows[0].status, "pending");

    const sig = await sign(`${id}|approve`, WM_SECRET);
    const okUrl = new URL(`https://aadhar.sh/webmention/approve?t=${id}&sig=${sig}`);
    const approved = await handleWebmentionDecision(new Request(okUrl), env, context(), okUrl);
    assert.equal(approved.status, 200);
    assert.equal(db.rows[0].status, "approved");

    // 5. now it renders, links out to the source, and is filed under its page.
    inbox = await handleInbox(new Request("https://aadhar.sh/inbox"), env, context());
    html = await inbox.text();
    assert.ok(html.includes("Resto-mod web"), "an approved mention renders");
    assert.ok(html.includes(source), "the row links out to the source");
    assert.ok(html.includes("/writing/in-flux"), "filed under the page it mentions");

    // 6. re-sending after the link is removed retracts it (the spec's delete signal).
    testGlobals.fetch = async () => new Response("<html><p>rewritten, no link anymore</p></html>", { headers: { "content-type": "text/html" } });
    const ctx3 = deferredContext();
    res = await handleWebmention(wmPost(source, target), env, ctx3);
    assert.equal(res.status, 202);
    await ctx3.settle();
    assert.equal(db.rows.length, 0, "a mention whose source dropped the link is retracted");
  } finally { testGlobals.fetch = realFetch; }
});

test("/inbox degrades honestly when the mention store is unbound", async () => {
  const res = await handleInbox(new Request("https://aadhar.sh/inbox"), { ASSETS: staticAssets({}) }, context());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /not connected/i, "says the store is missing rather than pretending there is no mail");
});

test("every page that accepts a mention also advertises where to send it", async () => {
  // Accepting a webmention it never advertises makes a page undiscoverable to a
  // spec-compliant sender, which is the same as not accepting it. /writing was
  // exactly that for one deploy: flagged in the registry, 202 on POST, and no
  // Link header on the folder itself. Tie the two together so they cannot drift.
  const headers = await readFile("public/_headers", "utf8");
  const advertisedByHeaders = headers
    .split(/\n(?=\S)/)
    .filter((block) => /Link:.*rel="webmention"/.test(block))
    .map((block) => block.split("\n")[0].trim());

  const coveredByStatics = (path) =>
    advertisedByHeaders.some((rule) =>
      rule.endsWith("/*") ? path.startsWith(rule.slice(0, -1)) : rule === path);

  // The worker-rendered ones, asked through their REAL handler rather than the
  // inner render, so an edge-cache wrapper that drops the header on its way out
  // still fails. A path that is neither covered by _headers nor named here fails
  // outright: a page can join WEBMENTION_PATHS with one manifest flag, and the
  // whole point of this test is that the flag is not enough on its own.
  const workerRendered = {
    "/writing": () => handleWritingIndex(new Request("https://aadhar.sh/writing"), { ASSETS: staticAssets({}) }, context()),
    "/inbox":   () => handleInbox(new Request("https://aadhar.sh/inbox"), { ASSETS: staticAssets({}) }, context()),
  };

  for (const path of WEBMENTION_PATHS) {
    if (coveredByStatics(path)) continue;
    const render = workerRendered[path];
    assert.ok(render, `no advertisement path known for ${path}`);
    const priorCaches = globalThis.caches;
    testGlobals.caches = { default: { match: async () => undefined, put: async () => {} } };
    let res;
    try {
      res = await render();
    } finally {
      if (priorCaches === undefined) delete globalThis.caches;
      else testGlobals.caches = priorCaches;
    }
    assert.match(
      res.headers.get("link") || "",
      /rel="webmention"/,
      `${path} accepts mentions, so it must say where to send them`
    );
  }
});

// The author markup on the first webmention this site ever received, verbatim
// from webmention.rocks receiver test 1 (2026-08-28). Kept as a fixture rather
// than paraphrased, because both bugs it caught live in the exact shape: an
// h-card whose only content is a linked photo, and an h-entry p-name a few
// hundred characters later that is the POST title rather than anybody's name.
const REAL_HCARD = (target) => `<html><head><title>Webmention Rocks!</title></head><body>
  <div class="post-container h-entry">
    <div class="post-main"><a href="${target}" class="u-in-reply-to">${target}</a></div>
    <div class="post-main">
      <div class="left p-author h-card">
        <a href="/">
          <img src="/assets/webmention-rocks-icon.png" width="80" class="u-photo" alt="Webmention Rocks!">
        </a>
      </div>
      <div class="right">
        <h1 class="p-name"><a href="/receive/1">Receiver Test #1</a></h1>
        <div class="e-content"><p>This test verifies that you accept a Webmention request.</p></div>
      </div>
    </div>
  </div></body></html>`;

async function storeFrom(html, source = "https://webmention.rocks/receive/1/abc") {
  const db = fakeD1();
  const target = "https://aadhar.sh/writing/in-flux";
  const realFetch = globalThis.fetch;
  testGlobals.fetch = async () => new Response(typeof html === "function" ? html(target) : html,
    { headers: { "content-type": "text/html" } });
  try {
    const ctx = deferredContext();
    await handleWebmention(wmPost(source, target), wmEnv(db), ctx);
    await ctx.settle();
  } finally { testGlobals.fetch = realFetch; }
  return db.rows[0];
}

test("an h-card that wraps only a photo names its author, and never blank", async () => {
  // The regression, measured on the real thing: the p-author pattern matched and
  // then captured the whitespace between that div's ">" and the "<a" on the next
  // line. Whitespace is truthy, so the fallback chain stopped and the hostname
  // floor never ran; clean() reduced the winner to "". Stored author was "".
  const row = await storeFrom(REAL_HCARD);
  assert.ok(row, "the mention is stored");
  assert.equal(row.author, "Webmention Rocks!", "the u-photo alt is what mf2 says carries the name here");
});

test("an entry title is never mistaken for an author", async () => {
  // p-name inside an h-card is the author's name; p-name inside an h-entry is the
  // POST's name. A pattern that cannot see which parent it sits under reads the
  // title, which is worse than falling back to the hostname because it is
  // confidently wrong. On the fixture above that mistake reads "Receiver Test #1".
  const row = await storeFrom(REAL_HCARD);
  assert.notEqual(row.author, "Receiver Test #1");
});

test("a source with no author markup falls back to its host, never to nothing", async () => {
  const target = "https://aadhar.sh/writing/in-flux";
  const row = await storeFrom(`<html><head><title>A post</title></head><body>
    <p>see <a href="${target}">this</a></p></body></html>`, "https://mari.example/post");
  assert.equal(row.author, "mari.example", "the documented floor: an unknown author reads as the site it came from");
});

test("a p-author with real text still wins over the floor", async () => {
  const target = "https://aadhar.sh/writing/in-flux";
  const row = await storeFrom(`<html><body>
    <div class="h-card p-author"><a class="p-name" href="/">Mari Kondo</a></div>
    <p>see <a href="${target}">this</a></p></body></html>`, "https://mari.example/post");
  assert.equal(row.author, "Mari Kondo");
});
