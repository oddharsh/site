import assert from "node:assert/strict";
import test from "node:test";
import { prefersMarkdown } from "../src/worker/http.ts";
import { validateLensTarget } from "../src/worker/lens.ts";

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

test("Lens accepts only ordinary public web targets", () => {
  assert.equal(validateLensTarget("https://example.com/path").target?.href, "https://example.com/path");
  for (const value of [
    "javascript:alert(1)", "file:///etc/passwd", "http://localhost/", "http://127.0.0.1/",
    "http://10.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "https://user:pass@example.com/",
    "https://example.com:8443/",
  ]) assert.ok(validateLensTarget(value).error, `${value} should be refused`);
});
