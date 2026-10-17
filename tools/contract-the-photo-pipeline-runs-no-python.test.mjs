// gen-alt-text.py was the last interpreter the photo pipeline spawned, and it
// was the one file the shell path sweep of gotcha 40 could not see: a repointed
// ROOT captioned nothing for five days behind `python3 … || echo`. It is
// gen-alt-text.ts since 2026-09-15, beside the four node scripts add-photos.sh
// already ran. Four things have to hold for that to stay true, and the first
// is the one a green run could not prove: alt.json is COMMITTED, and the old
// script wrote it in Python's json.dump(indent=0, sort_keys=True) shape, so the
// serializer has to reproduce the committed file byte for byte or the first
// captioned photo diffs 258 lines it did not touch.
import path from "node:path";
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

// THE SCANNED SET IS DERIVED, since 2026-09-22. This test used to read a
// hand-kept list of three files (add-photos.sh, extract-photo-metadata.sh,
// photo-pipeline.yml), and add-photos.sh calls hash-thumbnails.sh on every
// photo add, which ran a `python3 - ... <<'EOF'` heredoc for a week after the
// ban was declared. The pattern would have matched it; the list never showed
// it the file. So the set is now whatever the pipeline's entry points actually
// invoke, followed transitively, plus every committed shell script in the tree
// whether or not anything reaches it.

/** A file's executable lines. A COMMENT may say the word, because the history
 *  of why this holds lives in comments; a spawn, a shebang or a setup step may
 *  not. The shebang is kept on purpose, since `#!` is the one comment-shaped
 *  line that runs something. */
const codeOf = (rel, text) => {
  const lines = text.split("\n");
  const comment = /\.(?:sh|ya?ml)$/.test(rel) ? /^\s*#(?!!)/ : /^\s*(?:\/\/|\*|\/\*)/;
  return lines.filter((l, i) => !(comment.test(l) && !(i === 0 && l.startsWith("#!")))).join("\n");
};

/** Each offending line: an interpreter spawn (`python3 script.py`, the
 *  `python3 - <<'EOF'` heredoc form, a quoted argv element), a python shebang,
 *  a `.py` path, or a setup step. */
const PYTHON = [
  /\bpython3?\s+-(?:\s|$)/, // the heredoc / stdin form, named separately because it is the one that got through
  /\bpython3?(?:\s|["'`)]|$)/,
  /^#!.*\bpython/,
  /[\w/-]\.py\b/,
  /setup-python/,
];
const pythonSpawns = (rel, text) => codeOf(rel, text).split("\n").filter((l) => PYTHON.some((re) => re.test(l)));

/** Every committed file an entry point runs, followed transitively: shell
 *  `$SCRIPT_DIR/<name>`, `$PROJECT_DIR/tools/...`, `./tools/...` and bare
 *  `tools/...` paths, plus `bun run <script>` through package.json, whose value
 *  is scanned as a node of its own. Returns the visited set in visit order. */
const invokedClosure = (entries, read, scripts) => {
  const seen = new Set();
  const queue = [...entries];
  const refs = (from, text) => {
    const out = [];
    for (const m of text.matchAll(/\$\{?SCRIPT_DIR\}?\/([\w.-]+\.(?:sh|ts|mjs|js))\b/g)) out.push(path.posix.join(path.posix.dirname(from), m[1]));
    for (const m of text.matchAll(/(?:^|[\s"'=(])(?:\$\{?PROJECT_DIR\}?\/|\.\/)?(tools\/[\w/.-]+\.(?:sh|ts|mjs|js))\b/gm)) out.push(m[1]);
    for (const m of text.matchAll(/\bbun run ([\w:-]+)/g)) out.push(`package.json#${m[1]}`);
    return out;
  };
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = rel.startsWith("package.json#") ? scripts[rel.slice(13)] : read(rel);
    assert.equal(typeof text, "string", `${rel} is invoked on the photo pipeline's path and does not exist`);
    queue.push(...refs(rel, codeOf(rel.startsWith("package.json#") ? "x.sh" : rel, text)));
  }
  return [...seen];
};

const PIPELINE_ENTRIES = ["tools/photos/add-photos.sh", "tools/photos/reencode-thumbnails.sh", "tools/photos/extract-photo-metadata.sh", ".github/workflows/photo-pipeline.yml"];

test("nothing on the photo pipeline's path spawns python", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync } = await import("node:fs");
  const root = fileURLToPath(ROOT);
  const tracked = new Set(execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean));
  const read = (rel) => (tracked.has(rel) ? readFileSync(path.join(root, rel), "utf8") : undefined);
  const scripts = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8")).scripts;

  const closure = invokedClosure(PIPELINE_ENTRIES, read, scripts);
  // Floor: the closure has to reach the scripts this file exists for, or the
  // reference scanner has stopped matching and every assertion below is vacuous.
  for (const must of ["tools/photos/hash-thumbnails.sh", "tools/photos/pipeline-json.ts", "tools/photos/gen-alt-text.ts", "tools/photos/require-exif-sooc.sh", "tools/photos/check-photo-pipeline.ts", "package.json#photos"]) {
    assert.ok(closure.includes(must), `the invocation closure no longer reaches ${must}; it found ${closure.length} nodes`);
  }
  // Every committed shell script too, reached or not: a script nothing calls
  // today is one somebody calls tomorrow.
  const shells = [...tracked].filter((f) => f.endsWith(".sh"));
  assert.ok(shells.length >= 13, `git ls-files found ${shells.length} shell scripts`);

  for (const rel of new Set([...closure, ...shells])) {
    const text = rel.startsWith("package.json#") ? scripts[rel.slice(13)] : read(rel);
    assert.deepEqual(pythonSpawns(rel.startsWith("package.json#") ? "x.sh" : rel, text), [], `${rel} spawns python`);
  }
  assert.equal(scripts.captions, "bun tools/photos/gen-alt-text.ts");
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

test("control: the derived scan catches the heredoc the hand-kept list missed", () => {
  // The exact shapes that shipped on 2026-09-15: add-photos.sh calling
  // hash-thumbnails.sh, and hash-thumbnails.sh piping a heredoc to python3.
  const repo = {
    "tools/photos/add-photos.sh": '#!/usr/bin/env bash\n# python is gone from this pipeline\n"$SCRIPT_DIR/hash-thumbnails.sh" 2>&1 | tail -1\nbun "$SCRIPT_DIR/pipeline-json.ts" length "$INDEX_FILE"\n',
    "tools/photos/hash-thumbnails.sh": "#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p \"$OUT_DIR\"\n\npython3 - \"$SRC_DIR\" \"$OUT_DIR\" \"$MAP\" <<'EOF'\nimport hashlib\nEOF\n",
    "tools/photos/pipeline-json.ts": "// a comment may say python3 script.py\nimport fs from \"node:fs\";\n",
  };
  const closure = invokedClosure(["tools/photos/add-photos.sh"], (rel) => repo[rel], {});
  assert.deepEqual(closure, ["tools/photos/add-photos.sh", "tools/photos/hash-thumbnails.sh", "tools/photos/pipeline-json.ts"]);
  // The old list held three files and not this one, which is the whole bug.
  assert.ok(!["tools/photos/add-photos.sh", "tools/photos/extract-photo-metadata.sh", ".github/workflows/photo-pipeline.yml"].includes("tools/photos/hash-thumbnails.sh"));
  assert.deepEqual(pythonSpawns("tools/photos/hash-thumbnails.sh", repo["tools/photos/hash-thumbnails.sh"]), [`python3 - "$SRC_DIR" "$OUT_DIR" "$MAP" <<'EOF'`]);
  // Comments stay free to say the word; the other spawn shapes do not.
  assert.deepEqual(pythonSpawns("tools/photos/add-photos.sh", repo["tools/photos/add-photos.sh"]), []);
  assert.deepEqual(pythonSpawns("tools/photos/pipeline-json.ts", repo["tools/photos/pipeline-json.ts"]), []);
  assert.equal(pythonSpawns("x.sh", "#!/usr/bin/env python3\nprint(1)\n").length, 1, "a python shebang is a spawn");
  assert.equal(pythonSpawns("x.ts", 'execFileSync("python3", ["-c", "1"]);\n').length, 1, "a quoted argv element is a spawn");
  assert.equal(pythonSpawns("x.sh", "uv run tools/gen.py\n").length, 1, "a .py path is a spawn");
  assert.equal(pythonSpawns("x.yml", "      - uses: actions/setup-python@v5\n").length, 1);
  // A reference to a script that does not exist fails rather than shrinking
  // the closure, since a renamed callee is exactly how a scan goes quiet.
  assert.throws(() => invokedClosure(["a.sh"], (rel) => ({ "a.sh": '"$SCRIPT_DIR/gone.sh"\n' })[rel], {}), /gone\.sh is invoked/);
  // `bun run` goes through package.json.
  assert.deepEqual(invokedClosure(["w.yml"], (rel) => ({ "w.yml": "run: bun run photos\n", "tools/photos/add-photos.sh": "" })[rel], { photos: "bash tools/photos/add-photos.sh" }),
    ["w.yml", "package.json#photos", "tools/photos/add-photos.sh"]);
});
