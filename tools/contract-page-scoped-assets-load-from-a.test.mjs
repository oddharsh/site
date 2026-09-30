// ── page-scoped assets load from /a/, and the plain URLs keep serving ────────
// Three scripts one page (or one section) loads joined the content-hashed tier
// on 2026-09-30: /lwe/ask.js on 12 LWE pages, /garage/pretext.lib.js and
// /dotfiles.js. Each was a plain URL a returning visitor revalidated on every
// view. build.ts step 6 copies each into /a/ and rewrites its one loader; the
// plain file stays, because agents, old HTML and the .src.html twins still
// name it.
//
// What can quietly undo it: a loader whose spelling moves out from under the
// rewrite, a hashed copy whose bytes are not the plain file's, and a roll that
// cannot see the page-scoped scripts and so never gives them a dictionary.
import { brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { ROOT, assert, readFile, readdir, test } from "./contract-shared.ts";
import { SHELL_DISCOVERY_ROOTS } from "./lib/shell-roots.ts";

const BUILT = new URL(".build/public/", ROOT);
const needsBuild = !existsSync(BUILT) && "needs a built tree: bun run build";

// [plain path, /a/ base, extension, the loader's spelling in the SERVED page, pages]
const lwePages = ["dac", "drivers", "encoding", "fhe", "fuse", "knots", "lean", "mpc", "pcrypto", "tee", "utf8", "vigenere"].map((p) => `lwe/${p}.html`);
const ASSETS = [
  { plain: "lwe/ask.js", base: "ask", ext: "js", loader: /src=["']?\/lwe\/ask\.js/, pages: lwePages },
  { plain: "garage/pretext.lib.js", base: "pretext-lib", ext: "js", loader: /import\(\s*["'`](?:\.\/|\/garage\/)pretext\.lib\.js/, pages: ["garage/pretext.html"] },
  { plain: "dotfiles.js", base: "dotfiles", ext: "js", loader: /from\s*["'`]\/dotfiles\.js/, pages: ["dotfiles/index.html"] },
];

test("each page-scoped asset has one /a/ copy, byte-identical to the plain file, with a q11 twin", { skip: needsBuild }, async () => {
  const hashed = await readdir(new URL("a/", BUILT));
  for (const a of ASSETS) {
    const names = hashed.filter((n) => new RegExp(`^${a.base}\\.[0-9a-f]{8}\\.${a.ext}$`).test(n));
    assert.equal(names.length, 1, `${a.plain}: expected one /a/${a.base}.<hash8>.${a.ext}, found ${names.length}`);
    const [name] = names;
    const bytes = await readFile(new URL(`a/${name}`, BUILT));
    assert.ok(bytes.equals(await readFile(new URL(a.plain, BUILT))), `/a/${name} is not the bytes /${a.plain} serves`);
    assert.equal(name.split(".")[1], createHash("sha256").update(bytes).digest("hex").slice(0, 8), `/a/${name} does not name its own bytes`);
    assert.ok(brotliDecompressSync(await readFile(new URL(`a/${name}.br`, BUILT))).equals(bytes), `/a/${name}.br does not decode to it`);
  }
});

test("every page that loads one loads the /a/ copy and never the plain URL", { skip: needsBuild }, async () => {
  const hashed = await readdir(new URL("a/", BUILT));
  for (const a of ASSETS) {
    const name = hashed.find((n) => new RegExp(`^${a.base}\\.[0-9a-f]{8}\\.${a.ext}$`).test(n));
    for (const page of a.pages) {
      const html = await readFile(new URL(page, BUILT), "utf8");
      assert.ok(html.includes(`/a/${name}`), `${page} does not load /a/${name}`);
      assert.doesNotMatch(html, a.loader, `${page} still loads the plain /${a.plain}`);
    }
  }
});

test("the loaders in SOURCE still name the plain URL, which is what the rewrite keys on", async () => {
  // The inverse half of the test above. If a source page stops spelling the load
  // the way step 6 matches it, step 6's witness fails the build; this names which
  // page and which spelling, without needing a build to find out.
  for (const a of ASSETS) {
    for (const page of a.pages) {
      const html = await readFile(new URL(`src/pages/${page}`, ROOT), "utf8");
      assert.match(html, a.loader, `src/pages/${page} no longer loads /${a.plain} the way build.ts step 6 rewrites it`);
    }
  }
});

test("the roll and dcz:check discover assets from one list, and it reaches the page-scoped scripts", async () => {
  assert.ok(SHELL_DISCOVERY_ROOTS.includes("/dotfiles"), "/dotfiles.js is loaded by /dotfiles alone");
  assert.ok(SHELL_DISCOVERY_ROOTS.includes("/garage/pretext"), "the pretext library is loaded by /garage/pretext alone");
  assert.ok(SHELL_DISCOVERY_ROOTS.some((p) => p.startsWith("/lwe/")), "ask.js is loaded by the LWE pages alone");
  for (const file of ["roll-shell-dictionary.ts", "check-dictionary-support.ts"]) {
    const src = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(src, /for \(const path of SHELL_DISCOVERY_ROOTS\)/, `${file} must walk SHELL_DISCOVERY_ROOTS`);
    assert.doesNotMatch(src, /\["\/", "\/lens"/, `${file} carries its own copy of the discovery list again`);
  }
});
