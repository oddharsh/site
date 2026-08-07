#!/usr/bin/env node
// gen-photo-semantics.mjs — retrieval terms for every photo, written to
// holding/images/semantics.json as {stem: {terms, from}}.
//
// ── why this exists ───────────────────────────────────────────────────────
// queryPhotos ranks a query against the caption and the EXIF. Both are narrow.
// The captions are one plain sentence by design (they are ALT TEXT first, and
// accessible alt text should not editorialise), so "A city at night with a tall
// building and a bench" is all an agent gets for a photograph a person would
// describe with a dozen other words. This file is the widening, kept OUT of
// alt.json so the accessibility contract stays exactly what it was.
//
// ── why the model is offline ──────────────────────────────────────────────
// The obvious build is embeddings: index the captions, embed the query, rank by
// cosine. Embedding the QUERY is the problem — it happens per request, so it
// puts a Workers AI credential on the live request path, which is the exact
// dependency /ask was deleted to remove. Expanding the DOCUMENT side instead
// moves every model call to this script: the worker keeps zero credentials,
// zero subrequests, and works unchanged on the free plan.
//
// Same trade the rest of the repo already makes (markdown twins, dcz deltas):
// precompute the expensive thing, ship the artifact, keep the runtime dumb.
//
// ── two tiers, and each stem records which it got ─────────────────────────
//   derived — computed from the committed EXIF. No network, no credential, and
//             reproducible by anyone with the repo. Mostly vocabulary repair:
//             the metadata says "Nostalgic Neg" and "LEICA M MONOCHROM", while
//             a person asks for "nostalgic negative" and "monochrome".
//   vision  — a caption model looking at the committed thumbnail under a
//             retrieval prompt rather than an alt-text one. Needs a token, so
//             it is opt-in and the artifact is honest when it is absent.
//
// Usage:
//   node holding/scripts/gen-photo-semantics.mjs              # derived only
//   node holding/scripts/gen-photo-semantics.mjs --vision     # + model terms
//   node holding/scripts/gen-photo-semantics.mjs --vision --dry-run
//
//   export CLOUDFLARE_API_TOKEN=...   # the same token gen-alt-text.py uses
//
// Resumable: --vision only calls the model for stems that have no vision terms
// yet, so a 429 against the free daily neuron budget just means run it again.
// Strippable: delete semantics.json and the query keeps working, one tier down.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const META = path.join(ROOT, "images", "metadata.json");
const HASHES = path.join(ROOT, "images", "hashes.json");
const ALT = path.join(ROOT, "images", "alt.json");
const OUT = path.join(ROOT, "images", "semantics.json");

const WANT_VISION = process.argv.includes("--vision");
const DRY_RUN = process.argv.includes("--dry-run");
const TOKEN = (process.env.CLOUDFLARE_API_TOKEN || "").trim();
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "1c99acdb6141579023fb97d24261ea58";
const MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const AI_RUN = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${MODEL}`;

// Alt text answers "what is in this frame". This answers "what would someone
// call this frame when looking for it", which is a different question and the
// reason the two files exist separately.
const VISION_PROMPT = "List 12 to 20 lowercase search keywords for this photo, comma separated. "
  + "Cover the subject, the setting, the time of day, the weather, the light, and the mood. "
  + "Single words or two-word phrases. No sentences, no punctuation beyond the commas.";

// ── the derived tier ──────────────────────────────────────────────────────
// Hand-written because it is vocabulary, not inference. Every entry maps a
// string the CAMERA writes to strings a PERSON says. Fuji abbreviates film
// simulation names in EXIF ("Nostalgic Neg"), and no amount of stemming gets
// from "Neg" to "negative" without inventing a rule that would also collapse
// "Nostalgic Neg" and "Classic Negative" into each other.
const FILM_ALIASES = {
  "Nostalgic Neg": "nostalgic negative nostalgia warm",
  "Classic Negative": "classic neg superia",
  "Classic Chrome": "classic chrome muted documentary",
  "F0/Standard (Provia)": "provia standard neutral",
  "Reala ACE": "reala ace natural",
  "Eterna": "eterna cinematic film movie",
};

// Substring match against the camera string, which is verbose and vendor-shaped
// ("Leica Camera AG LEICA M MONOCHROM (Typ 246)") in a way nobody types.
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

// Only facts the EXIF actually supports. The tempting entries are the ones that
// sound like photography and are guesses — "night" is not derivable from a
// timestamp without a timezone and a location, and this archive publishes
// neither, so it is not here. Same rule the tooltip follows: skip the line
// rather than fabricate it.
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
  const card = Object.entries(record.recipe || {}).map(([k, v]) => `${k}: ${v}`).join(" ");
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
  const file = path.join(ROOT, "i", `${stem}.${entry.j}.jpg`);
  const image = Array.from(fs.readFileSync(file));
  const body = JSON.stringify({ image, prompt: VISION_PROMPT, max_tokens: 128 });
  if (DRY_RUN) {
    // Report the intent WITHOUT the constructed endpoint. That URL embeds the
    // account id, which comes from the environment, and a dry run is precisely
    // when its output gets pasted into an issue or a terminal recording. The
    // byte count and the model are the parts worth seeing.
    console.log(`      would POST ${body.length}B to Workers AI (${MODEL})`);
    return null;
  }
  const response = await fetch(AI_RUN, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body,
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
  const payload = await response.json();
  const raw = payload?.result?.description || payload?.result?.response || "";
  // The model is asked for a comma list and sometimes writes a sentence anyway.
  // Normalising here rather than trusting the prompt keeps the artifact one
  // shape, which is what the ranking reads.
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

const out = {};
for (const stem of stems) {
  const record = metadata[stem] || {};
  const derived = derivedTerms(record);
  const prior = existing[stem] || {};
  // The caption is folded in so one field answers the query. It is already
  // scored on its own at a higher weight, and a duplicate hit costs nothing
  // because each term scores once, at its best field.
  out[stem] = {
    terms: [derived, prior.vision || "", String(alt[stem] || "").toLowerCase()].filter(Boolean).join(" "),
    from: prior.vision ? ["derived", "vision"] : ["derived"],
    ...(prior.vision ? { vision: prior.vision } : {}),
  };
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
      if (DRY_RUN) continue;   // visionTerms already reported what it would send
      if (!terms) { console.log(`  [${index + 1}/${todo.length}] ${stem}: EMPTY`); continue; }
      out[stem].vision = terms;
      out[stem].from = ["derived", "vision"];
      out[stem].terms = [derivedTerms(metadata[stem] || {}), terms, String(alt[stem] || "").toLowerCase()].filter(Boolean).join(" ");
      done += 1;
      console.log(`  [${index + 1}/${todo.length}] ${stem}: ${terms.slice(0, 72)}`);
      // Written every time, so an interrupted run keeps what it paid for.
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
