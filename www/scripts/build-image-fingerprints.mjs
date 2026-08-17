#!/usr/bin/env node

// Build full-byte fingerprints for the published, content-addressed photo
// tiers. The short hash in hashes.json names a URL; this longer digest lets the
// MCP photo_recipe tool prove that an uploaded thumbnail is one of those exact
// published bytes before returning the camera recipe.
//
// The file is written DIGEST-FIRST (`{sha256: "stem:tier"}`) because that is the
// only direction anything reads it: photo_recipe hashes an upload and asks which
// published photo those bytes are. Stored stem-first it had to scan all 474
// entries through a nested loop; keyed by digest, JSON.parse hands back the
// index itself and the lookup is one property access.
//
// Note this buys nothing on the wire, which is worth knowing before anyone
// "optimises" the encoding further. sha256 is incompressible, so 474 digests sit
// on a ~15.2 KB entropy floor and brotli already recovers the hex alphabet's
// waste: hex lands at 16.1 KB, base64 at 16.4 KB, raw bytes at 15.4 KB. Only
// truncating the digest moves that number, and that is a separate decision about
// how strong a match claim the tool is making.

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
let tiers = 0;

// Stems sorted and tiers in a fixed order, so the emitted key order is stable
// and a rebuild that changed no pixel changes no byte of this file.
for (const stem of Object.keys(hashes).sort()) {
  const entry = hashes[stem];
  const files = {
    a: `${stem}.${entry.a}.avif`,
    j: `${stem}.${entry.j}.jpg`,
    s: `${stem}-400.${entry.s}.avif`,
    x: `${stem}-200.${entry.x}.avif`,
  };
  for (const tier of ["a", "j", "s", "x"]) {
    const sum = await digest(path.join(HASHED, files[tier]));
    // Two published tiers holding identical bytes cannot both be represented by
    // an inverted index. The old stem-first shape did not make this impossible,
    // it made it INVISIBLE: the scan returned whichever entry it happened to
    // reach first and nothing said the other existed. Refuse rather than pick.
    if (fingerprints[sum]) {
      console.error(`image-fingerprints: ${files[tier]} is byte-identical to ${fingerprints[sum]}; publish one of the two, not both`);
      process.exit(1);
    }
    fingerprints[sum] = `${stem}:${tier}`;
    tiers++;
  }
}

await writeFile(path.join(IMAGES, "fingerprints.json"), `${JSON.stringify(fingerprints)}\n`);
console.log(`image-fingerprints: ${Object.keys(hashes).length} photos, ${tiers} tiers`);
