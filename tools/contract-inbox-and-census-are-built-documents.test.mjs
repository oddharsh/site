// ── /inbox and /lens/census are built documents, with their live half as an island ─
// Both rendered per request until 2026-09-25. build.ts step 5b now bakes each
// shell, and what comes from D1 arrives after load: /inbox/mail.html (the
// approved webmentions) and /lens/census/table.html (the weekly census). What
// this pins:
//   - each shell is deterministic, carries its island, and bakes no live value;
//   - the census placeholder is one unnamed row per roster host, sized from the
//     roster rather than from the mount, so the row check can fail;
//   - nothing visible follows the inbox island, since its height is the mail's;
//   - the inbox shell still advertises the webmention endpoint.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ISLAND_MARKER, islandPreload, islandScript } from "../src/worker/lib/island.ts";
import { MAIL_URL, renderInboxMail, renderInboxPage, handleInboxMail } from "../src/worker/inbox.ts";
import { CENSUS_ROSTER, TABLE_URL, censusExhibitHtml, handleCensusTable, renderCensusPage } from "../src/worker/census.ts";

const mountOf = (shell) => shell.slice(shell.indexOf("data-island="), shell.indexOf("<noscript>", shell.indexOf("data-island=")));
const count = (s, re) => (s.match(re) || []).length;
const NO_BINDINGS = /** @type {import("../src/worker/lib/env.ts").Env} */ (/** @type {unknown} */ ({}));

for (const { name, render, url } of [
  { name: "/inbox", render: renderInboxPage, url: MAIL_URL },
  { name: "/lens/census", render: renderCensusPage, url: TABLE_URL },
]) {
  test(`${name}'s shell is deterministic and carries its island`, async () => {
    const a = await render().text();
    assert.equal(a, await render().text(), "two renders differ, so the build would bake whichever it got");
    assert.ok(a.includes(`data-island="${url}"`));
    assert.ok(a.includes(islandPreload(url).html), "the fragment must be preloaded from <head>");
    assert.ok(a.includes(islandScript().html));
    assert.match(a, /<noscript>[\s\S]*?<\/noscript>/);
  });
}

test("the inbox shell names no sender, advertises the endpoint, and ends at its island", async () => {
  const page = renderInboxPage();
  assert.match(page.headers.get("link") || "", /<\/webmention>; rel="webmention"/);
  const shell = await page.text();
  assert.doesNotMatch(shell, /id="m-\d|rel="noopener ugc external"/, "a real mention row in the bake would be one build's mail");
  // After the mount: its failure note (hidden unless the fetch failed) and the
  // window chrome. The endpoint line moved into the island so nothing below it
  // moves when the mail arrives.
  const mountEnd = shell.indexOf("</noscript></div>");
  assert.ok(mountEnd > 0 && shell.lastIndexOf('class="oe-foot"') < mountEnd, "the endpoint line belongs inside the island");
});

test("the census placeholder is one unnamed row per roster host", async () => {
  const mount = mountOf(await renderCensusPage().text());
  assert.equal(count(mount, /<tr aria-hidden="true">/g), CENSUS_ROSTER.length);
  assert.doesNotMatch(mount, /class="cx-site"><a /, "the placeholder links no site");
  const grouped = {
    snapshots: 2, firstYmd: "2026-09-13", lastYmd: "2026-09-20",
    hosts: CENSUS_ROSTER.map((r) => ({
      host: new URL(r.url).host, url: r.url,
      last: { tier: "open", score: 40, level: 1, doors: 3, surfaces: "{}" }, delta: 0, series: [{}, {}], scoreSeries: [38, 40],
    })),
  };
  const live = censusExhibitHtml(grouped);
  assert.equal(count(mount, /<tr/g), count(live, /<tr/g), "the swap would add or remove rows");
});

test("the two islands carry the marker and their cache policies", async () => {
  const inbox = await handleInboxMail(new Request("https://aadhar.sh" + MAIL_URL), NO_BINDINGS, { waitUntil() {} });
  assert.equal(inbox.headers.get(ISLAND_MARKER), "1");
  assert.equal(inbox.headers.get("cache-control"), "public, max-age=60");
  assert.match(await inbox.text(), /not connected/, "an unbound store says so");
  const census = await handleCensusTable(new Request("https://aadhar.sh" + TABLE_URL), NO_BINDINGS);
  assert.equal(census.headers.get(ISLAND_MARKER), "1");
  assert.equal(census.headers.get("cache-control"), "public, max-age=300, s-maxage=900");
  assert.match(await census.text(), /cx-empty/, "no store is the empty panel, never a table");
  // Values are escaped by construction.
  const hostile = renderInboxMail([{ kind: "reply", author: "<script>x</script>", source: "https://e.example/", target: "https://aadhar.sh/", approved_at: 0 }], "ok", "https://aadhar.sh").html;
  assert.ok(hostile.includes("&lt;script&gt;x&lt;/script&gt;") && !hostile.includes("<script>x"));
});
