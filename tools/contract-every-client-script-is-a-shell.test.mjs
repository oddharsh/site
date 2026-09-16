// ── every client script is a SHELLS row ─────────────────────────────────────
// build.ts step 3 minifies the client scripts named in SHELLS, ships each one a
// readable .src.js twin, and fails the build when the minified output has lost
// that row's MARKER. The marker is the one tripwire that turns a minifier
// deleting a whole island into a red build: measured 2026-09-15,
// `propertyWriteSideEffects: false` minified six /lens islands to 0 bytes,
// and "lens-browser.js: minified output lost the LensBrowser marker" is what
// stopped it. A file in src/client that is NOT a row gets none of that: it
// stages readable and verbatim, with no twin and nothing watching it.
//
// Three tests pinned three files by name (infotip, webmcp, lens-webmcp), each
// written the day its file was nearly left out. That is the allowlist that
// only grows when somebody remembers. These read the directory instead, so
// the next island is covered on the day it is written. The build carries the
// same check as an invariant; this is the copy `bun run test` reaches without
// a build. sw.js is the one exception, and the comment above SHELLS is why.
import { ROOT, assert, readFile, readdir, test } from "./contract-shared.ts";

const shellRows = async () => {
  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  const start = build.indexOf("const SHELLS = [");
  const block = build.slice(start, build.indexOf("\n];", start));
  assert.ok(start > 0 && block.length > 0, "could not find SHELLS in build.ts");
  return [...block.matchAll(/^\s*\["([^"]+\.js)",\s*"([^"]+)",\s*"([^"]*)"\]/gm)].map((m) => ({ file: m[1], twin: m[2], marker: m[3] }));
};

test("every src/client script except sw.js is a SHELLS row, so it ships minified, twinned, and under a marker", async () => {
  const rows = await shellRows();
  assert.ok(rows.length >= 15, `only ${rows.length} SHELLS rows parsed; the row shape changed and this test is reading nothing`);
  const files = (await readdir(new URL("src/client/", ROOT))).filter((f) => f.endsWith(".js")).sort();
  const missing = files.filter((f) => f !== "sw.js" && !rows.some((r) => r.file === f));
  assert.deepEqual(missing, [], `${missing.join(", ")} would ship unminified with no twin and no marker tripwire`);
  assert.ok(files.includes("sw.js"), "sw.js is the documented exception; if it is gone, drop the exception here and in build.ts");
});

test("every SHELLS row carries a marker the minified output must keep, and the marker is in the source", async () => {
  const rows = await shellRows();
  for (const r of rows) {
    assert.ok(r.marker.length > 0, `${r.file} carries no marker, so a minifier deleting it would pass the build`);
    const src = await readFile(new URL(`src/client/${r.file}`, ROOT), "utf8");
    assert.ok(src.includes(r.marker), `${r.file}: marker "${r.marker}" is not in the source, so the tripwire would fire on every build`);
    assert.equal(r.twin, `/${r.file.replace(/\.js$/, ".src.js")}`, `${r.file}: the readable twin is named for the file`);
  }
});

test("build.ts carries the same completeness check as an invariant, naming sw.js as the one exception", async () => {
  const build = await readFile(new URL("tools/build.ts", ROOT), "utf8");
  assert.match(build, /in src\/client but not in the list, so it would ship unminified/, "the build fails on a client script missing from SHELLS");
  assert.match(build, /carries no marker, so a minifier deleting it would pass the build/, "the build fails on a row with no marker");
  assert.match(build, /f !== "sw\.js" && !rows\.has\(f\)/, "the invariant exempts sw.js and nothing else");
});
