// ── request bodies stop at their cap ────────────────────────────────────────
// Cloudflare accepts a request body of up to 100 MB on Workers Free, and the
// isolate has 128 MB. Until 2026-11-19 most POST handlers called
// request.json() or .formData() with no cap, and the ones with a cap checked it
// after request.text() had buffered everything. A chunked body sends no
// content-length, so a header check alone never sees it. These cases send 8 MB
// that way and count how much of it each handler pulls.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROOT, assert, context, test } from "../../../tools/tests/contract-shared.ts";
import { REQUEST_BODY_CAP, cappedRequestBody } from "../lib/http.ts";

const CHUNK = 16 * 1024;
const SENT = 8 * 1024 * 1024;

// A chunked POST of SENT bytes of "a" that records how many bytes were pulled.
function flood(url: string, type = "application/json") {
  const seen = { bytes: 0 };
  const chunk = new TextEncoder().encode("a".repeat(CHUNK));
  const body = new ReadableStream(
    {
      pull(controller) {
        if (seen.bytes >= SENT) return controller.close();
        seen.bytes += CHUNK;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(url, { method: "POST", body, headers: { "content-type": type }, duplex: "half" } as RequestInit);
  return { request, seen };
}

test("cappedRequestBody hands back the same body under the cap and null over it", async () => {
  const form = new Request("https://aadhar.sh/x", {
    method: "POST",
    body: "source=https%3A%2F%2Fa.test%2F&target=%C3%A9",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const capped = await cappedRequestBody(form);
  assert.deepEqual(Object.fromEntries(await capped!.formData()), { source: "https://a.test/", target: "é" });

  const exact = await cappedRequestBody(new Request("https://aadhar.sh/x", { method: "POST", body: "x".repeat(600) }), 600);
  assert.equal(await exact!.text(), "x".repeat(600));
  assert.equal(await cappedRequestBody(new Request("https://aadhar.sh/x", { method: "POST", body: "x".repeat(601) }), 600), null);

  // A declared length over the cap is refused before a byte is read.
  const declared = flood("https://aadhar.sh/x");
  declared.request.headers.set("content-length", String(SENT));
  assert.equal(await cappedRequestBody(declared.request), null);
  assert.equal(declared.seen.bytes, 0);

  const chunked = flood("https://aadhar.sh/x");
  assert.equal(await cappedRequestBody(chunked.request), null);
  assert.equal(chunked.seen.bytes, REQUEST_BODY_CAP + CHUNK);
});

test("the vitals beacon and the site MCP stop reading a chunked flood at the cap", async () => {
  const { handleVitals } = await import("../vitals.ts");
  const beacon = flood("https://aadhar.sh/vitals", "text/plain");
  const env = { VITALS: { writeDataPoint: () => assert.fail("a flood is not a beacon") }, CF_VERSION_METADATA: { id: "abcdef1234" } };
  assert.equal((await handleVitals(beacon.request, env as any)).status, 204);
  assert.ok(beacon.seen.bytes <= CHUNK, `vitals pulled ${beacon.seen.bytes} bytes`);

  const { handleSiteMcp } = await import("../mcp.ts");
  const rpc = flood("https://aadhar.sh/mcp");
  const res = await handleSiteMcp(rpc.request, {}, context());
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, -32600);
  assert.equal(rpc.seen.bytes, REQUEST_BODY_CAP + CHUNK);
});

// Every Worker a visitor can POST to reads its body through cappedRequestBody.
// counter/ is left out: its Durable Object is reached only through a binding.
const PUBLIC = ["src/worker", "cal/src", "serendipity", "lwe-ask/src"];
const RAW_READ = /\b(?:request|req)\.(?:text|json|formData|arrayBuffer|blob)\(\)/;

test("no public Worker reads a request body except through cappedRequestBody", () => {
  const root = fileURLToPath(ROOT);
  const raw: string[] = [];
  let scanned = 0;
  for (const dir of PUBLIC) {
    for (const file of readdirSync(root + dir, { recursive: true }) as string[]) {
      if (!file.endsWith(".ts") || file.endsWith(".d.ts") || /(^|\/)(tests|node_modules|\.cloudflare)\//.test(file)) continue;
      scanned++;
      readFileSync(`${root}${dir}/${file}`, "utf8")
        .split("\n")
        .forEach((line, i) => RAW_READ.test(line) && raw.push(`${dir}/${file}:${i + 1}`));
    }
  }
  assert.ok(scanned > 100, `scanned only ${scanned} files`);
  assert.deepEqual(raw, []);
  assert.ok(RAW_READ.test("    payload = await request.json();"));
});
