// ── retired dependencies stay retired ────────────────────────────────────────
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

import { BAN_KINDS, binaryViolations, cargoLockViolations, cargoManifestViolations, inTree, npmViolations, sourceViolations } from "../lib/retired.ts";
import { repoFiles } from "../lib/repo-files.ts";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(ROOT);

// config/retired.json records every dependency this repository replaced with
// first-party code, and this file is the whole enforcement. Before it, three
// retirements were held three different ways: turndown by two assertions inside
// a test about the Reader's Markdown walk, exiftool and jq by prose in
// config/tools.json, and the rest by nothing at all.
//
// The reader test KEEPS its own narrower turndown assertion on purpose. It is
// making a claim about that Worker's traversal count rather than about the
// dependency graph, and it reads `lens-reader/src/reader.ts` to make it. What
// the ledger adds is the same ban across every committed manifest.

const ledger = JSON.parse(await readFile(new URL("config/retired.json", ROOT), "utf8"));

/** Files a commit would hold matching a pathspec, from git rather than a walk.
 *
 *  Same idiom as the shell-script and Worker-source censuses beside it, and for
 *  the same reason: a directory walk answers about the disk, which carries
 *  node_modules and .build. Git answers about the repository, untracked files
 *  included, since a new one is one `git add` from CI (gotcha 91).
 */
function committed(...pathspec: string[]) {
  return repoFiles(pathspec, root);
}

test("every retirement is recorded with a replacement, a date and a measurement", () => {
  // A FLOOR, not an inventory. 12 entries on 2026-10-16. The number is here because a
  // parser that stops matching this file reads zero entries, runs zero bans and
  // prints a clean pass, which is how every naive scanner in this repository
  // has failed. Deleting one entry deliberately costs nothing; losing the file
  // trips it.
  assert.ok(ledger.retired.length >= 8, `config/retired.json holds ${ledger.retired.length} entries, expected at least 8`);

  for (const entry of ledger.retired) {
    const at = `config/retired.json ${JSON.stringify(entry.id)}`;
    assert.ok(typeof entry.replaced_by === "string" && entry.replaced_by.length > 0, `${at} must name what replaced it, even when that is nothing`);
    for (const field of ["why", "measured"]) {
      assert.ok(
        typeof entry[field] === "string" && entry[field].length > 40,
        `${at} needs a substantive ${field}. A retirement with no measurement is a preference wearing a commit message`,
      );
    }
    // `on` is checked for SHAPE rather than length, being the one short field.
    assert.match(entry.on, /^\d{4}-\d{2}-\d{2}$/, `${at} must date the retirement`);

    const kinds = Object.keys(entry.bans ?? {});
    assert.ok(kinds.length > 0, `${at} declares no ban, so nothing stops it coming back and the entry is a note rather than a record`);
    for (const kind of kinds) {
      assert.ok(
        BAN_KINDS.includes(kind),
        `${at} declares a ${JSON.stringify(kind)} ban, which tools/lib/retired.ts does not implement. An unrecognised key sits in the file looking like enforcement while doing nothing, the same way .github/dependabot.yml asked for a label GitHub did not have`,
      );
    }
  }
});

test("no committed manifest asks for a retired package", async () => {
  const manifests = committed("package.json", "*/package.json", "*/*/package.json");
  // 7 on 2026-10-16. The floor catches a pathspec that stops matching, which would
  // otherwise scan nothing and pass.
  assert.ok(manifests.length >= 5, `found ${manifests.length} committed package.json files, expected at least 5`);

  const banned = ledger.retired.filter((e) => e.bans.npm);
  assert.ok(banned.length >= 4, `only ${banned.length} npm ban(s) declared`);

  for (const manifest of manifests) {
    const text = await readFile(new URL(manifest, ROOT), "utf8");
    for (const entry of banned) {
      const found = npmViolations(manifest, text, entry.bans.npm);
      assert.deepEqual(found, [], `${manifest} asks for ${found.join(", ")}, retired ${entry.on}: ${entry.why}`);
    }
  }
});

test("config/tools.json declares no retired binary", async () => {
  const toolsJson = await readFile(new URL("config/tools.json", ROOT), "utf8");
  const declared = JSON.parse(toolsJson).tools;
  assert.ok(declared.length >= 15, `config/tools.json declares ${declared.length} tools, expected at least 15`);

  for (const entry of ledger.retired.filter((e) => e.bans.binary)) {
    const found = binaryViolations(toolsJson, entry.bans.binary);
    assert.deepEqual(found, [], `config/tools.json declares ${found.join(", ")}, retired ${entry.on} in favour of ${entry.replaced_by}`);
  }
});

test("the zenc crate carries no retired crate or cargo feature", async () => {
  for (const entry of ledger.retired.filter((e) => e.bans.cargo)) {
    const ban = entry.bans.cargo;
    const toml = await readFile(new URL(ban.manifest, ROOT), "utf8");
    assert.deepEqual(cargoManifestViolations(toml, ban), [], `${ban.manifest} carries something retired ${entry.on}: ${entry.why}`);

    // The LOCKFILE is the right surface here, which is the reverse of the npm
    // case and worth not confusing: rayon reaches this graph through the one
    // banned feature and through nothing else, so its presence is evidence.
    const lock = await readFile(new URL(ban.manifest.replace(/Cargo\.toml$/, "Cargo.lock"), ROOT), "utf8");
    const found = cargoLockViolations(lock, ban.crates ?? []);
    assert.deepEqual(found, [], `${ban.manifest.replace(/toml$/, "lock")} resolves ${found.join(", ")}, which only arrives through a feature this ledger bans`);
  }
});

test("no source tree imports a retired package", async () => {
  let scanned = 0;
  for (const entry of ledger.retired.filter((e) => e.bans.source)) {
    const { specifiers, trees, except = [] } = entry.bans.source;
    for (const tree of trees) {
      const files = committed(`${tree}/**`).filter((f) => inTree(f, tree) && !except.includes(f));
      for (const file of files) {
        const text = await readFile(new URL(file, ROOT), "utf8");
        const found = sourceViolations(file, text, specifiers);
        assert.deepEqual(found, [], `${file} imports ${found.join(", ")}, retired ${entry.on} in favour of ${entry.replaced_by}`);
        scanned += 1;
      }
    }
  }
  // The floor that separates a clean tree from a scan that matched nothing.
  // Those produce identical output, which is the failure this repo's own notes
  // describe three times over.
  assert.ok(scanned >= 200, `the source ban scanned ${scanned} files, expected at least 200`);
});

test("a named exception is a real file, and it still uses what it is excused for", async () => {
  // A partial retirement is recorded as an exception (a scope) rather than
  // rounded to a clean kill, and the exception has to stay honest in both
  // directions: a stale path would silently widen the ban's blind spot, and an exception for
  // a file that no longer imports the thing means the retirement is complete
  // and the entry should say so.
  //
  // No entry carries an exception today (Pillow's went on 2026-09-15), so the
  // real ledger runs this over nothing. The control below is what shows it can
  // still fail when the next exception is written.
  assert.deepEqual(await exceptionProblems(ledger.retired, committed, (file) => readFile(new URL(file, ROOT), "utf8")), []);
});

/** What is wrong with each `bans.source.except` entry, as messages. */
async function exceptionProblems(entries, isCommitted, read) {
  const problems: any[] = [];
  for (const entry of entries.filter((e) => e.bans.source?.except)) {
    const { specifiers, except } = entry.bans.source;
    for (const file of except) {
      if (isCommitted(file).length !== 1) {
        problems.push(`config/retired.json excuses ${file}, which is not a committed file`);
        continue;
      }
      if (sourceViolations(file, await read(file), specifiers).length === 0) {
        problems.push(
          `config/retired.json excuses ${file} from the ${entry.id} ban, but it no longer imports it. The retirement is complete: drop the exception and the scope note`,
        );
      }
    }
  }
  return problems;
}

test("the exception check fails on a stale path and on a finished retirement", async () => {
  const files = { "gen.py": "from PIL import Image\n", "done.py": "import json\n" };
  const isCommitted = (file) => (file in files ? [file] : []);
  const read = async (file) => files[file];
  const entry = (except) => ({ id: "pillow", bans: { source: { specifiers: ["PIL"], except } } });
  assert.deepEqual(await exceptionProblems([entry(["gen.py"])], isCommitted, read), []);
  assert.deepEqual(await exceptionProblems([entry(["gone.py", "done.py"])], isCommitted, read), [
    "config/retired.json excuses gone.py, which is not a committed file",
    "config/retired.json excuses done.py from the pillow ban, but it no longer imports it. The retirement is complete: drop the exception and the scope note",
  ]);
});

test("each ban kind catches the thing it bans", () => {
  // THE CONTROLS. Four predicates, each one regex away from matching nothing
  // and reporting a clean pass over a tree that violates it. The real-tree
  // tests above cannot tell a working check from a broken one, because both
  // print the same thing.
  assert.deepEqual(npmViolations("package.json", JSON.stringify({ devDependencies: { turndown: "^7" } }), ["turndown"]), ["devDependencies.turndown"]);
  assert.deepEqual(npmViolations("package.json", JSON.stringify({ dependencies: { wrangler: "4" } }), ["turndown"]), []);

  assert.deepEqual(binaryViolations(JSON.stringify({ tools: [{ bin: "jaq" }, { bin: "exiftool" }] }), ["exiftool"]), ["exiftool"]);
  assert.deepEqual(binaryViolations(JSON.stringify({ tools: [{ bin: "jaq" }] }), ["exiftool"]), []);

  const ban = { manifest: "x", crates: ["rayon"], features: [{ crate: "zenjpeg", feature: "parallel" }] };
  assert.deepEqual(cargoManifestViolations(`[dependencies]\nzenjpeg = { version = "0.8.4", features = ["trellis", "parallel"] }\n`, ban), ["zenjpeg/parallel"]);
  assert.deepEqual(cargoManifestViolations(`[dependencies]\nrayon = "1"\n`, ban), ["dependencies.rayon"]);
  assert.deepEqual(cargoManifestViolations(`[dependencies]\nzenjpeg = { version = "0.8.4", features = ["trellis"] }\n`, ban), []);

  assert.deepEqual(cargoLockViolations(`[[package]]\nname = "rayon"\nversion = "1.11.0"\n`, ["rayon"]), ["rayon"]);
  assert.deepEqual(cargoLockViolations(`[[package]]\nname = "image"\n`, ["rayon"]), []);

  // The two that matter most, because both are what a text scan gets wrong: a
  // comment naming the retired thing must pass, and a real import must fail.
  assert.deepEqual(sourceViolations("a.ts", `import T from "turndown";`, ["turndown"]), ["turndown"]);
  assert.deepEqual(sourceViolations("a.ts", `// BOTH NAMES BELOW ARE turndown ON PURPOSE`, ["turndown"]), []);
  assert.deepEqual(sourceViolations("a.py", `from PIL import Image`, ["PIL"]), ["PIL"]);
  assert.deepEqual(sourceViolations("a.py", `# the bake used to import PIL`, ["PIL"]), []);

  assert.equal(inTree("tools/photos/x.py", "tools"), true);
  assert.equal(inTree("tools-old/x.py", "tools"), false, "a prefix test would put tools-old inside tools");
});
