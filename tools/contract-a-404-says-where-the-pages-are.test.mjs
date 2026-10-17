// ── a 404 gets one more look (src/worker/lib/not-found.ts) ───────────────────
// Each deterministic rule is pinned with the Location it sends, and so is what
// must NOT be answered: a capability this site does not serve stays 404, a
// probe gets no suggestions, and a handler's own 404 body is left alone. The
// route oracle covers the same rules end to end through workerd.
import { existsSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { OPENAPI_PATH, openApiDocument } from "../src/worker/lib/openapi.ts";
import { EXACT_PATHS } from "../src/worker/routes.ts";
import { HASHED_ASSETS } from "../src/worker/lib/shell-assets.ts";
import { _resetPhotoCaches } from "../src/worker/photos.ts";
import {
  DISCOVERY_ALIASES, MISS_LINKS, _resetSitemap, callerClass, canonicalPage, countMiss, missBucket, missPage, nearestPages, recoverNotFound,
} from "../src/worker/lib/not-found.ts";

const SITEMAP = `<?xml version="1.0"?><urlset>
  ${["/", "/garage", "/garage/resample", "/garage/masonry", "/garage/encoding", "/lwe", "/lwe/fhe", "/writing", "/writing/colophon"]
    .map((p) => `<url><loc>https://aadhar.sh${p}</loc></url>`).join("")}</urlset>`;

/**
 * An ASSETS binding serving a sitemap, a hashes.json and whatever else is listed.
 * @param {Record<string, any>} [extra]
 * @param {Record<string, Response>} [files]
 * @returns {any}
 */
function env(extra = {}, files = {}) {
  _resetSitemap();
  _resetPhotoCaches();
  const served = {
    "/sitemap.xml": new Response(SITEMAP),
    "/images/hashes.json": Response.json({ XT500010: { a: "aaaaaaaa", j: "jjjjjjjj", s: "ssssssss", x: "xxxxxxxx" } }),
    ...files,
  };
  return {
    ASSETS: {
      async fetch(input) {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        const r = served[path];
        return r ? r.clone() : new Response("", { status: 404 });
      },
    },
    ...extra,
  };
}

const empty404 = () => new Response("", { status: 404 });
/** @type {(path: string, init?: RequestInit) => Request} */
const get = (path, init) => new Request(`https://aadhar.sh${path}`, init);
/** @type {(path: string, e?: any, init?: RequestInit, response?: Response) => ReturnType<typeof recoverNotFound>} */
const recover = (path, e = env(), init, response = empty404()) => recoverNotFound(get(path, init), e, response);

test("a superseded /a/ hash answers with the current one", async () => {
  Object.assign(HASHED_ASSETS, { "icons.svg": "/a/icons.11111111.svg" });
  try {
    const r = await recover("/a/icons.cd1fc133.svg");
    assert.equal(r.response.status, 301);
    assert.equal(r.response.headers.get("location"), "https://aadhar.sh/a/icons.11111111.svg");
    assert.equal(r.response.headers.get("cache-control"), "public, max-age=86400", "a day, since the target moves next release");
    assert.equal(r.outcome, "redirect:stale-asset");
    assert.equal((await recover("/a/icons.11111111.svg")).response.status, 404, "the current hash never redirects to itself");
    assert.equal((await recover("/a/nothing.22222222.js")).response.status, 404, "a name the build never made is a plain miss");
  } finally { delete HASHED_ASSETS["icons.svg"]; }
});

test("a superseded /i/ photo tile answers with the same tier's current hash", async () => {
  const cases = {
    "/i/XT500010.0000aaaa.avif": "/i/XT500010.aaaaaaaa.avif",
    "/i/XT500010.0000aaaa.jpg": "/i/XT500010.jjjjjjjj.jpg",
    "/i/XT500010-400.0000aaaa.avif": "/i/XT500010-400.ssssssss.avif",
    "/i/XT500010-200.0000aaaa.avif": "/i/XT500010-200.xxxxxxxx.avif",
  };
  for (const [from, to] of Object.entries(cases)) {
    const r = await recover(from);
    assert.equal(r.response.headers.get("location"), `https://aadhar.sh${to}`, from);
  }
  assert.equal((await recover("/i/NOPE.0000aaaa.avif")).response.status, 404, "an unknown stem stays a miss");
});

test("share cards, terminal tools and MCP card probes go where the thing actually is", async () => {
  const withCard = env({}, { "/og/garage-pqc.jpg": new Response("jpg") });
  assert.equal((await recover("/og/garage-pqc.png", withCard)).response.headers.get("location"), "https://aadhar.sh/og/garage-pqc.jpg");
  assert.equal((await recover("/og/nope.png", withCard)).response.status, 404, "only a card that exists as .jpg is redirected");

  assert.equal((await recover("/finger.md")).response.headers.get("location"), "https://aadhar.sh/finger.txt");
  assert.equal((await recover("/writing.md")).response.status, 404, "only a registered text-frame tool maps .md to .txt");

  for (const [from, to] of Object.entries(DISCOVERY_ALIASES)) {
    assert.equal((await recover(from)).response.headers.get("location"), `https://aadhar.sh${to}`, from);
  }
  for (const to of new Set(Object.values(DISCOVERY_ALIASES))) {
    // /openapi.json is written by build.ts from lib/public-api.ts, /developers is
    // a Worker route; every other target is a file in public/
    assert.ok(to === OPENAPI_PATH || EXACT_PATHS.includes(to) || existsSync(`public${to}`), `an alias may only point at something this site serves: ${to}`);
  }
  for (const honest of ["/openapi.yaml", "/.well-known/ai-plugin.json", "/.well-known/x402", "/.well-known/agents.json"]) {
    assert.equal((await recover(honest)).response.status, 404, `${honest} names a capability this site does not serve`);
  }
});

test("the sitemap is the authority for the easy fixes, and the query survives", async () => {
  const pages = ["/garage", "/garage/resample", "/writing/colophon"];
  assert.equal(canonicalPage("/Garage/Resample/", pages), "/garage/resample");
  assert.equal(canonicalPage("/writing/colophon.html", pages), "/writing/colophon");
  assert.equal(canonicalPage("/garage/index.html", pages), "/garage");
  assert.equal(canonicalPage("/garage/resample", pages), null, "a page already spelled right is not a fix");
  const r = await recover("/Garage/Resample?ref=hn");
  assert.equal(r.response.headers.get("location"), "https://aadhar.sh/garage/resample?ref=hn");
  assert.equal(r.outcome, "redirect:canonical-page");
});

test("an empty 404 names the closest pages in its own section, and the sitemap", async () => {
  const r = await recover("/garage/resampe");
  assert.equal(r.response.status, 404);
  assert.equal(r.outcome, "404:suggested");
  assert.match(r.response.headers.get("content-type") || "", /^text\/plain/);
  assert.equal(r.response.headers.get("link"), MISS_LINKS);
  const body = await r.response.text();
  assert.match(body, /^404 Not Found: \/garage\/resampe/);
  assert.match(body, /Closest pages in \/garage:\n {2}\/garage\/resample\n/, "the typo's sibling first");
  assert.ok(!body.includes("/lwe/fhe"), "suggestions stay inside the section");
  assert.match(body, /Section index: \/garage/);
  assert.match(body, /\/sitemap\.xml/);

  assert.deepEqual(nearestPages("/zzzzzz-qqqq", ["/garage", "/garage/resample"]), { section: null, pages: [] },
    "an unrelated guess is not offered a near miss");

  const clamped = new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  assert.match(await (await recover("/garage/resampe", env(), undefined, clamped)).response.text(), /Closest pages in \/garage/,
    "the clamp's generic \"not found\" is rewritten like an empty body");

  const head = await recover("/garage/resampe", env(), { method: "HEAD" });
  assert.equal(head.response.status, 404);
  assert.equal(await head.response.text(), "", "HEAD carries no body");
});

test("an agent that asks for Markdown gets the same 404 as Markdown", async () => {
  const md = await recover("/garage/resampe", env(), { headers: { accept: "text/markdown, text/html, */*" } });
  assert.equal(md.response.status, 404, "the status never changes with the body");
  assert.equal(md.response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(md.response.headers.get("vary"), "accept");
  assert.equal(md.response.headers.get("link"), MISS_LINKS);
  const body = await md.response.text();
  assert.match(body, /^# 404 Not Found\n\n`\/garage\/resampe` is not a page on aadhar\.sh\./);
  assert.match(body, /## Closest pages in \/garage\n\n- \[\/garage\/resample\]\(https:\/\/aadhar\.sh\/garage\/resample\)\n/);
  assert.match(body, /Section index: \[\/garage\]\(https:\/\/aadhar\.sh\/garage\)/);
  assert.match(body, /- \[\/llms\.txt\]\(https:\/\/aadhar\.sh\/llms\.txt\)/);
  assert.match(body, /- \[\/sitemap\.xml\]\(https:\/\/aadhar\.sh\/sitemap\.xml\)/);

  const bare = await (await recover("/zzzzzz-qqqq", env(), { headers: { accept: "text/markdown" } })).response.text();
  assert.ok(!bare.includes("Closest pages"), "no near miss, no section for it");
  assert.match(bare, /## Where the pages are/);

  const probe = await recover("/.env", env(), { headers: { accept: "text/markdown" } });
  assert.ok(!(await probe.response.text()).includes("Closest pages"), "a probe is still offered no pages");

  for (const accept of ["*/*", "text/markdown;q=0"]) {
    const r = await recover("/garage/resampe", env(), { headers: { accept } });
    assert.match(r.response.headers.get("content-type") || "", /^text\/plain/, `${accept} keeps plain text`);
  }
  for (const accept of ["text/html,application/xhtml+xml,*/*;q=0.8", "text/html, text/markdown;q=0.5"]) {
    const r = await recover("/garage/resampe", env(), { headers: { accept } });
    assert.match(r.response.headers.get("content-type") || "", /^text\/html/, `${accept} gets the page`);
  }

  const head = await recover("/garage/resampe", env(), { method: "HEAD", headers: { accept: "text/markdown" } });
  assert.equal(head.response.headers.get("content-type"), "text/markdown; charset=utf-8", "HEAD says what GET would send");
  assert.equal(await head.response.text(), "");

  const json = new Response('{"error":"not found"}', { status: 404, headers: { "content-type": "application/json" } });
  const kept = await recover("/serendipity/event/nope", env(), { headers: { accept: "text/markdown" } }, json);
  assert.equal(kept.response.headers.get("content-type"), "application/json", "a handler's own 404 is never rewritten");
});

test("a browser's 404 is a Luna window whose suggestions are links", async () => {
  const accept = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
  const r = await recover("/garage/resampe", env(), { headers: { accept } });
  assert.equal(r.response.status, 404, "the status never changes with the body");
  assert.equal(r.outcome, "404:suggested");
  assert.equal(r.response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(r.response.headers.get("cache-control"), "no-store");
  assert.equal(r.response.headers.get("vary"), "accept");
  assert.ok((r.response.headers.get("link") || "").endsWith(MISS_LINKS), "the miss links ride after the shell preloads");
  const page = await r.response.text();
  assert.match(page, /^<!DOCTYPE html>/);
  assert.match(page, /<meta name="robots" content="noindex">/);
  assert.ok(!page.includes('rel="canonical"'), "a missing URL names nothing to canonicalize");
  assert.match(page, /<li><a href="\/garage\/resample">\/garage\/resample<\/a><\/li>/, "the typo's sibling is a link");
  assert.match(page, /<a href="\/garage">\/garage<\/a>/, "and so is its section");
  assert.match(page, /<a href="\/">The homepage<\/a>/);

  // The path is the visitor's own text, so it is escaped where it is printed.
  // Called directly: a request URL would percent-encode the brackets first and
  // make this pass without escaping anything.
  const hostile = await missPage("/<script>x</script>", { section: null, pages: [] }).text();
  assert.ok(!hostile.includes("<script>x</script>"), "the missing path is escaped");
  assert.ok(hostile.includes("&lt;script&gt;x&lt;/script&gt;"));

  const head = await recover("/garage/resampe", env(), { method: "HEAD", headers: { accept } });
  assert.equal(head.response.headers.get("content-type"), "text/html; charset=utf-8", "HEAD says what GET would send");
  assert.equal(await head.response.text(), "");
});

test("a probe gets the pointers and nothing else; a handler's own 404 keeps its body", async () => {
  const probe = await recover("/.env");
  assert.equal(probe.bucket, "probe");
  assert.equal(probe.outcome, "404");
  assert.ok(!(await probe.response.text()).includes("Closest pages"), "a vulnerability probe is offered no pages");

  const json = new Response('{"error":"not found"}', { status: 404, headers: { "content-type": "application/json" } });
  const kept = await recover("/serendipity/event/nope", env(), undefined, json);
  assert.equal(await kept.response.text(), '{"error":"not found"}');
  assert.equal(kept.response.headers.get("content-type"), "application/json");
  assert.match(kept.response.headers.get("link") || "", /rel="sitemap"/, "but it still points at the sitemap");
});

test("the counter records caller class, bucket and outcome for every miss", async () => {
  const points = [];
  const e = env({ MISS_LEDGER: { writeDataPoint: (p) => points.push(p) } });
  const req = get("/garage/resampe", { headers: { "user-agent": "Mozilla/5.0 (compatible; ClaudeBot/1.0)" } });
  const miss = await recoverNotFound(req, e, empty404());
  countMiss(e, req, "/garage/resampe", miss);
  assert.deepEqual(points, [{ blobs: ["ai-crawler", "page", "404:suggested", "/garage/resampe"], doubles: [1], indexes: ["page"] }]);
  countMiss({}, req, "/x", miss);   // no binding: nothing to write, and nothing thrown

  assert.equal(callerClass("curl/8.7.1"), "http-tool");
  assert.equal(callerClass("tphotobot/0.1 (+https://crawler.estidraft.com/bot)"), "other-bot");
  assert.equal(callerClass(""), "empty");
  assert.equal(missBucket("/a/icons.cd1fc133.svg"), "stale-asset");
  assert.equal(missBucket("/.well-known/ai-plugin.json"), "discovery");
  assert.equal(missBucket("/wp-admin/setup.php"), "probe");
});

test("a client that asks for JSON gets the Error object /openapi.json declares", async () => {
  const r = await recover("/garage/resampe", env(), { headers: { accept: "application/json" } });
  assert.equal(r.response.status, 404);
  assert.equal(r.response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(r.response.headers.get("vary"), "accept");
  const error = await r.response.json();
  assert.equal(error.ok, false);
  assert.equal(error.code, "not_found");
  assert.equal(error.status, 404);
  assert.match(error.error, /\/garage\/resampe/);
  assert.match(error.hint, /Did you mean \/garage\/resample\?/);
  assert.deepEqual(error.suggestions, ["https://aadhar.sh/garage/resample"]);
  assert.equal(error.docs, "https://aadhar.sh/developers");

  const bare = await (await recover("/zzzzzz-qqqq", env(), { headers: { accept: "application/json" } })).response.json();
  assert.equal(bare.suggestions, undefined, "no near miss, no suggestions key");
  assert.match(bare.hint, /\/openapi\.json/);

  const spec = JSON.parse(JSON.stringify(openApiDocument()));
  const declared = spec.components.schemas.Error;
  for (const key of Object.keys(bare)) assert.ok(key in declared.properties, `${key} is declared on Error`);
  for (const key of declared.required) assert.ok(key in bare, `${key} is required by Error`);

  const md = await recover("/garage/resampe", env(), { headers: { accept: "text/markdown, application/json" } });
  assert.match(md.response.headers.get("content-type") || "", /^text\/markdown/, "Markdown is checked first");
  for (const accept of ["*/*", "application/json;q=0"]) {
    const plain = await recover("/garage/resampe", env(), { headers: { accept } });
    assert.match(plain.response.headers.get("content-type") || "", /^text\/plain/, `${accept} keeps plain text`);
  }
  const browser = await recover("/garage/resampe", env(), { headers: { accept: "text/html,application/xhtml+xml,application/json;q=0.9" } });
  assert.match(browser.response.headers.get("content-type") || "", /^text\/html/, "HTML named first wins over JSON");
});

test("an API-shaped miss answers JSON unless the caller names HTML", async () => {
  // Whatever asked for /v1/users or /data.json will parse the body, and curl,
  // fetch() and most HTTP libraries send */* or nothing at all.
  for (const path of ["/v1/users", "/api/things", "/api", "/no-such-endpoint.json", "/V2/x"]) {
    for (const init of [undefined, { headers: { accept: "*/*" } }]) {
      const r = await recover(path, env(), init);
      assert.equal(r.response.status, 404);
      assert.equal(r.response.headers.get("content-type"), "application/json; charset=utf-8", `${path} with ${init ? "*/*" : "no Accept"}`);
      assert.equal((await r.response.json()).code, "not_found");
    }
  }
  // A browser names text/html and gets the page, and a page-shaped path stays
  // plain text: the controls that show the test can see the other branches.
  const browser = await recover("/v1/users", env(), { headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
  assert.match(browser.response.headers.get("content-type") || "", /^text\/html/, "a browser gets the HTML page");
  const page = await recover("/garage/resampe", env(), { headers: { accept: "*/*" } });
  assert.match(page.response.headers.get("content-type") || "", /^text\/plain/, "a page-shaped miss stays text");
  for (const notApi of ["/version1", "/apiary", "/v1x/y", "/notes.jsonl"]) {
    const r = await recover(notApi, env());
    assert.match(r.response.headers.get("content-type") || "", /^text\/plain/, `${notApi} is not API-shaped`);
  }
});
