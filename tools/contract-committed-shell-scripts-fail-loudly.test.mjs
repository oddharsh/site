// ── every committed shell script aborts instead of continuing ────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, readdir, test } from "./contract-shared.ts";

// Gotcha 40 is the bill for a shell script that kept going. `zenc histogram`
// returns 2 on an unreadable hashes.json, add-photos.sh ran it as
// `… | tail -1`, and a pipeline's status is its LAST command's, so `tail`
// reported 0 over the top of it. The bake was skipped for five days and the
// re-encode it was supposed to follow shipped 316 thumbnails whose histograms
// described bytes nobody was being served any more.
//
// `pipefail` is the option that fixes that class, and it was missing from
// exactly the two scripts that needed it most: of 11 committed scripts, 9
// carried `set -euo pipefail` and add-photos.sh and add-car-photo.sh carried a
// bare `set -e`. Nothing failed on the gap, which is why it lasted.
//
// This is the check that turns "the other 9 already do it" from a convention
// somebody remembers into one a PR cannot lose. A twelfth script is covered by
// existing rather than by an edit here.

/** Committed shell scripts, DISCOVERED rather than listed. Vendored and build
 *  trees are skipped: node_modules and cargo's target/ hold third-party scripts
 *  this repository does not own and may not edit. */
async function shellScripts(dir = new URL(".", ROOT), out = []) {
  const SKIP = new Set([
    "node_modules", ".git", ".build", ".wrangler", ".claude",
    "target", ".venv", "dist", ".dev-assets",
  ]);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) await shellScripts(child, out);
    else if (entry.name.endsWith(".sh")) out.push(child);
  }
  return out;
}

/** A `set` line is only the one that OPENS a line, so the word inside a comment
 *  or inside prose about this very check cannot match. Options may be spelled
 *  together (`set -euo pipefail`) or apart (`set -e`, `set -o pipefail`), so the
 *  property is asserted rather than one canonical string. */
function shellOptions(source) {
  const opts = { e: false, u: false, pipefail: false };
  for (const line of source.split("\n")) {
    const m = /^\s*set\s+(-[^\n#]*)/.exec(line);
    if (!m) continue;
    const rest = m[1];
    if (/\bpipefail\b/.test(rest)) opts.pipefail = true;
    // -euo, -eu, -e … short flags cluster, so read the letters off each group
    // that is not the argument to -o.
    for (const g of rest.matchAll(/-([a-zA-Z]+)/g)) {
      if (g[1] === "o") continue;
      if (g[1].includes("e")) opts.e = true;
      if (g[1].includes("u")) opts.u = true;
    }
  }
  return opts;
}

test("every committed shell script sets -e, -u and pipefail", async () => {
  const scripts = await shellScripts();

  // FLOOR. A scanner that matches nothing reports a pass, which is the failure
  // this repository has shipped three times. Eleven scripts exist today: ten
  // under tools/photos plus .github/deploy-wrangler.sh.
  assert.ok(
    scripts.length >= 11,
    `found only ${scripts.length} shell scripts; the scanner is broken`,
  );

  const missing = [];
  for (const url of scripts) {
    const rel = url.href.slice(new URL(".", ROOT).href.length);
    const opts = shellOptions(await readFile(url, "utf8"));
    const gaps = Object.entries(opts).filter(([, on]) => !on).map(([k]) => k);
    if (gaps.length) missing.push(`${rel} (missing ${gaps.join(", ")})`);
  }

  assert.deepEqual(
    missing,
    [],
    `these scripts continue past a failure they should abort on; add \`set -euo pipefail\`:\n  ${missing.join("\n  ")}`,
  );
});
