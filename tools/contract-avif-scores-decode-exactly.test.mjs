// ── an AVIF or AV2 file is scored from an exact decode, never `avifdec -d 8` ──
//
// gotcha 76. `avifdec -d 8` on a 10-bit file truncates the YUV to 8 bits before
// converting, so the PNG a probe scores is up to 3 levels darker than the file
// and 0.4 to 0.5 low on average. ssimulacra2 read that as 0 to 1.8 points of
// damage on the /garage/av2 samples, for AV1 and AV2 alike, while djxl's 8-bit
// output rounds, so every format comparison leaned toward JPEG XL. Scoring
// decodes at 16 bits and rounds once (avifToPng8 in gen-pixel-peeper.ts).
//
// CI has no libavif, so this reads the tools: any array literal that names an
// avifdec and asks for `-d 8` fails, however bun fmt wraps it. avifenc's own
// `-d 8` (an encode bit depth) is not a decode and stays legal.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { ROOT, assert, test } from "./contract-shared.ts";

const TOOLS = new URL("./", import.meta.url).pathname;

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.(ts|mjs|js)$/.test(name) && !name.startsWith("contract-avif-scores-decode-exactly.")) yield p;
  }
}

const EIGHT = /["'`](?:-d|--depth)["'`]\s*,\s*["'`]8["'`]/;
/** Argument lists that run an avifdec (the binary, or a variable naming it)
 *  with `-d 8`: a list that names it, `[AVIFDEC, "-d", "8", ...]`, or a list
 *  passed right after it, `spawnSync(AVIFDEC_AVM, ["-d", "8", ...])`. */
export function truncatingDecodes(src) {
  const hits = [];
  const add = (list) => hits.push(list.replace(/\s+/g, " ").slice(0, 120));
  for (const m of src.matchAll(/\[[^[\]]*\]/g)) if (/avifdec/i.test(m[0]) && EIGHT.test(m[0])) add(m[0]);
  for (const m of src.matchAll(/\w*avifdec\w*["'`]?\s*,\s*(\[[^[\]]*\])/gi)) if (!/avifdec/i.test(m[1]) && EIGHT.test(m[1])) add(m[1]);
  return hits;
}

test("the scan finds a truncating decode when one is there (control)", () => {
  assert.equal(truncatingDecodes('run([fmt === "av2" ? AVIFDEC_AV2 : AVIFDEC as string, "-d", "8", file, png]);').length, 1);
  assert.equal(truncatingDecodes('spawnSync(AVIFDEC_AVM, [\n  "-d",\n  "8",\n  file,\n  png,\n]);').length, 1, "the list passed right after the name counts too (codec-knob-probe.ts's form)");
  assert.equal(truncatingDecodes('spawnSync(AVIFDEC_AVM, ["-d", "16", file, png]);').length, 0, "a 16-bit decode is the fix, not a hit");
  assert.equal(truncatingDecodes('run([AVIFDEC_AVM,\n  "-d",\n  "8", file, png])').length, 1, "a wrapped list still counts");
  assert.equal(truncatingDecodes('run([AVIFENC, "-l", "-d", "8", png, avif])').length, 0, "an encode at 8 bits is not a decode");
});

test("no tool decodes an AVIF or AV2 file for scoring with -d 8", () => {
  const found = [];
  let scanned = 0;
  for (const file of sources(TOOLS)) {
    scanned += 1;
    for (const hit of truncatingDecodes(readFileSync(file, "utf8"))) found.push(`${path.relative(new URL(".", ROOT).pathname, file)}: ${hit}`);
  }
  assert.ok(scanned > 50, `only ${scanned} tool sources scanned; the walk has stopped finding them`);
  assert.deepEqual(found, [], "decode at 16 bits and round once (avifToPng8), never -d 8 (gotcha 76)");
});

test("the format axis decodes AVIF and AV2 through avifToPng8, at 16 bits", () => {
  const gen = readFileSync(new URL("photos/gen-pixel-peeper.ts", import.meta.url), "utf8");
  const body = (name) => { const i = gen.indexOf(`export function ${name}(`); assert.ok(i >= 0, `${name} is gone`); return gen.slice(i, gen.indexOf("\n}\n", i)); };
  assert.match(body("avifToPng8"), /["']-d["']\s*,\s*["']16["']/, "avifToPng8 must decode at 16 bits");
  assert.match(body("avifToPng8"), /zenc\(\s*\[\s*["']frame["']/, "avifToPng8 must round the 16-bit decode with zenc frame");
  assert.match(body("decodeFmt"), /fmt !== "jxl"\) return avifToPng8\(/, "decodeFmt must hand every AVIF-family file to avifToPng8");
});
