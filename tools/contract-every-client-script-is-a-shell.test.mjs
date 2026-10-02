// ── every client script is a row of the client asset registry ───────────────
// build.ts step 3 minifies the client scripts the registry names
// (tools/lib/client-assets.ts), ships each one a readable .src.js twin, and
// fails the build when the minified output has lost that row's MARKER. The
// marker is the one tripwire that turns a minifier deleting a whole island
// into a red build: measured 2026-09-15, `propertyWriteSideEffects: false`
// minified six /lens islands to 0 bytes, and "lens-browser.js: minified output
// lost the LensBrowser marker" is what stopped it. A file in src/client that is
// NOT a row gets none of that: it stages readable and verbatim, with no twin
// and nothing watching it.
//
// Three tests pinned three files by name (infotip, webmcp, lens-webmcp), each
// written the day its file was nearly left out. That is the allowlist that
// only grows when somebody remembers. These read the directory instead, so
// the next island is covered on the day it is written. The build runs the same
// function as an invariant; this is the copy `bun run test` reaches without a
// build. sw.js is the one exception, and clientScriptProblems says why.
//
// Until 2026-10-02 this file regex-sliced a SHELLS array out of build.ts. It
// imports the registry now, so it reads the rows the build reads rather than
// a parse of their source text.
import { ROOT, assert, readFile, readdir, test } from "./contract-shared.ts";
import { CLIENT_ASSETS, clientScriptProblems, minifiedScripts } from "./lib/client-assets.ts";

const clientFiles = async () => (await readdir(new URL("src/client/", ROOT), { recursive: true })).filter((f) => f.endsWith(".js")).sort();

test("every src/client script except sw.js is a registry row, so it ships minified, twinned, and under a marker", async () => {
  const rows = minifiedScripts();
  assert.ok(rows.length >= 15, `only ${rows.length} script rows; the registry is reading nothing`);
  const files = await clientFiles();
  assert.deepEqual(clientScriptProblems(files), [], "the registry and src/client disagree");
  assert.ok(files.includes("sw.js"), "sw.js is the documented exception; if it is gone, drop the exception in clientScriptProblems");
  const orphans = rows.filter((r) => !files.includes(r.file)).map((r) => r.file);
  assert.deepEqual(orphans, [], `${orphans.join(", ")} is registered as a client script but is not in src/client`);
});

test("CONTROL: a script the registry does not name, and a row with no marker, are each reported by name", async () => {
  const files = await clientFiles();
  const [missing] = clientScriptProblems([...files, "lens-unregistered.js"]);
  assert.match(missing, /^lens-unregistered\.js in src\/client but not in the client asset registry/);
  // sw.js is exempt, and nothing else is.
  assert.deepEqual(clientScriptProblems(["sw.js"], []), []);
  assert.equal(clientScriptProblems(["sw2.js"], []).length, 1);
  const unmarked = CLIENT_ASSETS.map((a) => (a.file === "lens-browser.js" ? { ...a, marker: "" } : a));
  assert.match(clientScriptProblems(files, unmarked).join("\n"), /^lens-browser\.js carries no marker, so a minifier deleting it would pass the build$/m);
});

test("every script row carries a marker the minified output must keep, and the marker is in the source", async () => {
  for (const r of minifiedScripts()) {
    assert.ok(r.marker.length > 0, `${r.file} carries no marker, so a minifier deleting it would pass the build`);
    const src = await readFile(new URL(`src/client/${r.file}`, ROOT), "utf8");
    assert.ok(src.includes(r.marker), `${r.file}: marker "${r.marker}" is not in the source, so the tripwire would fire on every build`);
    assert.equal(r.twin, `/${r.file.replace(/\.js$/, ".src.js")}`, `${r.file}: the readable twin is named for the file`);
  }
});

test("build.ts runs the same completeness check as an invariant and minifies from the registry", async () => {
  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  assert.match(build, /const problems = clientScriptProblems\(await readdir\("src\/client", \{ recursive: true \}\)\);\n\s*if \(problems\.length\) throw new Error/, "the build fails on what clientScriptProblems reports, reading src/client recursively");
  assert.match(build, /for \(const \{ file, twin: srcPath, marker, module \} of minifiedScripts\(\)\) \{/, "step 3 minifies the registry's rows");
  assert.match(build, /if \(marker && !min\.includes\(marker\)\) \{\n\s*throw new Error/, "and fails on a minified output that lost its marker");
});
