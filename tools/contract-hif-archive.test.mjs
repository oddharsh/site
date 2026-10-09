// ── a HIF photo's archive: JPEG XL from the HIF, against a JPEG bar ──
// hif-archive.ts bisects cjxl's distance for the fewest bytes that still beat
// the old archive JPEG on BOTH metrics, and the downloader tells its output
// apart from a lossless transcode by the jbrd box. These pin the pieces whose
// failure would still look like a working pipeline: a search that settles on
// a losing distance, a metric rule that accepts one win, and a kind check that
// calls a broken download "direct".
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { assert, test } from "./contract-shared.ts";
import { beats, codestreamBytes, RANGE, searchDistance, stripPng } from "./photos/hif-archive.ts";
import { jxlKind } from "./photos/pipeline-json.ts";

// A metric that wins at every distance up to `edge` and loses above it, the
// monotone shape the 2026-10-08 sweep measured on all 119 photos.
const edgeAt = (edge) => {
  const asked = [];
  return { asked, wins: async (d) => (asked.push(d), d <= edge) };
};

test("the search settles on the largest winning distance, within the tolerance", async () => {
  for (const edge of [0.12, 0.2, 0.31, 0.47, 0.59]) {
    const m = edgeAt(edge);
    const d = /** @type {number} */ (await searchDistance(m.wins));
    assert.ok(d <= edge, `${edge}: chose ${d}, which loses`);
    assert.ok(edge - d <= RANGE.tolerance, `${edge}: chose ${d}, more than ${RANGE.tolerance} short`);
    assert.ok(m.asked.length <= 8, `${edge}: ${m.asked.length} encodes`);
  }
});

test("the search reports the top when it wins, the floor band below lo, and null when nothing wins", async () => {
  assert.equal(await searchDistance(edgeAt(1).wins), RANGE.hi);
  const low = /** @type {number} */ (await searchDistance(edgeAt(0.07).wins));
  assert.ok(low >= RANGE.floor && low <= 0.07, `chose ${low}`);
  assert.equal(await searchDistance(edgeAt(0.01).wins), null, "below the floor, the archive stays as it was");
});

test("beating the bar takes both metrics; one win is not enough", () => {
  const bar = { s2: 90, ba3: 0.3 };
  assert.equal(beats({ s2: 91, ba3: 0.29 }, bar), true);
  assert.equal(beats({ s2: 91, ba3: 0.31 }, bar), false, "ssimulacra2 alone");
  assert.equal(beats({ s2: 89, ba3: 0.29 }, bar), false, "butteraugli alone");
  assert.equal(beats({ s2: 90, ba3: 0.3 }, bar), false, "a tie is not a win");
});

const box = (kind, body) => {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(body.length + 8);
  b.write(kind, 4, "latin1");
  return Buffer.concat([b, Buffer.from(body)]);
};
const container = (...boxes) => Buffer.concat([
  Buffer.from([0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
  box("ftyp", "jxl \0\0\0\0jxl "),
  ...boxes,
]);

test("jxl-kind reads a jbrd box as a transcode and refuses what is not a container", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "jxl-kind-"));
  const file = (name, bytes) => { const p = path.join(dir, name); writeFileSync(p, bytes); return p; };
  assert.equal(jxlKind(file("t.jxl", container(box("jbrd", "x"), box("jxlc", "image")))), "transcode");
  assert.equal(jxlKind(file("d.jxl", container(box("Exif", "\0\0\0\0MM"), box("jxlc", "image")))), "direct");
  // Controls: a JPEG, and a container whose last box runs past the end, both
  // throw rather than read as "direct", which would send a broken download
  // down the decode path.
  assert.throws(() => jxlKind(file("j.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]))), /not a JPEG XL container/);
  const whole = container(box("jxlc", "image"));
  assert.throws(() => jxlKind(file("cut.jxl", whole.subarray(0, whole.length - 2))), /past the end/);
});

test("codestreamBytes counts only codestream boxes, so metadata cannot fake a match", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cs-"));
  const a = path.join(dir, "a.jxl"), b = path.join(dir, "b.jxl");
  await writeFile(a, container(box("jxlp", "head"), box("jxlp", "the image")));
  await writeFile(b, container(box("jxlp", "head"), box("Exif", "lots of metadata here"), box("jxlp", "the image")));
  assert.equal(codestreamBytes(a), codestreamBytes(b));
  assert.equal(codestreamBytes(a), 8 + 4 + 8 + 9);
});

test("stripPng drops eXIf and XMP and keeps every other chunk byte for byte", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "png-"));
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, "latin1"), Buffer.from(data, "latin1"), Buffer.alloc(4)]); };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const keep = [chunk("IHDR", "dimensions...."), chunk("iCCP", "profile"), chunk("IDAT", "pixels"), chunk("IEND", "")];
  const src = path.join(dir, "in.png"), dst = path.join(dir, "out.png");
  await writeFile(src, Buffer.concat([sig, keep[0], keep[1], chunk("eXIf", "MM\0*orientation 8"), chunk("iTXt", "XML:com.adobe.xmp\0\0\0\0\0<x/>"), keep[2], keep[3]]));
  stripPng(src, dst);
  assert.deepEqual(await readFile(dst), Buffer.concat([sig, ...keep]));
});
