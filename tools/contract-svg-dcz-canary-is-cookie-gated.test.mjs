// ── /a/: the svg dictionary canary is cookie-gated ─────────────
// The sprite sat off the shared-dictionary path from #119 on, for a diagnosis that
// never reproduced (see DICTIONARY_TYPES in src/worker/lib/assets.ts). The canary
// puts ONE browser back on it. The canary is only worth running while the default
// stays exactly what it was, so the first thing these tests pin is that nobody
// without the cookie sees a single header change.
import { createHash } from "node:crypto";
import { assert, test } from "./contract-shared.ts";

const SPRITE = "/a/icons.0123abcd.svg";
const DICT = Buffer.from("<svg>the sprite this browser already holds</svg>");
const TAG = createHash("sha256").update(DICT).digest().subarray(0, 8).toString("hex");
const AVAILABLE = `:${createHash("sha256").update(DICT).digest("base64")}:`;

// A fake ASSETS binding holding the sprite, its q11 twin, and one delta against DICT.
// It records every path asked for, so a test can say which file answered.
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

test("without the cookie the sprite is served exactly as before: br twin, no offer, no delta", async () => {
  // Holding a dictionary is not enough. A browser that somehow sends
  // Available-Dictionary for the sprite still gets the plain twin, which is the
  // #119 default this canary must not move.
  const { res, asked, body } = await serve(SPRITE, { "available-dictionary": AVAILABLE });
  assert.equal(res.headers.get("content-encoding"), "br");
  assert.equal(body, "brotli sprite");
  assert.equal(res.headers.get("use-as-dictionary"), null);
  assert.doesNotMatch(res.headers.get("vary") || "", /cookie/i);
  assert.ok(!asked.some((p) => p.startsWith("/ad/")), `no delta lookup without the cookie, asked ${asked}`);
});

test("with the cookie the sprite offers itself as an IMAGE dictionary and says it varies by cookie", async () => {
  const { res } = await serve(SPRITE, { cookie: "theme=dark; svg-dcz=1" });
  assert.equal(res.headers.get("content-encoding"), "br");
  assert.equal(res.headers.get("use-as-dictionary"), 'match="/a/icons.*", match-dest=("image")');
  assert.match(res.headers.get("vary"), /\bcookie\b/i);
});

test("with the cookie and a held dictionary the sprite arrives as the dcz delta", async () => {
  const { res, body } = await serve(SPRITE, { cookie: "svg-dcz=1", "available-dictionary": AVAILABLE });
  assert.equal(res.headers.get("content-encoding"), "dcz");
  assert.equal(body, "the delta");
  assert.equal(res.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.match(res.headers.get("vary"), /available-dictionary/);
  assert.match(res.headers.get("vary"), /\bcookie\b/i);
});

test("only the exact cookie opts in", async () => {
  for (const cookie of ["svg-dcz=0", "svg-dcz=10", "xsvg-dcz=1", "svg-dcz", "a=svg-dcz=1"]) {
    const { res } = await serve(SPRITE, { cookie, "available-dictionary": AVAILABLE });
    assert.equal(res.headers.get("content-encoding"), "br", `${cookie} must not reach the delta`);
    assert.equal(res.headers.get("use-as-dictionary"), null, `${cookie} must not reach the offer`);
  }
});

test("js and css are untouched by the canary: the offer ships without the cookie and never varies on it", async () => {
  const { res } = await serve("/a/nav.0123abcd.js");
  assert.equal(res.headers.get("use-as-dictionary"), 'match="/a/nav.*", match-dest=("script")');
  assert.doesNotMatch(res.headers.get("vary") || "", /cookie/i);
});
