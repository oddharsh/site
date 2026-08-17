#!/usr/bin/env bun
// export-for-instagram.ts — encode photos for Instagram at the LOWEST quality
// that still clears a perceptual target, so the file you hand Instagram is as
// small as it can be without you being able to see the difference.
//
//   bun tools/photos/export-for-instagram.ts [options] <file-or-dir>...
//
//   -o, --out <dir>     destination            (default ~/Desktop/ig-export)
//   -w, --width <px>    long-edge width        (default 1080)
//   -t, --target <n>    ssimulacra2 floor      (default 70)
//   -q, --qmax <n>      quality ceiling        (default 95)
//       --qmin <n>      quality floor          (default 50)
//       --ba-max <n>    butteraugli ceiling    (optional second gate)
//       --yuv <n>       444 | 422 | 420        (default 420)
//       --calibrate     write a quality ladder instead of choosing
//       --max           encode flat at --qmax, no search
//       --keep-exif     carry EXIF across (default strips it)
//   -n, --dry-run       measure only, write nothing
//
// THE TWO METRICS ARE libjxl TOOLS, not the jpeg-xl formula's binaries: brew's
// jpeg-xl does not ship them, they need -DJPEGXL_ENABLE_TOOLS=ON, which is why
// the fallback below reaches into /opt/zerobrew/prefix/bin.
import { $ } from "bun";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { ensureZenc, requireBins } from "./lib/prereqs.ts";
import { EXIF_SOOC_MIN, versionAtLeast } from "./gen-encoding-grids.ts";

export const REQUIRES = ["sips", "exif-sooc"] as const;

export const LADDER = [60, 70, 75, 80, 85, 88, 90, 92, 95];
const SOURCE_EXT = /\.(jpg|jpeg|heic|heif|hif|png|tif|tiff)$/i;

/** EXIF orientation to the sips operations that bake it into pixels. */
export function orientOps(orientation: string): string[] {
  switch (orientation.trim()) {
    case "2": return ["f:horizontal"];
    case "3": return ["r:180"];
    case "4": return ["f:vertical"];
    case "5": return ["r:90", "f:horizontal"];
    case "6": return ["r:90"];
    case "7": return ["r:270", "f:horizontal"];
    case "8": return ["r:270"];
    default: return [];
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opts = {
    out: join(process.env.HOME!, "Desktop/ig-export"),
    width: 1080, target: 70, qmax: 95, qmin: 50,
    baMax: "" as string, yuv: "420", mode: "search" as "search" | "max" | "calibrate",
    keepExif: false, dry: false,
  };
  const inputs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") opts.out = argv[++i];
    else if (a === "-w" || a === "--width") opts.width = Number(argv[++i]);
    else if (a === "-t" || a === "--target") opts.target = Number(argv[++i]);
    else if (a === "-q" || a === "--qmax") opts.qmax = Number(argv[++i]);
    else if (a === "--qmin") opts.qmin = Number(argv[++i]);
    else if (a === "--ba-max") opts.baMax = argv[++i];
    else if (a === "--yuv") opts.yuv = argv[++i];
    else if (a === "--calibrate") opts.mode = "calibrate";
    else if (a === "--max") opts.mode = "max";
    else if (a === "--keep-exif") opts.keepExif = true;
    else if (a === "-n" || a === "--dry-run") opts.dry = true;
    else if (a.startsWith("-")) { console.error(`unknown option: ${a}`); process.exit(1); }
    else inputs.push(a);
  }
  if (!inputs.length) {
    console.error("usage: bun tools/photos/export-for-instagram.ts [options] <file-or-dir>...");
    process.exit(1);
  }
  if (!["444", "422", "420"].includes(opts.yuv)) { console.error("error: --yuv must be 444, 422 or 420"); process.exit(1); }
  for (const [flag, v] of [["--width", opts.width], ["--qmax", opts.qmax], ["--qmin", opts.qmin]] as const) {
    if (!Number.isInteger(v) || v < 0) { console.error(`error: ${flag} needs a whole number`); process.exit(1); }
  }
  if (opts.qmin > opts.qmax) { console.error(`error: --qmin (${opts.qmin}) is above --qmax (${opts.qmax})`); process.exit(1); }

  const bin = requireBins(REQUIRES);
  const version = (await $`exif-sooc --version`.quiet().nothrow()).stdout.toString().trim().split(/\s+/).at(-1) ?? "";
  if (!versionAtLeast(version, EXIF_SOOC_MIN)) {
    console.error(`error: exif-sooc ${version || "not found"} is older than ${EXIF_SOOC_MIN}, which cannot write metadata safely.`);
    process.exit(1);
  }
  const ssim = Bun.which("ssimulacra2") ?? "/opt/zerobrew/prefix/bin/ssimulacra2";
  const butter = Bun.which("butteraugli_main") ?? "/opt/zerobrew/prefix/bin/butteraugli_main";
  for (const tool of [ssim, butter]) {
    if (!(await Bun.file(tool).exists())) {
      console.error(`error: ${basename(tool)} not found (these are libjxl TOOLS, built with -DJPEGXL_ENABLE_TOOLS=ON; brew's jpeg-xl does not ship them)`);
      process.exit(1);
    }
  }
  const zenc = await ensureZenc();

  const tmp = join(tmpdir(), `ig-export-${process.pid}`);
  await mkdir(tmp, { recursive: true });

  const num = async (cmd: string, a: string, b: string, digits: number) => {
    const r = await $`${cmd} ${a} ${b}`.quiet().nothrow();
    const first = r.stdout.toString().split("\n")[0]?.trim().split(/\s+/)[0];
    return Number(first).toFixed(digits);
  };
  const s2 = (ref: string, c: string) => num(ssim, ref, c, 2);
  const ba = (ref: string, c: string) => num(butter, ref, c, 3);
  const kb = async (p: string) => `${((await stat(p)).size / 1024).toFixed(1)} KB`;
  const clears = (sc: string, bc: string) =>
    Number(sc) >= opts.target && (!opts.baMax || Number(bc) <= Number(opts.baMax));

  /** Decode to PNG at the target width, then bake the orientation in. */
  async function prepareReference(src: string, ref: string): Promise<string | null> {
    const o = (await $`exif-sooc -s -s -s -n -Orientation ${src}`.quiet().nothrow()).stdout.toString().trim();
    const dims = (await $`${bin.sips} -g pixelWidth -g pixelHeight ${src}`.quiet().nothrow()).stdout.toString();
    const w = Number(dims.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const h = Number(dims.match(/pixelHeight:\s*(\d+)/)?.[1]);
    if (!w || !h) return null;
    // A 90/270 rotation swaps which edge becomes the width, so the resample axis
    // has to follow the orientation rather than always being the width.
    const rotated = ["5", "6", "7", "8"].includes(o);
    const axis = rotated ? "--resampleHeight" : "--resampleWidth";
    const cur = rotated ? h : w;
    const r = cur > opts.width
      ? await $`${bin.sips} -s format png ${axis} ${opts.width} ${src} --out ${ref}`.quiet().nothrow()
      : await $`${bin.sips} -s format png ${src} --out ${ref}`.quiet().nothrow();
    if (r.exitCode !== 0) return null;
    for (const op of orientOps(o)) {
      const [kind, value] = op.split(":");
      const rr = await $`${bin.sips} ${kind === "r" ? "-r" : "-f"} ${value} ${ref}`.quiet().nothrow();
      if (rr.exitCode !== 0) return null;
    }
    const d2 = (await $`${bin.sips} -g pixelWidth -g pixelHeight ${ref}`.quiet()).stdout.toString();
    return `${d2.match(/pixelWidth:\s*(\d+)/)?.[1]}x${d2.match(/pixelHeight:\s*(\d+)/)?.[1]}`;
  }

  async function finish(cand: string, stem: string, src: string): Promise<number> {
    const destFile = join(opts.out, `${stem}.jpg`);
    await mkdir(opts.out, { recursive: true });
    await copyFile(cand, destFile);
    if (opts.keepExif) {
      await $`exif-sooc -TagsFromFile ${src} -all:all -Orientation#=1 -overwrite_original ${destFile}`.quiet().nothrow();
    } else {
      await $`exif-sooc -all= -overwrite_original ${destFile}`.quiet().nothrow();
    }
    return (await stat(destFile)).size;
  }

  // collect sources
  const sources = new Set<string>();
  for (const arg of inputs) {
    const st = await stat(arg).catch(() => null);
    if (st?.isDirectory()) {
      for (const f of await readdir(arg)) if (SOURCE_EXT.test(f)) sources.add(join(arg, f));
    } else if (st?.isFile()) sources.add(arg);
    else console.error(`warning: skipping ${arg} (not a file or directory)`);
  }
  const list = [...sources].sort();
  if (!list.length) { console.error("no eligible photos found in input(s)"); process.exit(1); }

  console.log(
    opts.mode === "search"
      ? `searching ${list.length} file(s) for the lowest q clearing ssimulacra2 >= ${opts.target}${opts.baMax ? ` and butteraugli <= ${opts.baMax}` : ""}`
      : opts.mode === "max"
        ? `encoding ${list.length} file(s) flat at q${opts.qmax} — the mode for handing Instagram a source it will re-encode`
        : `building the quality ladder for ${list.length} file(s) — flip through these on the phone you post from`,
  );
  console.log(`  ${opts.width}px wide · zenc ${opts.yuv[0]}:${opts.yuv[1]}:${opts.yuv[2]} · ${opts.keepExif ? "EXIF carried" : "metadata stripped"}`);
  if (opts.dry) console.log("  DRY RUN — measuring only, nothing will be written");
  console.log("");

  let ok = 0, missed = 0, failed = 0;
  try {
    for (const f of list) {
      const stem = basename(f, extname(f));
      const ref = join(tmp, `${stem}-ref.png`);
      const size = await prepareReference(f, ref);
      if (!size) { console.log(`  ${stem} — could not decode, skipped`); failed++; continue; }

      if (opts.mode === "calibrate") {
        const dir = join(opts.out, `${stem}-ladder`);
        if (!opts.dry) { await mkdir(dir, { recursive: true }); await copyFile(ref, join(dir, "original.png")); }
        console.log(`${stem}  ${size}`);
        console.log(`    ${"q".padEnd(4)} ${"bytes".padEnd(11)} ${"ssim2".padEnd(8)} ${"butter".padEnd(8)}`);
        for (const q of LADDER) {
          const cand = join(tmp, `${stem}-${q}.jpg`);
          if ((await $`${zenc} ${ref} ${cand} -q ${q} --yuv ${opts.yuv}`.quiet().nothrow()).exitCode !== 0) continue;
          const sc = await s2(ref, cand), bc = await ba(ref, cand);
          const mark = clears(sc, bc) ? `← clears ${opts.target}` : "";
          console.log(`    ${String(q).padEnd(4)} ${(await kb(cand)).padEnd(11)} ${sc.padEnd(8)} ${bc.padEnd(8)} ${mark}`);
          if (!opts.dry) await copyFile(cand, join(dir, `q${q}.jpg`));
        }
        console.log("");
        ok++;
        continue;
      }

      const top = join(tmp, `${stem}-top.jpg`);
      if ((await $`${zenc} ${ref} ${top} -q ${opts.qmax} --yuv ${opts.yuv}`.quiet().nothrow()).exitCode !== 0) {
        console.log(`  ${stem} — encode failed`); failed++; continue;
      }
      const topBytes = (await stat(top)).size;

      if (opts.mode === "max") {
        const sc = await s2(ref, top), bc = await ba(ref, top);
        const outBytes = opts.dry ? topBytes : await finish(top, stem, f);
        console.log(`  ${stem.padEnd(14)} ${size.padEnd(11)} q${String(opts.qmax).padEnd(3)} ${`${(outBytes / 1024).toFixed(1)} KB`.padEnd(11)} s2 ${sc.padEnd(7)} ba ${bc}`);
        ok++;
        continue;
      }

      // binary search for the LOWEST q that still clears the gate
      let lo = opts.qmin, hi = opts.qmax;
      let best = 0, bestS2 = "", bestBa = "", bestFile = "";
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const cand = join(tmp, `${stem}-try.jpg`);
        if ((await $`${zenc} ${ref} ${cand} -q ${mid} --yuv ${opts.yuv}`.quiet().nothrow()).exitCode !== 0) break;
        const sc = await s2(ref, cand);
        const bc = opts.baMax ? await ba(ref, cand) : "";
        if (clears(sc, bc)) {
          best = mid; bestS2 = sc; bestBa = bc;
          bestFile = join(tmp, `${stem}-best.jpg`);
          await copyFile(cand, bestFile);
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }

      if (!best) {
        const sc = await s2(ref, top), bc = await ba(ref, top);
        const outBytes = opts.dry ? topBytes : await finish(top, stem, f);
        console.log(`  ${stem.padEnd(14)} ${size.padEnd(11)} q${String(opts.qmax).padEnd(3)} ${`${(outBytes / 1024).toFixed(1)} KB`.padEnd(11)} s2 ${sc.padEnd(7)} ba ${bc.padEnd(7)} MISSED target ${opts.target} at q${opts.qmax}`);
        missed++;
        continue;
      }

      const bestBytes = (await stat(bestFile)).size;
      if (!bestBa) bestBa = await ba(ref, bestFile);
      const outBytes = opts.dry ? bestBytes : await finish(bestFile, stem, f);
      const pct = `${(((bestBytes - topBytes) * 100) / topBytes >= 0 ? "+" : "")}${(((bestBytes - topBytes) * 100) / topBytes).toFixed(0)}%`;
      console.log(`  ${stem.padEnd(14)} ${size.padEnd(11)} q${String(best).padEnd(3)} ${`${(outBytes / 1024).toFixed(1)} KB`.padEnd(11)} s2 ${bestS2.padEnd(7)} ba ${bestBa.padEnd(7)} ${pct} vs q${opts.qmax}`);
      ok++;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log(`\ndone — ${ok} ok · ${missed} missed target · ${failed} failed`);
  if (!opts.dry && opts.mode !== "calibrate") console.log(`written to ${opts.out}`);
  if (!opts.dry && opts.mode === "calibrate") console.log(`ladders in ${opts.out} — the rung you stop seeing is your --target`);
}
