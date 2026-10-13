#!/usr/bin/env bun
// zensim-probe.ts: could zensim stand in for the two libjxl metrics the photo
// tools gate on? ssimulacra2 and butteraugli_main decide the Instagram export's
// quality (export-for-instagram.sh) and the HIF archive's distance
// (hif-archive.ts). zensim (github.com/imazen/zensim) claims both lineages in
// one fast pass. This scores the same pixels with all of them and replays the
// two decisions.
//
// FINDINGS: see FOUND below. The instrument notes come first because each one
// cost a wrong number on the way here.
//
//   1. EVERY SCORER READS THE SAME PIXELS. Each candidate is decoded once and
//      rewritten as an 8-bit RGB PNG with no ICC by `zensim-score canon`, so a
//      decoder or colour-management difference cannot pass for a metric one.
//      The archive mode instead keeps sips's 16-bit reference, as production
//      does, and feeds zensim through its 16-bit path.
//   2. JOIN ON THE IMAGE PATH. libjxl scoring runs in a pool, so its rows land
//      in completion order. Pasting them beside zensim's line by line once
//      paired every score with the wrong image and still printed a plausible
//      r = -0.604.
//   3. THE 8-BIT CONTROL. `score16 --q8` rounds both images to 8 bits first.
//      If 16-bit and rounded scores were equal, zensim could not see the 10
//      bits the archive exists to keep, and the archive verdict would be moot.
//   4. NO ESTIMATED GAPS. zensim's `approx_*` helpers are reported against the
//      real libjxl numbers rather than trusted: on the pinned rev they are
//      broken for profile B (raw_distance holds the bake's score there, and
//      the helpers feed it to power laws fitted on a distance). The fix is
//      upstream as an imazen/zensim PR; zensim-score/Cargo.toml says why the
//      pin has not moved.
//
//   bun tools/photos/zensim-probe.ts ladder  [--limit N] [--jobs N] [--work DIR] [--json out]
//   bun tools/photos/zensim-probe.ts archive [--limit N] [--jobs N] [--work DIR] [--json out]
//   bun tools/photos/zensim-probe.ts speed   [--work DIR]
//
// ladder: 31 photos (every Leica, every 5th Fuji JPEG up to 8, every 7th HIF),
// reduced to 1080px exactly as export-for-instagram.sh prepares its reference,
// then 28 encodes each: zenc JPEG q30-95 4:2:0, AVIF 10-bit 4:4:4 q25-88 at
// speed 6, JPEG XL d0.5-6 at effort 7. ~1 min to encode, ~70 s to score on an
// M3 Max at --jobs 6.
//
// archive: hif-archive.ts's own decision at full resolution on every 7th HIF
// (20 frames), made four ways: libjxl's rule (ssimulacra2 AND butteraugli
// 3-norm, through hif-archive.ts's beats()), zensim B alone, zensim 0.2.7
// alone, and B on the 8-bit-rounded pair. Bisection, range and cjxl args are
// IMPORTED from hif-archive.ts, so the search cannot drift from production.
// Each libjxl score of a 40 MP pair takes 5 s and 7 GB (ssimulacra2) plus
// 16 s and 9 GB (butteraugli); --jobs defaults to 2 so two lanes fit in 36 GB.
//
// FOUND, 2026-10-13, M3 Max, zensim 0.2.7 + 0.3.0 at 96c3c9b, libjxl 0.12.0:
//
//   ladder, 868 pairs           vs ssimulacra2   cross-codec calls that
//                               (Spearman)       disagree with ssimulacra2
//   butteraugli 3-norm           0.979            6.2%
//   zensim 0.2.7                 0.992            4.3%
//   zensim B                     0.967            4.6%
//
//   zensim disagrees with ssimulacra2 less often than butteraugli does, on
//   809 pairs of different codecs within 15% of each other's bytes.
//
//   Instagram decision (lowest JPEG q with ssimulacra2 >= 84), threshold fit
//   on 16 photos, tested on 15: B at 78.95 picks the same q on 9 of 15,
//   butteraugli on 7, 0.2.7 on 8. A one-photo gap is noise at n = 15.
//
//   Codec verdicts move: at equal quality B puts AVIF at -44% bytes against
//   zenc JPEG, where ssimulacra2 says -36% and butteraugli -34%. JPEG XL reads
//   -15% to -20% under every metric.
//
//   speed, per pair, wall clock with decode (5 runs, median):
//                  ssimulacra2     butteraugli     zensim B, all cores / 1 core
//   1080px          100 ms          220 ms          30 ms / 60 ms
//   2048px          330 ms          760 ms          80 ms / 250 ms
//   40 MP           5.2 s, 7.2 GB   16.2 s, 9.0 GB  1.0 s, 1.5 GB / 2.9 s
//
//   ARCHIVE, PRELIMINARY (4 of 20 frames; the full run replaces this):
//   zensim B lets the JPEG XL go to d0.491 on all 4, where libjxl's
//   both-metric bar stops at d0.319-0.413: 10.7-12.9 MB against 12.0-16.3 MB.
//   None of B's picks clears libjxl's bar, so zensim scores the q100 4:2:2
//   JPEG more harshly, relative to JPEG XL, than ssimulacra2 and butteraugli
//   do. 16 bits do reach B (+1.25 to +1.47 points over the 8-bit control at
//   d0.1). B is not monotonic in distance here: it rises 1.23 points between
//   d0.335 and d0.35 on XT500010, the size of the margins a bisection decides.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARGS, beats, searchDistance, stripPng } from "./hif-archive.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZENC = path.join(HERE, "zenc/target/release/zenc");
const SCORER_DIR = path.join(HERE, "zensim-score");
const SCORER = path.join(SCORER_DIR, "target/release/zensim-score");
// CLAUDE.md: new photos come from here and nowhere else on disk.
const SRC = "/Users/aadharsh/Downloads/to post (from ssd)";

const argv = process.argv.slice(2);
const mode = argv[0];
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const WORK = path.resolve(arg("work") ?? path.join(os.tmpdir(), "zensim-probe"));

async function sh(cmd: string[], tolerate = false): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  // butteraugli_main exits non-zero on a large distance and still prints both scores
  if ((await p.exited) !== 0 && !tolerate) throw new Error(`${path.basename(cmd[0])} failed:\n${err.slice(-600)}`);
  return out.trim();
}

/** Run `fn` over `items`, `n` at a time, keeping input order in the result. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

function prerequisites() {
  if (!fs.existsSync(ZENC)) {
    throw new Error(`zenc is not built: cargo build --release --locked --manifest-path ${path.relative(process.cwd(), path.join(HERE, "zenc/Cargo.toml"))}`);
  }
  if (!fs.existsSync(SCORER)) {
    // Built on demand, like zenc in the photo shells.
    console.error("building zensim-score (once)...");
    const b = Bun.spawnSync(["cargo", "build", "--release", "--locked", "--manifest-path", path.join(SCORER_DIR, "Cargo.toml")], { stderr: "inherit" });
    if (b.exitCode !== 0) throw new Error("cargo build of zensim-score failed");
  }
}

type Lib = { s2: number; ba: number; ba3: number };
async function libjxl(ref: string, img: string): Promise<Lib> {
  const s2 = Number.parseFloat(await sh(["ssimulacra2", ref, img]));
  const b = await sh(["butteraugli_main", ref, img, "--pnorm", "3"], true);
  const ba = Number.parseFloat(b.split("\n")[0] ?? "");
  const ba3 = Number.parseFloat(/3-norm:\s*([\d.]+)/.exec(b)?.[1] ?? "");
  if (![s2, ba, ba3].every(Number.isFinite)) throw new Error(`a libjxl metric printed no score for ${img}`);
  return { s2, ba, ba3 };
}

// ---- statistics -------------------------------------------------------------
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const pearson = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return ab / Math.sqrt(aa * bb);
};
const rank = (a: number[]) => {
  const idx = a.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
  const r = new Array<number>(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
    i = j + 1;
  }
  return r;
};
const spearman = (a: number[], b: number[]) => pearson(rank(a), rank(b));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

// ---- ladder -----------------------------------------------------------------
const JPEG_Q = [30, 40, 50, 60, 65, 70, 75, 80, 84, 88, 92, 95];
const AVIF_Q = [25, 35, 45, 55, 63, 72, 80, 88];
const JXL_D = [0.5, 0.8, 1, 1.5, 2, 3, 4, 6];

/** The 31-photo pick: every Leica, every 5th Fuji JPEG (8), every 7th HIF. */
function pickLadder(): string[] {
  const all = fs.readdirSync(SRC).sort();
  const every = (re: RegExp, k: number, cap: number) => all.filter((f) => re.test(f)).filter((_, i) => i % k === 0).slice(0, cap);
  return [...all.filter((f) => f.startsWith("L")), ...every(/^XT.*\.JPG$/, 5, 8), ...every(/^XT.*\.HIF$/, 7, 21)];
}

type Enc = { stem: string; codec: "jpeg" | "avif" | "jxl"; knob: number; bytes: number; png: string };
async function encodeLadder(file: string): Promise<{ ref: string; encs: Enc[] }> {
  const stem = file.replace(/\.[^.]+$/, "");
  const tmp = fs.mkdtempSync(path.join(WORK, `${stem}-`));
  const ref = path.join(WORK, "ref", `${stem}.png`);
  const encs: Enc[] = [];
  try {
    // export-for-instagram.sh's prepare_reference, minus rotation (metrics do not care).
    await sh(["sips", "-s", "format", "tiff", path.join(SRC, file), "--out", path.join(tmp, "mid.tiff")]);
    await sh([ZENC, "resize", path.join(tmp, "mid.tiff"), "--width", "1080", "--filter", "box", "--out", path.join(tmp, "r.png")]);
    await sh([SCORER, "canon", path.join(tmp, "r.png"), ref]);
    const add = async (codec: Enc["codec"], knob: number, file: string, decoded: string) => {
      const png = path.join(WORK, "enc", `${stem}.${codec}.${knob}.png`);
      await sh([SCORER, "canon", decoded, png]);
      encs.push({ stem, codec, knob, bytes: fs.statSync(file).size, png });
    };
    for (const q of JPEG_Q) {
      const j = path.join(tmp, `j${q}.jpg`);
      await sh([ZENC, ref, j, "-q", String(q), "--yuv", "420"]);
      await add("jpeg", q, j, j);
    }
    for (const q of AVIF_Q) {
      const a = path.join(tmp, `a${q}.avif`), d = path.join(tmp, `a${q}.png`);
      await sh(["avifenc", "-q", String(q), "-d", "10", "-y", "444", "-s", "6", "-j", "1", ref, a]);
      await sh(["avifdec", "-d", "8", a, d]);
      await add("avif", q, a, d);
    }
    for (const dist of JXL_D) {
      const x = path.join(tmp, `x${dist}.jxl`), d = path.join(tmp, `x${dist}.png`);
      await sh(["cjxl", ref, x, "-d", String(dist), "-e", "7", "--num_threads", "1"]);
      await sh(["djxl", x, d, "--bits_per_sample", "8"]);
      await add("jxl", dist, x, d);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { ref, encs };
}

type Row = Enc & Lib & { z02: number; z02s2: number; z02ba: number; zB: number; zBs2: number; zBba: number; libMs: number; zMs: number };

async function ladder() {
  prerequisites();
  const jobs = Number(arg("jobs") ?? 6);
  const files = pickLadder().slice(0, Number(arg("limit") ?? Infinity));
  for (const d of ["ref", "enc"]) fs.mkdirSync(path.join(WORK, d), { recursive: true });
  console.error(`encoding ${files.length} photos x ${JPEG_Q.length + AVIF_Q.length + JXL_D.length} into ${WORK}`);
  const built = await pool(files, jobs, encodeLadder);
  const pairs = built.flatMap((b) => b.encs.map((e) => ({ ref: b.ref, e })));

  console.error(`scoring ${pairs.length} pairs with libjxl`);
  const lib = await pool(pairs, jobs, async ({ ref, e }) => {
    const t = performance.now();
    const s = await libjxl(ref, e.png);
    return { png: e.png, ...s, ms: performance.now() - t };
  });
  const libBy = new Map(lib.map((l) => [l.png, l]));

  console.error("scoring with zensim");
  const z = Bun.spawnSync([SCORER, "batch"], { stdin: Buffer.from(pairs.map((p) => `${p.ref}\t${p.e.png}\n`).join("")) });
  if (z.exitCode !== 0) throw new Error(`zensim-score batch failed: ${z.stderr.toString().slice(-400)}`);
  const zBy = new Map(z.stdout.toString().trim().split("\n").map((l) => {
    const c = l.split("\t");
    return [c[1], c.slice(2).map(Number)] as const;
  }));

  const rows: Row[] = pairs.map(({ e }) => {
    const l = libBy.get(e.png), c = zBy.get(e.png);
    if (!l || !c) throw new Error(`missing score for ${e.png}`);
    return { ...e, s2: l.s2, ba: l.ba, ba3: l.ba3, libMs: l.ms, z02: c[0], z02s2: c[2], z02ba: c[3], zB: c[5], zBs2: c[7], zBba: c[8], zMs: c[4] + c[9] };
  });
  report(rows);
  const out = arg("json");
  if (out) fs.writeFileSync(out, JSON.stringify(rows));
}

function report(rows: Row[]) {
  const stems = [...new Set(rows.map((r) => r.stem))].sort();
  const by = (s: string) => rows.filter((r) => r.stem === s);
  // every metric oriented so higher is better
  const M: Record<string, (r: Row) => number> = { s2: (r) => r.s2, ba3: (r) => -r.ba3, ba: (r) => -r.ba, z02: (r) => r.z02, zB: (r) => r.zB };
  const names = Object.keys(M);
  const table = (title: string, cell: (a: string, b: string) => string) => {
    console.log(`\n${title}\n        ${names.map((n) => n.padStart(8)).join("")}`);
    for (const a of names) console.log(a.padEnd(8) + names.map((b) => cell(a, b).padStart(8)).join(""));
  };
  console.log(`${rows.length} pairs, ${stems.length} photos`);
  table("Spearman, pooled over every pair:", (a, b) => spearman(rows.map(M[a]), rows.map(M[b])).toFixed(3));
  table("Spearman within one photo, codecs mixed (median over photos):", (a, b) =>
    median(stems.map((s) => spearman(by(s).map(M[a]), by(s).map(M[b])))).toFixed(3));

  // Same photo, two codecs, within 15% bytes: which looks better? The rate at
  // which ssimulacra2 and butteraugli disagree is the scale for the rest.
  const pairs: [Row, Row][] = [];
  for (const s of stems) {
    const rs = by(s);
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
      if (rs[i].codec !== rs[j].codec && Math.abs(Math.log(rs[i].bytes / rs[j].bytes)) <= Math.log(1.15)) pairs.push([rs[i], rs[j]]);
    }
  }
  table(`Cross-codec winner calls at +-15% bytes (n = ${pairs.length}), % where two metrics disagree:`, (a, b) =>
    pct(pairs.filter(([x, y]) => Math.sign(M[a](x) - M[a](y)) !== Math.sign(M[b](x) - M[b](y))).length / pairs.length));

  console.log("\nzensim's approximations against the real libjxl numbers:");
  for (const [label, f, g] of [
    ["0.2.7 approx_ssim2 vs ssimulacra2", (r: Row) => r.z02s2, (r: Row) => r.s2],
    ["B approx_ssim2 vs ssimulacra2", (r: Row) => r.zBs2, (r: Row) => r.s2],
    ["0.2.7 approx_butteraugli vs max", (r: Row) => r.z02ba, (r: Row) => r.ba],
    ["B approx_butteraugli vs max", (r: Row) => r.zBba, (r: Row) => r.ba],
  ] as const) {
    console.log(`  ${label.padEnd(34)} MAE ${mean(rows.map((r) => Math.abs(f(r) - g(r)))).toFixed(2).padStart(7)}  r ${pearson(rows.map(f), rows.map(g)).toFixed(3)}`);
  }

  // export-for-instagram.sh: the lowest q clearing ssimulacra2 >= 84. Fit each
  // metric's threshold on even-index photos, test on odd ones.
  const train = stems.filter((_, i) => i % 2 === 0), test = stems.filter((_, i) => i % 2 === 1);
  const step = (q: number | undefined) => (q === undefined ? JPEG_Q.length : JPEG_Q.indexOf(q));
  const pick = (s: string, f: (r: Row) => number, t: number) =>
    by(s).filter((r) => r.codec === "jpeg").sort((a, b) => a.knob - b.knob).find((r) => f(r) >= t);
  console.log(`\nInstagram decision (lowest JPEG q with ssimulacra2 >= 84), fit on ${train.length}, tested on ${test.length}:`);
  for (const [label, f, lo, hi, inc] of [
    ["butteraugli 3-norm", M.ba3, -3, 0, 0.01],
    ["zensim 0.2.7", M.z02, 0, 100, 0.05],
    ["zensim B", M.zB, 0, 100, 0.05],
  ] as const) {
    let best = { t: lo, err: Infinity };
    for (let t = lo; t <= hi; t += inc) {
      const err = mean(train.map((s) => Math.abs(step(pick(s, M.s2, 84)?.knob) - step(pick(s, f, t)?.knob))));
      if (err < best.err - 1e-9) best = { t, err };
    }
    const res = test.map((s) => {
      const a = pick(s, M.s2, 84), b = pick(s, f, best.t);
      return { d: step(b?.knob) - step(a?.knob), bytes: a && b ? b.bytes / a.bytes - 1 : NaN };
    });
    console.log(`  ${label.padEnd(20)} t=${best.t.toFixed(2).padStart(6)}  same q ${res.filter((r) => r.d === 0).length}/${test.length}  within one step ${res.filter((r) => Math.abs(r.d) <= 1).length}/${test.length}  bytes ${pct(mean(res.map((r) => r.bytes).filter(Number.isFinite)))}`);
  }

  // Bjontegaard-style: mean log-bytes gap between two codecs' curves over their
  // shared quality range, per photo and metric.
  const gap = (s: string, f: (r: Row) => number, c: Row["codec"]) => {
    const curve = (k: Row["codec"]) => by(s).filter((r) => r.codec === k).map((r) => [f(r), Math.log(r.bytes)] as const).sort((a, b) => a[0] - b[0]);
    const A = curve("jpeg"), B = curve(c);
    const lo = Math.max(A[0][0], B[0][0]), hi = Math.min(A[A.length - 1][0], B[B.length - 1][0]);
    if (!(hi > lo)) return NaN;
    const at = (C: (readonly [number, number])[], q: number) => {
      for (let i = 1; i < C.length; i++) {
        if (C[i][0] >= q) {
          const [q0, b0] = C[i - 1], [q1, b1] = C[i];
          return q1 === q0 ? b1 : b0 + ((b1 - b0) * (q - q0)) / (q1 - q0);
        }
      }
      return C[C.length - 1][1];
    };
    let sum = 0;
    for (let k = 0; k <= 64; k++) sum += at(B, lo + ((hi - lo) * k) / 64) - at(A, lo + ((hi - lo) * k) / 64);
    return Math.exp(sum / 65) - 1;
  };
  console.log("\nBytes at equal quality against zenc JPEG (median over photos):");
  for (const n of names) {
    const v = (c: Row["codec"]) => pct(median(stems.map((s) => gap(s, M[n], c)).filter(Number.isFinite)));
    console.log(`  ${n.padEnd(6)} AVIF ${v("avif").padStart(7)}   JPEG XL ${v("jxl").padStart(7)}`);
  }
}

// ---- archive ----------------------------------------------------------------
type Z16 = { z02: number; zB: number; z02q8: number; zBq8: number };
async function zen16(ref: string, img: string): Promise<Z16> {
  const o = (await sh([SCORER, "score16", ref, img])).split("\t").map(Number);
  const q = (await sh([SCORER, "score16", ref, img, "--q8"])).split("\t").map(Number);
  return { z02: o[0], zB: o[3], z02q8: q[0], zBq8: q[3] };
}

async function archiveOne(hif: string) {
  const stem = path.basename(hif, path.extname(hif));
  const dir = fs.mkdtempSync(path.join(WORK, `${stem}-`));
  try {
    const raw = path.join(dir, "raw.png"), ref = path.join(dir, "ref.png");
    const baseJpg = path.join(dir, "base.jpg"), base = path.join(dir, "base.ppm");
    // hif-archive.ts's reference, and add-photos.sh's baseline (its jpegtran
    // pass only reorders scans, so the decoded pixels are zenc's).
    await sh(["sips", "-s", "format", "png", hif, "--out", raw]);
    stripPng(raw, ref);
    await sh([ZENC, raw, baseJpg, "-q", "100", "--yuv", "422"]);
    await sh(["djpeg", "-outfile", base, baseJpg]);
    const baseLib = await libjxl(ref, base), baseZ = await zen16(ref, base);

    type Cand = { d: number; bytes: number; lib?: Lib; z: Z16 };
    const cands = new Map<number, Cand>();
    const cand = async (d: number) => {
      let c = cands.get(d);
      if (!c) {
        const jxl = path.join(dir, `d${d}.jxl`), dec = path.join(dir, `d${d}.png`);
        await sh(["cjxl", "--quiet", "-d", String(d), ...ARGS, ref, jxl]);
        await sh(["djxl", jxl, dec]);
        c = { d, bytes: fs.statSync(jxl).size, z: await zen16(ref, dec) };
        cands.set(d, c);
      }
      return c;
    };
    const withLib = async (c: Cand) => (c.lib ??= await libjxl(ref, path.join(dir, `d${c.d}.png`)));

    const libjxlPick = await searchDistance(async (d) => beats(await withLib(await cand(d)), baseLib));
    const zB = await searchDistance(async (d) => (await cand(d)).z.zB > baseZ.zB);
    const z02 = await searchDistance(async (d) => (await cand(d)).z.z02 > baseZ.z02);
    const zBq8 = await searchDistance(async (d) => (await cand(d)).z.zBq8 > baseZ.zBq8);
    // Would zensim's pick clear libjxl's bar? Score it to find out.
    for (const d of [zB, z02]) if (d !== null) await withLib(await cand(d));
    console.error(`${stem} libjxl=${libjxlPick} zB=${zB} z02=${z02} zBq8=${zBq8}`);
    return {
      stem, baseBytes: fs.statSync(baseJpg).size, baseLib, baseZ,
      picks: { libjxl: libjxlPick, zB, z02, zBq8 },
      cands: [...cands.values()].sort((a, b) => a.d - b.d),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
type Arch = Awaited<ReturnType<typeof archiveOne>>;

async function archive() {
  prerequisites();
  fs.mkdirSync(WORK, { recursive: true });
  const hifs = fs.readdirSync(SRC).sort().filter((f) => /^XT.*\.HIF$/.test(f)).filter((_, i) => i % 7 === 0)
    .slice(0, Number(arg("limit") ?? Infinity)).map((f) => path.join(SRC, f));
  console.error(`${hifs.length} HIFs at full resolution into ${WORK}; expect ~10 min per photo per lane`);
  const recs = await pool(hifs, Number(arg("jobs") ?? 2), archiveOne);
  archiveReport(recs);
  const out = arg("json");
  if (out) fs.writeFileSync(out, JSON.stringify(recs));
}

function archiveReport(recs: Arch[]) {
  const n = recs.length;
  const bytesAt = (r: Arch, d: number | null) => (d === null ? r.baseBytes : r.cands.find((c) => c.d === d)?.bytes ?? NaN);
  const clears = (r: Arch, d: number | null) => {
    const c = d === null ? undefined : r.cands.find((x) => x.d === d);
    return c?.lib ? beats(c.lib, r.baseLib) : false;
  };
  console.log(`\nArchive decision on ${n} HIFs at full resolution (largest cjxl distance beating the q100 4:2:2 JPEG):`);
  for (const k of ["zB", "z02", "zBq8"] as const) {
    const same = recs.filter((r) => r.picks[k] === r.picks.libjxl).length;
    const bytes = median(recs.map((r) => bytesAt(r, r.picks[k]) / bytesAt(r, r.picks.libjxl) - 1).filter(Number.isFinite));
    const pass = k === "zBq8" ? "" : `  its pick clears libjxl's bar ${recs.filter((r) => clears(r, r.picks[k])).length}/${n}`;
    console.log(`  ${k.padEnd(5)} same distance as libjxl ${same}/${n}  median bytes vs libjxl's pick ${pct(bytes)}${pass}`);
  }
  console.log(`  B on 16 bits vs rounded to 8: same pick ${recs.filter((r) => r.picks.zB === r.picks.zBq8).length}/${n}`);
  const lift = recs.flatMap((r) => r.cands.map((c) => c.z.zB - c.z.zBq8));
  console.log(`  B's 16-bit lift over the 8-bit control: median ${median(lift).toFixed(3)}, max ${Math.max(...lift).toFixed(3)} points`);
  // hif-archive.ts bisects, which assumes the score worsens as distance grows.
  let inv = 0, steps = 0, worst = 0, invS2 = 0, stepsS2 = 0;
  for (const r of recs) {
    for (let i = 1; i < r.cands.length; i++) {
      steps++;
      const up = r.cands[i].z.zB - r.cands[i - 1].z.zB;
      if (up > 0) { inv++; worst = Math.max(worst, up); }
    }
    const lib = r.cands.filter((c) => c.lib);
    for (let i = 1; i < lib.length; i++) {
      stepsS2++;
      if ((lib[i].lib?.s2 ?? 0) > (lib[i - 1].lib?.s2 ?? 0)) invS2++;
    }
  }
  console.log(`  monotonicity, adjacent tried distances where the score IMPROVES as distance grows: B ${inv}/${steps} (worst +${worst.toFixed(2)}), ssimulacra2 ${invS2}/${stepsS2}`);
}

// ---- speed ------------------------------------------------------------------
async function speed() {
  prerequisites();
  fs.mkdirSync(WORK, { recursive: true });
  const hifs = fs.readdirSync(SRC).sort().filter((f) => /^XT.*\.HIF$/.test(f)).slice(0, 2);
  const sizes: [string, number | null][] = [["1080px", 1080], ["2048px", 2048], ["40 MP", null]];
  const sets: { size: string; ref: string; dist: string }[] = [];
  for (const f of hifs) {
    const stem = f.replace(/\.[^.]+$/, ""), full = path.join(WORK, `${stem}.full.png`);
    await sh(["sips", "-s", "format", "png", path.join(SRC, f), "--out", full]);
    for (const [size, w] of sizes) {
      const ref = path.join(WORK, `${stem}-${size}.png`), r = path.join(WORK, "r.png"), j = path.join(WORK, "e.jpg");
      if (w) await sh([ZENC, "resize", full, "--width", String(w), "--filter", "box", "--out", r]);
      await sh([SCORER, "canon", w ? r : full, ref]);
      await sh([ZENC, ref, j, "-q", "84", "--yuv", "420"]);
      const dist = path.join(WORK, `${stem}-${size}.q84.png`);
      await sh([SCORER, "canon", j, dist]);
      sets.push({ size, ref, dist });
    }
    fs.rmSync(full);
  }
  // /usr/bin/time -l: wall clock and peak RSS of the whole process, decode included.
  const timed = async (cmd: string[]) => {
    const p = Bun.spawn(["/usr/bin/time", "-l", ...cmd], { stdout: "ignore", stderr: "pipe" });
    const err = await new Response(p.stderr).text();
    await p.exited;
    return { s: Number(/([\d.]+) real/.exec(err)?.[1]), gb: Number(/(\d+)\s+maximum resident/.exec(err)?.[1]) / 2 ** 30 };
  };
  const tools: [string, (r: string, d: string) => string[]][] = [
    ["ssimulacra2", (r, d) => ["ssimulacra2", r, d]],
    ["butteraugli", (r, d) => ["butteraugli_main", r, d, "--pnorm", "3"]],
    ["zensim both, all cores", (r, d) => [SCORER, "score16", r, d]],
    ["zensim both, 1 core", (r, d) => [SCORER, "score16", r, d, "--st"]],
  ];
  const res = new Map<string, { s: number; gb: number }[]>();
  for (let rep = 0; rep < 5; rep++) {
    for (const s of sets) {
      for (const [name, cmd] of tools) {
        const k = `${s.size}\t${name}`;
        res.set(k, [...(res.get(k) ?? []), await timed(cmd(s.ref, s.dist))]);
      }
    }
  }
  console.log("\nper pair, median of 10 (2 photos x 5 runs), wall clock including decode:");
  for (const [k, v] of res) {
    const [size, name] = k.split("\t");
    console.log(`  ${size.padEnd(7)} ${name.padEnd(24)} ${(1000 * median(v.map((x) => x.s))).toFixed(0).padStart(6)} ms  ${median(v.map((x) => x.gb)).toFixed(1).padStart(5)} GB`);
  }
}

const modes: Record<string, () => Promise<void>> = { ladder, archive, speed };
const run = mode ? modes[mode] : undefined;
if (!run) {
  console.error("usage: bun tools/photos/zensim-probe.ts ladder|archive|speed [--limit N] [--jobs N] [--work DIR] [--json out]");
  process.exit(2);
}
await run();
