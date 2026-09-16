// osv-scanner.toml ignores ONE advisory against wrangler, and the file's own
// header says why: the pin is a pkg.pr.new tarball URL, the bun.lock extractor
// passes that URL through as the version, and a non-semver string sits inside
// every `introduced: 0` range. The ignore is therefore correct exactly as long
// as the pin is URL-shaped. The day `wrangler:pin` is retired and package.json
// names a registry version, the same entry starts hiding a real advisory
// against a wrangler whose version the scanner CAN read, and nothing would say
// so, since a suppressed finding is an absence. So the file is held to the
// argument rather than trusted: an IgnoredVulns entry is allowed only while
// the package it excuses is pinned by URL, and a PackageOverrides entry on
// wrangler is refused outright, because that shape hides every future
// advisory too.
import { parse } from "smol-toml";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

// The one advisory this tree ignores, and the package whose pin excuses it.
const URL_PIN_IGNORES = { "GHSA-8c93-4hch-xgxp": "wrangler" };

/**
 * An array-of-tables (`[[Name]]`) out of a parsed document, or empty. smol-toml
 * types every value as TomlValue, so this is where the shape gets narrowed.
 * @param {Record<string, import("smol-toml").TomlValue>} config
 * @param {string} key
 * @returns {Record<string, any>[]}
 */
function tables(config, key) {
  const value = config[key];
  return Array.isArray(value) ? /** @type {Record<string, any>[]} */ (value) : [];
}

/**
 * The rule, pure so the control below can feed it a semver pin.
 * @param {string} toml
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} pkg
 */
export function auditOsvIgnores(toml, pkg) {
  const problems = [];
  const config = parse(toml);
  for (const entry of tables(config, "IgnoredVulns")) {
    if (!entry.reason || entry.reason.trim().length < 20) {
      problems.push(`${entry.id} is ignored without a reason a reader can act on`);
    }
    const dep = URL_PIN_IGNORES[entry.id];
    if (!dep) {
      problems.push(`${entry.id} is ignored and this test does not know which URL pin excuses it; add it to URL_PIN_IGNORES with the package, or delete the ignore`);
      continue;
    }
    const pin = pkg.devDependencies?.[dep] ?? pkg.dependencies?.[dep] ?? "";
    if (!/^https?:\/\//.test(pin)) {
      problems.push(`${entry.id} is ignored because ${dep} was pinned by URL, and ${dep} is now "${pin}": the scanner can read that version, so delete the ignore`);
    }
  }
  for (const override of tables(config, "PackageOverrides")) {
    if (Object.values(URL_PIN_IGNORES).includes(override.name)) {
      problems.push(`PackageOverrides on ${override.name} hides every advisory against it, present and future; ignore by advisory id instead`);
    }
  }
  return problems;
}

test("osv-scanner.toml ignores only advisories a URL pin explains", async () => {
  const toml = await readFile(new URL("osv-scanner.toml", ROOT), "utf8");
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const problems = auditOsvIgnores(toml, pkg);
  assert.deepEqual(problems, [], problems.join("\n"));
  // The file must ignore the advisory it was written for, and nothing else,
  // so a second entry is a deliberate act that edits URL_PIN_IGNORES too.
  const ids = tables(parse(toml), "IgnoredVulns").map((e) => e.id);
  assert.deepEqual(ids, Object.keys(URL_PIN_IGNORES));
});

test("control: the ignore fails the day wrangler is a registry version", async () => {
  const toml = await readFile(new URL("osv-scanner.toml", ROOT), "utf8");
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  const semver = { ...pkg, devDependencies: { ...pkg.devDependencies, wrangler: "4.131.2" } };
  const problems = auditOsvIgnores(toml, semver);
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], /delete the ignore/);
  // And a PackageOverrides entry on wrangler is refused whatever the pin is.
  const widened = `${toml}\n[[PackageOverrides]]\nname = "wrangler"\necosystem = "npm"\nignore = true\nreason = "x"\n`;
  assert.match(auditOsvIgnores(widened, pkg).join("\n"), /hides every advisory/);
});
