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
  assert.equal(serializeAlt({ b: "2", a: "1" }), '{\n"a": "1",\n"b": "2"\n}');
  assert.equal(serializeAlt({}), "{\n\n}");
  assert.notEqual(serializeAlt({ a: "1" }), JSON.stringify({ a: "1" }, null, 1));
});

test("clean() is the worker's post-processing, regex for regex", async () => {
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

const codeOf = (rel, text) => {
  const lines = text.split("\n");
  const comment = /\.(?:sh|ya?ml)$/.test(rel) ? /^\s*#(?!!)/ : /^\s*(?:\/\/|\*|\/\*)/;
  return lines.filter((l, i) => !(comment.test(l) && !(i === 0 && l.startsWith("#!")))).join("\n");
};

const PYTHON = [
  /\bpython3?\s+-(?:\s|$)/,
  /\bpython3?(?:\s|["'`)]|$)/,
  /^#!.*\bpython/,
  /[\w/-]\.py\b/,
  /setup-python/,
];
const pythonSpawns = (rel, text) => codeOf(rel, text).split("\n").filter((l) => PYTHON.some((re) => re.test(l)));

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
  for (const must of ["tools/photos/hash-thumbnails.sh", "tools/photos/pipeline-json.ts", "tools/photos/gen-alt-text.ts", "tools/photos/require-exif-sooc.sh", "tools/photos/check-photo-pipeline.ts", "package.json#photos"]) {
    assert.ok(closure.includes(must), `the invocation closure no longer reaches ${must}; it found ${closure.length} nodes`);
  }
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
  const { execFileSync } = await import("node:child_process");
  const py = execFileSync("git", ["ls-files", "-z", "*.py", "**/*.py", "*/requirements*.txt", "**/requirements*.txt"], { cwd: fileURLToPath(ROOT), encoding: "utf8" }).split("\0").filter(Boolean);
  assert.deepEqual(py, [], `Python files are committed: ${py.join(", ")}`);
  const tools = JSON.parse(await readFile(new URL("config/tools.json", ROOT), "utf8")).tools;
  assert.equal(tools.some((t) => /^python|^uv$/.test(t.bin)), false, "tools.json declares an interpreter");
  const dependabot = await readFile(new URL(".github/dependabot.yml", ROOT), "utf8");
  assert.doesNotMatch(dependabot, /package-ecosystem: pip/, "the pip lane is back");
  const ts = execFileSync("git", ["ls-files", "-z", "tools/photos/*.ts"], { cwd: fileURLToPath(ROOT), encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(ts.includes("tools/photos/gen-pixel-peeper.ts"), "the pathspec scanner sees files that exist");
});

test("control: the derived scan catches the heredoc the hand-kept list missed", () => {
  const repo = {
    "tools/photos/add-photos.sh": '#!/usr/bin/env bash\n# python is gone from this pipeline\n"$SCRIPT_DIR/hash-thumbnails.sh" 2>&1 | tail -1\nbun "$SCRIPT_DIR/pipeline-json.ts" length "$INDEX_FILE"\n',
    "tools/photos/hash-thumbnails.sh": "#!/usr/bin/env bash\nset -euo pipefail\nmkdir -p \"$OUT_DIR\"\n\npython3 - \"$SRC_DIR\" \"$OUT_DIR\" \"$MAP\" <<'EOF'\nimport hashlib\nEOF\n",
    "tools/photos/pipeline-json.ts": "// a comment may say python3 script.py\nimport fs from \"node:fs\";\n",
  };
  const closure = invokedClosure(["tools/photos/add-photos.sh"], (rel) => repo[rel], {});
  assert.deepEqual(closure, ["tools/photos/add-photos.sh", "tools/photos/hash-thumbnails.sh", "tools/photos/pipeline-json.ts"]);
  assert.ok(!["tools/photos/add-photos.sh", "tools/photos/extract-photo-metadata.sh", ".github/workflows/photo-pipeline.yml"].includes("tools/photos/hash-thumbnails.sh"));
  assert.deepEqual(pythonSpawns("tools/photos/hash-thumbnails.sh", repo["tools/photos/hash-thumbnails.sh"]), [`python3 - "$SRC_DIR" "$OUT_DIR" "$MAP" <<'EOF'`]);
  assert.deepEqual(pythonSpawns("tools/photos/add-photos.sh", repo["tools/photos/add-photos.sh"]), []);
  assert.deepEqual(pythonSpawns("tools/photos/pipeline-json.ts", repo["tools/photos/pipeline-json.ts"]), []);
  assert.equal(pythonSpawns("x.sh", "#!/usr/bin/env python3\nprint(1)\n").length, 1, "a python shebang is a spawn");
  assert.equal(pythonSpawns("x.ts", 'execFileSync("python3", ["-c", "1"]);\n').length, 1, "a quoted argv element is a spawn");
  assert.equal(pythonSpawns("x.sh", "uv run tools/gen.py\n").length, 1, "a .py path is a spawn");
  assert.equal(pythonSpawns("x.yml", "      - uses: actions/setup-python@v5\n").length, 1);
  assert.throws(() => invokedClosure(["a.sh"], (rel) => ({ "a.sh": '"$SCRIPT_DIR/gone.sh"\n' })[rel], {}), /gone\.sh is invoked/);
  assert.deepEqual(invokedClosure(["w.yml"], (rel) => ({ "w.yml": "run: bun run photos\n", "tools/photos/add-photos.sh": "" })[rel], { photos: "bash tools/photos/add-photos.sh" }),
    ["w.yml", "package.json#photos", "tools/photos/add-photos.sh"]);
});
