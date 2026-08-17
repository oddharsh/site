// Binary prerequisites, declared as VALUES.
//
// WHY THIS EXISTS, and it is not ergonomics. In shell a prerequisite is written
//
//     for cmd in sips exif-sooc jq; do command -v "$cmd" || ...; done
//
// so the binary name exists only as a loop word. A search for `exif-sooc` finds
// nothing, which is why four prerequisites stayed undocumented until
// `tools:check` went looking, and why that checker needs three source-scraping
// scanners each carrying a FLOOR so that a scanner which stops matching cannot
// report a pass. All of that is scaffolding around one fact: the shell hid the
// names.
//
// A script that says `export const REQUIRES = ["sips", "exif-sooc"]` hides
// nothing. The names are greppable, importable, and checkable by reading rather
// than by regex.
//
// The install hints are NOT repeated here. config/tools.json already declares
// every tool with its `install` line and its `why`, and a second copy is a
// second thing to drift; this reads that file and builds the message from it.

import decl from "../../../config/tools.json" with { type: "json" };

type Tool = { bin: string; install?: string; why?: string };
const TOOLS: Tool[] = (decl as { tools: Tool[] }).tools;

/** Every binary config/tools.json knows about. */
export const declaredBins = (): string[] => TOOLS.map((t) => t.bin);

/**
 * Resolve each named binary to an absolute path, or exit naming what is missing
 * and how to install it.
 *
 * Resolution goes through PATH rather than a hardcoded prefix. The shell scripts
 * these replace carried `/usr/bin/sips` and `/opt/homebrew/bin/avifenc`
 * literally, which is wrong on any machine that installs elsewhere: an Intel
 * Mac puts Homebrew at /usr/local, and a linux runner has neither path.
 */
export function requireBins(names: readonly string[]): Record<string, string> {
  const found: Record<string, string> = {};
  const missing: string[] = [];

  for (const name of names) {
    const path = Bun.which(name);
    if (path) found[name] = path;
    else missing.push(name);
  }

  if (missing.length) {
    console.error(`missing ${missing.length} required tool(s):\n`);
    for (const name of missing) {
      const t = TOOLS.find((x) => x.bin === name);
      console.error(`  ${name}`);
      if (t?.install) console.error(`    install: ${t.install}`);
      if (t?.why) console.error(`    needed for: ${t.why.split(". ")[0]}.`);
      if (!t) console.error(`    NOT DECLARED in config/tools.json — add it there too`);
      console.error("");
    }
    process.exit(1);
  }
  return found;
}

/**
 * zenc is built from source in this repo rather than installed, so it is not a
 * PATH lookup. Returns the binary path, building it first if it is absent.
 */
export async function ensureZenc(): Promise<string> {
  const dir = new URL("../zenc/", import.meta.url).pathname;
  const bin = `${dir}target/release/zenc`;
  if (await Bun.file(bin).exists()) return bin;

  requireBins(["cargo"]);
  const { $ } = await import("bun");
  console.error("zenc: building (first run only)…");
  const built = await $`cargo build --release --manifest-path ${dir}Cargo.toml`.nothrow();
  if (built.exitCode !== 0) {
    console.error("error: zenc build failed");
    process.exit(1);
  }
  return bin;
}
