// The tree is formatted by bun fmt (`bun run format`, checked in validate, and
// run on each agent edit by tools/format-hook.ts). Bun reads bunfig.toml's
// [fmt] section on every run, so the formatter is exactly as safe as that
// section. On 2026-10-16 the whole tree was
// formatted and run through the build, the suite, lint and the checks; these
// tests hold the four hazards that turned up:
//
//   gotcha 71  embedded-language formatting rewrites html`` templates
//   gotcha 72  the Markdown printer renumbers ordered lists
//   gotcha 73  quoteProps "as-needed" unquotes keys that lint rules then read
//   gotcha 74  files whose exact text something else reads
//
// Each behaviour is checked twice on the running bun: once under the repo's
// config, where nothing may change, and once in a directory with no config,
// where the hazard must reproduce. The second half is the control. Without it
// a bun that stopped formatting at all would pass the first.
import { ROOT, assert, readFile, test } from "./contract-shared.ts";

import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(ROOT);
// `bun run test:node` runs this file under node, where process.execPath is node.
const bun = process.versions.bun ? process.execPath : "bun";
const fmt = (cwd, args) => spawnSync(bun, ["fmt", ...args], { cwd, encoding: "utf8", timeout: 60_000 });

const TEMPLATE =
  'export const T = html`<span class="axp-histnav"><button type="button" class="axp-back" aria-label="Back" title="Back"></button>' +
  '<button type="button" class="axp-fwd" aria-label="Forward" title="Forward"></button></span>`;';
const FIXTURE = {
  "t.ts": `const html = (s: TemplateStringsArray, ...v: unknown[]) => String.raw(s, ...v);\n${TEMPLATE}\nexport const O = { "shape": 1, "kind": 2 };\n`,
  "g.md": "1. first\n\n3. third\n\n7. seventh\n",
};

/** Format the fixture in a fresh directory, with or without a copy of the repo's bunfig.toml. */
async function formatFixture(withRepoConfig) {
  const dir = await mkdtemp(join(tmpdir(), "bun-fmt-"));
  try {
    if (withRepoConfig) await copyFile(join(repo, "bunfig.toml"), join(dir, "bunfig.toml"));
    for (const [name, body] of Object.entries(FIXTURE)) await writeFile(join(dir, name), body);
    const out = fmt(dir, Object.keys(FIXTURE));
    assert.equal(out.error, undefined, `bun fmt did not run: ${out.error}`);
    const ts = await readFile(join(dir, "t.ts"), "utf8");
    const md = await readFile(join(dir, "g.md"), "utf8");
    return { ts, md, out };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("bunfig.toml's [fmt] section keeps every setting the hazards need", async () => {
  // Parsed by bun itself, which is also what reads the section when anyone formats.
  const read = spawnSync(bun, ["-e", 'process.stdout.write(JSON.stringify(Bun.TOML.parse(require("fs").readFileSync("bunfig.toml", "utf8")).fmt ?? null))'], {
    cwd: repo,
    encoding: "utf8",
    timeout: 30_000,
  });
  const conf = JSON.parse(read.stdout || "null");
  assert.ok(conf, "bunfig.toml has no [fmt] section, so an ad hoc `bun fmt` runs on Prettier defaults");
  assert.equal(conf.embeddedLanguageFormatting, "off", "gotcha 71");
  assert.equal(conf.quoteProps, "preserve", "gotcha 73");
  for (const pattern of ["**/*.md"]) assert.ok(conf.ignorePatterns.includes(pattern), `gotcha 72: ${pattern}`);
  for (const pattern of [
    "public/**",
    "src/dict/**",
    "src/pages/**",
    "src/content/**",
    "src/styles/**",
    "design/tokens/**",
    "**/*.json",
    "pipelines/*/specs/**",
    "src/worker/lib/desktop.*",
    "src/worker/lib/site-manifest.*",
    "src/client/nav-run.js",
    "src/client/lwe/ask.js",
    "lwe-ask/src/passages.ts",
  ])
    assert.ok(conf.ignorePatterns.includes(pattern), `gotcha 74: ${pattern} left [fmt].ignorePatterns`);
});

test("under the repo's config, templates, keys and list numbers survive bun fmt", async () => {
  const { ts, md } = await formatFixture(true);
  assert.ok(ts.includes(TEMPLATE), "gotcha 71: the html`` template's markup changed");
  assert.match(ts, /\{ "shape": 1, "kind": 2 \}/, "gotcha 73: quoted keys were unquoted");
  assert.equal(md, FIXTURE["g.md"], "gotcha 72: a Markdown file was formatted");
});

test("CONTROL: with no config, bun fmt does all three", async () => {
  const { ts, md } = await formatFixture(false);
  assert.ok(!ts.includes(TEMPLATE), "Prettier defaults left the template alone; gotcha 71 no longer reproduces, so the first test proves nothing");
  assert.match(ts, /\{ shape: 1, kind: 2 \}/, "Prettier defaults kept the quotes; gotcha 73 no longer reproduces");
  assert.match(md, /^2\. third$/m, "Prettier defaults kept the gaps; gotcha 72 no longer reproduces");
});

test("bun fmt never reaches a file whose exact text something else reads", () => {
  const out = fmt(repo, ["--list-files"]);
  assert.equal(out.status, 0, out.stderr);
  const listed = new Set(out.stdout.split("\n").filter(Boolean));
  // The listing has to be a real one, or an empty list passes everything below.
  for (const file of ["tools/build.ts", "src/worker/routes.ts"]) assert.ok(listed.has(file), `${file} should be in scope`);
  for (const file of [
    "docs/GOTCHAS.md", // gotcha 72
    "src/styles/luna.css",
    "design/tokens/colors.css",
    "pipelines/lwe/specs/encoding-demo.js",
    "src/worker/lib/desktop.ts",
    "src/worker/lib/site-manifest.ts",
    "src/client/nav-run.js",
    "src/client/lwe/ask.js",
    "config/derivations.json",
    "config/ts-baseline.json",
    "src/pages/index.html",
    "src/content/index.md",
    "bun.lock",
  ])
    assert.ok(!listed.has(file), `gotcha 74: bun fmt would rewrite ${file}`);
});

// tools/format-hook.ts formats each file an agent edits, from the project root,
// so bunfig.toml's [fmt] section scopes it the same way as `bun run format`.
const hook = (dir, stdin) =>
  spawnSync(bun, [join(repo, "tools/format-hook.ts")], {
    cwd: dir,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    timeout: 60_000,
  });

test("the format hook formats an edited file in scope and leaves a protected one byte for byte", async () => {
  const dir = await mkdtemp(join(tmpdir(), "format-hook-"));
  try {
    await copyFile(join(repo, "bunfig.toml"), join(dir, "bunfig.toml"));
    await writeFile(join(dir, "t.ts"), 'const a={"b":1,"c":2}\n');
    await writeFile(join(dir, "g.md"), FIXTURE["g.md"]);
    const outside = await mkdtemp(join(tmpdir(), "format-hook-outside-"));
    await writeFile(join(outside, "o.ts"), "const o={x:1}\n");

    for (const file of [join(dir, "t.ts"), join(dir, "g.md"), join(outside, "o.ts")]) {
      const out = hook(dir, JSON.stringify({ cwd: dir, tool_input: { file_path: file } }));
      assert.equal(out.status, 0, `the hook must never fail the tool call: ${out.stderr}`);
    }
    assert.equal(await readFile(join(dir, "t.ts"), "utf8"), 'const a = { "b": 1, "c": 2 };\n', "an in-scope edit lands formatted");
    assert.equal(await readFile(join(dir, "g.md"), "utf8"), FIXTURE["g.md"], "gotcha 72: an ignored file is passed explicitly and still left alone");
    assert.equal(await readFile(join(outside, "o.ts"), "utf8"), "const o={x:1}\n", "a file outside the project is not the hook's to touch");
    await rm(outside, { recursive: true, force: true });

    for (const stdin of ["", "not json", "{}", JSON.stringify({ tool_input: { file_path: join(dir, "missing.ts") } })]) {
      assert.equal(hook(dir, stdin).status, 0, `the hook exits 0 on ${JSON.stringify(stdin)}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the formatter is wired: scripts, the validate step, the agent hook", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"));
  assert.equal(pkg.scripts.format, "bun fmt");
  assert.equal(pkg.scripts["format:check"], "bun fmt --check");
  // gotcha 67: a script named fmt would shadow the built-in for every flag.
  assert.equal(pkg.scripts.fmt, undefined, "name it format, never fmt");
  assert.match(pkg.scripts["check:fast"], /\bformat:check\b/);

  const ci = await readFile(new URL(".github/workflows/ci.yml", ROOT), "utf8");
  assert.match(ci, /- name: Format\n\s+id: format\n\s+run: bun run format:check\n/, "validate runs the format check");

  const settings = JSON.parse(await readFile(new URL(".claude/settings.json", ROOT), "utf8"));
  const entry = settings.hooks.PostToolUse.find((h) => h.hooks.some((x) => x.command.includes("tools/format-hook.ts")));
  assert.ok(entry, "PostToolUse runs tools/format-hook.ts");
  for (const tool of ["Edit", "Write", "MultiEdit"]) assert.ok(new RegExp(`(^|\\|)${tool}($|\\|)`).test(entry.matcher), `the hook fires on ${tool}`);
});
