#!/usr/bin/env node
// Validate the authoring contract and the page wiring for both explanatory
// families. This stays separate from build.ts so editors can run it without
// staging the deploy tree.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCss } from "./lib/css-parse.ts";
import { closeTagSource } from "./lib/html-raw-text.ts";
import { validateUnderstanding } from "../pipelines/content/page-contract.mjs";
import { pageHtml as renderLwePage } from "../pipelines/lwe/generate.mjs";
import { pageHtml as renderGaragePage } from "../pipelines/garage/generate.mjs";

const ROOT = new URL("../", import.meta.url).pathname;

async function filesIn(dir) {
  return (await readdir(join(ROOT, dir))).filter((file) => file.endsWith(".html")).sort();
}

// Case-insensitive, and tolerant of every shape of end tag, because HTML accepts
// `</script >`, `</script\t\n bar>` and `</script/>` as closes while `</scriptfoo>`
// is a different element. The close comes from tools/lib/html-raw-text.ts so the
// three tools that answer this question answer it the same way.
const LUQ_BLOCK = new RegExp(
  `<script\\b[^>]*\\btype="application/json"[^>]*\\bid="luq-data"[^>]*>([\\s\\S]*?)${closeTagSource("script")}`,
  "gi",
);

function payload(html, file) {
  // The CAPTURE GROUP is the payload. Re-stripping the delimiters off the whole
  // match, which is what this did, means writing the same two patterns a second
  // time and keeping them in agreement with these.
  const matches = [...html.matchAll(LUQ_BLOCK)];
  assert.equal(matches.length, 1, `${file}: expected exactly one luq-data block`);
  return JSON.parse(matches[0][1]);
}

async function checkPublishedPages(family, skip = new Set()) {
  for (const file of await filesIn(`src/pages/${family}`)) {
    if (file === "index.html" || skip.has(file)) continue;
    const path = `src/pages/${family}/${file}`;
    const html = await readFile(join(ROOT, path), "utf8");
    assert.equal((html.match(/<script src="\/quiz\.js" defer><\/script>/g) || []).length, 1, `${path}: missing shared quiz runtime`);
    if (family === "lwe") {
      assert.equal((html.match(/<link rel="stylesheet" href="\/luna\.css">/g) || []).length, 1, `${path}: missing parse-time Luna shell CSS`);
    }
    const data = payload(html, path);
    assert.equal(data.skin, family === "lwe" ? "lwe" : "garage", `${path}: wrong quiz skin`);
    const { skin, ...understanding } = data;
    validateUnderstanding(understanding, `${path}.understanding`);
    if (family === "garage") assert.match(html, /<section id="luq"/, `${path}: missing Garage quiz mount`);
  }
}

// Rendering every structured LWE spec catches a future schema omission before
// it can overwrite a page. The manually authored LWE pages are checked below.
const lweSpecFiles = (await readdir(join(ROOT, "pipelines/lwe/specs")))
  .filter((file) => file.endsWith(".json"))
  .sort();
for (const file of lweSpecFiles) {
  const spec = JSON.parse(await readFile(join(ROOT, "pipelines/lwe/specs", file), "utf8"));
  const html = renderLwePage(spec);
  assert.match(html, /id="luq-data"/, `pipelines/lwe/specs/${file}: generator omitted quiz data`);
  assert.match(html, /<script src="\/quiz\.js" defer><\/script>/, `pipelines/lwe/specs/${file}: generator omitted quiz runtime`);
  assert.match(html, /id="axp-desktop"/, `pipelines/lwe/specs/${file}: generator omitted static desktop shell`);
  assert.match(html, /id="axp-taskbar"/, `pipelines/lwe/specs/${file}: generator omitted static taskbar shell`);
  assert.equal((html.match(/<link rel="stylesheet" href="\/lwe-base\.css">/g) || []).length, 1, `pipelines/lwe/specs/${file}: generator omitted shared LWE CSS`);
  assert.equal((html.match(/<link rel="stylesheet" href="\/luna\.css">/g) || []).length, 1, `pipelines/lwe/specs/${file}: generator omitted parse-time Luna shell CSS`);
  assert.doesNotMatch(html, /<style>[\s\S]*?\*\s*\{\s*box-sizing:/, `pipelines/lwe/specs/${file}: generator re-inlined shared LWE structure`);
  if (spec.demoJsFile) {
    const demo = (await readFile(join(ROOT, "pipelines/lwe/specs", spec.demoJsFile), "utf8")).trimEnd();
    assert.ok(html.includes(`<script>\n${demo}\n</script>`),
      `pipelines/lwe/specs/${file}: generator omitted its external demo program`);
  }
  // Every LWE spec page is its generator's output byte for byte, the same pin
  // Garage carries. It held for encoding alone until 2026-09-30, while all six
  // spec pages already matched.
  const published = await readFile(join(ROOT, "src/pages/lwe", `${spec.id}.html`), "utf8");
  assert.equal(html, published, `src/pages/lwe/${spec.id}.html: run node pipelines/lwe/generate.mjs page ${spec.id}`);
}

const garageSpecFiles = (await readdir(join(ROOT, "pipelines/garage/specs")))
  .filter((file) => file.endsWith(".json"))
  .sort();
assert.ok(garageSpecFiles.length > 0, "discover Garage specs before checking them");
for (const file of garageSpecFiles) {
  const spec = JSON.parse(await readFile(join(ROOT, "pipelines/garage/specs", file), "utf8"));
  assert.equal(spec.id, file.slice(0, -5), `${file}: spec id must match its filename`);
  const html = renderGaragePage(spec); // validates every spec, including a newly added file
  // Every Garage spec page is the generator's output byte for byte, so a hand
  // edit to the page (octane carried its own favicon and --axp-maxw for two
  // months) fails here instead of being dropped by the next regeneration.
  const published = await readFile(join(ROOT, "src/pages/garage", `${spec.id}.html`), "utf8");
  assert.equal(html, published, `src/pages/garage/${spec.id}.html: run node pipelines/garage/generate.mjs page ${spec.id}`);
}
const garageFixture = {
  id: "contract-fixture",
  title: "Contract fixture",
  description: "A tiny generated page used to test the Garage scaffold.",
  status: "test",
  added: "2026-07-18",
  bodyHtml: '<h1>Contract fixture</h1><p class="garage-intro">The scaffold carries the shell and the check.</p>',
  pageCss: "",
  pageJs: "",
  editorial: {
    reader: "A site builder checking the page contract.",
    problem: "The builder needs proof that the scaffold carries the page's model.",
    thesis: "The scaffold should make the model testable before the page ships.",
    evidence: ["The generated document contains the quiz payload and runtime."],
    uncertainty: "The fixture tests wiring; it does not test a production experiment."
  },
  understanding: {
    intro: "Reconstruct the scaffold before you close the hood.",
    questions: [{
      q: "What does this fixture prove?",
      options: [
        { t: "That the generator emits the shared page contract.", ok: true, why: "Right. The fixture checks the generated wiring." },
        { t: "That every experiment is correct.", why: "The fixture tests wiring, not the truth of an experiment." },
        { t: "That a quiz can replace the page body.", why: "The body and the check serve different jobs." }
      ]
    }, {
      q: "What should a real Garage page add?",
      options: [
        { t: "A concrete mechanism, evidence, and a stated uncertainty.", ok: true, why: "Right. The scaffold carries the shell; the author carries the experiment." },
        { t: "Only a longer title.", why: "A title cannot explain a mechanism." },
        { t: "A score gate that blocks the page.", why: "The check diagnoses a second read and never blocks the page." }
      ]
    }, {
      q: "What would falsify the scaffold contract?",
      options: [
        { t: "The generated page lacks its quiz payload or runtime.", ok: true, why: "Right. The generator promises both pieces." },
        { t: "The reader misses a question.", why: "A miss points the reader back to the page; it does not falsify the scaffold." },
        { t: "The page has custom experiment CSS.", why: "Custom CSS is an explicit part of the Garage boundary." }
      ]
    }]
  }
};
const garageHtml = renderGaragePage(garageFixture);
assert.match(garageHtml, /id="luq-data"/, "Garage scaffold omitted quiz data");
assert.match(garageHtml, /<script src="\/quiz\.js" defer><\/script>/, "Garage scaffold omitted quiz runtime");
assert.match(garageHtml, /id="luq"/, "Garage scaffold omitted quiz mount");
assert.match(garageHtml, /id="axp-desktop"/, "Garage scaffold omitted static desktop shell");
assert.match(garageHtml, /id="axp-taskbar"/, "Garage scaffold omitted static taskbar shell");
const garageCss = garageHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1];
assert.ok(garageCss, "Garage scaffold omitted inline CSS");
// Parsed by the SAME engine and the same tolerated-warning family the build
// uses, so a scaffold cannot pass here and fail step 7b. This used to be
// esbuild's CSS loader, which disagrees with Lightning in both directions.
parseCss("garage scaffold inline <style>", garageCss);
assert.equal((garageHtml.match(/<link rel="stylesheet" href="\/prose\.css">/g) || []).length, 1, "Garage scaffold omitted the prose kit (/prose.css)");
assert.match(garageHtml, /<div class="content prose">/, "Garage scaffold omitted the prose class on its content");
assert.doesNotMatch(garageCss, /(^|[}\s])\*\s*\{\s*box-sizing|(^|[}\s])body\s*\{/, "Garage scaffold re-inlined page defaults that luna.css and prose.css own");

// Every windowed Garage page shares the prose kit and the page defaults rather
// than pasting them. vt-b and vt-check are windowless view-transition fixtures.
for (const file of (await readdir(join(ROOT, "src/pages/garage"))).filter((f) => f.endsWith(".html") && !f.startsWith("vt-"))) {
  const page = await readFile(join(ROOT, "src/pages/garage", file), "utf8");
  assert.equal((page.match(/<link rel="stylesheet" href="\/prose\.css">/g) || []).length, 1, `src/pages/garage/${file}: link /prose.css before the page's <style>`);
  const inline = page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  assert.doesNotMatch(inline, /(^|[}\s])\*\s*\{\s*box-sizing|(^|[}\s])body\s*\{/, `src/pages/garage/${file}: page defaults belong to luna.css and prose.css, not the page`);
}

// The same holds outside Garage: every page that links luna.css render-blocking
// gets border-box sizing and the window measure from it, so none restates them.
// The homepage is the exception: it loads luna.css non-blocking, so it keeps its
// own copy for first paint.
const restatesDefaults = /(^|[}\s])\*\s*\{\s*box-sizing|\.window\s*\{[^}]*[{;\s]max-width:\s*var\(--axp-maxw\)/;
const pageFiles = (await readdir(join(ROOT, "src/pages"), { recursive: true }))
  .filter((f) => f.endsWith(".html") && f !== "index.html" && !f.startsWith("garage/vt-"));
for (const file of pageFiles) {
  const page = await readFile(join(ROOT, "src/pages", file), "utf8");
  const inline = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  assert.doesNotMatch(inline, restatesDefaults, `src/pages/${file}: border-box sizing and the .window max-width come from luna.css`);
}
assert.doesNotMatch(await readFile(join(ROOT, "src/styles/lwe-base.css"), "utf8"), restatesDefaults, "lwe-base.css restates page defaults luna.css owns");

const invalidUnderstanding = JSON.parse(JSON.stringify(garageFixture.understanding));
invalidUnderstanding.questions[0].options[1].ok = true;
assert.throws(
  () => validateUnderstanding(invalidUnderstanding, "negative-understanding-fixture"),
  /exactly one option/,
  "the contract must reject multiple correct options",
);

await checkPublishedPages("lwe");
await checkPublishedPages("garage", new Set(["vt-b.html", "vt-check.html"]));
console.log("page contracts ok: generated LWE + Garage scaffolds and published explainer wiring");
