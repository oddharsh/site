#!/usr/bin/env bun
// gen-jxl-source-crops.ts — the /garage/encoding figure that puts the two
// kinds of .jxl side by side: one repacked from a JPEG, one encoded from a HIF.
//
//   bun tools/photos/gen-jxl-source-crops.ts <XT509890.HIF> <repack.jxl> <direct.jxl>
//
// Both files are R2 objects for XT509890. <repack.jxl> is the archive it had
// until 2026-10-16 (the q100 4:2:2 zenc JPEG, repacked losslessly), which
// reencode-hif-archives.ts --backup kept. <direct.jxl> is what R2 serves now,
// encoded from the HIF by hif-archive.ts: https://aadhar.sh/images/full/XT509890.jxl
//
// WHY. The two files share an extension and nothing else. A JPEG goes into
// JPEG XL with its own DCT coefficients and comes back out byte for byte; a
// HIF (HEVC) or an AVIF (AV1) has no coefficients JPEG XL can adopt (and cjxl
// reads neither container), so the file is a fresh lossy encode of decoded
// pixels. At 1:1 the two look the same, so the figure shows each file's
// error against the HIF, amplified, where the difference is visible.
//
// WHAT. Check each file is the kind it claims (djxl -J rebuilds a JPEG from
// the repack and refuses the direct file); decode the HIF and both files to
// 16 bits; cut each crop from all three and write it, plus each file's
// absolute error times GAIN, as 8-bit PNG. Nothing is encoded, so a rerun
// reproduces the committed crops from the same three inputs.
//
// HOW, and the trap it avoids: sips decodes the HIF in sensor orientation,
// while djxl applies the codestream's orientation. Each crop is cut from the
// reference at the matching sensor rectangle and turned upright, trying both
// quarter turns and keeping the one that lines up; more than 2/255 of mean
// error means neither did, and the run fails rather than publish a misaligned
// error map.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const OUT = path.join(import.meta.dirname, "../../public/garage/enc");
// Display-orientation squares on XT509890: red scaffolding against sky, and
// yellow paint beside a headlight, where JPEG XL's error leans blue.
const CROPS = [
  { name: "scaffold", x: 3800, y: 150 },
  { name: "paint", x: 1000, y: 3330 },
];
const SIZE = 160,
  GAIN = 32;

type Img = { w: number; h: number; px: Float64Array }; // RGB, 0..1

function sh(cmd: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd[0]} exited ${code}: ${err.trim().split("\n").at(-1)}`))));
  });
}

/** Stream a non-interlaced 8- or 16-bit RGB(A) PNG once, cutting every box. */
function crops(file: string, boxes: { x: number; y: number }[]) {
  const b = fs.readFileSync(file),
    idat: Buffer[] = [];
  let ihdr: Buffer | undefined;
  for (let i = 8; i < b.length;) {
    const len = b.readUInt32BE(i),
      type = b.toString("latin1", i + 4, i + 8);
    if (type === "IHDR") ihdr = b.subarray(i + 8, i + 8 + len);
    if (type === "IDAT") idat.push(b.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  if (!ihdr || ihdr[12] !== 0 || (ihdr[9] !== 2 && ihdr[9] !== 6)) throw new Error(`${path.basename(file)}: expected a non-interlaced RGB PNG`);
  const W = ihdr.readUInt32BE(0),
    H = ihdr.readUInt32BE(4),
    bytes = ihdr[8] / 8;
  const bpp = (ihdr[9] === 2 ? 3 : 4) * bytes,
    stride = W * bpp,
    max = bytes === 2 ? 65535 : 255;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const outs: Img[] = boxes.map(() => ({ w: SIZE, h: SIZE, px: new Float64Array(SIZE * SIZE * 3) }));
  let prev = Buffer.alloc(stride),
    cur = Buffer.alloc(stride);
  for (let y = 0; y < H; y++) {
    const off = y * (stride + 1),
      f = raw[off];
    for (let k = 0; k < stride; k++) {
      const x = raw[off + 1 + k],
        a = k >= bpp ? cur[k - bpp] : 0,
        u = prev[k],
        c = k >= bpp ? prev[k - bpp] : 0;
      let v = x;
      if (f === 1) v += a;
      else if (f === 2) v += u;
      else if (f === 3) v += (a + u) >> 1;
      else if (f === 4) {
        const p = a + u - c,
          pa = Math.abs(p - a),
          pb = Math.abs(p - u),
          pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? u : c;
      }
      cur[k] = v & 255;
    }
    boxes.forEach((bx, n) => {
      if (y < bx.y || y >= bx.y + SIZE) return;
      for (let x = 0; x < SIZE; x++)
        for (let ch = 0; ch < 3; ch++) {
          const o = (bx.x + x) * bpp + ch * bytes;
          outs[n].px[((y - bx.y) * SIZE + x) * 3 + ch] = (bytes === 2 ? cur.readUInt16BE(o) : cur[o]) / max;
        }
    });
    [prev, cur] = [cur, prev];
  }
  return { W, H, outs };
}

/** A quarter turn clockwise, `turns` times. */
function turn(im: Img, turns: number): Img {
  let r = im;
  for (let t = 0; t < turns; t++) {
    const px = new Float64Array(r.px.length);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) for (let k = 0; k < 3; k++) px[(x * r.h + (r.h - 1 - y)) * 3 + k] = r.px[(y * r.w + x) * 3 + k];
    r = { w: r.h, h: r.w, px };
  }
  return r;
}

const meanErr = (a: Img, b: Img) => {
  let s = 0;
  for (let i = 0; i < a.px.length; i++) s += Math.abs(a.px[i] - b.px[i]);
  return (s / a.px.length) * 255;
};

/** Per-channel RMS error in 8-bit steps, and the error map times GAIN. */
function error(a: Img, ref: Img) {
  const px = new Float64Array(a.px.length),
    sq = [0, 0, 0];
  for (let i = 0; i < px.length; i++) {
    const d = Math.abs(a.px[i] - ref.px[i]);
    sq[i % 3] += d * d;
    px[i] = Math.min(1, d * GAIN);
  }
  const rms = sq.map((s) => +(Math.sqrt(s / (a.px.length / 3)) * 255).toFixed(2));
  return { map: { w: a.w, h: a.h, px }, rms: { r: rms[0], g: rms[1], b: rms[2] } };
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type: string, data: Buffer) {
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  let c = 0xffffffff;
  for (const x of td) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  const head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([head, td, tail]);
}

/** 8-bit RGB PNG tagged sRGB, which is what the HIF decodes to. */
function writePng(file: string, im: Img) {
  const raw = Buffer.alloc(im.h * (im.w * 3 + 1));
  for (let y = 0; y < im.h; y++)
    for (let i = 0; i < im.w * 3; i++) raw[y * (im.w * 3 + 1) + 1 + i] = Math.max(0, Math.min(255, Math.round(im.px[y * im.w * 3 + i] * 255)));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(im.w, 0);
  ihdr.writeUInt32BE(im.h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.writeFileSync(
    file,
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("sRGB", Buffer.from([0])),
      chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

async function main(hif: string, repack: string, direct: string) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "jxl-source-crops-"));
  try {
    const p = (f: string) => path.join(work, f);

    // The repack holds a JPEG and gives it back; the direct file never held one.
    const rebuilt = await sh(["djxl", "-J", repack, p("rebuilt.jpg")]).then(
      () => true,
      () => false,
    );
    if (!rebuilt) throw new Error(`${path.basename(repack)} has no JPEG inside: pass the pre-migration repack`);
    const refused = await sh(["djxl", "-J", direct, p("nope.jpg")]).then(
      () => false,
      () => true,
    );
    if (!refused) throw new Error(`${path.basename(direct)} rebuilt a JPEG: pass the file encoded from the HIF`);
    fs.copyFileSync(repack, p("from-jpeg.jxl"));
    fs.copyFileSync(direct, p("from-hif.jxl"));

    await sh(["sips", "-s", "format", "png", hif, "--out", p("hif.png")]);
    for (const k of ["from-jpeg", "from-hif"]) await sh(["djxl", p(`${k}.jxl`), p(`${k}.png`), "--bits_per_sample=16"]);

    const fromJpeg = crops(p("from-jpeg.png"), CROPS),
      fromHif = crops(p("from-hif.png"), CROPS);
    if (fromJpeg.W !== fromHif.W || fromJpeg.H !== fromHif.H) throw new Error("the two decodes differ in size");
    // The HIF decode is sideways relative to djxl's upright one: try the
    // rectangle and turn for each direction and keep whichever lines up.
    const Hs = fromJpeg.W,
      Ws = fromJpeg.H;
    const options = [
      { turns: 3, rect: (c: { x: number; y: number }) => ({ x: Ws - c.y - SIZE, y: c.x }) },
      { turns: 1, rect: (c: { x: number; y: number }) => ({ x: c.y, y: Hs - c.x - SIZE }) },
    ];
    let ref: Img[] | undefined,
      best = Infinity;
    for (const o of options) {
      const cut = crops(p("hif.png"), CROPS.map(o.rect)).outs.map((im) => turn(im, o.turns));
      const e = meanErr(cut[0], fromJpeg.outs[0]);
      if (e < best) {
        best = e;
        ref = cut;
      }
    }
    if (!ref || best > 2) throw new Error(`no orientation lines the HIF up with its decodes (best mean error ${best.toFixed(2)}/255)`);

    const report = CROPS.map((c, n) => {
      const ej = error(fromJpeg.outs[n], ref![n]),
        eh = error(fromHif.outs[n], ref![n]);
      writePng(path.join(OUT, `jx-${c.name}-hif.png`), ref![n]);
      writePng(path.join(OUT, `jx-${c.name}-from-jpeg.png`), fromJpeg.outs[n]);
      writePng(path.join(OUT, `jx-${c.name}-from-hif.png`), fromHif.outs[n]);
      writePng(path.join(OUT, `jx-${c.name}-from-jpeg-err.png`), ej.map);
      writePng(path.join(OUT, `jx-${c.name}-from-hif-err.png`), eh.map);
      return { crop: c.name, rmsFromJpeg: ej.rms, rmsFromHif: eh.rms };
    });
    console.log(
      JSON.stringify(
        {
          repackBytes: fs.statSync(repack).size,
          jpegBytes: fs.statSync(p("rebuilt.jpg")).size,
          directBytes: fs.statSync(direct).size,
          gain: GAIN,
          crops: report,
        },
        null,
        2,
      ),
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [hif, repack, direct] = process.argv.slice(2);
  if (!hif || !repack || !direct) {
    console.error("usage: bun tools/photos/gen-jxl-source-crops.ts <XT509890.HIF> <repack.jxl> <direct.jxl>");
    process.exit(2);
  }
  await main(hif, repack, direct);
}
