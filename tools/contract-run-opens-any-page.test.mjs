// ── /run opens any page the site registers ──────────────────────────────────
// /run is the no-script Run dialog: a form, and a 302 to whatever the typed name
// resolves to. It knew 22 hand-listed names, so a real page like garage/av2 got
// "Windows cannot find 'garage/av2'". Now a name resolves against the site
// manifest too, by path or by a last segment only one page has, and a miss keeps
// XP's error with a filled-in site search inside it (XP's own error points to
// Search). From the build-off's simple entry (buildoff/simple, worker.js run()).
import { handleRun } from "../src/worker/run.ts";
import { AGENT_SURFACES } from "../src/worker/lib/site-manifest.ts";
import { assert, test } from "./contract-shared.ts";

const env = { ASSETS: { fetch: async (req) => new Response(new URL(req.url).pathname === "/writing/posts.json" ? "[]" : "not found", { status: new URL(req.url).pathname === "/writing/posts.json" ? 200 : 404 }) } };
const ctx = { waitUntil() {} };
const run = (cmd) => handleRun(new Request(`https://aadhar.sh/run?cmd=${encodeURIComponent(cmd)}`), env, ctx);
const opens = async (cmd) => { const r = await run(cmd); return r.status === 302 ? r.headers.get("location") : null; };

test("a registered page opens by its path or by a last segment only it has", async () => {
  assert.equal(await opens("garage/av2"), "https://aadhar.sh/garage/av2");
  assert.equal(await opens("/lwe/fhe/"), "https://aadhar.sh/lwe/fhe");
  assert.equal(await opens("AV2"), "https://aadhar.sh/garage/av2");
  assert.equal(await opens("census"), "https://aadhar.sh/lens/census");
  // the hand-listed names still win, and still take a unique prefix
  assert.equal(await opens("garage"), "https://aadhar.sh/garage");
  assert.equal(await opens("gar"), "https://aadhar.sh/garage");
});

test("a name two pages share opens neither", async () => {
  assert.equal(await opens("encoding"), null, "/lwe/encoding and /garage/encoding both end in it");
});

test("a typed name never lands on a content-addressed file", async () => {
  for (const cmd of ["a/luna.css", "/i/L1000069_3", "images/hashes.json", "../etc/passwd"]) {
    const location = await opens(cmd);
    assert.ok(location === null || !/\/(?:a|i)\//.test(new URL(location).pathname), `${cmd} opened ${location}`);
  }
});

test("a miss keeps the Run error and offers a filled-in search", async () => {
  const res = await run("zzz nothing <b>");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Windows cannot find 'zzz nothing &lt;b&gt;'/);
  assert.match(html, /href="\/search\?q=zzz%20nothing%20%3Cb%3E"/, "the search link is filled in and encoded");
  assert.ok(AGENT_SURFACES.some((s) => s.path === "/search"), "the link points at a page the site registers");
});
