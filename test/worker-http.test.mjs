import assert from "node:assert/strict";
import test from "node:test";
import { prefersMarkdown } from "../src/worker/http.ts";

function request(accept) {
  return new Request("https://aadhar.sh/", { headers: { accept } });
}

test("Markdown negotiation requires an explicit media type", () => {
  assert.equal(prefersMarkdown(request("*/*")), false);
  assert.equal(prefersMarkdown(request("text/html")), false);
  assert.equal(prefersMarkdown(request("text/markdown")), true);
});

test("Markdown negotiation respects weights and client order", () => {
  assert.equal(prefersMarkdown(request("text/markdown;q=0.7, text/html;q=0.9")), false);
  assert.equal(prefersMarkdown(request("text/html;q=0.5, text/markdown;q=0.8")), true);
  assert.equal(prefersMarkdown(request("text/markdown;q=0, text/html;q=1")), false);
});
