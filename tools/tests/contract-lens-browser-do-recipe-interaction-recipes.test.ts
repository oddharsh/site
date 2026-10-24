import { Script } from "node:vm";
// ── /lens/browser?do=<recipe> — interaction recipes ────────────────────────
import {
  assert,
  context,
  handleLensBrowser,
  handleLensCompare,
  lensRecipe,
  lensRecipeIds,
  lensRecipeScript,
  test,
} from "./contract-shared.ts";

// The feature runs JavaScript inside somebody else's page. Almost every test
// below is about the blast radius of that rather than the feature working.

const recipeEnv = (content, capture?: any) => ({
  BROWSER: {
    async quickAction(name, input) {
      if (capture) capture[name] = input;
      return Response.json({ result: { content }, meta: { status: 200 } });
    },
  },
});
const browserReq = (query) => new Request("https://aadhar.sh/lens/browser?url=https%3A%2F%2Fexample.com%2F" + query);

test("a plain browser run is byte-for-byte what it was before recipes existed", async () => {
  const captured: Record<string, any> = {};
  const response = await handleLensBrowser(browserReq(""), recipeEnv("<html><body>hi</body></html>", captured), context());
  const body = await response.json();
  // The whole backwards-compatibility claim in one place: no injection is sent,
  // and no consumer of this route sees a new key appear.
  assert.equal(captured.snapshot.addScriptTag, undefined, "a plain run must inject nothing");
  assert.equal(captured.snapshot.waitForTimeout, undefined);
  assert.equal("interaction" in body, false, "the field is absent, not null, on a plain run");
  assert.equal(body.ok, true);
});

test("an unknown recipe is refused rather than quietly served as a plain render", async () => {
  // Falling through to the plain render would hand back a perfectly good
  // snapshot the caller believes is post-interaction. That is the exact failure
  // this feature exists to avoid, so a typo has to be loud.
  for (const bad of ["", "   ", "../", "expand;", "<script>", "EXPAND", " expand", "x".repeat(10000)]) {
    let called = false;
    const env = {
      BROWSER: {
        quickAction: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const response = await handleLensBrowser(browserReq("&do=" + encodeURIComponent(bad)), env, context());
    assert.equal(response.status, 400, `"${bad.slice(0, 20)}" must 400`);
    assert.equal(called, false, `"${bad.slice(0, 20)}" must never reach the binding`);
    const body = await response.json();
    assert.deepEqual(body.recipes, lensRecipeIds(), "a refusal names the ids that would work");
  }
});

test("no caller byte reaches the injected script, and none ever will", async () => {
  // THE test. `addScriptTag` runs arbitrary JS in a third-party page, so a `js=`
  // or `selector=` parameter would make /lens an open remote-code-execution
  // proxy running attacker code from Cloudflare IPs under this account's browser
  // identity. The allowlist is the only thing standing there.
  for (const id of lensRecipeIds()) {
    const captured: Record<string, any> = {};
    // Every hostile shape a caller controls, all at once: extra query params the
    // handler must ignore, and payload-ish text inside the url itself.
    await handleLensBrowser(
      new Request(
        "https://aadhar.sh/lens/browser?url=" +
          encodeURIComponent("https://example.com/?evil=</script><script>alert(1)</script>") +
          "&do=" +
          id +
          "&js=alert(9)&selector=body&script=pwn",
      ),
      recipeEnv("<html></html>", captured),
      context(),
    );
    const sent = captured.snapshot.addScriptTag;
    assert.equal(sent.length, 1, `${id} must inject exactly one tag`);
    const nonce = (sent[0].content.match(/\}\)\("([0-9a-f]{16})"\);$/) || [])[1];
    assert.ok(nonce, `${id} must carry a server-generated 16-hex nonce`);
    // As an IIFE argument, never a top-level `var`. A `var` lands on `window`,
    // where any timer on the page reads it and forges a receipt that passes the
    // nonce check. Verified in Chromium 2026-08-08 before this was tightened.
    assert.equal(/^\s*var\s/.test(sent[0].content), false, `${id} must not leak the nonce to window`);
    assert.equal(sent[0].content, lensRecipeScript(lensRecipe(id), nonce), `${id} must be the registry script verbatim`);

    // Nothing the caller typed may appear anywhere in the payload except in url.
    const rest = JSON.stringify({ ...captured.snapshot, url: "" });
    for (const smuggled of ["alert(9)", "selector", "pwn", "evil"]) {
      assert.equal(rest.includes(smuggled), false, `${id} leaked "${smuggled}" into the payload`);
    }
  }
});

test("two runs of one recipe never share a nonce", async () => {
  // A fixed nonce would be discoverable by rendering the page once, which is
  // exactly what the attacker here is already able to do.
  const seen = new Set();
  for (let i = 0; i < 5; i++) {
    const captured: Record<string, any> = {};
    await handleLensBrowser(browserReq("&do=expand"), recipeEnv("<html></html>", captured), context());
    seen.add(captured.snapshot.addScriptTag[0].content.match(/\}\)\("([0-9a-f]{16})"\);$/)[1]);
  }
  assert.equal(seen.size, 5, "each run must mint a fresh nonce");
});

test("the recipe registry stays inside what it is allowed to do", async () => {
  const { LENS_RECIPES } = await import("../../src/worker/lens-recipes.ts");
  const ids = new Set();
  for (const r of LENS_RECIPES) {
    assert.match(r.id, /^[a-z][a-z0-9-]{1,15}$/, `${r.id} is not a safe id`);
    assert.equal(ids.has(r.id), false, `${r.id} is declared twice`);
    ids.add(r.id);
    assert.ok(r.label && r.claim, `${r.id} must say what it does before it does it`);
    // A recipe is a DOM edit, never a network actor. Any of these would turn an
    // observation into an action taken on somebody else's behalf.
    for (const banned of [
      "fetch(",
      "XMLHttpRequest",
      "import(",
      "eval(",
      "new Function",
      "document.cookie",
      "localStorage",
      "sessionStorage",
      "sendBeacon",
      "location=",
      "location =",
      ".submit(",
      "postMessage",
    ]) {
      assert.equal(r.script.includes(banned), false, `${r.id} must not contain ${banned}`);
    }
    // Parses as a program. A syntax error would surface as a page that silently
    // never interacts, which reads identically to a CSP refusal.
    new Script(`(function () {${r.script}\n})`);
  }
});

test("no shipping recipe presses a control on somebody else's page", async () => {
  const { LENS_RECIPES } = await import("../../src/worker/lens-recipes.ts");
  // Removing a consent overlay from our own copy of the DOM sets no cookie and
  // records no choice. Clicking "Accept all" from a Cloudflare IP would be this
  // site manufacturing a consent record on a third party's page, which is the
  // machine behaviour /lens was built to criticise. The distinction is the whole
  // ethical argument for shipping `consent` at all, so it is pinned here rather
  // than left to a reviewer noticing a `.click()` in a minified string.
  for (const r of LENS_RECIPES) {
    assert.equal(r.script.includes(".click("), false, `${r.id} must not click`);
    assert.equal(/\.(submit|requestSubmit)\(/.test(r.script), false, `${r.id} must not submit`);
  }
});

test("the published scripts are the scripts that run", async () => {
  const { LENS_RECIPES } = await import("../../src/worker/lens-recipes.ts");
  const response = await handleLensBrowser(new Request("https://aadhar.sh/lens/browser?recipes=1"), {}, context());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(
    body.recipes.map((r) => r.id),
    LENS_RECIPES.map((r) => r.id),
  );
  for (const published of body.recipes) {
    // Disclosure that can drift from execution is worse than no disclosure.
    assert.equal(published.script, LENS_RECIPES.find((r) => r.id === published.id).script);
  }
});

test("the receipt is read, then removed before anything counts or caps it", async () => {
  const nonceOf = (captured) => captured.snapshot.addScriptTag[0].content.match(/"([0-9a-f]{16})"/)[1];
  const captured: Record<string, any> = {};
  const env = {
    BROWSER: {
      async quickAction(name, input) {
        captured[name] = input;
        const n = input.addScriptTag[0].content.match(/"([0-9a-f]{16})"/)[1];
        // 500 words of padding inside the receipt: if the strip happens after
        // documentTally, they land in the word count and the delta lies.
        return Response.json({
          result: {
            content: `<html><body><p>one two three</p><script type="application/lens-receipt" id="lens-recipe-receipt">{"v":1,"n":"${n}","acted":4,"scanned":9,"note":"acted","pad":"${"word ".repeat(500)}"}</script></body></html>`,
          },
          meta: { status: 200 },
        });
      },
    },
  };
  const body = await (await handleLensBrowser(browserReq("&do=expand"), env, context())).json();
  assert.equal(nonceOf(captured).length, 16);
  assert.equal(body.interaction.ran, true);
  assert.equal(body.interaction.acted, 4);
  assert.equal(body.interaction.scanned, 9);
  assert.equal(body.content.includes("lens-recipe-receipt"), false, "the receipt must not reach the reader's content");
  assert.equal(body.tally.words, 3, "the receipt must be gone before the words are counted");
});

test("a page cannot forge a result for a script it was not given", async () => {
  // Without the nonce a hostile page ships its own receipt claiming Lens tore
  // down a wall it never touched, and /lens repeats the lie in its own voice.
  const body = await (
    await handleLensBrowser(
      browserReq("&do=consent"),
      recipeEnv(
        '<html><body><script type="application/lens-receipt" id="lens-recipe-receipt">{"v":1,"n":"deadbeefdeadbeef","acted":9999,"scanned":9999,"note":"acted"}</script></body></html>',
      ),
      context(),
    )
  ).json();
  assert.equal(body.interaction.ran, false);
  assert.equal(body.interaction.note, "forged-receipt");
  assert.equal(body.interaction.acted, 0, "a forged count must never be repeated as ours");
  assert.equal(body.content.includes("lens-recipe-receipt"), false, "and it still must not reach the reader");
});

test("nonsense counts in a receipt are clamped rather than believed", async () => {
  const { lensRecipeReceipt } = await import("../../src/worker/lens-recipes.ts");
  const wrap = (json) => `<script type="application/lens-receipt" id="lens-recipe-receipt">${json}</script>`;
  const read = (json) => lensRecipeReceipt(wrap(json), "n").receipt;
  assert.equal(read('{"n":"n","acted":"12","scanned":0,"note":"acted"}').acted, 0, "a string is not a count");
  assert.equal(read('{"n":"n","acted":1e9,"scanned":0,"note":"acted"}').acted, 100000, "clamped, not believed");
  assert.equal(read('{"n":"n","acted":-5,"scanned":0,"note":"acted"}').acted, 0);
  assert.equal(read('{"n":"n","acted":1,"scanned":0,"note":"whatever"}').note, "unknown", "an unknown note is not echoed");
  assert.equal(lensRecipeReceipt("<p>no receipt here</p>", "n").receipt, null);
  assert.equal(lensRecipeReceipt(wrap("{not json"), "n").receipt, null);
});

test("a recipe that finds nothing, or never runs, is a 200 and says which", async () => {
  // Both are successful observations. Reporting either as an error would teach
  // the reader to distrust the instrument on the pages where it is most useful.
  const nothing = await handleLensBrowser(
    browserReq("&do=expand"),
    recipeEnv(
      '<html><body><script type="application/lens-receipt" id="lens-recipe-receipt">{"v":1,"n":"REPLACED","acted":0,"scanned":12,"note":"none-found"}</script></body></html>',
    ),
    context(),
  );
  assert.equal(nothing.status, 200);
  // The nonce will not match, so this lands as forged; what matters here is the
  // status and that a body came back. The no-receipt path is the real case:
  const blind = await handleLensBrowser(browserReq("&do=expand"), recipeEnv("<html><body><p>a b c</p></body></html>"), context());
  const body = await blind.json();
  assert.equal(blind.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.interaction.ran, false);
  assert.equal(body.interaction.note, "no-receipt", "a CSP-refused injection is reported, not hidden");
  assert.equal(body.tally.words, 3, "and the snapshot itself is still returned in full");
});

test("a recipe run caches beside the plain snapshot, never on top of it", async () => {
  // The plain key keeps its exact legacy shape. Changing its format would
  // invalidate the whole namespace in one deploy and buy a wave of fresh Quick
  // Actions against a budget of ten browser-minutes a day.
  const writes: any[] = [];
  const kv = {
    get: async () => null,
    put: async (k, _v, o) => {
      writes.push([k, o]);
    },
  };
  const env = { ...recipeEnv("<html></html>"), RN_KV: kv };
  await handleLensBrowser(browserReq(""), env, context());
  await handleLensBrowser(browserReq("&do=expand"), env, context());
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(writes.length, 2);
  assert.match(writes[0][0], /^lens:browser:[0-9a-f]{64}$/, "the plain key shape is load-bearing");
  assert.equal(writes[1][0], writes[0][0] + ":expand", "a recipe appends, so the plain entry survives as the before");
  // 6h, raised from 15 minutes on 2026-08-14. Deliberately a LITERAL rather than
  // an imported constant: the number is the budget control for the most
  // expensive call this site can make, so changing it should cost a visible edit
  // here. A test that imported the value would agree with any future change.
  // Keep it equal to /lens/shot and /lens/wire, which both sit at 21600.
  assert.equal(writes[0][1].expirationTtl, 21600);
  assert.equal(writes[1][1].expirationTtl, 21600);
});

test("the before comes from the cached plain snapshot, and is never manufactured", async () => {
  // Rendering a before on demand would be two Quick Actions for one click.
  let quickActions = 0;
  const plain = { ok: true, tally: { words: 210, headings: 2, links: 14, images: 3, jsonld: 0 } };
  const env = {
    BROWSER: {
      async quickAction() {
        quickActions++;
        return Response.json({ result: { content: "<html><body>a b c</body></html>" }, meta: {} });
      },
    },
    RN_KV: { get: async (k) => (k.endsWith(":expand") ? null : plain), put: async () => {} },
  };
  const body = await (await handleLensBrowser(browserReq("&do=expand"), env, context())).json();
  assert.equal(quickActions, 1, "one click must cost exactly one render");
  assert.deepEqual(body.interaction.before, plain.tally);
  assert.equal(body.interaction.beforeSource, "kv");

  // And with no plain entry, no delta is claimed rather than a zero invented.
  const bare = { ...env, RN_KV: { get: async () => null, put: async () => {} } };
  const alone = await (await handleLensBrowser(browserReq("&do=expand"), bare, context())).json();
  assert.equal(alone.interaction.before, null);
  assert.equal(alone.interaction.beforeSource, "none");
});

test("a recipe run bills against the same two buckets as a plain one", async () => {
  // A third bucket would let one visitor stack 3 plain + 3 recipe renders a
  // minute while the shared ceiling is 4, so the per-IP limit would stop
  // bounding anything. This repo has already made that mistake once.
  for (const spent of ["LENS_RL_BROWSER", "LENS_RL_BROWSER_ALL"]) {
    let called = false;
    const env = {
      BROWSER: {
        quickAction: async () => {
          called = true;
          return Response.json({});
        },
      },
      [spent]: { limit: async () => ({ success: false }) },
    };
    const response = await handleLensBrowser(browserReq("&do=expand"), env, context());
    assert.equal(response.status, 429, `${spent} must bound the recipe path too`);
    assert.equal(called, false, `${spent} must short-circuit before the render`);
  }
});

test("Lens comparison rejects invalid targets before any fetch", async () => {
  const response = await handleLensCompare(
    new Request("https://aadhar.sh/lens/compare.json?left=javascript%3Aalert(1)&right=https%3A%2F%2Fexample.com"),
    {},
    context(),
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
});
