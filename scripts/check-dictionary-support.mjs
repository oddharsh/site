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
// 2. page html — the one immutable site-page dictionary, taken from PRODUCTION.
//
// Pages used to be diffed against committed snapshots of their own previous bytes
// (holding/p-dict), which made this probe a search over local candidates. That
// mechanism is gone: build.mjs derives ONE raw 64KB corpus from the staged pages
// and every page delta is keyed by that dictionary's tag alone. So the honest probe
// is the round trip a real browser makes — read the dictionary URL out of the page's
// own Link header, fetch those exact bytes, and ask for a delta against them.
// Nothing local is involved, which also means the probe cannot rot against a
// snapshot set nobody maintains anymore.
{
  const page = await fetch("https://aadhar.sh/garage/pretext", { headers: { "accept-encoding": "identity" } });
  const offered = page.headers.get("link")?.match(/<([^>]+)>;\s*rel="compression-dictionary"/)?.[1];
  try { await page.body?.cancel(); } catch {}
  if (!offered) {
    report("page html (pretext)", false, "no rel=compression-dictionary Link on the page — is PAGE_DICTIONARY populated?");
  } else {
    // The dictionary is served as a q11 .br twin; a worker cannot negotiate that away
    // (gotcha 13). Chrome hashes the DECODED resource, so decode before hashing —
    // whether undici already did it for us or left the header on.
    const res = await fetch(`https://aadhar.sh${offered}`, { headers: { "accept-encoding": "br" } });
    const body = Buffer.from(await res.arrayBuffer());
    const raw = res.headers.get("content-encoding") === "br" ? brotliDecompressSync(body) : body;
    const uad = res.headers.get("use-as-dictionary") || "";
    report("page dictionary offered", /match="\/\*"/.test(uad) && /match-dest=\("document"\)/.test(uad),
           `${offered} ${raw.length} B, uad=${uad || "(absent)"}`);
    const r = await get("https://aadhar.sh/garage/pretext", b64(raw));
    const ce = r.headers.get("content-encoding");
    report("page html (pretext)", ce === "dcz",
           ce === "dcz" ? `ce=dcz vs ${offered}` : `ce=${ce} — the deployed /pd/ deltas may predate this dictionary`);
  }
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
//
// Each asset carries its OWN scope, matching its own destination: nav.js is
// ("script"), luna.css is ("style"). This assertion used to require both names on
// every offer, which was right while one `/a/*` glob covered the pair, and became
// wrong the moment #138 split the offers per asset. It then failed for eleven days
// against correct behaviour — and because dcz:check is a manual check rather than a
// CI gate, a red line here is exactly the kind that gets read as background noise.
// So: assert each asset's own destination, and assert they DIFFER, which is the
// property that a regression back to a shared glob would actually break.
{
  const home = await (await fetch("https://aadhar.sh/", { headers: { "accept-encoding": "identity" } })).text();
  const navHash = home.match(/\/a\/nav\.([0-9a-f]{8})\.js/)?.[1];
  const cssHash = home.match(/\/a\/luna\.([0-9a-f]{8})\.css/)?.[1];

  const nav = (await get(`https://aadhar.sh/a/nav.${navHash}.js`)).headers.get("use-as-dictionary") || "";
  report("shell js offer scoped", /match="\/a\/nav\.\*"/.test(nav) && /match-dest=\("script"\)/.test(nav),
         `uad=${nav || "(absent)"}`);

  const css = cssHash ? (await get(`https://aadhar.sh/a/luna.${cssHash}.css`)).headers.get("use-as-dictionary") || "" : "";
  report("shell css offer scoped", /match="\/a\/luna\.\*"/.test(css) && /match-dest=\("style"\)/.test(css),
         `uad=${css || "(absent)"}`);

  report("shell offers are per-asset", nav !== "" && css !== "" && nav !== css,
         `nav and css must not share one offer (nav=${nav || "(absent)"} css=${css || "(absent)"})`);

  // A page must NOT offer ITSELF as a dictionary. Pages ship `max-age=0`, and Chrome
  // correctly refuses an immediately-stale response as a dictionary — so the offer
  // would only teach browsers to send Available-Dictionary for bytes we never diff
  // against. Since #156 the single document-scoped offer lives on the immutable
  // /a/page-family.<hash8>.dict asset, asserted in probe 2 above.
  const p = await get("https://aadhar.sh/garage/pretext");
  const puad = p.headers.get("use-as-dictionary");
  try { await p.body?.cancel(); } catch {}
  report("page does not offer itself", !puad, `uad=${puad || "(absent)"}`);
}
console.log("  BLOCKED (by platform, not by us): SSR'd pages — workerd zstd ignores `dictionary`; re-run the scratchpad spike or watch for CF shared-dictionaries Phase 2.");
process.exit(fail ? 1 : 0);
