#!/usr/bin/env node
// gen-alt-text.ts — alt text for every grid photo, written to
// public/images/alt.json as {stem: alt}. The worker bakes it into each grid
// <img alt> and nav.js's Run palette reads it for the photo destinations, so a
// stem with no entry ships an unlabelled image.
//
// Two routes to the same model (@cf/llava-hf/llava-1.5-7b-hf) under the same
// prompt, so a caption reads identically whichever one produced it:
//
//   LOCAL (preferred; needs CLOUDFLARE_API_TOKEN) reads the square thumbnail
//   already sitting in public/i/ and posts those bytes to the Workers AI REST
//   API. Because it never asks production for anything, it captions a photo
//   that has never been deployed, which is the whole reason add-photos.sh can
//   caption a shot in the same run that encodes it.
//
//   REMOTE (fallback; no credentials) hands a stem to /garage/cf/caption and
//   lets that worker fetch the thumbnail from aadhar.sh. It only sees photos
//   that are already live, so it cannot close the gap on a fresh add. It stays
//   so the script still does useful work on a machine with no token.
//
// Both routes read the SAME bytes (public/i/<stem>.<hash8>.jpg is exactly what
// production serves), so switching routes does not change what the model sees.
//
// Resumable either way: a re-run only fills stems that have no caption, so a
// 429 (the free 10k neurons/day) just means run again later.
//
//   export CLOUDFLARE_API_TOKEN=...   # Account · Workers AI · Read
//   export CLOUDFLARE_AI_GATEWAY=""   # opt OUT of gateway routing (defaults to "default")
//   bun run captions                  # or: node tools/photos/gen-alt-text.ts
//
// Strippable: delete alt.json plus the worker/template lookups to revert to
// empty alt.
//
// ── why this is TypeScript, since 2026-09-15 ──────────────────────────────
// It was gen-alt-text.py, and it was the last thing in the pipeline that ran
// under python3. The pipeline already ran node four times in the same script
// (photo-inputs, build-histogram-index, gen-photo-semantics, check-photo-
// pipeline), so the interpreter bought nothing, and it cost two things worth
// naming. It was the one file the shell path sweep of gotcha 40 could not see,
// which is how a repointed ROOT captioned nothing for five days. And its
// caller was `python3 … || echo "captions incomplete"`, so a traceback read as
// a warning. As TS it is held by the tools program, typecheck, the writer
// census and the same scanners as its four siblings.
//
// The FILE FORMAT is the old script's, byte for byte, because alt.json is
// committed and a serializer change would diff 165 lines on a run that
// captioned nothing: Python's json.dump(indent=0, sort_keys=True,
// ensure_ascii=False) is one key per line, no indentation, keys in code-point
// order, and no trailing newline. writeAlt below reproduces that and a
// contract test round-trips the committed file through it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNT, MODEL, TOKEN, WorkersAiHttpError, runVision, visionBody } from "./lib/workers-ai.ts";

// Anchor on the TREE, never on a count of directories above this file: the
// Python version read dirname(dirname(__file__)) and moved twice (gotcha 40).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "public");
const META = path.join(ROOT, "images", "metadata.json");
const HASHES = path.join(ROOT, "images", "hashes.json");
const HASHED = path.join(ROOT, "i");
const OUT = path.join(ROOT, "images", "alt.json");

// keep in sync with cf-garage/src/index.ts's ?mode=alt branch: that endpoint is
// the public /garage/cf demo and carries its own copy of this prompt.
export const PROMPT = "Write alt text for this photo: one plain, factual sentence naming only "
  + "what is clearly visible (main subject and setting). No mood, no "
  + "interpretation, no guessing, no 'image of'. Under 16 words.";
const ENDPOINT = "https://aadhar.sh/garage/cf/caption?mode=alt&img=";
// a real UA: Cloudflare's WAF 403s a bare library default
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 alt-gen";
const DRY_RUN = process.argv.includes("--dry-run");

/** Match the worker's post-processing so both routes emit the same shape. The
 *  regex is cf-garage/src/index.ts's, and a contract test holds the two equal. */
export function clean(caption: string): string {
  let cap = caption.trim().replace(/^(an? |the )?(image|photo|photograph|picture) (of|shows|depicts|captures)\s*/i, "");
  cap = cap.replace(/\s+/g, " ").trim();
  return cap ? cap[0].toUpperCase() + cap.slice(1) : "";
}

/** alt.json in the exact shape the Python script wrote (see the header). */
export function serializeAlt(alt: Record<string, string>): string {
  const keys = Object.keys(alt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{\n${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(alt[k])}`).join(",\n")}\n}`;
}

function thumbPath(stem: string, hashes: Record<string, { j?: string }>): string {
  const entry = hashes[stem] || {};
  if (!entry.j) throw new Error(`${stem} missing from hashes.json (half-run pipeline?)`);
  return path.join(HASHED, `${stem}.${entry.j}.jpg`);
}

/** POST the committed thumbnail bytes straight to Workers AI. */
async function captionLocal(stem: string, hashes: Record<string, { j?: string }>): Promise<string> {
  const body = visionBody(thumbPath(stem, hashes), PROMPT, 64);
  if (DRY_RUN) {
    console.log(`      would POST ${body.length}B to Workers AI (${MODEL})`);
    return "";
  }
  return clean(await runVision(body, { timeoutMs: 90_000 }));
}

/** Ask the deployed worker to fetch the thumbnail from production itself. */
async function captionRemote(stem: string): Promise<string> {
  if (DRY_RUN) {
    console.log(`      would GET ${ENDPOINT}${stem}`);
    return "";
  }
  const response = await fetch(ENDPOINT + stem, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(40_000) });
  if (!response.ok) throw new WorkersAiHttpError(response.status, response.statusText, "");
  const d = await response.json();
  // the usual cause of ok:false: the photo is not deployed yet, so the worker 404s on it
  if (!d?.ok) throw new Error(d?.error || "caption endpoint returned ok:false");
  return clean(d.caption || "");
}

const readJson = (file: string, fallback: unknown) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

async function main(): Promise<number> {
  const stems: string[] = Object.keys(JSON.parse(fs.readFileSync(META, "utf8")));
  const hashes = JSON.parse(fs.readFileSync(HASHES, "utf8"));
  const alt: Record<string, string> = readJson(OUT, {});
  const todo = stems.filter((s) => !alt[s]);

  const route = TOKEN ? "local bytes -> Workers AI REST" : "stem -> /garage/cf/caption (deployed photos only)";
  const caption = TOKEN ? captionLocal : (stem: string) => captionRemote(stem);

  console.log(`${stems.length} photos, ${Object.keys(alt).length} already done, ${todo.length} to generate`);
  console.log(`route: ${route}`);
  if (!TOKEN && todo.length) {
    console.log("  no CLOUDFLARE_API_TOKEN: a photo that is not deployed yet will fail here.\n"
      + "  set a token scoped to Account · Workers AI · Read to caption pre-deploy.");
  }

  let done = 0;
  for (const [i, stem] of todo.entries()) {
    const tag = `[${i + 1}/${todo.length}] ${stem}`;
    try {
      const cap = await caption(stem, hashes);
      if (!cap) {
        if (!DRY_RUN) console.log(`  ${tag}: EMPTY (model returned nothing)`);
        continue;
      }
      alt[stem] = cap;
      fs.writeFileSync(OUT, serializeAlt(alt));
      done += 1;
      console.log(`  ${tag}: ${cap}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof WorkersAiHttpError && (e.status === 401 || e.status === 403)) {
        console.log(`  ${tag}: ${msg}: check CLOUDFLARE_API_TOKEN (needs Account · Workers AI · Read on ${ACCOUNT}).`);
        break;
      }
      console.log(`  ${tag}: ERROR ${msg}`);
      if (msg.includes("429")) {  // neuron budget hit: stop, resume later
        console.log("  rate-limited (429), stopping; re-run to resume.");
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  const total = stems.filter((s) => alt[s]).length;
  const gaps = stems.filter((s) => !alt[s]);
  console.log(`\ndone this run: ${done}.  total captioned: ${total}/${stems.length} -> ${OUT}`);
  if (gaps.length) {
    console.log(`still missing (${gaps.length}): ${gaps.slice(0, 8).join(", ")}${gaps.length > 8 ? " …" : ""}`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exit(await main());
