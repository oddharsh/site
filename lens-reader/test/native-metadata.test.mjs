import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { brotliDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { parseHTML } from "../src/dom.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifest = fileURLToPath(new URL("../native/Cargo.toml", import.meta.url));
const corpus = new URL("./corpus/", import.meta.url);

test("native metadata preserves corpus titles, meta tags, and links", () => {
  const fixtures = readdirSync(corpus).filter((file) => file.endsWith(".html.br"));
  assert.ok(fixtures.length >= 10);
  for (const fixture of fixtures) {
    const html = brotliDecompressSync(readFileSync(new URL(fixture, corpus))).toString("utf8");
    const native = JSON.parse(execFileSync("cargo", ["run", "--quiet", "--release", "--locked", "--manifest-path", manifest], {
      cwd: root, input: html, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    }));
    const { document } = parseHTML(html);
    assert.equal(native.title, document.querySelector("title")?.textContent || "", fixture);
    const meta = [...document.querySelectorAll("meta")]
      .filter((el) => (el.hasAttribute("name") || el.hasAttribute("property")) && el.hasAttribute("content"))
      .map((el) => ({ name: el.getAttribute("name") ?? el.getAttribute("property"), content: el.getAttribute("content") }));
    assert.deepEqual(native.meta, meta, fixture);
    assert.equal(native.truncated, false, fixture);
    const links = [...document.querySelectorAll("link")]
      .filter((el) => el.hasAttribute("rel") && el.hasAttribute("href"))
      .map((el) => ({ rel: el.getAttribute("rel"), href: el.getAttribute("href") }));
    assert.deepEqual(native.links, links, fixture);
  }
});
