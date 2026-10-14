#!/usr/bin/env node
// gen-alt-text.ts — alt text for every grid photo, written to
// public/images/alt.json as {stem: alt}. The worker bakes it into each grid
// <img alt> and nav.js's Run palette reads it for the photo destinations, so a
// stem with no entry ships an unlabelled image.
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

export const PROMPT = "Write alt text for this photo: one plain, factual sentence naming only "
  + "what is clearly visible (main subject and setting). No mood, no "
  + "interpretation, no guessing, no 'image of'. Under 16 words.";
const ENDPOINT = "https://aadhar.sh/garage/cf/caption?mode=alt&img=";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 alt-gen";
const DRY_RUN = process.argv.includes("--dry-run");

export function clean(caption: string): string {
  let cap = caption.trim().replace(/^(an? |the )?(image|photo|photograph|picture) (of|shows|depicts|captures)\s*/i, "");
  cap = cap.replace(/\s+/g, " ").trim();
  return cap ? cap[0].toUpperCase() + cap.slice(1) : "";
}

export function serializeAlt(alt: Record<string, string>): string {
  const keys = Object.keys(alt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{\n${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(alt[k])}`).join(",\n")}\n}`;
}

function thumbPath(stem: string, hashes: Record<string, { j?: string }>): string {
  const entry = hashes[stem] || {};
  if (!entry.j) throw new Error(`${stem} missing from hashes.json (half-run pipeline?)`);
  return path.join(HASHED, `${stem}.${entry.j}.jpg`);
}

async function captionLocal(stem: string, hashes: Record<string, { j?: string }>): Promise<string> {
  const body = visionBody(thumbPath(stem, hashes), PROMPT, 64);
  if (DRY_RUN) {
    console.log(`      would POST ${body.length}B to Workers AI (${MODEL})`);
    return "";
  }
  return clean(await runVision(body, { timeoutMs: 90_000 }));
}

async function captionRemote(stem: string): Promise<string> {
  if (DRY_RUN) {
    console.log(`      would GET ${ENDPOINT}${stem}`);
    return "";
  }
  const response = await fetch(ENDPOINT + stem, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(40_000) });
  if (!response.ok) throw new WorkersAiHttpError(response.status, response.statusText, "");
  const d = await response.json();
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
      if (msg.includes("429")) {
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
