// run.js — the zero-JS floor under the Run palette (blueprint's declarative
// ladder). The ⌘K palette in nav.js is script; this is the same idea as a real
// page: an <input list> + <datalist> of destinations and a GET form this
// handler answers with a 302. Works with scripting disabled, invokers missing,
// or dialog unsupported — the palette's own footer links here.
import { cachedRender } from "./lib/cache.ts";
import { lunaPage } from "./lib/chrome.ts";
import { unsafeHtml } from "./lib/html.ts";
import { escAttr, escHtml } from "./lib/http.ts";
import { AGENT_SURFACES } from "./lib/site-manifest.ts";
import { PHOTO_POOL } from "./photos.ts";

// Mirrors nav.js's inline pages + profiles set (kept small on purpose; photos
// resolve dynamically against the manifest instead of bloating the datalist).
// Every other page resolves against the site manifest below, so the datalist
// stays a suggestion list rather than the whole map.
const DESTS = [
  ["home",        "/",            "the homepage"],
  ["photos",      "/photos",      "every photo, Thumbnails view"],
  ["writing",     "/writing",     "notes, in flux"],
  ["reading",     "/reading",     "the bookshelf"],
  ["garage",      "/garage",      "experiments, mules, teardowns"],
  ["lwe",         "/lwe",         "little walkthrough explainers"],
  ["serendipity", "/serendipity", "the event pool"],
  ["around",      "/around",      "the crypto-VC neighborhood"],
  ["lens",        "/lens",        "the other web"],
  ["pixel peeper", "/pixel-peeper", "a compression vision test"],
  ["music",       "/rn",          "now playing"],
  ["coffee",      "/coffee",      "book a coffee"],
  ["whoareyou",   "/whoareyou",   "System Properties"],
  ["security",    "/security",    "Security Center"],
  ["updates",     "/updates",     "Windows Update"],
  ["restore",     "/restore",     "System Restore"],
  ["bot",         "/bot",         "AadharshBot methodology"],
  ["twitter",     "https://x.com/oddhash",                        "profile"],
  ["instagram",   "https://www.instagram.com/aadharsh.hif",                 "profile"],
  ["curius",      "https://curius.app/aadharsh-pannirselvam",           "profile"],
  ["beli",        "https://beliapp.com/users/aadharsh",                 "profile"],
  ["spotify",     "https://open.spotify.com/user/aadharsh2010",         "profile"],
];

async function resolve(cmd, env, request) {
  const q = cmd.trim().toLowerCase().replace(/\/+$/, "");
  if (!q) return null;

  // exact path ("/garage", "garage") or name match first
  for (const [name, path] of DESTS) {
    if (q === name || q === path.toLowerCase() || ("/" + q) === path.toLowerCase()) return path;
  }
  // writing slugs: "colophon" → /writing/colophon
  try {
    const res = await env.ASSETS.fetch(new URL("/writing/posts.json", request.url));
    if (res.ok) {
      const posts = await res.json();
      const hit = Array.isArray(posts) && posts.find(p => p.slug && p.slug.toLowerCase() === q);
      if (hit) return `/writing/${hit.slug}`;
    }
  } catch {}
  // photo stems: "L1000069_3" → the SOOC original
  if (/^[a-z0-9_@-]+$/i.test(q)) {
    const hit = PHOTO_POOL.find(p => p.stem.toLowerCase() === q);
    if (hit) return `/images/full/${encodeURIComponent(hit.full).replace(/%2F/g, "/")}`;
  }
  // any page the site registers: its path ("garage/av2"), or its last segment
  // when only one page ends that way ("av2", "fhe"; "encoding" is two pages, so
  // it falls through). The manifest lists public pages only, so a typed name
  // can never land on an /a/ or /i/ file.
  const pages = AGENT_SURFACES.map((s) => s.path);
  const byPath = pages.find((p) => p.toLowerCase() === "/" + q.replace(/^\/+/, ""));
  if (byPath) return byPath;
  const bySegment = pages.filter((p) => p.toLowerCase().split("/").pop() === q);
  if (bySegment.length === 1) return bySegment[0];
  // unique name prefix ("gar" → garage)
  const pre = DESTS.filter(([name]) => name.startsWith(q));
  if (pre.length === 1) return pre[0][1];
  return null;
}

export function renderRun({ cmd = "", notFound = false } = {}) {
  const options = DESTS.map(([name, path, hint]) =>
    `<option value="${escAttr(name)}">${escHtml(hint)} — ${escHtml(path)}</option>`).join("\n");
  // XP's own Run error ends "To search for a file, click the Start button, and
  // then click Search." Here the search is one link away, already filled in.
  const search = `/search?q=${encodeURIComponent(cmd.trim())}`;
  const errorBanner = notFound
    ? `<div class="run-err" role="alert"><b>Windows cannot find '${escHtml(cmd)}'.</b>
       Make sure you typed the name correctly, and then try again. To look for it,
       <a href="${escAttr(search)}">search the site for '${escHtml(cmd.trim())}'</a>.</div>`
    : "";

  return lunaPage({
    title: "Run",
    path: "aadhar.sh/run",
    route: "/run",
    width: 460,
    description: "Type the name of a page, photo, or profile, and aadhar.sh will open it for you.",
    robots: "noindex",
    css: `/*min*/
  .run-lede { display: flex; gap: 10px; align-items: flex-start; margin: 2px 0 12px; }
  .run-ico { flex: 0 0 32px; width: 32px; height: 32px; background: var(--amber-70); position: relative; }
  .run-ico::before { content: ""; position: absolute; inset: 4px 7px; background: var(--amber-88); clip-path: polygon(50% 0, 100% 100%, 0 100%); }
  .run-lede p { margin: 2px 0 0; font-size: var(--text-ui); color: var(--grey-28); }
  /* scoped to the window content: a bare "button" rule gave the taskbar's sound button
     this page's 74px min-width, which pushed the clock off a phone screen */
  .content form { display: flex; gap: 8px; align-items: center; margin: 0 0 4px; }
  .content label { font-size: var(--text-ui); }
  .content input[type=text] {
    flex: 1; font-family: var(--font-ui); font-size: var(--text-ui); padding: 3px 5px;
    border: 1px solid oklch(56.86% 0.0525 249.86);
    box-shadow: inset 1px 1px 0 oklch(80.63% 0.0281 250.85);
    background: oklch(100% 0 0);
  }
  .content button {
    min-width: 74px; padding: 3px 12px; font-family: var(--font-ui); font-size: var(--text-ui); cursor: pointer;
    color: oklch(18% 0 0); background: linear-gradient(180deg, var(--paper) 0%, oklch(93.5% 0.008 100) 86%, oklch(88% 0.012 95) 100%);
    border: 1px solid oklch(56.86% 0.0525 249.86); border-radius: 3px;
    box-shadow: inset 1px 1px 0 oklch(100% 0 0);
  }
  .content button:active { background: oklch(88% 0.012 95); box-shadow: none; }
  .run-err {
    border: 1px solid oklch(60% 0.16 29); background: oklch(97% 0.02 60);
    color: oklch(35% 0.05 29); padding: 8px 10px; margin: 10px 0; font-size: var(--text-sm);
  }
  .run-note { font-size: var(--text-xs); color: var(--ink-dim); margin-top: 12px; }
`,
    body: unsafeHtml(`
    <div class="run-lede">
      <span class="run-ico" aria-hidden="true"></span>
      <p>Type the name of a page, a photo, or a profile, and aadhar.sh will open it for you.</p>
    </div>
    ${errorBanner}
    <form action="/run" method="get">
      <label for="cmd">Open:</label>
      <input type="text" id="cmd" name="cmd" list="dests" value="${escAttr(cmd)}" autofocus autocomplete="off" spellcheck="false">
      <button type="submit">OK</button>
      <datalist id="dests">
${options}
      </datalist>
    </form>
    <p class="run-note">
      This is the no-script floor: a plain form and a 302. With JS on, press
      <b>&#8984;K</b> (or Start &gt; Run) anywhere for the live palette with
      photo search and previews. Photo stems work here too ("L1000069_3").
    </p>
`),
    cache: "public, max-age=300",
    headers: { "x-robots-tag": "noindex" },
  });
}

export async function handleRun(request, env, ctx) {
  const url = new URL(request.url);
  const cmd = url.searchParams.get("cmd");

  if (cmd) {
    const dest = await resolve(cmd, env, request);
    if (dest) {
      const location = /^https?:\/\//.test(dest) ? dest : url.origin + dest;
      return new Response(null, { status: 302, headers: { "location": location, "cache-control": "no-store" } });
    }
    // the classic Run error, as a page (200: the form is the content)
    return renderRun({ cmd, notFound: true });
  }

  // bare /run is static-shaped: edge-cache it. Query variants never enter this
  // branch, so the 302/error paths can't be masked by a cached bare page.
  return cachedRender(request, ctx, () => Promise.resolve(renderRun()), "/run", env);
}
