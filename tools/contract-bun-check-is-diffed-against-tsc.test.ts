// The canary's checker gate (checkerAgreementGate in lib/bun-gates.ts) diffs
// a candidate bun's `bun check` against Microsoft's tsc. A diff that ignores
// chain lines, collapses duplicates or misreads an exit code would agree with
// anything, so each way it could go blind has a control here that must fail.
// The executables are shell stand-ins: the real tsc comes from the registry,
// and this suite runs with the network off.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TSC_REFERENCE, checkerAgreementGate, diagnosticBlocks, diffDiagnostics } from "./lib/bun-gates.ts";
import { defaultPrograms } from "./typecheck.ts";

const REPO = fileURLToPath(ROOT);

const A = "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.";
const B = "src/b.ts(4,3): error TS2345: Argument of type 'null' is not assignable to parameter of type 'URL'.";
const CHAIN = "  Type 'null' is not assignable to type 'URL'.";
const OUT = `${A}\n${B}\n${CHAIN}\n`;

test("a diagnostic's chain lines belong to it, and stray text is a block of its own", () => {
  assert.deepEqual(diagnosticBlocks(OUT), [A, `${B}\n${CHAIN}`]);
  assert.deepEqual(diagnosticBlocks("error TS5083: Cannot read file 'x.json'.\n\n"), ["error TS5083: Cannot read file 'x.json'."]);
  assert.deepEqual(diagnosticBlocks(`Stopped before type checking\n${A}\n`), ["Stopped before type checking", A]);
});

// The shape `bun check` printed on a GitHub runner on 2026-10-17: the plain
// line, then the same diagnostic as a workflow command.
const ANNOTATION = "::error file=src/a.ts,line=1,col=7,endLine=1,endColumn=9,title=TS2322::Type 'string' is not assignable to type 'number'.";

test("GitHub annotations beside the plain lines agree with tsc", () => {
  assert.equal(diffDiagnostics(diagnosticBlocks(OUT), diagnosticBlocks(`${A}\n${ANNOTATION}\n${B}\n${CHAIN}\n`)).agree, true);
});

test("CONTROL: annotations alone are not the diagnostics", () => {
  assert.deepEqual(diffDiagnostics(diagnosticBlocks(`${A}\n`), diagnosticBlocks(`${ANNOTATION}\n`)).onlyReference, [A]);
});

test("the same diagnostics in another order agree", () => {
  assert.equal(diffDiagnostics(diagnosticBlocks(OUT), diagnosticBlocks(`${B}\n${CHAIN}\n${A}\n`)).agree, true);
});

test("CONTROL: a dropped error, a changed chain line and a dropped duplicate each disagree", () => {
  const ref = diagnosticBlocks(OUT);
  assert.deepEqual(diffDiagnostics(ref, diagnosticBlocks(`${B}\n${CHAIN}\n`)).onlyReference, [A]);
  const reworded = diffDiagnostics(ref, diagnosticBlocks(`${A}\n${B}\n  Type 'null' is not assignable to type 'string'.\n`));
  assert.equal(reworded.onlyReference.length, 1);
  assert.equal(reworded.onlyCandidate.length, 1);
  assert.deepEqual(diffDiagnostics(diagnosticBlocks(`${A}\n${A}\n`), diagnosticBlocks(`${A}\n`)).onlyReference, [A]);
});

function fakes(scripts) {
  const dir = mkdtempSync(join(tmpdir(), "checker-gate-"));
  const paths: Record<string, any> = {};
  for (const [name, body] of Object.entries<string>(scripts)) {
    paths[name] = join(dir, name);
    writeFileSync(paths[name], `#!/bin/sh\n${body}\n`);
    chmodSync(paths[name], 0o755);
  }
  return { dir, paths };
}

const print = (text, status) => `printf '%s' '${text.replaceAll("'", "'\\''")}'; exit ${status}`;

test("the gate passes when bun check prints what tsc prints, and names a pinned bun that does not", () => {
  const { dir, paths } = fakes({ tsc: print(OUT, 1), same: print(OUT, 1), short: print(`${A}\n`, 1) });
  try {
    const green = checkerAgreementGate(paths.same, paths.same, paths.tsc, REPO, ["config/tsconfig.json"]);
    assert.equal(green.ok, true, green.detail);
    assert.equal(green.name, `bun check agrees with tsc ${TSC_REFERENCE}`);
    const fixed = checkerAgreementGate(paths.same, paths.short, paths.tsc, REPO, ["config/tsconfig.json"]);
    assert.equal(fixed.ok, true);
    assert.match(fixed.detail, /pinned bun disagrees in 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CONTROL: the gate fails on a dropped error, on a crash, and says whether the pin shares it", () => {
  const { dir, paths } = fakes({
    tsc: print(OUT, 1),
    same: print(OUT, 1),
    short: print(`${A}\n`, 1),
    crash: print("", 3),
    clean: print("", 0),
  });
  try {
    const regressed = checkerAgreementGate(paths.short, paths.same, paths.tsc, REPO, ["config/tsconfig.json"]);
    assert.equal(regressed.ok, false);
    assert.match((regressed.notes ?? []).join("\n"), /1 only in tsc, 0 only in bun check; the pinned bun agrees with tsc, so this is new/);
    assert.match((regressed.notes ?? []).join("\n"), /- tsc: src\/b\.ts\(4,3\)/);
    const inherited = checkerAgreementGate(paths.short, paths.short, paths.tsc, REPO, ["config/tsconfig.json"]);
    assert.match((inherited.notes ?? []).join("\n"), /the pinned bun disagrees too/);
    assert.equal(checkerAgreementGate(paths.crash, paths.same, paths.tsc, REPO, ["config/tsconfig.json"]).ok, false);
    // Same (empty) diagnostics, different verdict: the exit code is compared too.
    const { dir: d2, paths: p2 } = fakes({ tsc: print("", 0), crash: print("", 3) });
    try {
      assert.equal(checkerAgreementGate(p2.crash, p2.tsc, p2.tsc, REPO, ["config/tsconfig.json"]).ok, false);
    } finally {
      rmSync(d2, { recursive: true, force: true });
    }
    assert.equal(checkerAgreementGate(paths.clean, paths.clean, paths.clean, REPO, ["config/tsconfig.json"]).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tsc that cannot finish throws, because then there is no reference", () => {
  const { dir, paths } = fakes({ tsc: print("panic: runtime error\n", 2), same: print(OUT, 1) });
  try {
    assert.throws(() => checkerAgreementGate(paths.same, paths.same, paths.tsc, REPO, ["config/tsconfig.json"]), /could not check config\/tsconfig\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the canary and the bumper run the gate on typecheck's own programs, against an exact tsc", async () => {
  assert.match(TSC_REFERENCE, /^\d+\.\d+\.\d+$/, "a range would let the reference move under the gate");
  const programs = defaultPrograms();
  assert.ok(programs.includes("config/tsconfig.json") && programs.includes("config/tsconfig.tools.json"));
  assert.ok(!programs.some((p) => p.includes("lens-reader")), "lens-reader has its own node_modules and its own typecheck run");
  for (const file of ["tools/canary-bun.ts", "tools/bump-bun-pin.ts"]) {
    const code = await readFile(new URL(file, ROOT), "utf8");
    const at = code.indexOf("checkerAgreementGate(candidate, process.execPath, tsc, ROOT, defaultPrograms(ROOT))");
    assert.ok(at > 0, `${file} must run the checker gate on defaultPrograms`);
    assert.ok(code.lastIndexOf("gen-runtime-types.ts", at) > 0, `${file} must generate the runtime types before either checker reads the Worker programs`);
    assert.ok(at < code.indexOf("byteIdenticalBuildGate(candidate"), `${file} runs a seconds-long gate after the minutes-long build`);
    // The download and the types are the pinned side: failing them is exit 2,
    // never a red gate that would read as a finding about the candidate.
    assert.match(code.slice(at, at + 600), /catch \(err\) \{[\s\S]*?process\.exit\(2\);/, `${file} must treat a missing reference as the instrument`);
  }
});
