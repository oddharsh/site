// ── no shell page paints its window half parsed ──────────────────────────────
// On a slow CPU Chrome yields the HTML parser mid-document and paints what it
// has, and markup parsed after that frame moves the window (luna.css's
// .window:has(>.axp-tasks) rail, the HyperCam band's padding). browser:check
// read it on a GitHub runner at 4x throttle as layout shift on /coffee,
// /lwe/dac, /garage/resample and four more, on about 1 load in 2. DESKTOP_HOLD
// holds the first frame until #axp-icons, the element after the window, is
// parsed (gen-desktop-partial.ts has the measurements).
//
// Every renderer that ships the desktop chrome is separate code, so each one is
// rendered here: a new scaffold that copies DESKTOP_CHROME without the hold
// would paint half a window again, and only a throttled browser would notice.
import { readFileSync } from "node:fs";
import { assert, test } from "../../../tools/tests/contract-shared.ts";
import { lunaPage } from "../lib/chrome.ts";
import { DESKTOP_HOLD } from "../lib/desktop.ts";
import { unsafeHtml } from "../lib/html.ts";
import { renderWritingIndex } from "../writing.ts";
import { bookingPage } from "../../../cal/src/templates.ts";
import { renderSerendipityPage } from "../../../serendipity/serendipity.ts";
import { staticShellPages } from "../../../tools/photos/gen-desktop-partial.ts";

/** Whether the page holds its first frame for the shell. Throws if it holds for an element it never ships. */
function holds(html: string, label: string): boolean {
  const head = html.slice(0, html.indexOf("</head>"));
  const count = head.split(DESKTOP_HOLD).length - 1;
  const target = html.includes('<nav id="axp-icons"');
  assert.ok(count <= 1, `${label}: ${count} holds in <head>`);
  assert.equal(count === 1, target, `${label}: ${target ? "ships #axp-icons with no hold in <head>" : "holds for #axp-icons, which it never ships"}`);
  return target;
}

test("the check fails on a shell page with no hold, and on a hold with no shell (control)", () => {
  const icons = '<nav id="axp-icons"></nav>';
  assert.throws(() => holds(`<head></head><body>${icons}</body>`, "no hold"), /no hold in <head>/);
  assert.throws(() => holds(`<head>${DESKTOP_HOLD}</head><body></body>`, "no shell"), /never ships/);
  assert.throws(() => holds(`<head></head><body>${DESKTOP_HOLD}${icons}</body>`, "in body"), /no hold in <head>/);
  assert.equal(holds(`<head>${DESKTOP_HOLD}</head><body>${icons}</body>`, "held"), true);
  assert.equal(holds("<head></head><body></body>", "standalone"), false);
});

test("every static shell page holds its first frame", () => {
  const pages = staticShellPages();
  const held = pages.filter((file) => holds(readFileSync(file, "utf8"), file));
  assert.equal(held.length, pages.length, `${pages.length - held.length} static shell pages ship no #axp-icons`);
  assert.ok(held.length >= 40, `only ${held.length} static shell pages found`);
});

test("the worker scaffolds hold theirs, and the standalone cal host has nothing to hold for", async () => {
  const shell = { HOST_NAME: "aadhar.sh", HOST_PUBLIC_URL: "https://aadhar.sh", BASE_PATH: "/coffee" };
  const env = { ASSETS: { fetch: async () => new Response(readFileSync("src/content/writing/posts.json", "utf8")) } };
  const pages: [string, string][] = [
    ["lunaPage", await lunaPage({ title: "t", body: unsafeHtml("<p>x</p>") }).text()],
    ["/serendipity", await renderSerendipityPage().text()],
    ["/writing", await (await renderWritingIndex(env)).text()],
    ["/coffee", bookingPage(shell)],
  ];
  for (const [label, html] of pages) assert.equal(holds(html, label), true, `${label}: lost the shell`);
  assert.equal(holds(bookingPage({ HOST_NAME: "aadhar.sh", HOST_PUBLIC_URL: "https://aadhar.sh" }), "cal.aadhar.sh"), false);
});
