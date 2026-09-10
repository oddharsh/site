import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { navFenceBody, readFenceBody, workerModule } from "./gen-manifest.ts";

const ROOT = new URL("../", import.meta.url);
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "page-generators-"));
  const put = async (file, body) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), body);
  };
  const read = (file) => readFile(path.join(root, file), "utf8");
  const cli = (file, ...args) => spawnSync(process.execPath, [path.join(root, file), ...args],
    { cwd: tmpdir(), encoding: "utf8" });
  const files = ["pipelines/garage/generate.mjs", "pipelines/lwe/generate.mjs", "pipelines/lwe/concepts.json",
    "pipelines/content/page-contract.mjs", "tools/gen-manifest.ts", "tools/photos/shell-data.ts", "tools/lib/html-raw-text.ts",
    "src/worker/lib/desktop.ts", "src/worker/lib/site-manifest.ts", "src/client/nav-run.js",
    "config/site-manifest.json", "public/sitemap.xml", "src/pages/lwe/index.html", "public/lwe/ask.js"];
  try {
    for (const file of files) await put(file, await readFile(new URL(file, ROOT), "utf8"));
    await run({ root, put, read, cli });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("LWE wiring uses the manifest for navigation and agent discovery", async () => {
  await fixture(async ({ put, read, cli }) => {
    const manifest = JSON.parse(await read("config/site-manifest.json"));
    const content = manifest.surfaces.find((s) => s.section === "lwe" && s.kind === "content" && s.flags.run);
    content.hint = 'canonical "navigation" hint';
    content.description = "canonical agent discovery";
    await put("config/site-manifest.json", JSON.stringify(manifest));
    const registry = JSON.parse(await read("pipelines/lwe/concepts.json"));
    const concept = registry.concepts.find((c) => c.path === content.path);
    concept.navHint = "page-specific subtitle";
    concept.buddyName = "Fixture buddy";
    concept.lastmod = "2001-02-03";
    concept.hasAsk = true;
    await put("pipelines/lwe/concepts.json", JSON.stringify(registry));
    const result = cli("pipelines/lwe/generate.mjs", "wire");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFenceBody(await read("src/client/nav-run.js"), "lwe-pages"), navFenceBody(manifest.surfaces, "lwe"));
    assert.equal(await read("src/worker/lib/site-manifest.ts"), workerModule(manifest.surfaces));
    assert.match(await read("src/pages/lwe/index.html"), /Fixture buddy/);
    assert.match(await read("public/sitemap.xml"), /<lastmod>2001-02-03<\/lastmod>/);
    assert.ok((await read("public/lwe/ask.js")).includes(`"${concept.path}": "${concept.id}"`));
    const files = ["src/client/nav-run.js", "src/worker/lib/site-manifest.ts", "src/pages/lwe/index.html", "public/sitemap.xml", "public/lwe/ask.js"];
    const once = await Promise.all(files.map(read));
    assert.equal(cli("pipelines/lwe/generate.mjs", "wire").status, 0);
    assert.deepEqual(await Promise.all(files.map(read)), once, "rewiring is byte-idempotent");
  });
});

test("retired Garage wiring refuses before touching a legacy shelf", async () => {
  await fixture(async ({ put, read, cli }) => {
    // These inputs let the former implementation reach its writer, so the
    // negative control tests the refusal rather than a missing fixture file.
    const specs = (await readdir(new URL("pipelines/garage/specs/", ROOT))).filter((f) => f.endsWith(".json"));
    const pages = [];
    for (const file of specs) {
      const source = await readFile(new URL(`pipelines/garage/specs/${file}`, ROOT), "utf8");
      const spec = JSON.parse(source);
      await put(`pipelines/garage/specs/${file}`, source);
      pages.push({ id: spec.id, title: spec.title, summary: "fixture", status: "fixture", lastmod: "2001-01-01", navLabel: spec.id, navHint: "fixture" });
    }
    await put("pipelines/garage/pages.json", JSON.stringify({ pages }));
    const shelf = "authored shelf\n<!-- generated:garage-pages:start -->\nold card\n<!-- generated:garage-pages:end -->";
    await put("src/pages/garage/index.html", shelf);
    const result = cli("pipelines/garage/generate.mjs", "wire");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retired.*gen:manifest/);
    assert.equal(await read("src/pages/garage/index.html"), shelf);
  });
});

test("the LWE publisher passes concept arguments literally and stops on a failed stage", async () => {
  await fixture(async ({ put, read, cli }) => {
    await put("pipelines/lwe/publish.mjs", await readFile(new URL("pipelines/lwe/publish.mjs", ROOT), "utf8"));
    const concept = "fixture; touch unexpected-command";
    await put(`pipelines/lwe/specs/${concept}.json`, "{}");
    await put("pipelines/lwe/generate.mjs", `import {appendFileSync} from 'node:fs';\nappendFileSync('calls', JSON.stringify(process.argv.slice(2))+'\\n');`);
    const result = cli("pipelines/lwe/publish.mjs", concept);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await read("calls"), `${JSON.stringify(["page", concept])}\n${JSON.stringify(["wire"])}\n`);
    await assert.rejects(read("unexpected-command"), { code: "ENOENT" });
    await put("calls", "");
    await put("pipelines/lwe/generate.mjs", "process.exit(7);");
    assert.notEqual(cli("pipelines/lwe/publish.mjs", concept).status, 0);
    assert.equal(await read("calls"), "");
  });
});
