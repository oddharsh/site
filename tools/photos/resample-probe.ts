// resample-probe.ts — is a downscaler CORRECT, judged without a reference
// implementation.
//
// WHY THIS EXISTS. Two attempts at moving the photo pipeline's square crop into
// zenc were declined on quality (the numbers are at the geometry comment in
// add-photos.sh), and BOTH were judged by a harness that could not have been
// fair: it downscaled, upscaled back with ffmpeg, and scored the round trip
// against the native crop. The upscale runs in encoded sRGB, so it rewards a
// candidate that also worked in encoded sRGB and penalises one that worked in
// linear light. That is the axis the two candidates differed on, so the
// instrument was measuring the thing it was supposed to be neutral about.
//
// Comparing against a "known good" downscaler has the same disease one step
// removed: picking the reference picks the winner.
//
// So this asks a different question. Not "which output is closer to X", but
// "does this resampler have the properties a resampler is supposed to have".
// The patterns below have an ANALYTICALLY KNOWN correct answer, so no reference
// implementation is involved and no candidate is privileged.
//
//   gamma      a 1px black/white checkerboard averages to HALF THE LIGHT, which
//              is sRGB ~188, not sRGB 128. Averaging encoded values instead of
//              light is the classic downscale defect and it darkens every
//              texture. This is the test the two attempts actually disagreed on.
//   identity   downscaling to the size you already are must change nothing.
//              `image`'s Lanczos3 fails this, which is how attempt 2's real
//              fault was found: it softens at every scale, including 1:1.
//   ringing    a step edge must not overshoot into values outside the range the
//              source contained. Lanczos rings by design, so this is reported
//              as a magnitude to compare rather than a pass or fail.
//   channels   a grayscale source must stay grayscale. Attempt 1 promoted Luma8
//              to RGBA and nobody noticed until the pixel diff was nonsense.
//
// USAGE. A candidate is a shell command with {in}, {out} and {size} placeholders,
// so anything that resamples can be plugged in without this file knowing about it:
//
//   bun tools/photos/resample-probe.ts \
//     --candidate 'sips:sips -Z {size} {in} --out {out}' \
//     --candidate 'zenc:./zenc square {in} --size {size} --out {out}'
//
// With no --candidate it probes the shipping sips chain alone, which is the
// baseline any future attempt has to beat.
import { deflateSync, inflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── PNG, written and read here so the probe carries no image dependency ─────
// A dependency that decodes images is a dependency with an opinion about
// colour, which is the thing under test.

type Img = { w: number; h: number; ch: number; data: Uint8Array };

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  const crcSrc = out.subarray(4, 8 + body.length);
  dv.setUint32(8 + body.length, crc32(crcSrc));
  return out;
}

/** @param ch 1 for grayscale, 3 for RGB. Both are written, because "does a
 *  grayscale source stay grayscale" is one of the properties under test. */
function writePng(path: string, img: Img): void {
  const { w, h, ch, data } = img;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;                      // bit depth
  ihdr[9] = ch === 1 ? 0 : 2;       // colour type: 0 grayscale, 2 truecolour
  const raw = new Uint8Array(h * (1 + w * ch));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * ch)] = 0;      // filter: none, so the bytes are the pixels
    raw.set(data.subarray(y * w * ch, (y + 1) * w * ch), y * (1 + w * ch) + 1);
  }
  const png = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  writeFileSync(path, Buffer.concat(png));
}

function readPng(path: string): Img {
  const d = readFileSync(path);
  let i = 8, w = 0, h = 0, bitDepth = 8, colourType = 0;
  const idat: Buffer[] = [];
  while (i < d.length) {
    const len = d.readUInt32BE(i);
    const type = d.toString("ascii", i + 4, i + 8);
    const body = d.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      bitDepth = body[8]!; colourType = body[9]!;
    } else if (type === "IDAT") idat.push(Buffer.from(body));
    else if (type === "IEND") break;
    i += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`${path}: only 8-bit is handled, got ${bitDepth}`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType as 0 | 2 | 4 | 6];
  if (!ch) throw new Error(`${path}: unsupported colour type ${colourType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = new Uint8Array(h * stride);
  let prev = new Uint8Array(stride), pos = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[pos++]!;
    const line = new Uint8Array(raw.subarray(pos, pos + stride)); pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch]! : 0;
      const b = prev[x]!;
      const c = x >= ch ? prev[x - ch]! : 0;
      if (f === 1) line[x] = (line[x]! + a) & 255;
      else if (f === 2) line[x] = (line[x]! + b) & 255;
      else if (f === 3) line[x] = (line[x]! + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[x] = (line[x]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    out.set(line, y * stride); prev = line;
  }
  return { w, h, ch, data: out };
}

// ── the patterns, each with an answer that is known rather than measured ────

/** Alternating black and white pixels. Downscaled far enough, every output
 *  pixel covers equal black and white area, so the correct value is the sRGB
 *  encoding of linear 0.5. */
function checkerboard(n: number, ch: number): Img {
  const data = new Uint8Array(n * n * ch);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = (x + y) % 2 === 0 ? 0 : 255;
      for (let c = 0; c < ch; c++) data[(y * n + x) * ch + c] = v;
    }
  }
  return { w: n, h: n, ch, data };
}

/** Left half black, right half white. A resampler must not produce values
 *  outside [0,255]'s occupied range in the flat regions; how far it overshoots
 *  is its ringing. */
function stepEdge(n: number, ch: number): Img {
  const data = new Uint8Array(n * n * ch);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = x < n / 2 ? 0 : 255;
      for (let c = 0; c < ch; c++) data[(y * n + x) * ch + c] = v;
    }
  }
  return { w: n, h: n, ch, data };
}

/** A smooth gradient, used for the identity check: any softening shows up as a
 *  difference from a source that a correct 1:1 resample returns untouched. */
function gradient(n: number, ch: number): Img {
  const data = new Uint8Array(n * n * ch);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = Math.round((x / (n - 1)) * 255);
      for (let c = 0; c < ch; c++) data[(y * n + x) * ch + c] = v;
    }
  }
  return { w: n, h: n, ch, data };
}

const srgbToLinear = (c: number): number => {
  const s = c / 255;
  return s <= 0.040449936 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const linearToSrgb = (l: number): number => {
  const x = Math.min(1, Math.max(0, l));
  const s = x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
  return s * 255;
};

/** Ignore a margin, because every resampler is entitled to edge effects at the
 *  frame boundary and this is measuring the interior. */
function interiorMean(img: Img, margin: number): number {
  let t = 0, n = 0;
  for (let y = margin; y < img.h - margin; y++) {
    for (let x = margin; x < img.w - margin; x++) {
      for (let c = 0; c < img.ch; c++) { t += img.data[(y * img.w + x) * img.ch + c]!; n++; }
    }
  }
  return n ? t / n : NaN;
}

// ── the control ─────────────────────────────────────────────────────────────
//
// A probe that has only ever seen defective candidates has not been shown to
// detect anything. These two are area-average downscalers differing in ONE
// respect: whether the average is taken over light or over encoded values. They
// exist to prove the gamma column discriminates, and they are the reason a
// reading from it can be trusted. `--self-test` runs them and asserts the split.
//
// Area-average rather than Lanczos on purpose: at an integer factor it is
// exactly the analytic answer for these patterns, and at factor 1 it is exactly
// identity, so a nonzero identity column would be this file's own bug.

function areaResample(src: Img, size: number, linear: boolean): Img {
  const { w, h, ch, data } = src;
  const out = new Uint8Array(size * size * ch);
  const fwd = linear ? srgbToLinear : (c: number) => c / 255;
  const inv = linear ? linearToSrgb : (v: number) => v * 255;
  for (let oy = 0; oy < size; oy++) {
    const y0 = (oy * h) / size, y1 = ((oy + 1) * h) / size;
    for (let ox = 0; ox < size; ox++) {
      const x0 = (ox * w) / size, x1 = ((ox + 1) * w) / size;
      for (let c = 0; c < ch; c++) {
        let acc = 0, wsum = 0;
        for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
          const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
          if (wy <= 0) continue;
          for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
            const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
            if (wx <= 0) continue;
            acc += fwd(data[(sy * w + sx) * ch + c]!) * wx * wy;
            wsum += wx * wy;
          }
        }
        out[(oy * size + ox) * ch + c] = Math.round(inv(acc / wsum));
      }
    }
  }
  return { w: size, h: size, ch, data: out };
}

// ── running a candidate ─────────────────────────────────────────────────────

type Candidate = { name: string; cmd: string; internal?: (i: string, o: string, n: number) => void };

function runCandidate(c: Candidate, inPath: string, outPath: string, size: number): boolean {
  if (c.internal) {
    try { c.internal(inPath, outPath, size); return true; } catch { return false; }
  }
  const cmd = c.cmd.replaceAll("{in}", inPath).replaceAll("{out}", outPath).replaceAll("{size}", String(size));
  try {
    execFileSync("/bin/sh", ["-c", cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const REFERENCES: Candidate[] = [
  { name: "ref-linear", cmd: "", internal: (i, o, n) => writePng(o, areaResample(readPng(i), n, true)) },
  { name: "ref-naive",  cmd: "", internal: (i, o, n) => writePng(o, areaResample(readPng(i), n, false)) },
];

function parseArgs(argv: string[]): { candidates: Candidate[]; size: number; source: number; selfTest: boolean } {
  const candidates: Candidate[] = [];
  let size = 64, source = 1024, selfTest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--candidate") {
      const spec = argv[++i] ?? "";
      const at = spec.indexOf(":");
      if (at < 1) throw new Error(`--candidate wants name:command, got ${JSON.stringify(spec)}`);
      candidates.push({ name: spec.slice(0, at), cmd: spec.slice(at + 1) });
    } else if (a === "--self-test") selfTest = true;
    else if (a === "--size") size = Number(argv[++i]);
    else if (a === "--source") source = Number(argv[++i]);
    else throw new Error(`unexpected argument ${JSON.stringify(a)}`);
  }
  if (selfTest) candidates.unshift(...REFERENCES);
  if (!candidates.length) {
    // The shipping baseline. `sips -Z` is the resize the pipeline actually runs;
    // the surrounding TIFF dance is container work and does not resample.
    candidates.push({ name: "sips", cmd: "sips -Z {size} {in} --out {out} >/dev/null 2>&1" });
  }
  return { candidates, size, source, selfTest };
}

function main(): number {
  const { candidates, size, source, selfTest } = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), "resample-probe-"));
  const ideal = linearToSrgb(0.5);
  console.log(`resample-probe: ${source}px sources -> ${size}px, ${candidates.length} candidate(s)\n`);

  const rows: string[] = [];
  const measured: Record<string, { gamma: number; identity: number; ring: number; ch: number }> = {};
  try {
    for (const c of candidates) {
      // 1. GAMMA. The answer is known: half the light, encoded.
      const gammaResults: Record<string, number> = {};
      for (const ch of [1, 3] as const) {
        const src = join(dir, `check-${ch}.png`), dst = join(dir, `check-${ch}.out.png`);
        writePng(src, checkerboard(source, ch));
        if (!runCandidate(c, src, dst, size)) { gammaResults[`ch${ch}`] = NaN; continue; }
        gammaResults[`ch${ch}`] = interiorMean(readPng(dst), 2);
      }

      // 2. IDENTITY. Downscale to the size it already is.
      const idSrc = join(dir, "grad.png"), idDst = join(dir, "grad.out.png");
      writePng(idSrc, gradient(size, 3));
      let identity = NaN;
      if (runCandidate(c, idSrc, idDst, size)) {
        const a = readPng(idSrc), b = readPng(idDst);
        if (a.w === b.w && a.h === b.h && a.ch === b.ch) {
          let diff = 0;
          for (let i = 0; i < a.data.length; i++) diff += Math.abs(a.data[i]! - b.data[i]!);
          identity = diff / a.data.length;
        }
      }

      // 3. RINGING. Overshoot past the source's own range.
      const stSrc = join(dir, "step.png"), stDst = join(dir, "step.out.png");
      writePng(stSrc, stepEdge(source, 3));
      let ring = NaN;
      if (runCandidate(c, stSrc, stDst, size)) {
        const o = readPng(stDst);
        let worst = 0;
        for (let y = 0; y < o.h; y++) {
          for (let x = 0; x < o.w; x++) {
            const v = o.data[(y * o.w + x) * o.ch]!;
            const nearEdge = Math.abs(x - o.w / 2) < o.w * 0.08;
            if (nearEdge) continue;          // the transition itself is not ringing
            worst = Math.max(worst, x < o.w / 2 ? v : 255 - v);
          }
        }
        ring = worst;
      }

      // 4. CHANNELS. A grayscale source must come back grayscale.
      const gSrc = join(dir, "gray.png"), gDst = join(dir, "gray.out.png");
      writePng(gSrc, gradient(source, 1));
      let chOut = -1;
      if (runCandidate(c, gSrc, gDst, size)) chOut = readPng(gDst).ch;

      const g1 = gammaResults.ch1!, g3 = gammaResults.ch3!;
      measured[c.name] = { gamma: g1, identity, ring, ch: chOut };
      rows.push(
        `  ${c.name.padEnd(10)} ` +
        `gamma ${fmt(g1)}/${fmt(g3)}  ` +
        `identity ${Number.isNaN(identity) ? "  n/a" : identity.toFixed(2).padStart(5)}  ` +
        `ring ${Number.isNaN(ring) ? "n/a" : String(Math.round(ring)).padStart(3)}  ` +
        `gray->ch ${chOut < 0 ? "n/a" : chOut}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`  ${"".padEnd(10)} gamma gray/rgb   identity    ring  gray->ch`);
  console.log(`  ${"ideal".padEnd(10)} ${ideal.toFixed(1)}/${ideal.toFixed(1)}      0.00       0         1\n`);
  for (const r of rows) console.log(r);
  console.log(`
  gamma     mean of a 1px checkerboard's interior. ${ideal.toFixed(1)} is correct
            (linear 0.5 encoded). 127.5 means encoded values were averaged as
            though they were light, which darkens every downscaled texture.
  identity  mean absolute difference when asked to resize to the size it already
            is. Anything above 0 is unconditional softening, applied at every
            scale and not only this one.
  ring      worst overshoot into the flat regions away from the edge. Lanczos
            rings by design; this is for comparing magnitudes.
  gray->ch  channels out of a 1-channel source. 1 is correct; 3 or 4 means the
            tool promoted grayscale and any byte comparison against it is void.`);

  // THE CONTROL, asserted rather than printed. Two internal resamplers differing
  // only in whether they average light or encoded values must land on opposite
  // sides of the gamma column, or the column is measuring nothing and every
  // reading above it is decoration.
  if (selfTest) {
    const lin = measured["ref-linear"], naive = measured["ref-naive"];
    const problems: string[] = [];
    if (!lin || !naive) problems.push("a reference candidate did not run");
    else {
      if (Math.abs(lin.gamma - ideal) > 1) problems.push(`ref-linear gamma ${lin.gamma.toFixed(1)}, expected ~${ideal.toFixed(1)}`);
      if (Math.abs(naive.gamma - 127.5) > 1) problems.push(`ref-naive gamma ${naive.gamma.toFixed(1)}, expected ~127.5`);
      if (lin.gamma - naive.gamma < 50) problems.push("the two references did not separate; the gamma column is not discriminating");
      for (const [n, m] of [["ref-linear", lin], ["ref-naive", naive]] as const) {
        if (m.identity !== 0) problems.push(`${n} identity ${m.identity}, expected 0 from an area filter`);
        if (m.ch !== 1) problems.push(`${n} returned ${m.ch} channels from a grayscale source`);
      }
    }
    if (problems.length) {
      console.error(`\nself-test FAILED:\n  ${problems.join("\n  ")}`);
      return 1;
    }
    console.log(`\nself-test passed: the references separate by ${(lin!.gamma - naive!.gamma).toFixed(1)} on gamma and agree on the rest.`);
  }
  return 0;
}

const fmt = (v: number): string => (Number.isNaN(v) ? "  n/a" : v.toFixed(1).padStart(5));

process.exit(main());
