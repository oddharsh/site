// ── tag stripping: the closers HTML allows and a regex forgets ───────────
// Split from contract-tests.test.mjs; shared imports live in contract-shared.mjs.
import {
  assert,
  test,
} from "./contract-shared.ts";

// ── tag stripping: the closers HTML allows and a regex forgets ───────────

// `</script >` is a legal end tag and `--!>` legally closes a comment, so a stripper
// spelled `</script>` or `-->` hands the body straight through. Neither one is an
// injection here (lensMarkdown returns JSON that reaches the DOM through esc(), and an
// excerpt is stored escaped), so what it costs is fidelity: script source lands in a
// markdown render, and minified JS lands in a webmention excerpt that a human reads.
test("a spaced end tag and an --!> comment close their elements", async () => {
  const { lensMarkdown } = await import("../src/worker/lens.ts");

  const md = lensMarkdown("<body><p>keep</p><script >var leak=1;</script >tail</body>", "https://x/");
  assert.ok(!md.includes("leak"), "a spaced </script > must close the script");
  assert.ok(md.includes("keep") && md.includes("tail"), "the surrounding prose survives");

  assert.ok(!lensMarkdown("<body><!-- gone --!><p>after</p></body>", "https://x/").includes("gone"),
    "--!> closes a comment");

  // <head> must not swallow a page that opens with <header>, which is what a
  // missing word boundary buys: the strip runs to the next literal </head>.
  assert.ok(lensMarkdown("<body><header><p>nav</p></header><p>body</p></body>", "https://x/").includes("body"),
    "<header> is not <head>");

  const { contentOf } = await import("../src/worker/webmention-send.ts");
  assert.ok(!contentOf("<html><body><script >var s=1;</script >real</body></html>").includes("var s"),
    "outbound link extraction skips script bodies closed with a space");
});

// HTML lets an end tag carry attributes, so `</script bar>` closes a script element
// as surely as `</script>`. A stripper that only allows whitespace before the `>`
// hands the whole body through.
test("an end tag carrying attributes still closes its element", async () => {
  const { lensMarkdown } = await import("../src/worker/lens.ts");
  const { contentOf } = await import("../src/worker/webmention-send.ts");

  assert.ok(!lensMarkdown("<body><script>var leak=1;</script bar>tail</body>", "https://x/").includes("leak"),
    "lensMarkdown closes on </script bar>");
  assert.ok(!contentOf("<html><body><script>var s=1;</script bar>real</body></html>").includes("var s"),
    "contentOf closes on </script bar>");
});
