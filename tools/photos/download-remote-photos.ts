#!/usr/bin/env bun
// download-remote-photos.ts — fetch source images from the public R2-backed
// photo route for the GitHub-hosted photo pipeline.
//
//   bun tools/photos/download-remote-photos.ts <keys-file> <destination-dir>
//
// Input is one R2 object key per line. The special key "all" expands the
// current public manifest and is intended for full thumbnail re-encodes.
// Originals never enter the repository: the destination is disposable runner
// state.
//
// TWO PREREQUISITES DISAPPEAR HERE rather than move. The shell version needed
// curl to fetch and jq both to read the manifest and to @uri-encode a key;
// fetch, JSON.parse and encodeURIComponent are builtins. exif-sooc stays,
// because reading image dimensions is genuinely somebody else's job.
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { requireBins } from "./lib/prereqs.ts";

export const REQUIRES = ["exif-sooc"] as const;

/** The R2 photo contract is flat filenames. Anything else is a path or URL
 *  injection surface arriving through a workflow input. */
export const FLAT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Strip CRs, trim, drop blanks. The shell did this with sed + awk. */
export function normalizeKeys(text: string): string[] {
  return text.split("\n").map((l) => l.replace(/\r$/, "").trim()).filter(Boolean);
}

/** `all` must be the ONLY entry; a mixed file is a mistake, not a superset. */
export function wantsAll(lines: string[]): boolean {
  if (!lines.includes("all")) return false;
  if (lines.length !== 1) throw new Error("all must be the only source-key entry");
  return true;
}

if (import.meta.main) {
  const [keysFile, destDir] = process.argv.slice(2);
  if (!keysFile || !destDir) {
    console.error("usage: bun tools/photos/download-remote-photos.ts <keys-file> <destination-dir>");
    process.exit(1);
  }
  requireBins(REQUIRES);

  const origin = (process.env.PHOTO_SOURCE_ORIGIN || "https://aadhar.sh").replace(/\/$/, "");
  if (!(await Bun.file(keysFile).exists())) {
    console.error(`error: keys file not found: ${keysFile}`);
    process.exit(1);
  }
  await mkdir(destDir, { recursive: true });

  // curl's --retry 3 --retry-all-errors, kept because a runner on a flaky
  // network should not fail a whole pipeline on one transient 502.
  const get = async (url: string): Promise<Response> => {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(20_000) });
        if (r.ok) return r;
        last = new Error(`HTTP ${r.status}`);
      } catch (e) {
        last = e;
      }
      if (attempt < 3) await Bun.sleep(500 * 2 ** attempt);
    }
    throw last;
  };

  let keys: string[];
  const lines = normalizeKeys(await Bun.file(keysFile).text());
  try {
    if (wantsAll(lines)) {
      const manifest = await (await get(`${origin}/images/manifest.json`)).json();
      keys = (manifest.photos ?? []).map((p: { full?: string }) => p.full).filter(Boolean);
    } else {
      keys = lines;
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }

  const stems = new Set<string>();
  let count = 0;

  for (const key of keys) {
    if (!FLAT_KEY.test(key)) {
      console.error(`error: invalid flat photo key: ${key}`);
      process.exit(1);
    }
    const stem = key.replace(/\.[^.]*$/, "");
    if (stems.has(stem)) {
      console.error(`error: multiple source objects for stem ${stem}; choose one key`);
      process.exit(1);
    }
    stems.add(stem);

    const output = join(destDir, key);
    console.log(`fetching ${key}`);
    try {
      const r = await get(`${origin}/images/full/${encodeURIComponent(key)}`);
      await Bun.write(output, await r.arrayBuffer());
    } catch (e) {
      console.error(`error: fetching ${key}: ${(e as Error).message}`);
      process.exit(1);
    }

    // Non-empty is not enough: a 200 carrying an error page would pass it.
    // Asking a real reader for the dimensions is what proves it is an image.
    const size = (await stat(output).catch(() => null))?.size ?? 0;
    const { $ } = await import("bun");
    const dims = await $`exif-sooc -q -s3 -ImageWidth -ImageHeight ${output}`.quiet().nothrow();
    if (size === 0 || !/[0-9]/.test(dims.stdout.toString())) {
      console.error(`error: downloaded object is not a readable image: ${key}`);
      process.exit(1);
    }
    count++;
  }

  if (count === 0) {
    console.error("error: no source images selected");
    process.exit(1);
  }
  console.log(`downloaded ${count} source image(s) into ${destDir}`);
}
