// ── every og:image names a file ─────────────────────────────────────────────
// A page's card image is fetched by a link-preview crawler that has only the
// URL in the <meta> tag, so a card that does not exist is a blank unfurl on
// every share of that page, and nothing on the page itself looks wrong.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assert, test, ROOT } from "./contract-shared.ts";

const root = fileURLToPath(ROOT);
const PAGES = join(root, "src/pages");
const PUBLIC = join(root, "public");

const noRewriter = typeof HTMLRewriter === "undefined" && "needs bun's HTMLRewriter";

test("the card-image scanner reads what a crawler reads", { skip: noRewriter }, async () => {
  const { metaImageRefs } = await import("./lib/link-integrity.ts");
  const html = [
    '<meta property="og:image" content="https://aadhar.sh/og/a.jpg">',
    '<meta name="twitter:image" content="https://aadhar.sh/og/a.jpg?v=2">',
    "<meta property=og:image:secure_url content=https://aadhar.sh/og/b.jpg>",
    '<meta property="og:image" content="/og/c.jpg">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:alt" content="https://aadhar.sh/og/not-a-url.jpg">',
    '<meta property="og:image" content="https://cdn.example/og/d.jpg">',
    '<meta property="og:image" content="//cdn.example/og/e.jpg">',
  ].join("");
  assert.deepEqual(await metaImageRefs(html), ["/og/a.jpg", "/og/a.jpg", "/og/b.jpg", "/og/c.jpg"]);
});

test("every og:image and twitter:image in an authored page is a file in public/", { skip: noRewriter }, async () => {
  const { metaImageRefs } = await import("./lib/link-integrity.ts");
  const missing = [];
  let checked = 0;
  for (const rel of readdirSync(PAGES, { recursive: true, encoding: "utf8" })) {
    if (!rel.endsWith(".html")) continue;
    for (const path of await metaImageRefs(readFileSync(join(PAGES, rel), "utf8"))) {
      checked++;
      if (!existsSync(join(PUBLIC, path))) missing.push(`src/pages/${rel} -> ${path}`);
    }
  }
  assert.ok(checked >= 70, `scanned only ${checked} card references; the scanner has stopped matching`);
  assert.deepEqual(missing, [],
    `these pages hand a crawler a card image that does not exist:\n  ${missing.join("\n  ")}\n`
    + "  Generate it (docs/MAINTENANCE.md, Regenerate the OG / Twitter cards) or fix the extension.");
});

test("every card a Worker renderer names is a file in public/", () => {
  const dir = join(root, "src/worker");
  const named = [];
  for (const rel of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    if (!rel.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, rel), "utf8");
    for (const m of src.matchAll(/\/og\/([\w.-]+\.(?:jpg|jpeg|png|webp|avif))\b/g)) named.push([rel, m[1]]);
  }
  assert.ok(named.length >= 1, "found no /og/ card literal in src/worker; /lens names one");
  const missing = named.filter(([, f]) => !existsSync(join(PUBLIC, "og", f))).map(([r, f]) => `src/worker/${r} -> /og/${f}`);
  assert.deepEqual(missing, [], `Worker renderers name card images that do not exist:\n  ${missing.join("\n  ")}`);
});
