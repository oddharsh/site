// gen-alt-text.py was the last interpreter the photo pipeline spawned, and it
// was the one file the shell path sweep of gotcha 40 could not see: a repointed
// ROOT captioned nothing for five days behind `python3 … || echo`. It is
// gen-alt-text.ts since 2026-09-15, beside the four node scripts add-photos.sh
// already ran. Four things have to hold for that to stay true, and the first
// is the one a green run could not prove: alt.json is COMMITTED, and the old
// script wrote it in Python's json.dump(indent=0, sort_keys=True) shape, so the
// serializer has to reproduce the committed file byte for byte or the first
// captioned photo diffs 258 lines it did not touch.
import { fileURLToPath } from "node:url";
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { clean, serializeAlt } from "./photos/gen-alt-text.ts";

test("serializeAlt reproduces the committed alt.json byte for byte", async () => {
  const raw = await readFile(new URL("public/images/alt.json", ROOT), "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(Object.keys(parsed).length >= 100, "the fixture is the real file, so a collapse here is a real loss");
  assert.equal(serializeAlt(parsed), raw);
  // Controls: the shape is load-bearing in three places a naive JSON.stringify
  // gets wrong. Keys sort by code point, entries sit one per line with no
  // indent, and there is no trailing newline.
  assert.equal(serializeAlt({ b: "2", a: "1" }), '{\n"a": "1",\n"b": "2"\n}');
  assert.equal(serializeAlt({}), "{\n\n}");
  assert.notEqual(serializeAlt({ a: "1" }), JSON.stringify({ a: "1" }, null, 1));
});

test("clean() is the worker's post-processing, regex for regex", async () => {
  // The script and cf-garage's ?mode=alt branch each carry the strip; the
  // comment in both says keep them in sync, and this is the check that does.
  const script = await readFile(new URL("tools/photos/gen-alt-text.ts", ROOT), "utf8");
  const worker = await readFile(new URL("cf-garage/src/index.ts", ROOT), "utf8");
  const strip = /\.replace\((\/\^\(an\? \|the \)\?\(image\|photo\|photograph\|picture\) \(of\|shows\|depicts\|captures\)\\s\*\/i), ""\)/;
  const a = script.match(strip), b = worker.match(strip);
  assert.ok(a && b, "both files must carry the strip regex in the same literal form");
  assert.equal(a[1], b[1]);
  assert.equal(clean("  an image of a bus seat with   a button "), "A bus seat with a button");
  assert.equal(clean("The photo shows two cars"), "Two cars");
  assert.equal(clean("picture depicts a dog"), "A dog");
  assert.equal(clean(""), "");
});

test("nothing on the photo pipeline's path spawns python", async () => {
  for (const rel of ["tools/photos/add-photos.sh", "tools/photos/extract-photo-metadata.sh", ".github/workflows/photo-pipeline.yml"]) {
    const text = await readFile(new URL(rel, ROOT), "utf8");
    // A COMMENT may say the word: the history of why this holds lives in
    // comments. A spawn or a setup step may not.
    const code = text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    assert.doesNotMatch(code, /\bpython3? /, `${rel} spawns python`);
    assert.doesNotMatch(code, /setup-python/, `${rel} sets up python`);
  }
  const scripts = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8")).scripts;
  assert.equal(scripts.captions, "node tools/photos/gen-alt-text.ts");
  assert.equal(scripts["photos:env"], undefined, "the Pillow venv builder left with the last Python");
  for (const [name, cmd] of Object.entries(scripts)) assert.doesNotMatch(cmd, /\bpython3?\b|\buv\b/, `script ${name} names python`);
});

test("no Python is committed, declared, or pinned anywhere in the tree", async () => {
  // The last three .py files left on 2026-09-15 (gen-alt-text, matched-bytes-
  // probe, gen-pixel-peeper). config/retired.json bans the binary; this holds
  // the other three shapes a return could take.
  const { execFileSync } = await import("node:child_process");
  const py = execFileSync("git", ["ls-files", "-z", "*.py", "**/*.py", "*/requirements*.txt", "**/requirements*.txt"], { cwd: fileURLToPath(ROOT), encoding: "utf8" }).split("\0").filter(Boolean);
  assert.deepEqual(py, [], `Python files are committed: ${py.join(", ")}`);
  const tools = JSON.parse(await readFile(new URL("config/tools.json", ROOT), "utf8")).tools;
  assert.equal(tools.some((t) => /^python|^uv$/.test(t.bin)), false, "tools.json declares an interpreter");
  const dependabot = await readFile(new URL(".github/dependabot.yml", ROOT), "utf8");
  assert.doesNotMatch(dependabot, /package-ecosystem: pip/, "the pip lane is back");
  // Control: the ls-files pathspec matches when there is something to match.
  const ts = execFileSync("git", ["ls-files", "-z", "tools/photos/*.ts"], { cwd: fileURLToPath(ROOT), encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(ts.includes("tools/photos/gen-pixel-peeper.ts"), "the pathspec scanner sees files that exist");
});
