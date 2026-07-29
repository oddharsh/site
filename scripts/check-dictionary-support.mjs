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
// 2. page html — exercise both dictionary tiers. The family dictionary is read from
// the production page's Link header; the per-page candidate is a committed snapshot
// of the previous release. Both are real Available-Dictionary values a browser can
// send, and the worker must answer each with dcz when that candidate is present.
{
  const page = await fetch("https://aadhar.sh/garage/pretext", { headers: { "accept-encoding": "identity" } });
  const offered = page.headers.get("link")?.match(/<([^>]+)>;\s*rel="compression-dictionary"/)?.[1];
  try { await page.body?.cancel(); } catch {}
  if (!offered) {
    report("page html (pretext)", false, "no rel=compression-dictionary Link on the page — is PAGE_DICTIONARY populated?");
  } else {
    // The dictionary is served as a q11 .br twin; a worker cannot negotiate that away
    // (gotcha 13). Chrome hashes the DECODED resource, so decode before hashing.
    //
    // Do NOT branch on the content-encoding header to decide whether to decode.
    // undici decompresses br on its own and leaves the header in place, so that
    // test says "br" over a body that is already plain, and brotliDecompressSync
    // then throws ERR__ERROR_FORMAT_RESERVED and takes the whole check down. Try
    // the decode and keep the bytes that survive: the header is not evidence about
    // the body once a fetch stack has been in the middle.
    const res = await fetch(`https://aadhar.sh${offered}`, { headers: { "accept-encoding": "br" } });
    const body = Buffer.from(await res.arrayBuffer());
    let raw = body;
    try { raw = brotliDecompressSync(body); } catch { /* already decoded upstream */ }
    const uad = res.headers.get("use-as-dictionary") || "";
    report("page dictionary offered", /match="\/\*"/.test(uad) && /match-dest=\("document"\)/.test(uad),
           `${offered} ${raw.length} B, uad=${uad || "(absent)"}`);
    const r = await get("https://aadhar.sh/garage/pretext", b64(raw));
    const ce = r.headers.get("content-encoding");
    report("page html (pretext)", ce === "dcz",
           ce === "dcz" ? `ce=dcz vs ${offered}` : `ce=${ce} — the deployed /pd/ deltas may predate this dictionary`);
  }

  const candidates = (await readdir("holding/p-dict").catch(() => []))
    .filter((name) => name.startsWith("garage__pretext.") && name.endsWith(".html.br"));
  if (!candidates.length) {
    report("page html per-page tier", true, "no committed pretext snapshot — family tier is the only candidate");
  } else {
    const raw = brotliDecompressSync(await readFile(`holding/p-dict/${candidates[0]}`));
    const r = await get("https://aadhar.sh/garage/pretext", b64(raw));
    const ce = r.headers.get("content-encoding");
    report("page html per-page tier", ce === "dcz", `ce=${ce} vs ${candidates[0]}`);
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

  // A page that offers ITSELF as a dictionary has to survive to the moment of use.
  // RFC 9842: "To be considered as a match, the dictionary resource MUST be either
  // fresh or allowed to be served stale." Chromium implements that literally, sizing a
  // registered dictionary's lifetime from the response's own freshness — so an offer on
  // a stale-on-arrival response is stored already-expired and dropped, and the whole
  // per-page tier (its /pd/ deltas, its committed p-dict snapshots, its build time)
  // buys nothing on the client while costing a DevTools error per navigation.
  //
  // Measured in Chrome 2026-07-29, one navigation per policy, watching for the
  // Available-Dictionary a browser sends back only when it actually kept the offer:
  //
  //   max-age=3600                                                REGISTERED (control)
  //   max-age=0, stale-while-revalidate=604800                     REGISTERED
  //   public, max-age=0, s-maxage=86400, stale-while-revalidate=604800   REGISTERED
  //   public, max-age=0, s-maxage=86400, stale-while-revalidate=5        no (the swr
  //                                                        window IS the lifetime)
  //   max-age=0, must-revalidate                                         no
  //   max-age=0, must-revalidate, stale-while-revalidate=604800          no
  //   private, no-cache, must-revalidate                                 no
  //   private, no-cache, stale-while-revalidate=604800                   no
  //
  // So must-revalidate and no-cache each veto it outright, s-maxage is invisible (a
  // browser is a private cache), and the swr window doubles as the dictionary's
  // lifetime. This mirrors canRegisterAsDictionary in _worker.js/lib/assets.js; the
  // point of checking it HERE is that production's cache-control for these pages comes
  // from _headers, which that function never sees.
  const canRegister = (cc) => {
    const v = (cc || "").toLowerCase();
    if (/\b(?:no-store|no-cache|must-revalidate)\b/.test(v)) return false;
    const secs = (n) => Number(v.match(new RegExp(`\\b${n}=(\\d+)`))?.[1] || 0);
    return secs("max-age") > 0 || secs("stale-while-revalidate") > 0;
  };
  const p = await get("https://aadhar.sh/garage/pretext");
  const puad = p.headers.get("use-as-dictionary");
  const pcc = p.headers.get("cache-control") || "";
  try { await p.body?.cancel(); } catch {}
  // The offer and the policy have to agree in BOTH directions. Advertising a dictionary
  // no browser will keep is the bug this check was written for; silently dropping the
  // offer on a page whose policy WOULD have kept it is the per-page tier going dark
  // with nothing on the wire to say so.
  report("page self-offer matches what the policy can keep", !!puad === canRegister(pcc),
         puad
           ? `offers itself (${puad}) under "${pcc}"${canRegister(pcc) ? "" : " — stale on arrival, so no browser can keep it"}`
           : `no self-offer under "${pcc}"${canRegister(pcc) ? " — but this policy WOULD register; the tier is dark for nothing" : " (correct; the family dictionary carries the page tier)"}`);
  // A short swr window registers a short-lived dictionary, which fails as a slow leak
  // rather than a hard error: the offer still looks right and simply stops matching.
  const swr = Number(pcc.match(/\bstale-while-revalidate=(\d+)/)?.[1] || 0);
  report("page dictionary lifetime is useful", !puad || swr === 0 || swr >= 86400,
         swr ? `stale-while-revalidate=${swr}s of dictionary lifetime` : "(freshness, not swr, carries the lifetime)");
}
console.log("  BLOCKED (by platform, not by us): SSR'd pages — workerd zstd ignores `dictionary`; re-run the scratchpad spike or watch for CF shared-dictionaries Phase 2.");
process.exit(fail ? 1 : 0);
