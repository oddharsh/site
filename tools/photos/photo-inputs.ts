import { access, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

const JPEG = new Set([".jpg", ".jpeg"]);
const HEIF = new Set([".hif", ".heic", ".heif"]);
const extension = (file: string) => path.extname(file).toLowerCase();
const stemOf = (file: string) => path.basename(file, path.extname(file));

export type PhotoInput = { stem: string; source: string; original: string | null; full: string };

/** Resolve each published stem once, before encoders or uploads can write it. */
export async function photoInputs(
  inputs: string[],
  { remote = false, published }: { remote?: boolean; published?: ReadonlySet<string> } = {},
): Promise<PhotoInput[]> {
  const files = new Set<string>();
  const eligible = (file: string) => JPEG.has(extension(file)) || HEIF.has(extension(file)) ||
    (published !== undefined && extension(file) === ".png");
  const include = async (file: string) => {
    if (published && !published.has(stemOf(file))) return;
    // Resolve directory aliases while retaining the requested filename/key.
    files.add(path.join(await realpath(path.dirname(file)), path.basename(file)));
  };
  for (const input of inputs) {
    const resolved = path.resolve(input);
    const info = await stat(resolved);
    if (info.isDirectory()) {
      for (const entry of await readdir(resolved, { withFileTypes: true })) {
        if (entry.isFile() && eligible(entry.name)) await include(path.join(resolved, entry.name));
      }
    } else if (info.isFile() && eligible(resolved)) {
      await include(resolved);
    } else {
      throw new Error(`unsupported photo input: ${input}`);
    }
  }

  // An explicitly requested HEIF may have a camera JPEG beside it even when
  // that JPEG was not an argument. It is the existing click-through contract.
  for (const file of [...files]) {
    if (!HEIF.has(extension(file))) continue;
    for (const entry of await readdir(path.dirname(file), { withFileTypes: true })) {
      if (entry.isFile() && stemOf(entry.name) === stemOf(file) && JPEG.has(extension(entry.name))) {
        await include(path.join(path.dirname(file), entry.name));
      }
    }
  }

  // A HIF photo's archive is JPEG XL encoded from the HIF (hif-archive.ts), so
  // the downloader leaves a .jxl and a decoded PNG and no JPEG. Remote ingest
  // has nothing to re-ingest there: the original is already what ingest would
  // make. Say so, rather than dropping the photo from the plan without a word.
  if (remote) {
    const jpegStems = new Set([...files].filter((file) => JPEG.has(extension(file))).map(stemOf));
    for (const input of inputs) {
      const dir = path.resolve(input);
      const entries = (await stat(dir)).isDirectory() ? await readdir(dir) : [];
      const direct = entries.filter((e) => extension(e) === ".jxl" && !jpegStems.has(stemOf(e)));
      if (direct.length) {
        throw new Error(`remote ingest cannot re-ingest ${direct.map(stemOf).join(", ")}: the archive is JPEG XL encoded from the HIF, with no JPEG behind it. Rerender tiles with reencode-thumbnails and metadata with refresh-metadata.`);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const file of [...files].sort()) {
    const stem = stemOf(file);
    const group = groups.get(stem) ?? [];
    group.push(file);
    groups.set(stem, group);
  }
  const plan: PhotoInput[] = [];
  for (const stem of [...(published ?? groups.keys())].sort()) {
    const group = groups.get(stem) ?? [];
    if (group.length === 0) {
      // A partial rerender deliberately leaves missing published stems alone.
      plan.push({ stem, source: "", original: null, full: "" });
      continue;
    }
    const heif = group.filter(file => HEIF.has(extension(file)));
    const jpeg = group.filter(file => JPEG.has(extension(file)));
    const pair = group.length === 2 && heif.length === 1 && jpeg.length === 1 &&
      path.dirname(heif[0]) === path.dirname(jpeg[0]);
    if (group.length > 1 && !pair) {
      throw new Error(`ambiguous photo stem ${stem}; select one source or one same-folder HEIF/JPEG pair:\n  ${group.join("\n  ")}`);
    }
    const source = heif[0] ?? group[0];
    let original = jpeg[0] ?? null;
    if (remote && HEIF.has(extension(source))) {
      throw new Error(`remote ingest needs the existing JPEG object for ${stem}; select that key instead of its HEIF original`);
    }
    let full = original ? (remote ? path.basename(original) : `${stem}${extension(original)}`) : `${stem}.jpg`;
    // A remote JPEG XL original arrives as the .jxl plus the JPEG djxl rebuilt
    // from it (download-remote-photos.sh), which keeps the .jxl in <dir>.r2 so
    // exif-sooc never scans it (an older layout kept it beside the JPEG). The
    // JPEG feeds the encoders; the .jxl is the R2 object, so it names the key
    // and its bytes give the size.
    if (remote && original) {
      const dir = path.dirname(original);
      for (const jxl of [path.join(`${dir}.r2`, `${stem}.jxl`), path.join(dir, `${stem}.jxl`)]) {
        if (await access(jxl).then(() => true, () => false)) { original = jxl; full = path.basename(jxl); break; }
      }
    }
    plan.push({ stem, source, original, full });
  }
  if (plan.length === 0) throw new Error("no eligible photos selected");
  return plan;
}

async function main() {
  const [mode, ...inputs] = process.argv.slice(2);
  let plan: PhotoInput[];
  if (mode === "ingest" && inputs.length > 0) {
    plan = await photoInputs(inputs, { remote: process.env.REMOTE_RENDER_ONLY === "1" });
  } else if (mode === "rerender" && inputs.length === 2) {
    const [source, tiles] = inputs;
    const published = new Set((await readdir(tiles)).filter(file => file.endsWith(".jpg"))
      .map(file => stemOf(stemOf(file))));
    plan = await photoInputs([source], { published });
  } else {
    throw new Error("usage: photo-inputs.ts ingest <file-or-dir>... | rerender <source-dir> <published-tiles-dir>");
  }
  // Four NUL-terminated fields per photo. Bash 3.2 can read this without
  // splitting spaces, tabs, newlines, or shell metacharacters in source paths.
  process.stdout.write(plan.flatMap(({ source, original, full, stem }) => [source, original ?? "", full, stem])
    .map(field => `${field}\0`).join(""));
}

if (import.meta.main) {
  main().catch(error => { console.error(`error: ${error.message}`); process.exitCode = 1; });
}
