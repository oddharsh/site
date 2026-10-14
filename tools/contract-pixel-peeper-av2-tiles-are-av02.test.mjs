// ── /pixel-peeper's AV2 tiles reach the decoder, and only the decoder ────────
//
// The format axis ships AV2 tiles beside AVIF ones, both as .avif files, since
// libavif writes AV2 inside the same container. The page tells them apart by
// label: an option whose label starts "AV2 " is fetched and decoded by the
// AVM WebAssembly worker, and every other option goes straight into an <img>.
// A mislabeled AV2 file would therefore land in an <img>, which draws it
// broken (gotcha 7), and a mislabeled AVIF would be refused by the worker. So
// the label and the file's image item have to agree, and this holds them to
// it through the same parser and decoder the page runs.
//
// It also holds the axis to its one rule, matched bytes: every tile in a
// format call, and every format in the scored pool the page tabulates, sits
// within 2% of that call's budget (gen-pixel-peeper.ts BUDGET_TOL).
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { decode } from "../src/client/garage/av2-decode.js";

const MANIFEST = JSON.parse(readFileSync(new URL("../public/pixel-peeper/manifest.json", import.meta.url), "utf8"));
const WORKER = readFileSync(new URL("../src/client/garage/av2-decode.js", import.meta.url), "utf8");
const WASM_NAME = /const WASM_URL = "\/garage\/av2\/(av2dec\.[0-9a-f]{8}\.wasm)";/.exec(WORKER)?.[1] ?? "";
const PAGE = readFileSync(new URL("../src/pages/pixel-peeper/index.html", import.meta.url), "utf8");
const BUDGET_TOL = 0.02;

const tileBytes = (src) => {
  const buf = readFileSync(new URL(`../public${src}`, import.meta.url));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};
const formatOptions = MANIFEST.trials.filter((t) => t.axis === "format").flatMap((t) => t.options);

test("the page routes AV2 by the label prefix this test checks", () => {
  assert.match(PAGE, /const isAv2=o=>o\.label\.startsWith\("AV2 "\);/, "the page's isAv2 must stay the label test this contract holds the files to");
});

test("an option is labeled AV2 exactly when its file's image item is av02, and every AV2 tile decodes to a full tile", async () => {
  const wasm = readFileSync(new URL(`../public/garage/av2/${WASM_NAME}`, import.meta.url));
  for (const o of formatOptions.filter((x) => x.src.endsWith(".avif"))) {
    const labeledAv2 = o.label.startsWith("AV2 ");
    const got = await decode(tileBytes(o.src), { wasm }).then((d) => d, (e) => e);
    if (labeledAv2) {
      assert.ok(!(got instanceof Error), `${o.src} is labeled "${o.label}" but the AV2 decoder refused it: ${got instanceof Error ? got.message : ""}`);
      assert.deepEqual([got.width, got.height], [MANIFEST.tile, MANIFEST.tile], `${o.src}: an AV2 tile decodes to ${MANIFEST.tile}px square`);
    } else {
      assert.ok(got instanceof Error && /not av02/.test(got.message), `${o.src} is labeled "${o.label}", so the page puts it in an <img>, but its image item is AV2`);
    }
  }
});

test("no AV2 label sits on a file that isn't .avif", () => {
  for (const o of formatOptions) if (o.label.startsWith("AV2 ")) assert.ok(o.src.endsWith(".avif"), `${o.src} is labeled AV2 but isn't an .avif container`);
});

test("every format call and every scored pool row holds its formats to one byte budget", () => {
  for (const t of MANIFEST.trials.filter((x) => x.axis === "format")) {
    for (const o of t.options) assert.ok(Math.abs(o.bytes - t.budget) / t.budget <= BUDGET_TOL, `${t.crop} [${t.tier}] ${o.label}: ${o.bytes}B is more than 2% off ${t.budget}B`);
  }
  for (const r of MANIFEST.format_pool ?? []) {
    for (const f of ["avif", "jxl", "av2"]) {
      if (r[f]) assert.ok(Math.abs(r[f].bytes - r.budget) / r.budget <= BUDGET_TOL, `pool ${r.crop} [${r.tier}] ${f}: ${r[f].bytes}B is more than 2% off ${r.budget}B`);
    }
  }
});
