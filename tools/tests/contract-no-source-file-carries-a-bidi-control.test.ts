// ── no source file carries an invisible bidi control ────────────────────────
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, assert, test } from "./contract-shared.ts";
import { repoFiles } from "../lib/repo-files.ts";

// Gotcha 85. A bidi control (U+202A-202E, U+2066-2069, U+200E/F, U+061C)
// reorders how a line DISPLAYS without changing what it parses as, which is
// the Trojan Source attack (CVE-2021-42574): a reviewer reads one program and
// the runtime runs another. On 2026-10-23 the guestbook's sanitizer regex,
// written by an agent as four-hex `\u` escapes, landed on disk holding the raw
// characters instead. The tool-input layer decodes those escapes before the
// file is written, so nothing in this repo's toolchain can stop it at the
// source; this scan is the backstop.
//
// The class is named by Unicode property, so this file never spells the
// characters it hunts and needs no self-exemption. `Bidi_Control` is exactly
// the twelve code points above.

const BIDI = /\p{Bidi_Control}/gu;
// The presence test needs its own non-global copy: `test` on a `g` regex
// advances lastIndex, and the next file would be searched from there.
const HAS_BIDI = /\p{Bidi_Control}/u;

/** Files the repo owns or is about to: tracked, intent-to-add, and untracked
 *  but not ignored, the trap that let #1410 pass locally and fail CI
 *  (gotcha 91). Ignored trees (node_modules, target, vendored clones) stay out. */
export function candidateFiles(cwd: string): string[] {
  return repoFiles([], cwd);
}

type Hit = { file: string; line: number; col: number; cp: string };

/** Every bidi control in a text file under `cwd`. A file with a NUL in its
 *  first 8000 bytes is binary by git's own rule and skipped, because a JPEG
 *  can hold the same UTF-8 bytes by chance. A tracked file deleted from the
 *  working tree is skipped too. */
export function scan(cwd: string): { hits: Hit[]; text: number } {
  const hits: Hit[] = [];
  let text = 0;
  for (const file of candidateFiles(cwd)) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(cwd, file));
    } catch {
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue;
    text++;
    const src = buf.toString("utf8");
    if (!HAS_BIDI.test(src)) continue;
    src.split("\n").forEach((row, i) => {
      for (const m of row.matchAll(BIDI)) {
        hits.push({ file, line: i + 1, col: m.index + 1, cp: `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` });
      }
    });
  }
  return { hits, text };
}

test("no tracked or untracked source file carries a bidi control", () => {
  const { hits, text } = scan(fileURLToPath(ROOT));
  // Gotcha 79: a scan that reads nothing passes. On 2026-10-23 the tree held
  // 2,273 files: 994 text, and 1,279 binary (605 .avif, 306 .br, 294 .jpg and
  // the rest images, one .wasm, one .pdf).
  assert.ok(text > 900, `scanned only ${text} text files; the enumerator is broken`);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}:${h.col} ${h.cp}`),
    [],
    "spell the class by property (/[\\p{Cc}\\p{Bidi_Control}]/gu) or build the string with String.fromCodePoint (gotcha 85)",
  );
});

test("control: the scan finds a planted control in tracked and untracked files, and skips ignored and binary ones", () => {
  const cwd = mkdtempSync(join(tmpdir(), "bidi-"));
  try {
    const rlo = String.fromCodePoint(0x202e);
    const lri = String.fromCodePoint(0x2066);
    execFileSync("git", ["init", "-q"], { cwd });
    writeFileSync(join(cwd, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(cwd, "tracked.ts"), `const ok = 1;\nconst a = "x${rlo}y";\n`);
    writeFileSync(join(cwd, "clean.ts"), "const fine = /[\\p{Bidi_Control}]/gu;\n");
    execFileSync("git", ["add", "."], { cwd });
    writeFileSync(join(cwd, "new.ts"), `// ${lri}\n`);
    writeFileSync(join(cwd, "ignored.ts"), `const b = "${rlo}";\n`);
    writeFileSync(join(cwd, "photo.bin"), Buffer.concat([Buffer.from([0xff, 0xd8, 0]), Buffer.from(rlo)]));
    const { hits, text } = scan(cwd);
    assert.deepEqual(hits.map((h) => `${h.file}:${h.line}:${h.col} ${h.cp}`).sort(), ["new.ts:1:4 U+2066", "tracked.ts:2:13 U+202E"]);
    assert.equal(text, 4, ".gitignore, clean.ts, new.ts and tracked.ts are the text files");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
