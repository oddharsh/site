// ── /coffee is a built document, with its open slots as an island ────────────
// It rendered per request until 2026-09-30, on config/per-request-pages.json
// with the reason that cal could not import lib/island.ts. build.ts step 5b now
// bakes cal's bookingPage() once (q11 twin, dcz delta, ETag, hashed CSP), and
// the slots arrive from /coffee/slots.html, which cal renders and edge-caches
// for 30 seconds. What this pins:
//   - cal imports lib/island.ts and keeps no copy of it;
//   - the shell is deterministic, carries its island, and bakes no live slot;
//   - the placeholder is the slot renderer's own markup, fed a placeholder model;
//   - a slot is a native radio bound to the form, so booking needs no script;
//   - the route serves the bake, and the island stays out of Workers Cache.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as site from "../src/worker/lib/island.ts";
import { bookingPage, PICK_PATH, renderSlotList, slotsFragment, SLOTS_PATH } from "../cal/src/templates.ts";
import { siteConfig } from "./lib/site-config.ts";
import { configText } from "./contract-shared.ts";

const ROOT = new URL("../", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), "utf8");

// The env build.ts bakes with: the Worker's own vars, under the /coffee prefix.
const bakeEnv = async () => ({ ...(await siteConfig()).vars, BASE_PATH: "/coffee" });
const SLOTS_URL = `/coffee${SLOTS_PATH}`;
// Three open slots on two days, in the host timezone's working hours.
const SLOTS = [
  { start: Date.UTC(2026, 9, 6, 14, 0), end: Date.UTC(2026, 9, 6, 14, 30) },
  { start: Date.UTC(2026, 9, 6, 15, 0), end: Date.UTC(2026, 9, 6, 15, 30) },
  { start: Date.UTC(2026, 9, 7, 14, 0), end: Date.UTC(2026, 9, 7, 14, 30) },
];
// build.ts step 5b's own tripwire, restated: a radio carrying a slot, a day label
// with a real weekday in it, or the no-slots note.
const LIVE = /name="start" value=|class="xp-day-label">[A-Z][a-z]+day,|no open slots in the next/;

test("cal imports the site's island contract rather than keeping a copy", async () => {
  // It kept one (cal/src/island.ts) for a day, held byte-identical by this file.
  // cal already imported lib/desktop.ts, and island.ts and html.ts never reach
  // cloudflare:workers, which is the line gotcha 16 actually draws.
  assert.ok(!existsSync(new URL("cal/src/island.ts", ROOT)), "cal/src/island.ts is back; import src/worker/lib/island.ts instead");
  for (const file of ["cal/src/templates.ts", "cal/src/index.ts"]) {
    assert.match(read(file), /from\s+"\.\.\/\.\.\/src\/worker\/lib\/island\.ts"/, `${file} must import lib/island.ts`);
  }
  // And the page ships the site's loader verbatim, so /coffee shares its CSP
  // hash with every other island page.
  assert.ok(bookingPage(await bakeEnv()).includes(site.islandScript().html));
});

test("/coffee's shell is deterministic and carries its island", async () => {
  const env = await bakeEnv();
  const shell = bookingPage(env);
  assert.equal(shell, bookingPage(env), "two renders differ, so the build would bake whichever it got");
  assert.ok(shell.includes(`data-island="${SLOTS_URL}"`));
  assert.ok(shell.includes(site.islandPreload(SLOTS_URL).html), "the fragment must be preloaded from <head>");
  assert.ok(shell.includes(site.islandScript().html));
  assert.match(shell, /<noscript>[\s\S]*?\/coffee\/pick[\s\S]*?<\/noscript>/, "a no-JS reader is sent to the page that lists slots inline");
  assert.ok(shell.includes("axp-taskbar"), "BASE_PATH /coffee joins the desktop shell");
});

test("the bake names no slot, and the patterns that say so do match a live list", async () => {
  const env = await bakeEnv();
  assert.doesNotMatch(bookingPage(env), LIVE);
  // The control: the same patterns match the live fragment, the inline page,
  // and an empty calendar's note, so the tripwire is not vacuous.
  assert.match(slotsFragment(SLOTS, env), LIVE);
  assert.match(bookingPage(env, { slots: SLOTS }), LIVE);
  assert.match(slotsFragment([], env), LIVE);
});

test("the placeholder is the slot list's own markup", async () => {
  const env = await bakeEnv();
  const placeholder = renderSlotList({ pending: true }, env);
  const live = slotsFragment(SLOTS, env);
  for (const cls of ["xp-day-label", "slots", "slot-btn"]) {
    assert.ok(placeholder.includes(`class="${cls}"`), `the placeholder lost .${cls}`);
    assert.ok(live.includes(`class="${cls}"`), `the live list lost .${cls}`);
  }
  // A placeholder radio posts nothing: no name, no value, disabled.
  assert.doesNotMatch(placeholder, /<input[^>]*name=/);
  assert.match(placeholder, /<input type="radio" disabled>/);
});

test("a slot is a native radio that names the form, so booking needs no script", async () => {
  const env = await bakeEnv();
  const live = slotsFragment(SLOTS, env);
  const radios = [...live.matchAll(/<label class="slot-btn"><input type="radio" name="start" value="(\d+)" form="bookform" required aria-label="([^"]+)">/g)];
  assert.deepEqual(radios.map((m) => Number(m[1])), SLOTS.map((s) => s.start));
  assert.match(radios[0][2], /^Tuesday, October 6, \d/, "the accessible name carries the day as well as the time");
  assert.doesNotMatch(live, /<button|<form|<html/i, "a fragment of radios, never a document");

  const shell = bookingPage(env);
  assert.match(shell, /<form class="book" id="bookform" method="POST" action="\/coffee\/book">/, "no novalidate: the browser checks the required radio");
  assert.doesNotMatch(shell, /id="start"/, "the hidden start input the button script filled is gone");
  assert.match(shell, /<button type="submit" class="xp-button primary" id="submit" data-tz="America\/New_York">send request<\/button>/,
    "the submit is enabled from the start, since only a script could enable a disabled one");
  // The relabel script is a constant: nothing caller-supplied reaches script text.
  const scripts = [...shell.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const relabel = scripts.find((s) => s.includes('addEventListener("change"'));
  assert.ok(relabel, "the relabel script is still shipped");
  assert.equal(relabel, [...bookingPage({ ...env, HOST_TIMEZONE: "</script>" }).matchAll(/<script>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]).find((s) => s.includes('addEventListener("change"')), "the script text moved with the env");
  assert.equal(PICK_PATH, "/pick");
});

test("the route serves the bake, and the island stays out of Workers Cache", async () => {
  const index = read("src/worker/index.ts");
  const route = index.slice(index.indexOf("async function routeCoffee("), index.indexOf("async function routeCalHost("));
  assert.ok(route.indexOf("serveBuiltPage(") > 0 && route.indexOf("serveBuiltPage(") < route.indexOf("live: () => calWorker.fetch("),
    "GET /coffee reads the built page before falling back to cal's render");
  // cal invalidates the slot list through caches.default on every booking
  // action. Workers Cache answers before the Worker runs and those deletes never
  // reach it, so a fragment admitted there would outlive a booking.
  const { CACHEABLE_PATHS } = await import("../src/worker/routes.ts");
  assert.ok(CACHEABLE_PATHS.has("/coffee"), "the page is a static document like /reading and /around");
  assert.ok(!CACHEABLE_PATHS.has(SLOTS_URL), "the slots island must not sit behind Workers Cache");

  const globRe = (g) => new RegExp("^" + g.replace(/[\\.+?^${}()|[\]]/g, "\\$&").replace(/\*/g, ".*") + "$");
  const config = "cloudflare.config.ts";
  const block = ((await configText(config)).match(/"run_worker_first"\s*:\s*\[([\s\S]*?)\]/) || [, ""])[1];
  const allow = [...block.replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const p of ["/coffee", SLOTS_URL, "/coffee/pick"]) {
    assert.ok(allow.includes(p) || allow.some((a) => a.includes("*") && globRe(a).test(p)), `${config}: ${p} is not in run_worker_first`);
  }
  const ledger = JSON.parse(read("config/per-request-pages.json")).pages;
  assert.ok(!("/coffee" in ledger), "a built page leaves the per-request ledger");
});
