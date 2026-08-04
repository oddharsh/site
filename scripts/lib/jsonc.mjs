// scripts/lib/jsonc.mjs — the one JSONC reader.
//
// Wrangler's configs are the most heavily commented files in this repo (that is
// deliberate; they are where the deploy's reasoning lives), and they also carry
// string values like "https://aadhar.sh" and "*/30 * * * *". A naive comment
// strip eats the "//" inside those and corrupts the config, so this walks the
// text string-aware instead.
//
// It lived privately inside check-infra.mjs until gen-remote-config.mjs needed
// the same thing. Two copies of a parser is how the two drift, and a parser that
// drifts on a config this load-bearing fails in the least legible way available.

export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  // trailing commas, now that comments are gone and we are outside strings
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}
