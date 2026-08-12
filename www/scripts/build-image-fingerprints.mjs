#!/usr/bin/env node

// Build full-byte fingerprints for the published, content-addressed photo
// tiers. The short hash in hashes.json names a URL; this longer digest lets the
// MCP photo_recipe tool prove that an uploaded thumbnail is one of those exact
// published bytes before returning the camera recipe.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGES = path.join(ROOT, "www/images");
const HASHED = path.join(ROOT, "www/i");
const hashes = JSON.parse(await readFile(path.join(IMAGES, "hashes.json"), "utf8"));

const digest = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const fingerprints = {};
for (const stem of Object.keys(hashes).sort()) {
  const entry = hashes[stem];
  fingerprints[stem] = {
    a: await digest(path.join(HASHED, `${stem}.${entry.a}.avif`)),
    j: await digest(path.join(HASHED, `${stem}.${entry.j}.jpg`)),
    s: await digest(path.join(HASHED, `${stem}-400.${entry.s}.avif`)),
  };
}

await writeFile(path.join(IMAGES, "fingerprints.json"), `${JSON.stringify(fingerprints)}\n`);
console.log(`image-fingerprints: ${Object.keys(fingerprints).length} photos, ${Object.keys(fingerprints).length * 3} tiers`);
