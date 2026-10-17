// ── /garage/av2's in-page AV2 decoder draws what native AVM draws ────────────
//
// The page decodes AV2 with AVM 1.0.0 compiled to WebAssembly and says it draws
// exactly the pixels the native build does. Two things could quietly make that
// false: a rebuilt .wasm that decodes differently (a compiler flag, a different
// AVM tree), or a worker that hands the decoder the wrong bytes (the container
// parse, the item extents). CI has no AVM, so tools/photos/av2-wasm/expect.ts
// records the native decode's sample hashes into expected.json on a machine
// that does, and this decodes the same shipped files through the shipped
// worker module and the shipped .wasm, and compares.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { decode } from "../src/client/garage/av2-decode.ts";

const DIR = new URL("../public/garage/av2/", import.meta.url);
const WORKER = readFileSync(new URL("../src/client/garage/av2-decode.ts", import.meta.url), "utf8");
const EXPECTED = JSON.parse(readFileSync(new URL("./photos/av2-wasm/expected.json", import.meta.url), "utf8"));
const wasmName = /const WASM_URL = "\/garage\/av2\/(av2dec\.[0-9a-f]{8}\.wasm)";/.exec(WORKER)?.[1] ?? "";

test("the worker names exactly one .wasm, which exists and names its own bytes", () => {
  assert.ok(wasmName, "av2-decode.js must set WASM_URL to /garage/av2/av2dec.<sha8>.wasm");
  const shipped = readdirSync(DIR).filter((f) => /^av2dec\..*\.wasm$/.test(f));
  assert.deepEqual(shipped, [wasmName], "build.sh removes older builds, so one .wasm ships and it is the one the worker loads");
  const bytes = readFileSync(new URL(wasmName, DIR));
  assert.equal(wasmName.split(".")[1], createHash("sha256").update(bytes).digest("hex").slice(0, 8), `${wasmName} does not name its own bytes`);
});

test("every shipped AV2 file decodes to the samples native AVM produced", async () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith("-av2.avif")).sort();
  assert.deepEqual(files, Object.keys(EXPECTED).sort(), "expected.json covers every AV2 file; re-run tools/photos/av2-wasm/expect.ts");
  const wasm = readFileSync(new URL(wasmName, DIR));
  for (const f of files) {
    const buf = readFileSync(new URL(f, DIR));
    const d = await decode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), { wasm, planes: true });
    const hash = createHash("sha256");
    for (const plane of d.planes ?? []) hash.update(plane);
    const want = EXPECTED[f];
    assert.deepEqual([d.width, d.height], [want.width, want.height], `${f}: size`);
    assert.equal(hash.digest("hex"), want.sha256, `${f}: the WebAssembly decode differs from native AVM's`);
    assert.equal(d.rgba.byteLength, d.width * d.height * 4, `${f}: RGBA is one 4-byte pixel per sample`);
  }
});

test("a file whose image item isn't AV2 is refused by name, before any decode", async () => {
  const av1 = readFileSync(new URL("demo-av1.avif", DIR));
  await assert.rejects(decode(av1.buffer.slice(av1.byteOffset, av1.byteOffset + av1.byteLength), { wasm: readFileSync(new URL(wasmName, DIR)) }), /av01, not av02/);
});
