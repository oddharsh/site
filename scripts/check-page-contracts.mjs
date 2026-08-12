#!/usr/bin/env node
// Validate the authoring contract and the page wiring for both explanatory
// families. This stays separate from build.mjs so editors can run it without
// staging the deploy tree.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { transform } from "esbuild";

import { validateUnderstanding } from "../pipelines/content/page-contract.mjs";
import { pageHtml as renderLwePage } from "../pipelines/lwe/generate.mjs";
import { pageHtml as renderGaragePage, validateRegistry } from "../pipelines/garage/generate.mjs";

const ROOT = new URL("../", import.meta.url).pathname;

async function filesIn(dir) {
  return (await readdir(join(ROOT, dir))).filter((file) => file.endsWith(".html")).sort();
}

function payload(html, file) {
  const matches = html.match(/<script type="application\/json" id="luq-data">([\s\S]*?)<\/script>/g) || [];
  assert.equal(matches.length, 1, `${file}: expected exactly one luq-data block`);
  const raw = matches[0].replace(/^<script[^>]*>\n?/, "").replace(/\n?<\/script>$/, "");
  return JSON.parse(raw);
}

async function checkPublishedPages(family, skip = new Set()) {
  for (const file of await filesIn(`www/${family}`)) {
    if (file === "index.html" || skip.has(file)) continue;
    const path = `www/${family}/${file}`;
    const html = await readFile(join(ROOT, path), "utf8");
    assert.equal((html.match(/<script src="\/quiz\.js" defer><\/script>/g) || []).length, 1, `${path}: missing shared quiz runtime`);
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
  assert.doesNotMatch(html, /<style>[\s\S]*?\*\s*\{\s*box-sizing:/, `pipelines/lwe/specs/${file}: generator re-inlined shared LWE structure`);
}

validateRegistry();
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
const cssResult = await transform(garageCss, { loader: "css", minify: false });
assert.equal(cssResult.warnings.length, 0, "Garage scaffold CSS should parse without warnings");

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
