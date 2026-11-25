import { assert, test } from "../../../tools/tests/contract-shared.ts";
import { renderLensShell } from "../lens.ts";

test("Lens examples expose their scan targets as real links", async () => {
  const page = await renderLensShell().text();
  const examples = [...page.matchAll(/<a\b[^>]*\bdata-(url|vs-pair)="([^"]+)"[^>]*\bhref="([^"]+)"[^>]*>/g)];
  assert.equal(examples.length, 8, "all eight Lens examples must be links with scan URLs");
  for (const [, kind, target, href] of examples) {
    const url = new URL(href.replaceAll("&amp;", "&"), "https://aadhar.sh");
    const [first, second] = target.split("|");
    assert.equal(url.pathname, "/lens");
    assert.equal(url.searchParams.get("url"), first);
    assert.equal(url.searchParams.get("vs"), kind === "vs-pair" ? second : null);
  }
});
