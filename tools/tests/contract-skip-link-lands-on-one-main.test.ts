// ── the skip link lands on exactly one <main id="main"> ─────────────────────
// #1386 put `Skip to content` (href="#main") at the top of every window through
// DESKTOP_TOP, and a <main id="main"> into each scaffold that wraps a .content
// pane. /writing and its notes ship DESKTOP_TOP too, but they draw their own
// Notepad window with no .content, so the link pointed at nothing: activating it
// scrolled nowhere and left focus on the link. Found by the second
// specification.website audit, 2026-10-17.
//
// The check renders every surface that ships the link, static and worker-built,
// because the renderers are separate code: a new one that copies DESKTOP_TOP
// without a <main> fails silently in a browser.
import { readFileSync } from "node:fs";
import { assert, test } from "./contract-shared.ts";
import { lunaPage } from "../../src/worker/lib/chrome.ts";
import { unsafeHtml } from "../../src/worker/lib/html.ts";
import { renderWritingIndex, renderWritingPost } from "../../src/worker/writing.ts";
import { bookingPage, successPage } from "../../cal/src/templates.ts";
import { renderMcpInfoPage, renderSerendipityPage } from "../../serendipity/serendipity.ts";
import { staticShellPages } from "../photos/gen-desktop-partial.ts";

const SKIP = /<a class="axp-skip" href="#main">/;

// The id appears once on the whole page, and that one element is a <main>.
function assertOneMain(html, label) {
  if (!SKIP.test(html)) return false;
  const ids = [...html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*\sid="main"[^>]*>/g)];
  assert.equal(ids.length, 1, `${label}: the skip link targets #main, found ${ids.length} elements with that id`);
  assert.equal(ids[0][1], "main", `${label}: #main is a <${ids[0][1]}>, not the <main> landmark`);
  return true;
}

test("the check fails on a skip link with no target, and on a <div id=main> (control)", () => {
  const top = '<a class="axp-skip" href="#main">Skip to content</a>';
  assert.throws(() => assertOneMain(`${top}<div class="np-window"></div>`, "no target"), /found 0/);
  assert.throws(() => assertOneMain(`${top}<div id="main"></div>`, "div"), /not the <main>/);
  assert.throws(() => assertOneMain(`${top}<main id="main"></main><main id="main"></main>`, "two"), /found 2/);
  assert.equal(assertOneMain('<main id="main"></main>', "no link"), false, "a page without the link is not checked");
});

test("every static shell page resolves #main once", () => {
  const pages = staticShellPages();
  const checked = pages.filter((file) => assertOneMain(readFileSync(file, "utf8"), file));
  assert.ok(checked.length >= 40, `only ${checked.length} of ${pages.length} static pages carry the skip link`);
});

const env = {
  ASSETS: {
    fetch: async (url) => {
      const path = new URL(url).pathname;
      try {
        return new Response(readFileSync(`src/content${path}`, "utf8"));
      } catch {
        return new Response("", { status: 404 });
      }
    },
  },
};

test("/writing, each note and the missing-note page resolve #main once", async () => {
  const posts = JSON.parse(readFileSync("src/content/writing/posts.json", "utf8"));
  assert.ok(posts.length >= 1, "posts.json lists no notes");
  const pages = [
    { label: "/writing", response: await renderWritingIndex(env) },
    { label: "/writing/no-such-note", response: await renderWritingPost("no-such-note", env) },
  ];
  for (const post of posts) pages.push({ label: `/writing/${post.slug}`, response: await renderWritingPost(post.slug, env) });
  for (const { label, response } of pages) assert.ok(assertOneMain(await response.text(), label), `${label}: lost the skip link`);
});

test("the worker scaffolds resolve #main once", async () => {
  const cal = { HOST_NAME: "aadhar.sh", HOST_PUBLIC_URL: "https://aadhar.sh", BASE_PATH: "/coffee" };
  const pages = [
    ["lunaPage", await lunaPage({ title: "t", body: unsafeHtml("<p>x</p>") }).text()],
    ["/serendipity", await renderSerendipityPage().text()],
    ["/serendipity/mcp-info", await renderMcpInfoPage().text()],
    ["/coffee", bookingPage(cal)],
    ["/coffee success", successPage(cal)],
  ];
  for (const [label, html] of pages) assert.ok(assertOneMain(html, label), `${label}: lost the skip link`);
});
