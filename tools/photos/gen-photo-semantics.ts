#!/usr/bin/env node
// gen-photo-semantics.mjs — retrieval terms for every photo, written to
// public/images/semantics.json as {stem: {terms, from}}.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL, TOKEN, runVision, visionBody } from "./lib/workers-ai.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const META = path.join(ROOT, "public", "images", "metadata.json");
const HASHES = path.join(ROOT, "public", "images", "hashes.json");
const ALT = path.join(ROOT, "public", "images", "alt.json");
const OUT = path.join(ROOT, "public", "images", "semantics.json");

const WANT_VISION = process.argv.includes("--vision");
const DRY_RUN = process.argv.includes("--dry-run");

const VISION_PROMPT = "List 12 to 20 lowercase search keywords for this photo, comma separated. "
  + "Cover the subject, the setting, the time of day, the weather, the light, and the mood. "
  + "Single words or two-word phrases. No sentences, no punctuation beyond the commas.";

const FILM_ALIASES = {
  "Nostalgic Neg": "nostalgic negative nostalgia warm",
  "Classic Negative": "classic neg superia",
  "Classic Chrome": "classic chrome muted documentary",
  "F0/Standard (Provia)": "provia standard neutral",
  "Reala ACE": "reala ace natural",
  "Eterna": "eterna cinematic film movie",
};

const CAMERA_ALIASES = [
  ["X-T50", "fuji fujifilm xt50 x-t50 aps-c mirrorless"],
  ["MONOCHROM", "leica monochrome black and white bw m246 rangefinder full frame"],
  ["LEICA", "leica rangefinder"],
];

const RECIPE_ALIASES = [
  ["Acros", "acros black and white monochrome bw grain"],
  ["Sepia", "sepia toned warm"],
];

const shutterSeconds = (value) => {
  const text = String(value ?? "");
  if (text.includes("/")) {
    const [num, den] = text.split("/").map(Number);
    return den ? num / den : null;
  }
  const n = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

function derivedTerms(record) {
  const out = [];
  const film = String(record.film || "");
  if (film) {
    out.push(film.toLowerCase());
    if (FILM_ALIASES[film]) out.push(FILM_ALIASES[film]);
  }
  const camera = String(record.camera || "");
  for (const [needle, alias] of CAMERA_ALIASES) {
    if (camera.toUpperCase().includes(needle.toUpperCase())) { out.push(alias); break; }
  }
  const card = Object.entries(record.recipe || {}).map(([k, v]) => `${k}: ${String(v)}`).join(" ");
  for (const [needle, alias] of RECIPE_ALIASES) {
    if (card.toLowerCase().includes(needle.toLowerCase())) out.push(alias);
  }
  const iso = Number(record.iso) || 0;
  if (iso >= 3200) out.push("low light high iso available light");
  else if (iso > 0 && iso <= 200) out.push("bright daylight base iso");
  const seconds = shutterSeconds(record.shutter);
  if (seconds !== null && seconds >= 1) out.push("long exposure slow shutter");
  if (seconds !== null && seconds <= 1 / 1000) out.push("fast shutter frozen motion");
  const year = String(record.date || "").slice(0, 4);
  if (/^\d{4}$/.test(year)) out.push(year);
  return out.join(" ");
}

async function visionTerms(stem, hashes) {
  const entry = hashes[stem] || {};
  if (!entry.j) throw new Error(`${stem} missing from hashes.json (half-run pipeline?)`);
  const file = path.join(ROOT, "public", "i", `${stem}.${entry.j}.jpg`);
  const body = visionBody(file, VISION_PROMPT, 128);
  if (DRY_RUN) {
    console.log(`      would POST ${body.length}B to Workers AI (${MODEL})`);
    return null;
  }
  const raw = await runVision(body);
  return raw.toLowerCase().replace(/[^a-z0-9,\s-]/g, " ")
    .split(/[,\n]/).map((part) => part.trim()).filter((part) => part && part.length < 30)
    .slice(0, 24).join(" ");
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
};

const metadata = readJson(META, {});
const hashes = readJson(HASHES, {});
const alt = readJson(ALT, {});
const existing = readJson(OUT, {});
const stems = Object.keys(metadata);

const out: Record<string, { terms: string; from: string[]; vision?: string }> = {};
for (const stem of stems) {
  const record = metadata[stem] || {};
  const derived = derivedTerms(record);
  const prior = existing[stem] || {};
  const entry: { terms: string; from: string[]; vision?: string } = {
    terms: [derived, prior.vision || "", String(alt[stem] || "").toLowerCase()].filter(Boolean).join(" "),
    from: prior.vision ? ["derived", "vision"] : ["derived"],
  };
  if (prior.vision) entry.vision = prior.vision;
  out[stem] = entry;
}

if (WANT_VISION) {
  if (!TOKEN && !DRY_RUN) {
    console.error("--vision needs CLOUDFLARE_API_TOKEN. Run without it for the derived tier alone.");
    process.exit(1);
  }
  const todo = stems.filter((stem) => !(existing[stem] || {}).vision);
  console.log(`${stems.length} photos, ${stems.length - todo.length} already have vision terms, ${todo.length} to generate`);
  let done = 0;
  for (const [index, stem] of todo.entries()) {
    try {
      const terms = await visionTerms(stem, hashes);
      if (DRY_RUN) continue;
      if (!terms) { console.log(`  [${index + 1}/${todo.length}] ${stem}: EMPTY`); continue; }
      out[stem].vision = terms;
      out[stem].from = ["derived", "vision"];
      out[stem].terms = [derivedTerms(metadata[stem] || {}), terms, String(alt[stem] || "").toLowerCase()].filter(Boolean).join(" ");
      done += 1;
      console.log(`  [${index + 1}/${todo.length}] ${stem}: ${terms.slice(0, 72)}`);
      fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
    } catch (error) {
      console.log(`  [${index + 1}/${todo.length}] ${stem}: ${error.message}`);
    }
  }
  console.log(`vision terms written for ${done} photo(s)`);
}

if (DRY_RUN) {
  console.log(`dry run — ${stems.length} stems, nothing written`);
} else {
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  const withVision = Object.values(out).filter((entry) => entry.from.includes("vision")).length;
  console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${stems.length} stems, ${withVision} with vision terms`);
}
