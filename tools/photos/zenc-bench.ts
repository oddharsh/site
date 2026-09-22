#!/usr/bin/env bun
// zenc-bench.ts: is the working tree's zenc FASTER than a baseline, with
// BYTE-IDENTICAL output? The instrument for iterating on zenc's speed.
//
//   bun run zenc:bench                     baseline = merge-base with origin/main
//   bun run zenc:bench -- --ref <rev>      any commit as the baseline
//   bun run zenc:bench -- --trials 9       alternating pairs per source (default 5)
//   bun run zenc:bench -- --parallel 8     THROUGHPUT: the corpus through 8 workers,
//                                          which is how add-photos.sh runs it
//   SRC=/path bun run zenc:bench           a different source folder
//
// THE GATE RUNS BEFORE THE TIMER, and a mismatch prints no timing at all. `/i/`
// is content-addressed, so a zenc that is faster and moves one byte re-mints
// every URL it touches and orphans the histograms and page dictionaries built
// on them (gotchas 35 and 46). A speedup on different output is a different
// encoder, and the only honest thing to print about it is the file that moved.
//
// The loop this serves came from Max Woolf's agentic-iteration writeup
// (minimaxir.com/2026/09/agentic-iteration): baseline, demand a quantified
// floor, forbid the known cheats, iterate to convergence. His fitness function
// is criterion's statistics, and his cheats are an agent gaming a measurement
// that stays real (disabling a physics engine for a 34,500x "speedup"). Byte
// identity closes that whole class here: skipping work, loosening a quality
// knob and trimming a trial all fail `cmp` on the first source.
//
// WHY NOT CRITERION, which is what this was first proposed as. criterion times
// functions inside ONE build, and the question is two builds of one command.
// It would also land in tools/photos/zenc/Cargo.lock, which config/derivations.json
// declares an input to the histogram bake, and compile inside the required
// validate job on every PR via `clippy --all-targets`. Interleaved runs of the
// two binaries answer the actual question with no dependency at all.
//
// THE CONTROL IS THE POINT, the same rule zenc:reproducible and onestep:probe
// carry. A comparison that finds nothing is worthless until it has found
// something, so one source is re-encoded at --jpeg-quality 83 and exactly its
// JPEG must be reported as moved, with its three AVIFs untouched.
//
// WHERE THE TIME GOES, measured 2026-09-22 and printed on every run so nobody
// iterates blind. libavif at speed 2 takes most of a photo, and its --jobs and
// speed settings are QUALITY flags here (gotcha 43), so under byte identity that
// share can only be rescheduled, never tuned. Decode, orient, linearise and the
// three full-frame resamples are zenc's own code, and the first run put them at
// 28% of the corpus, a ceiling of 1.38x before touching any encoder:
//
//   upright sources   13-23% ours   ceiling 1.14-1.30x
//   rotated sources   29-45% ours   ceiling 1.41-1.81x
//
// ROTATION IS THE FIRST TARGET that split names. On one 26 MP JPEG, interleaved,
// the floor reads 520 ms upright, 745 ms at orientation 3, 780 ms at 6 and 880
// ms at 8, so orient() costs 225-360 ms, and 135 of the 185 sources are rotated.
// Orientation 3 transposes nothing and still costs 225 ms, which suggests the
// permuted full-frame copy rather than the access pattern. Reading the source
// through the orientation inside the resample would skip that copy while moving
// the same values in the same order, so it is identity by construction.
//
// The histogram bake is not worth a loop: 0.6 s for all 258 stems.
//
// LATENCY IS NOT THROUGHPUT, and the default measures latency. add-photos.sh
// runs 8 photos at once (JOBS) and every AVIF encode already takes 4 threads, so
// a change that parallelises INSIDE one photo can win this bench's default mode
// and lose the pipeline. Any change that adds threads owes a --parallel 8 run.
//
// It is a workstation instrument like zenc:reproducible: it needs the SOOC
// originals, cargo, libavif, sips (for HIF) and exif-sooc. Nothing is written
// into the repository except the cached baseline build under target/, which is
// gitignored.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ── the production command ──────────────────────────────────────────────────
// add-photos.sh's `zenc square` call, flag for flag. contract-zenc-bench-times-
// the-production-command holds these to that script, because a bench that
// times a different command measures nothing anybody ships.
export const JPEG_QUALITY = 84;
export const FILTER = "box";
export const TIERS: readonly { size: number; outputs: readonly ("avif" | "jpeg")[] }[] = [
  { size: 600, outputs: ["avif", "jpeg"] },
  { size: 400, outputs: ["avif"] },
  { size: 200, outputs: ["avif"] },
];

/** The argv for one photo, writing `<size>.avif` / `<size>.jpg` into `dir`. */
export function productionArgs(input: string, orient: string, dir: string, quality = JPEG_QUALITY): string[] {
  const args = ["square", input, "--orient", orient, "--filter", FILTER, "--jpeg-quality", String(quality)];
  for (const tier of TIERS) {
    args.push("--size", String(tier.size));
    for (const kind of tier.outputs) {
      args.push(kind === "avif" ? "--avif-out" : "--jpeg-out", join(dir, `${tier.size}.${kind === "avif" ? "avif" : "jpg"}`));
    }
  }
  return args;
}

/** Everything productionArgs writes, by file name. */
export const OUTPUT_FILES: readonly string[] = TIERS.flatMap((t) => t.outputs.map((k) => `${t.size}.${k === "avif" ? "avif" : "jpg"}`));

// ── the corpus ──────────────────────────────────────────────────────────────
// One source per class production actually meets, first in sorted order so the
// corpus is the same on every run. Counts are the library on 2026-09-22.
export type Probe = { SourceFile: string; Orientation?: number; Model?: string };
export type Source = { file: string; cls: string; orient: string };

export function classify(p: Probe): string | null {
  const ext = p.SourceFile.split(".").pop()!.toUpperCase();
  const orient = p.Orientation ?? 1;
  const model = p.Model ?? "";
  if (model.includes("MONOCHROM")) return "monochrom jpeg (gray path, YUV400)"; // 3
  if (ext === "HIF") return orient === 1 ? "x-t50 hif, upright" : "x-t50 hif, rotated"; // 38 / 101
  if (ext !== "JPG") return null;
  if (orient === 1) return "x-t50 jpeg, upright"; // 10
  if (orient === 6) return "x-t50 jpeg, orientation 6"; // 1, XT507876 (gotcha 3)
  return "x-t50 jpeg, rotated"; // 32
}

export function pickCorpus(probes: readonly Probe[]): Source[] {
  const seen = new Map<string, Source>();
  for (const p of [...probes].sort((a, b) => (a.SourceFile < b.SourceFile ? -1 : 1))) {
    const cls = classify(p);
    if (cls && !seen.has(cls)) seen.set(cls, { file: p.SourceFile, cls, orient: String(p.Orientation ?? 1) });
  }
  return [...seen.values()];
}

// ── statistics ──────────────────────────────────────────────────────────────
export const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The instrument's own wobble on one side: (max - min) / median. */
export const spread = (xs: readonly number[]): number => (Math.max(...xs) - Math.min(...xs)) / median(xs);

export const geomean = (xs: readonly number[]): number => Math.exp(xs.reduce((a, x) => a + Math.log(x), 0) / xs.length);

// ── the run ─────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const ROOT = fileURLToPath(new URL("../..", import.meta.url));
  const CRATE = join(ROOT, "tools/photos/zenc");
  const SRC = process.env.SRC ?? "/Users/aadharsh/Downloads/to post (from ssd)";

  const argv = process.argv.slice(2);
  const flag = (name: string, fallback: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const TRIALS = Number(flag("--trials", "5"));
  const PARALLEL = Number(flag("--parallel", "0"));
  if (!Number.isInteger(TRIALS) || TRIALS < 3) die("--trials needs an integer of at least 3, since a median of two is an average");
  if (!Number.isInteger(PARALLEL) || PARALLEL < 0) die("--parallel needs a worker count");

  const run = (cmd: string[], cwd = ROOT, env?: Record<string, string>) =>
    Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: env ? { ...process.env, ...env } : undefined });
  const text = (r: ReturnType<typeof run>) => r.stdout.toString().trim();

  for (const tool of ["cargo", "exif-sooc", "sips", "git", "tar"]) {
    if (!Bun.which(tool)) die(`needs ${tool} on PATH (bun run tools:check lists the photo prerequisites)`);
  }
  if (!existsSync(SRC)) die(`no source folder at ${SRC}; set SRC=`);

  // A timer on a busy machine is the instrument lying (gotcha 15), and several
  // sessions share this one. Say so before any number is printed.
  const [load] = loadavg();
  const cores = availableParallelism();
  console.log(`load average ${load.toFixed(1)} on ${cores} cores${load > cores / 2 ? ": BUSY. Timings will be noisy; the gate is unaffected." : ""}`);

  const scratch = mkdtempSync(join(tmpdir(), "zenc-bench-"));
  process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

  // ── two binaries ─────────────────────────────────────────────────────────
  const refArg = flag("--ref", "");
  const base = refArg || text(run(["git", "merge-base", "HEAD", "origin/main"]));
  if (!base) die("could not resolve a baseline; pass --ref");
  const baseSha = text(run(["git", "rev-parse", "--short=10", `${base}^{commit}`]));
  const tree = text(run(["git", "rev-parse", `${base}:tools/photos/zenc`]));
  if (!baseSha || !tree) die(`${base} has no tools/photos/zenc`);
  const same = run(["git", "diff", "--quiet", base, "--", "tools/photos/zenc"]).exitCode === 0;

  // The baseline is cached by the zenc TREE it was built from, not by commit, so
  // an agent iterating on top of one baseline pays for its build once.
  const cached = join(CRATE, "target/bench-baseline", tree, "zenc");
  if (!existsSync(cached)) {
    const src = join(scratch, "baseline-src");
    mkdirSync(src);
    const archive = run(["sh", "-c", `git archive ${base} tools/photos/zenc | tar -x -C "${src}"`]);
    if (archive.exitCode !== 0) die(`git archive of ${base} failed: ${archive.stderr.toString().trim()}`);
    console.log(`building baseline zenc at ${baseSha} (cached afterwards by tree ${tree.slice(0, 10)})`);
    const build = run(["cargo", "build", "--release", "--locked", "--manifest-path", join(src, "tools/photos/zenc/Cargo.toml")], ROOT,
      { CARGO_TARGET_DIR: join(CRATE, "target/bench-baseline/build") });
    if (build.exitCode !== 0) die(`baseline build failed:\n${build.stderr.toString().trim()}`);
    mkdirSync(join(CRATE, "target/bench-baseline", tree), { recursive: true });
    copyFileSync(join(CRATE, "target/bench-baseline/build/release/zenc"), cached);
  }
  console.log("building candidate zenc from the working tree");
  const cand = run(["cargo", "build", "--release", "--locked", "--manifest-path", join(CRATE, "Cargo.toml")]);
  if (cand.exitCode !== 0) die(`candidate build failed:\n${cand.stderr.toString().trim()}`);
  // Copied aside so a rebuild in another terminal cannot swap a binary mid-run.
  const A = join(scratch, "zenc-baseline");
  const B = join(scratch, "zenc-candidate");
  copyFileSync(cached, A);
  copyFileSync(join(CRATE, "target/release/zenc"), B);
  run(["chmod", "+x", A, B]);

  console.log(same
    ? `\nbaseline ${baseSha} and the working tree hold the SAME zenc source: this run measures the instrument's noise floor`
    : `\nbaseline ${baseSha} vs the working tree`);

  // ── the corpus ───────────────────────────────────────────────────────────
  const files = readdirSync(SRC).filter((f) => /\.(jpe?g|hif)$/i.test(f));
  const probe = run(["exif-sooc", "-j", "-n", "-Orientation", "-Model", ...files], SRC);
  if (probe.exitCode !== 0) die(`exif-sooc failed: ${probe.stderr.toString().trim()}`);
  const corpus = pickCorpus(JSON.parse(probe.stdout.toString()) as Probe[]);
  if (corpus.length < 4) die(`only ${corpus.length} source classes found in ${SRC}; the gate needs both sensors and both orientations`);

  // A HIF reaches zenc as the full-resolution TIFF sips writes, exactly as in
  // add-photos.sh, so the sips step is outside what either binary is timed on.
  const inputs = new Map<string, string>();
  for (const s of corpus) {
    let input = join(SRC, s.file);
    if (/\.hif$/i.test(s.file)) {
      input = join(scratch, `${s.file}.tiff`);
      if (run(["sips", "-s", "format", "tiff", join(SRC, s.file), "--out", input]).exitCode !== 0) die(`sips could not convert ${s.file}`);
    }
    inputs.set(s.file, input);
  }
  console.log(`corpus: ${corpus.length} sources, one per class`);
  for (const s of corpus) console.log(`  ${s.file.padEnd(18)} ${s.cls}`);

  const outDir = (who: string, s: Source) => {
    const d = join(scratch, "out", who, s.file);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const encode = (bin: string, s: Source, dir: string, quality = JPEG_QUALITY) => {
    const r = run([bin, ...productionArgs(inputs.get(s.file)!, s.orient, dir, quality)]);
    if (r.exitCode !== 0) die(`${bin === A ? "baseline" : "candidate"} failed on ${s.file}: ${r.stderr.toString().trim()}`);
  };
  // Every production output must exist and be non-empty on both sides, so a
  // binary that writes nothing cannot agree with another that writes nothing.
  const differing = (a: string, b: string) => OUTPUT_FILES.filter((f) => {
    const [x, y] = [join(a, f), join(b, f)];
    if (!existsSync(x) || !existsSync(y)) die(`${f} missing under ${existsSync(x) ? b : a}`);
    const [bx, by] = [readFileSync(x), readFileSync(y)];
    if (!bx.length || !by.length) die(`${f} is empty`);
    return !bx.equals(by);
  });

  // ── the gate ─────────────────────────────────────────────────────────────
  console.log("\ngate: every production output, byte for byte");
  const moved: string[] = [];
  for (const s of corpus) {
    const [da, db] = [outDir("baseline", s), outDir("candidate", s)];
    encode(A, s, da);
    encode(B, s, db);
    for (const f of differing(da, db)) moved.push(`${s.file}/${f}`);
  }

  // The bake shares pixels.rs with square, so a decode change has to hold here too.
  const hashes = join(ROOT, "public/images/hashes.json");
  const bake = (bin: string, name: string) => {
    const root = join(scratch, "bake", name);
    mkdirSync(join(root, "images/meta"), { recursive: true });
    copyFileSync(hashes, join(root, "images/hashes.json"));
    run(["ln", "-s", join(ROOT, "public/i"), join(root, "i")]);
    const r = run([bin, "histogram", "--root", root]);
    if (r.exitCode !== 0) die(`histogram bake failed under ${name}: ${r.stderr.toString().trim()}`);
    const meta = join(root, "images/meta");
    return new Map(readdirSync(meta).map((f) => [f, readFileSync(join(meta, f), "utf8")]));
  };
  const [ha, hb] = [bake(A, "baseline"), bake(B, "candidate")];
  if (ha.size < 100) die(`the bake wrote ${ha.size} meta files, under the floor of 100`);
  if (ha.size !== hb.size) moved.push(`histograms: ${ha.size} stems vs ${hb.size}`);
  for (const [f, body] of ha) if (hb.get(f) !== body) moved.push(`histogram ${f}`);

  // ── the control ──────────────────────────────────────────────────────────
  const victim = corpus[0];
  const control = outDir("control", victim);
  encode(B, victim, control, JPEG_QUALITY - 1);
  const seen = differing(outDir("candidate", victim), control);
  if (seen.length !== 1 || seen[0] !== "600.jpg") {
    die(`control failed: --jpeg-quality ${JPEG_QUALITY - 1} on ${victim.file} moved [${seen.join(", ")}], expected exactly 600.jpg. The comparison cannot be trusted.`);
  }
  console.log(`  control ok: q${JPEG_QUALITY - 1} on ${victim.file} moves exactly its 600.jpg and none of its AVIFs`);

  if (moved.length) {
    console.log(`\nGATE FAILED: ${moved.length} output(s) differ from baseline ${baseSha}`);
    for (const m of moved.slice(0, 20)) console.log(`  moved  ${m}`);
    console.log("\nNo timing is printed. A faster zenc with different bytes re-mints /i/ URLs and");
    console.log("orphans their histograms (CLAUDE.md gotchas 35, 46); that is a different encoder.");
    process.exit(1);
  }
  console.log(`  identical: ${corpus.length * OUTPUT_FILES.length} square outputs and ${ha.size} histograms`);

  // ── the timer ────────────────────────────────────────────────────────────
  // Alternating A/B, never all-A then all-B, so thermal drift and background
  // load land on both sides. One untimed warm-up each pulls the input into the
  // page cache before anything is measured.
  const time = (fn: () => void) => { const t = performance.now(); fn(); return performance.now() - t; };
  const ms = (x: number) => `${x.toFixed(0).padStart(6)} ms`;

  if (PARALLEL > 0) {
    // Throughput: the whole corpus, repeated to keep every worker busy, through
    // a pool of PARALLEL processes. The unit is batch wall-clock.
    const jobs = Array.from({ length: Math.max(PARALLEL * 2, corpus.length) }, (_, i) => corpus[i % corpus.length]);
    const batch = async (bin: string, who: string) => {
      const t = performance.now();
      let next = 0;
      await Promise.all(Array.from({ length: PARALLEL }, async () => {
        while (next < jobs.length) {
          const i = next++;
          const s = jobs[i];
          const p = Bun.spawn([bin, ...productionArgs(inputs.get(s.file)!, s.orient, outDir(`${who}-p${i}`, s))], { stdout: "ignore", stderr: "pipe" });
          if ((await p.exited) !== 0) die(`${who} failed on ${s.file} under --parallel`);
        }
      }));
      return performance.now() - t;
    };
    console.log(`\nthroughput: ${jobs.length} photos through ${PARALLEL} workers, ${TRIALS} alternating batches`);
    await batch(A, "baseline");
    await batch(B, "candidate");
    const [ta, tb]: number[][] = [[], []];
    for (let i = 0; i < TRIALS; i++) {
      ta.push(await batch(A, "baseline"));
      tb.push(await batch(B, "candidate"));
    }
    report([{ label: `batch of ${jobs.length}`, a: ta, b: tb }]);
  } else {
    console.log(`\nlatency: ${TRIALS} alternating pairs per source, after one warm-up each`);
    const rows: Row[] = [];
    for (const s of corpus) {
      const [da, db] = [outDir("baseline", s), outDir("candidate", s)];
      encode(A, s, da);
      encode(B, s, db);
      const [ta, tb]: number[][] = [[], []];
      for (let i = 0; i < TRIALS; i++) {
        ta.push(time(() => encode(A, s, da)));
        tb.push(time(() => encode(B, s, db)));
      }
      rows.push({ label: s.file, a: ta, b: tb });
    }
    report(rows);

    // ── where the time goes ────────────────────────────────────────────────
    // The candidate with the same NUMBER of tiers at 8px and no AVIF. tier()
    // resamples the full source once per tier (the 400 and 200 tiers are never
    // resamples of the 600, which was a defect), so this is decode, orient,
    // linearise and three full-frame resamples, plus encodes too small to
    // register. That is zenc's own code. It slightly UNDERSTATES it, because an
    // 8px vertical pass is cheaper than a 600px one, so the ceiling it implies
    // is conservative. Everything above it is the encoders.
    console.log("\nwhere the candidate's time goes (zenc's own code vs the encoders)");
    const floors: number[] = [];
    const totals: number[] = [];
    for (const s of corpus) {
      const d = join(scratch, "floor", s.file);
      mkdirSync(d, { recursive: true });
      const floorArgs = ["square", inputs.get(s.file)!, "--orient", s.orient, "--filter", FILTER,
        ...TIERS.flatMap((_, i) => ["--size", "8", "--jpeg-out", join(d, `f${i}.jpg`)])];
      run([B, ...floorArgs]);
      const f = median(Array.from({ length: TRIALS }, () => time(() => { if (run([B, ...floorArgs]).exitCode !== 0) die(`floor run failed on ${s.file}`); })));
      const total = median(rows.find((r) => r.label === s.file)!.b);
      floors.push(f);
      totals.push(total);
      console.log(`  ${s.file.padEnd(18)} ${ms(total)}   our code ${ms(f)} (${((100 * f) / total).toFixed(0).padStart(2)}%)   ceiling if ours were free ${(total / Math.max(total - f, 1)).toFixed(2)}x`);
    }
    const [F, T] = [floors.reduce((a, x) => a + x, 0), totals.reduce((a, x) => a + x, 0)];
    console.log(`  corpus: our code is ${((100 * F) / T).toFixed(0)}% of the time; ceiling ${(T / (T - F)).toFixed(2)}x before touching an encoder,`);
    console.log("  and the encoders' knobs are quality flags (gotcha 43), so the rest can only be rescheduled.");
  }

  type Row = { label: string; a: number[]; b: number[] };
  // Each source is judged against ITS OWN noise. A corpus-wide worst case would
  // let one bad trial on one photo erase a real win on five others, which errs
  // the safe way and still hides exactly what the loop is looking for.
  function report(rows: Row[]) {
    console.log(`  ${"".padEnd(18)} ${"baseline".padStart(9)} ${"candidate".padStart(9)}   speedup    noise`);
    const ratios: number[] = [];
    let [won, lost] = [0, 0];
    for (const r of rows) {
      const [ma, mb] = [median(r.a), median(r.b)];
      const n = Math.max(spread(r.a), spread(r.b));
      const ratio = ma / mb;
      ratios.push(ratio);
      const call = Math.abs(ratio - 1) <= n ? "" : ratio > 1 ? "  faster" : "  SLOWER";
      if (call === "  faster") won++;
      if (call === "  SLOWER") lost++;
      console.log(`  ${r.label.padEnd(18)} ${ms(ma)} ${ms(mb)}   ${ratio.toFixed(3)}x   ±${(100 * n).toFixed(1).padStart(4)}%${call}`);
    }
    const g = geomean(ratios);
    const verdict = lost
      ? `SLOWER beyond noise on ${lost} of ${rows.length}${won ? `, faster on ${won}` : ""}`
      : won
        ? `FASTER beyond noise on ${won} of ${rows.length}, slower on none`
        : "no source moved beyond its own noise: no measurable difference";
    console.log(`\n  geomean speedup ${g.toFixed(3)}x: ${verdict}`);
  }
}

function die(msg: string): never {
  console.error(`zenc:bench: ${msg}`);
  process.exit(2);
}
