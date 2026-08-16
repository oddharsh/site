#!/usr/bin/env bun
// bun run bun:canary:check
//
// Asserts that the bun on PATH is the one config/bun-canary.json declares, and
// that it can still do the one thing this repo's build depends on.
//
// WHY A DIGEST AND NOT A VERSION. bun 1.4 is unreleased. It is on npm in no
// form (newest there is 1.3.14 from 2026-05-13; the `canary` dist-tag points at
// a 1.3.13 canary), so the 1.4 line ships only as a GitHub release asset under
// the tag `canary` — and that tag ROLLS. Measured 2026-08-16: the
// darwin-aarch64 asset reported updated_at of that same morning, the release
// was titled after a different commit than the binary reports, and no immutable
// per-canary tag exists (bun-v1.4.0-canary.1 answers 404).
//
// So `1.4.0-canary.1` is a LABEL, not a pin. It stays fixed while the binary
// under it changes daily. That is the worst possible shape for this repo,
// because /a/ and /i/ are content-addressed: a compiler swapped underneath them
// re-mints URLs and orphans every committed dictionary, and nothing says a word.
//
// This is the workstation twin of .github/actions/setup-bun. Same two questions.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";

const decl = JSON.parse(readFileSync(new URL("../config/bun-canary.json", import.meta.url), "utf8"));
const key = process.platform === "darwin" ? "darwin-aarch64" : "linux-x64";
const plat = decl.platforms[key];

let failed = 0;
const say = (ok, name, detail) => {
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? `\n          ${detail}` : ""}`);
};

console.log(`config/bun-canary.json declares ${decl.revision}\n`);

// 1 — identity. Which bun is actually running this?
const running = execFileSync(process.execPath, ["--revision"], { encoding: "utf8" }).trim();
say(running === decl.revision, "the running bun is the declared revision",
  running === decl.revision ? "" : `running ${running}, declared ${decl.revision}`);

// 2 — the digest, which is the actual pin. Read the binary this process is.
const digest = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");
say(digest === plat.binary_sha256, `the ${key} binary matches the declared SHA-256`,
  digest === plat.binary_sha256
    ? ""
    : `running ${digest}\n          declared ${plat.binary_sha256}\n          The canary tag rolls. If this is a deliberate bump, re-run the\n          byte-identical build control and commit the new digest.`);

// 3 — the capability, which is why the version matters at all. bun 1.3.14
// ACCEPTS `dictionary` and silently ignores it: the compressed size never
// shrinks, the frame still decodes against the dictionary, and the API reports
// nothing. That ships no-op dcz deltas (gotcha 28).
const target = Buffer.from("the quick brown fox jumps over the lazy dog. ".repeat(40));
const dict = Buffer.from("the quick brown fox jumps over the lazy dog. ".repeat(10));
const none = zstdCompressSync(target).length;
const good = zstdCompressSync(target, { dictionary: dict }).length;
const wrong = zstdCompressSync(target, { dictionary: Buffer.from("z".repeat(430)) }).length;
say(good < none, "zstd honours the dictionary option",
  good < none ? `none=${none} good=${good} wrong=${wrong}` : `none=${none} good=${good} wrong=${wrong} — all equal means it is IGNORING the dictionary`);

console.log(failed ? `\n${failed} check(s) failed.` : "\nbun canary verified.");
process.exit(failed ? 1 : 0);
