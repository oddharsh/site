// ── every committed shell script aborts instead of continuing ────────────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import { execFileSync } from "node:child_process";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// Gotcha 40 is the bill for a shell script that kept going. `zenc histogram`
// returns 2 on an unreadable hashes.json, add-photos.sh ran it as
// `… | tail -1`, and a pipeline's status is its LAST command's, so `tail`
// reported 0 over the top of it. The bake was skipped for five days and the
// re-encode it was supposed to follow shipped 316 thumbnails whose histograms
// described bytes nobody was being served any more.

function shellScripts() {
  const out = execFileSync("git", ["ls-files", "-z", "*.sh"], {
    cwd: new URL(".", ROOT),
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean).map((rel) => new URL(rel, new URL(".", ROOT)));
}

function shellOptions(source) {
  const opts = { e: false, u: false, pipefail: false };
  for (const line of source.split("\n")) {
    const m = /^\s*set\s+(-[^\n#]*)/.exec(line);
    if (!m) continue;
    const rest = m[1];
    if (/\bpipefail\b/.test(rest)) opts.pipefail = true;
    for (const g of rest.matchAll(/-([a-zA-Z]+)/g)) {
      if (g[1] === "o") continue;
      if (g[1].includes("e")) opts.e = true;
      if (g[1].includes("u")) opts.u = true;
    }
  }
  return opts;
}

test("every committed shell script sets -e, -u and pipefail", async () => {
  const scripts = shellScripts();

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
