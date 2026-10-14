// expect.ts: record what NATIVE AVM decodes each shipped AV2 file to.
//
// usage: bun tools/photos/av2-wasm/expect.ts [--build <av2-tone encoder build dir>]

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AV2_BUILD } from "../av2-tone.ts";

const HERE = import.meta.dir;
const REPO = path.resolve(HERE, "../../..");
const i = process.argv.indexOf("--build");
const BUILD = path.resolve(i >= 0 ? process.argv[i + 1] : AV2_BUILD);
const DIR = path.join(REPO, "public/garage/av2");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "av2-expect-"));

const files = fs.readdirSync(DIR).filter((f) => f.endsWith("-av2.avif")).sort();
const expected: Record<string, { width: number; height: number; sha256: string }> = {};
try {
  for (const f of files) {
    const y4m = path.join(work, `${f}.y4m`);
    const p = Bun.spawnSync([path.join(BUILD, "avifdec"), path.join(DIR, f), y4m], { stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`avifdec ${f}: ${p.stderr.toString().slice(-300)}`);
    const b = fs.readFileSync(y4m);
    const header = b.subarray(0, b.indexOf(10)).toString();
    const px = b.subarray(b.indexOf(10, b.indexOf(10) + 1) + 1);
    expected[f] = {
      width: Number(/ W(\d+)/.exec(header)?.[1]),
      height: Number(/ H(\d+)/.exec(header)?.[1]),
      sha256: createHash("sha256").update(px).digest("hex"),
    };
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
fs.writeFileSync(path.join(HERE, "expected.json"), `${JSON.stringify(expected, null, 1)}\n`);
console.log(`${files.length} files: ${files.join(", ")}`);
