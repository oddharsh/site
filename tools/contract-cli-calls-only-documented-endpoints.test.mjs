// ── the CLI calls only what /openapi.json documents (cli/aadhar.mjs) ─────────
// The CLI is a thin client over the public API, so its whole contract is that
// each command reaches a documented operation with documented parameters, and
// that an API error reaches the terminal as the error's own sentence. Driven
// here with a fake fetch: nothing leaves the machine.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { COMMANDS, buildUrl, run } from "../cli/aadhar.mjs";
import { openApiDocument } from "../src/worker/lib/openapi.ts";

const spec = JSON.parse(JSON.stringify(openApiDocument()));

/** A run with a canned response, capturing what was asked and what was printed. */
async function drive(argv, response) {
  const calls = [];
  let stdout = "", stderr = "";
  const code = await run(argv, {
    fetch: async (url, init) => { calls.push({ url: String(url), accept: init?.headers?.accept }); return response(); },
    out: (s) => { stdout += s; },
    err: (s) => { stderr += s; },
    env: {},
  });
  return { code, calls, stdout, stderr };
}

test("every command calls a GET the spec documents, with documented parameters", () => {
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    const op = spec.paths[cmd.path]?.get;
    assert.ok(op, `${name} calls ${cmd.path}, which /openapi.json does not document`);
    const documented = new Set((op.parameters || []).map((p) => p.name));
    for (const p of [...cmd.args, ...Object.values(cmd.flags), ...Object.keys(cmd.fixed || {})]) {
      assert.ok(documented.has(p), `${name} sends ?${p}, which ${cmd.path} does not document`);
    }
  }
});

test("arguments and flags become the query string", () => {
  assert.equal(String(buildUrl("search", ["homomorphic", "encryption"], { limit: "3" }).url),
    "https://aadhar.sh/search.json?q=homomorphic+encryption&limit=3", "a multi-word query is one parameter");
  assert.equal(String(buildUrl("ask", ["what", "is", "lens"], {}).url),
    "https://aadhar.sh/ask?query=what+is+lens&streaming=0", "ask always asks for one JSON body");
  assert.equal(String(buildUrl("compare", ["a.com", "b.com"], {}).url),
    "https://aadhar.sh/lens/compare.json?left=a.com&right=b.com");
  assert.equal(String(buildUrl("photos", [], { recipe: "DR400", limit: "5" }, "http://localhost:8787").url),
    "http://localhost:8787/photos/query.json?recipe=DR400&limit=5", "--base moves the origin");
  assert.match(buildUrl("lens", [], {}).error ?? "", /lens needs <url>/);
  assert.match(buildUrl("nope", [], {}).error ?? "", /unknown command/);
});

test("a success prints the result; --json prints the body", async () => {
  const body = { query: "fhe", total: 1, returned: 1, results: [{ url: "/lwe/fhe", title: "FHE", description: "Fully homomorphic encryption", kind: "page" }] };
  const human = await drive(["search", "fhe"], () => Response.json(body));
  assert.equal(human.code, 0);
  assert.equal(human.calls[0].accept, "application/json");
  assert.match(human.stdout, /^FHE\n {2}https:\/\/aadhar\.sh\/lwe\/fhe\n {2}Fully homomorphic encryption\n$/);
  const json = await drive(["search", "fhe", "--json"], () => Response.json(body));
  assert.deepEqual(JSON.parse(json.stdout), body);
});

test("an API error reaches the terminal as its own sentence, code and hint", async () => {
  const r = await drive(["lens", "localhost"], () => Response.json({ ok: false, error: "That host is on the no-fetch list.", code: "refused", hint: "Use a public host." }, { status: 400 }));
  assert.equal(r.code, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "400: That host is on the no-fetch list. (refused)\nUse a public host.\n");
  const html = await drive(["playing"], () => new Response("<html>1101</html>", { status: 500 }));
  assert.equal(html.code, 1);
  assert.match(html.stderr, /not JSON/);
});

test("read asks for Markdown at the page's own URL", async () => {
  const r = await drive(["read", "/lwe/fhe"], () => new Response("# FHE\n", { headers: { "content-type": "text/markdown" } }));
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, [{ url: "https://aadhar.sh/lwe/fhe", accept: "text/markdown" }]);
  assert.equal(r.stdout, "# FHE\n");
});

test("usage errors exit 2 without a request", async () => {
  for (const argv of [[], ["lens"], ["read"], ["nope"]]) {
    const r = await drive(argv, () => { throw new Error("no request expected"); });
    assert.equal(r.code, 2, argv.join(" ") || "(no args)");
    assert.equal(r.calls.length, 0);
  }
  assert.equal((await drive(["--help"], () => { throw new Error("no"); })).code, 0);
});

test("the package stays unpublishable until its owner says otherwise", () => {
  const pkg = JSON.parse(readFileSync("cli/package.json", "utf8"));
  assert.equal(pkg.private, true, "publishing is the owner's call (npm credentials, the package name)");
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], "no dependencies");
  assert.equal(pkg.bin.aadhar, "bin/aadhar.mjs");
});
