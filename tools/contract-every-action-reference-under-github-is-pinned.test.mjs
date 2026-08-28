// ── every action reference under .github is pinned ───────────────────────────
// Shared imports live in contract-shared.mjs.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { auditActionPins, classifyRef, scanActionRefs } from "./lib/action-pins.ts";

// THIS FILE EXISTS BECAUSE THE FIRST VERSION OF THE SCAN PASSED THREE ATTACKS.
// It lived inline in check-infra.ts, matched `/^\s*(?:-\s+)?uses:/`, and
// reported "all 32 third-party action reference(s) in .github are
// commit-pinned" over a flow-style step running `attacker/evil-action@main`.
// Every fixture below is one of those attacks, kept runnable so a refactor
// cannot reopen a hole by tidying a regex.
//
// The floor in infra.json catches a scan that stopped matching and CANNOT catch
// an evasion, since a hidden ref moves the count by zero or one. These fixtures
// are what covers that half.

const root = fileURLToPath(ROOT);

/** A fixture repository: a Map of repo-relative path to contents, wearing the
 *  ActionIo shape auditActionPins takes. Two methods, both repo-relative, so a
 *  fixture needs no temp directory and no cleanup. */
function memoryIo(files) {
  const map = new Map(Object.entries(files));
  return {
    async read(rel) {
      return map.has(rel) ? map.get(rel) : null;
    },
    async list(dir) {
      // An ABSENT directory is an empty list rather than a throw. That is the
      // whole of the .github/actions repair: readdir's ENOENT used to take the
      // required check down over a directory GitHub Actions treats as optional.
      return [...map.keys()].filter((p) => p.startsWith(`${dir}/`)).sort();
    },
  };
}

/** The real tree, through the same adapter check-infra.ts builds. */
function diskIo() {
  const io = {
    async read(rel) {
      return readFile(join(root, rel), "utf8").then((s) => s, () => null);
    },
    async list(dir) {
      const out = [];
      let entries;
      try {
        entries = await readdir(join(root, dir), { withFileTypes: true });
      } catch {
        return out;
      }
      for (const e of entries) {
        if (e.isDirectory()) out.push(...await io.list(`${dir}/${e.name}`));
        else if (e.isFile()) out.push(`${dir}/${e.name}`);
      }
      return out;
    },
  };
  return io;
}

const OK = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

const workflow = (body) => `name: fixture\non: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${body}\n`;

// ---------------------------------------------------------------- the tree --

test("the walked file set is every workflow plus every composite, and nothing else", async () => {
  const audit = await auditActionPins(diskIo());
  const onDisk = (await readdir(join(root, ".github/workflows")))
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => `.github/workflows/${f}`)
    .sort();

  // PINNED as a SET rather than a count. A count goes green when one file
  // silently replaces another, which is the failure this whole file is about.
  const walked = new Set(audit.files);
  for (const f of onDisk) assert.ok(walked.has(f), `${f} is a workflow this scan never opened`);
  assert.ok(walked.has(".github/actions/setup-bun/action.yml"), "the setup-bun composite must be scanned, not exempted for being local");
  assert.equal(audit.files.length, onDisk.length + 1, `walked ${audit.files.join(", ")}`);
});

test("the committed tree has no unpinned, unreadable or unresolvable reference", async () => {
  const audit = await auditActionPins(diskIo());
  assert.deepEqual(audit.problems, []);
  // A floor on the scan itself: if this collapses, every assertion above is
  // agreeing with a scanner that read nothing.
  assert.ok(audit.remote >= 24, `only ${audit.remote} third-party refs found`);
  assert.ok(audit.local >= 1, "no local ./ refs found, so the resolver never ran");
  // 7 repositories across 8 paths, because github/codeql-action contributes
  // `init` and `analyze` from one commit. infra.json's note says so and the
  // printed pass line used to contradict it by calling paths "actions".
  assert.ok(audit.paths.size >= audit.repos.size, "paths can never be fewer than repositories");
});

// ------------------------------------------------------------ the attacks --

test("a flow-style step cannot smuggle an unpinned action past the scan", async () => {
  const io = memoryIo({
    ".github/workflows/ci.yml": workflow(`      - {name: Exfiltrate, uses: attacker/evil-action@main}\n      - uses: ${OK}`),
  });
  const audit = await auditActionPins(io);
  const hit = audit.problems.find((p) => p.ref === "attacker/evil-action@main");
  assert.ok(hit, `flow-style step went unreported: ${JSON.stringify(audit.problems)}`);
  assert.equal(hit.kind, "unpinned");
  assert.equal(hit.line, 7);
});

test("a `uses:` whose value sits on the next line FAILS rather than reading as absent", async () => {
  const io = memoryIo({
    ".github/workflows/ci.yml": workflow("      - name: sneaky\n        uses:\n          actions/setup-python@v7"),
  });
  const audit = await auditActionPins(io);
  // Two findings, and both are correct: the key pass refuses the shape it
  // cannot read, and the shape pass catches the ref sitting below it.
  assert.ok(audit.problems.some((p) => p.kind === "unreadable"), "the dangling `uses:` must fail closed");
  assert.ok(audit.problems.some((p) => p.ref === "actions/setup-python@v7"), "the scalar on the next line must still be seen");
});

test("a local ref is followed into a NESTED composite, at any depth", async () => {
  const io = memoryIo({
    ".github/workflows/ci.yml": workflow("      - uses: ./.github/actions/toolchain/python"),
    ".github/actions/toolchain/python/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-python@v7\n",
  });
  const audit = await auditActionPins(io);
  assert.ok(audit.files.includes(".github/actions/toolchain/python/action.yml"), "the nested composite was never opened");
  const hit = audit.problems.find((p) => p.ref === "actions/setup-python@v7");
  assert.ok(hit, "the nested composite's unpinned ref went unreported");
  assert.equal(hit.file, ".github/actions/toolchain/python/action.yml");
});

test("a local ref is followed OUTSIDE .github, which no walk of .github can reach", async () => {
  const io = memoryIo({
    ".github/workflows/ci.yml": workflow("      - uses: ./ci-actions/setup-python"),
    "ci-actions/setup-python/action.yml": "runs:\n  using: composite\n  steps:\n    - uses: actions/setup-python@v7\n",
  });
  const audit = await auditActionPins(io);
  assert.ok(audit.files.includes("ci-actions/setup-python/action.yml"), "GitHub honours ./ anywhere in the repo, so the walk must too");
  assert.ok(audit.problems.some((p) => p.file === "ci-actions/setup-python/action.yml"));
});

test("a local ref that resolves to nothing FAILS instead of being exempted", async () => {
  const io = memoryIo({ ".github/workflows/ci.yml": workflow("      - uses: ./.github/actions/gone") });
  const audit = await auditActionPins(io);
  assert.equal(audit.problems.length, 1);
  assert.equal(audit.problems[0].kind, "local-missing");
});

test("a local ref that climbs above the repository root FAILS", async () => {
  const io = memoryIo({ ".github/workflows/ci.yml": workflow("      - uses: ./../../etc/evil") });
  const audit = await auditActionPins(io);
  assert.equal(audit.problems[0]?.kind, "local-missing");
});

test("a cycle between two composites terminates", async () => {
  const io = memoryIo({
    ".github/workflows/ci.yml": workflow("      - uses: ./.github/actions/a"),
    ".github/actions/a/action.yml": "runs:\n  steps:\n    - uses: ./.github/actions/b\n",
    ".github/actions/b/action.yml": "runs:\n  steps:\n    - uses: ./.github/actions/a\n",
  });
  const audit = await auditActionPins(io);
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.files.length, 3);
});

// ------------------------------------------------------------ degradation --

test("a repository with no .github/actions scans clean rather than throwing", async () => {
  const io = memoryIo({ ".github/workflows/ci.yml": workflow(`      - uses: ${OK}`) });
  const audit = await auditActionPins(io);
  assert.deepEqual(audit.problems, []);
  assert.equal(audit.remote, 1);
  assert.equal(audit.local, 0);
});

// ------------------------------------------------------------- the shapes --

test("classifyRef fails closed on anything it does not recognise", () => {
  assert.equal(classifyRef(OK).kind, "pinned");
  assert.equal(classifyRef("actions/checkout@v7").kind, "unpinned");
  assert.equal(classifyRef("github/codeql-action/init@cdf488f595d80d6e07e03d4674febd5ab45fa938").kind, "pinned", "a sub-path is part of the ref, so codeql-action/init pins like any other");
  assert.equal(classifyRef(`actions/checkout@${"a".repeat(39)}`).kind, "unpinned", "40 hex means forty, not roughly forty");
  assert.equal(classifyRef(`actions/checkout@${"A".repeat(40)}`).kind, "unpinned", "git prints a sha in lower case, so upper case is a shape nobody writes");
  assert.equal(classifyRef("./.github/actions/setup-bun").kind, "local");
  assert.equal(classifyRef(null).kind, "unreadable");
  assert.equal(classifyRef(">-").kind, "unreadable", "a block scalar indicator is not a ref");
  assert.equal(classifyRef("*anchor").kind, "unreadable");
  assert.equal(classifyRef("docker://alpine:3.18").kind, "unpinned", "an image tag is mutable the same way a git tag is");
  assert.equal(classifyRef(`docker://alpine@sha256:${"0".repeat(64)}`).kind, "pinned");
});

test("the key matcher reads `uses:` wherever it sits, quoted or not", () => {
  const rows = [
    ['      - uses: actions/checkout@v7', "actions/checkout@v7"],
    ['      - {uses: actions/checkout@v7}', "actions/checkout@v7"],
    ['      - {"uses": "actions/checkout@v7"}', "actions/checkout@v7"],
    ["      - uses: 'actions/checkout@v7'", "actions/checkout@v7"],
    [`      - uses: ${OK} # v7.0.1`, OK],
  ];
  for (const [line, want] of rows) {
    const found = scanActionRefs("f.yml", line);
    assert.ok(found.some((r) => r.ref === want), `${line} read as ${JSON.stringify(found.map((r) => r.ref))}`);
  }
});

test("the shape pass catches a ref on a line carrying no readable `uses:` key", () => {
  // YAML's explicit-key form puts `uses` and its value on separate lines, so
  // neither line carries a `uses:` the key pass can read.
  const found = scanActionRefs("f.yml", "      ? uses\n      : actions/setup-python@v7");
  assert.ok(found.some((r) => r.ref === "actions/setup-python@v7" && r.kind === "unpinned"));
});

test("a pinned ref in prose is not a finding, so the shape pass costs no false positive", () => {
  const found = scanActionRefs("f.yml", `      # we run ${OK} on every job`);
  assert.deepEqual(found, []);
});
