// ── /a/: the icon sprite rides the shared-dictionary path like js and css ────
// The sprite sat off this path from #119 until 2026-09-26, for a diagnosis that never
// reproduced; a cookie canary (#940) then proved the delta in production, and the
// cookie came out. See DICTIONARY_TYPES in src/worker/lib/assets.ts.
import { createHash } from "node:crypto";
import { assert, test } from "./contract-shared.ts";

const SPRITE = "/a/icons.0123abcd.svg";
const DICT = Buffer.from("<svg>the sprite this browser already holds</svg>");
const TAG = createHash("sha256").update(DICT).digest().subarray(0, 8).toString("hex");
const AVAILABLE = `:${createHash("sha256").update(DICT).digest("base64")}:`;

function fakeAssets() {
  const asked = [];
  const files = new Map([
    [`${SPRITE}`, "plain sprite"],
    [`${SPRITE}.br`, "brotli sprite"],
    [`/ad/icons.0123abcd.${TAG}.dcz`, "the delta"],
    ["/a/nav.0123abcd.js", "plain nav"],
    ["/a/nav.0123abcd.js.br", "brotli nav"],
  ]);
  return {
    asked,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      asked.push(path);
      return files.has(path)
        ? new Response(files.get(path), { status: 200, headers: { "cache-control": "public, max-age=31536000, immutable" } })
        : new Response("missing", { status: 404 });
    },
  };
}

async function serve(path, headers = {}) {
  const { servePrecompressedShell } = await import("../src/worker/lib/assets.ts");
  const ASSETS = fakeAssets();
  const res = await servePrecompressedShell(new Request(`https://aadhar.sh${path}`, { headers }), { ASSETS });
  return { res, asked: ASSETS.asked, body: await res.text() };
}

test("the sprite offers itself as an IMAGE dictionary with no cookie at all", async () => {
  const { res, body } = await serve(SPRITE);
  assert.equal(res.headers.get("content-encoding"), "br");
  assert.equal(body, "brotli sprite");
  assert.equal(res.headers.get("use-as-dictionary"), 'match="/a/icons.*", match-dest=("image")');
  assert.doesNotMatch(res.headers.get("vary") || "", /cookie/i);
});

test("a browser holding the previous sprite gets the dcz delta, with no cookie", async () => {
  const { res, body } = await serve(SPRITE, { "available-dictionary": AVAILABLE });
  assert.equal(res.headers.get("content-encoding"), "dcz");
  assert.equal(body, "the delta");
  assert.equal(res.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.match(res.headers.get("vary"), /available-dictionary/);
  assert.doesNotMatch(res.headers.get("vary"), /cookie/i);
  assert.equal(res.headers.get("use-as-dictionary"), 'match="/a/icons.*", match-dest=("image")');
});

test("the old canary cookie changes nothing now", async () => {
  for (const headers of [{}, { "available-dictionary": AVAILABLE }]) {
    const plain = await serve(SPRITE, headers);
    const opted = await serve(SPRITE, { ...headers, cookie: "svg-dcz=1" });
    assert.equal(opted.body, plain.body);
    for (const h of ["content-encoding", "use-as-dictionary", "vary"]) {
      assert.equal(opted.res.headers.get(h), plain.res.headers.get(h), `${h} differs with the old cookie`);
    }
  }
});

test("an unknown dictionary falls through to the br twin rather than failing", async () => {
  const other = `:${createHash("sha256").update("some other sprite").digest("base64")}:`;
  const { res, body } = await serve(SPRITE, { "available-dictionary": other });
  assert.equal(res.headers.get("content-encoding"), "br");
  assert.equal(body, "brotli sprite");
});

test("js keeps its own script-scoped offer beside the sprite's", async () => {
  const { res } = await serve("/a/nav.0123abcd.js");
  assert.equal(res.headers.get("use-as-dictionary"), 'match="/a/nav.*", match-dest=("script")');
  assert.doesNotMatch(res.headers.get("vary") || "", /cookie/i);
});
