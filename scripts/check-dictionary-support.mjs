#!/usr/bin/env node
// check-dictionary-support.mjs — is shared-dictionary compression OPERATIONAL, per
// surface class, against PRODUCTION? (npm run dcz:check)
//
// Synthesizes Available-Dictionary from the committed dictionary sets, exactly the way a
// returning Chromium visitor would send it, and asserts the wire answer. Local builds
// cannot answer this (gotcha 13/14: three platform behaviors were mis-diagnosed locally),
// so every probe here hits aadhar.sh. Loader-class rules this encodes:
//   js/css  dcz expected  (proven in production 2026-07-27)
//   html    dcz expected  (server side proven; document-loader client check post-deploy)
//   svg     NO dictionary offer, by design (#119: Chromium's image loader chokes on dcz)
//   SSR     blocked: workerd's zstd ignores `dictionary`; revisit via scratchpad spike
import { readdir, readFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";

const b64 = (buf) => `:${createHash("sha256").update(buf).digest("base64")}:`;
const get = (url, dict) => fetch(url, { headers: {
  "accept-encoding": "zstd, br, dcz",
  ...(dict ? { "available-dictionary": dict } : {}),
}, redirect: "manual" });

let fail = 0;
const report = (name, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`); if (!ok) fail++; };

// 1. shell js — nav delta against an a-dict candidate that is NOT the live hash
{
  const home = await (await fetch("https://aadhar.sh/", { headers: { "accept-encoding": "identity" } })).text();
  const live = home.match(/\/a\/nav\.([0-9a-f]{8})\.js/)?.[1];
  const cand = (await readdir("holding/a-dict")).find((n) => n.startsWith("nav.") && !n.includes(live));
  if (!cand) report("shell js (nav)", false, "no non-live a-dict candidate to probe with");
  else {
    const r = await get(`https://aadhar.sh/a/nav.${live}.js`, b64(await readFile(`holding/a-dict/${cand}`)));
    const ce = r.headers.get("content-encoding");
    report("shell js (nav)", ce === "dcz", `ce=${ce} vs candidate ${cand}`);
  }
}
// 2. page html — same shape against p-dict
{
  const cands = (await readdir("holding/p-dict")).filter((n) => n.startsWith("garage__pretext."));
  let hit = null;
  for (const c of cands) {
    const raw = brotliDecompressSync(await readFile(`holding/p-dict/${c}`));
    const r = await get("https://aadhar.sh/garage/pretext", b64(raw));
    if (r.headers.get("content-encoding") === "dcz") { hit = c; break; }
  }
  report("page html (pretext)", !!hit, hit ? `ce=dcz vs ${hit}` : `no candidate produced dcz (${cands.length} tried) — roll may be pending a deploy`);
}
// 3. svg — must NOT offer a dictionary (the #119 rule)
{
  const home = await (await fetch("https://aadhar.sh/", { headers: { "accept-encoding": "identity" } })).text();
  const icons = home.match(/\/a\/icons\.[0-9a-f]{8}\.svg/)?.[0];
  const r = await get(`https://aadhar.sh${icons}`);
  report("svg stays off (icons)", !r.headers.get("use-as-dictionary"), `use-as-dictionary=${r.headers.get("use-as-dictionary")}`);
}
// 4. offers are SCOPED to destinations we answer. The spec defaults match-dest to every
// destination, so a bare `match=` promises deltas for image/fetch/etc too. Assert the
// scope AND that a delta still comes back — a malformed inner list would make Chromium
// drop the offer and every delta would vanish silently into plain brotli.
{
  const home = await (await fetch("https://aadhar.sh/", { headers: { "accept-encoding": "identity" } })).text();
  const live = home.match(/\/a\/nav\.([0-9a-f]{8})\.js/)?.[1];
  const r = await get(`https://aadhar.sh/a/nav.${live}.js`);
  const uad = r.headers.get("use-as-dictionary") || "";
  report("shell offer scoped", /match-dest=\("script" "style"\)/.test(uad), `uad=${uad || "(absent)"}`);
  const p = await get("https://aadhar.sh/garage/pretext");
  const puad = p.headers.get("use-as-dictionary") || "";
  report("page offer scoped", /match-dest=\("document"\)/.test(puad), `uad=${puad || "(absent)"}`);
}
console.log("  BLOCKED (by platform, not by us): SSR'd pages — workerd zstd ignores `dictionary`; re-run the scratchpad spike or watch for CF shared-dictionaries Phase 2.");
process.exit(fail ? 1 : 0);
