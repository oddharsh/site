import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageHtml, readGaragePages } from "../../pipelines/garage/generate.mjs";

test("Rust-validated Garage content renders byte-identically to authored JSON", () => {
  const pages = readGaragePages();
  const registry = JSON.parse(readFileSync(new URL("../../pipelines/garage/pages.json", import.meta.url), "utf8"));
  assert.deepEqual([...pages.keys()], registry.pages.map((page: { id: string }) => page.id));
  for (const [id, page] of pages) {
    const authored = JSON.parse(readFileSync(new URL(`../../pipelines/garage/specs/${id}.json`, import.meta.url), "utf8"));
    assert.deepEqual(page, authored, `${id}: native boundary lost content`);
    assert.equal(pageHtml(page), pageHtml(authored), `${id}: native boundary changed rendered bytes`);
  }
});
