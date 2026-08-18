#!/usr/bin/env node
// check-dictionary-support.mjs — is shared-dictionary compression OPERATIONAL, per
// surface class, against PRODUCTION? (pnpm run dcz:check)
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
import { PAGE_FAMILY_MATCH } from "../src/worker/lib/assets.js";

const b64 = (buf) => `:${createHash("sha256").update(buf).digest("base64")}:`;
const get = (url, dict) => {
  // The header is ABSENT on the control arm rather than empty: an empty
  // `available-dictionary` is a different request from one that never offered a
  // dictionary, and the control depends on the second.
  const headers = { "accept-encoding": "zstd, br, dcz" };
  if (dict) headers["available-dictionary"] = dict;
  return fetch(url, { headers, redirect: "manual" });
};

let fail = 0;
const report = (name, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`); if (!ok) fail++; };

// 1. shell js — nav delta against an a-dict candidate that is NOT the live hash
{
  const home = await (await fetch("https://aadhar.sh/", { headers: { "accept-encoding": "identity" } })).text();
  const live = home.match(/\/a\/nav\.([0-9a-f]{8})\.js/)?.[1];
  const cand = (await readdir("src/dict/a-dict")).find((n) => n.startsWith("nav.") && !n.includes(live));
  if (!cand) report("shell js (nav)", false, "no non-live a-dict candidate to probe with");
  else {
    const r = await get(`https://aadhar.sh/a/nav.${live}.js`, b64(await readFile(`src/dict/a-dict/${cand}`)));
    const ce = r.headers.get("content-encoding");
    report("shell js (nav)", ce === "dcz", `ce=${ce} vs candidate ${cand}`);
  }
}
// 1b. shell COVERAGE: is the a-dict set built against the bytes browsers actually HOLD?
//
// Probe 1 above offers a committed candidate and asserts the worker answers dcz. That is
// true by construction: build.mjs builds a delta for every a-dict entry, so the probe can
// only ever agree with itself. It reads the live hash purely to EXCLUDE it.
//
// The question a returning visitor asks is the opposite one. They hold whatever `/a/` asset
// production served them last, they offer ITS hash, and they get a delta only if that hash
// was in a-dict when the new version was built. So the assertion is coverage of the LIVE
// shell, which is the same shape as the "committed snapshots are WIRE bytes" check the page
// tier already has (gotcha 20). Without it the shell tier can go months uncovered while every
// row here reads PASS. Measured 2026-08-12, live nav.1c6af07b.js and luna.1523f4f6.css were
// absent while a-dict still held the three candidates from #178 on 2026-07-30.
//
// Bases with no a-dict entry at all are SKIPPED, not failed: a newly shipped asset cannot
// have a dictionary until it has been served once, and `pnpm run shell:roll` adopts it on the
// next roll. What this catches is a base that HAS a history and whose live bytes are missing
// from it, which is the drift that matters.
//
// Advisory on purpose. Like infra:check's edge tier this reads production, so it stays red
// until a deploy fixes it. Do NOT make dcz:check a required check or it deadlocks the very
// release that would clear it.
{
  const committed = (await readdir("src/dict/a-dict")).filter((n) => /\.[0-9a-f]{8}\.(js|css)$/.test(n));
  const bases = new Set(committed.map((n) => n.replace(/\.[0-9a-f]{8}\.(js|css)$/, "")));

  // Two pages, because no single document references every dictionary-carrying asset:
  // the homepage pulls nav + luna, /lens pulls lens.js on top of them.
  const refs = new Map();
  for (const path of ["/", "/lens"]) {
    const html = await (await fetch(`https://aadhar.sh${path}`, { headers: { "accept-encoding": "identity" } })).text();
    for (const [, name] of html.matchAll(/\/a\/([\w-]+\.[0-9a-f]{8}\.(?:js|css))/g)) {
      refs.set(name, name.replace(/\.[0-9a-f]{8}\.(js|css)$/, ""));
    }
  }

  const tracked = [...refs].filter(([, base]) => bases.has(base));
  const missing = [];
  for (const [name] of tracked) {
    if (!committed.includes(name)) { missing.push(name); continue; }
    // A matching FILENAME is not a matching dictionary. The hash is only 8 hex of a
    // sha256, and the browser keys on the full digest of the bytes it stored, so the
    // committed copy has to be those bytes exactly.
    const served = Buffer.from(await (await fetch(`https://aadhar.sh/a/${name}`, { headers: { "accept-encoding": "identity" } })).arrayBuffer());
    if (!served.equals(await readFile(`src/dict/a-dict/${name}`))) missing.push(`${name} (filename matches, bytes do not)`);
  }
  const skipped = [...refs].filter(([, base]) => !bases.has(base)).map(([n]) => n);
  report("live shell is covered by a-dict", missing.length === 0,
         missing.length
           ? `run \`pnpm run shell:roll\` from the DEPLOYED commit. Uncovered: ${missing.join(", ")}`
           : `${tracked.length} live asset(s) present in a-dict${skipped.length ? `; ${skipped.length} untracked base(s) skipped: ${skipped.join(", ")}` : ""}`);
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
    report("page dictionary offered", uad === `match="${PAGE_FAMILY_MATCH}", match-dest=("document")`,
           `${offered} ${raw.length} B, uad=${uad || "(absent)"}`);
    const r = await get("https://aadhar.sh/garage/pretext", b64(raw));
    const ce = r.headers.get("content-encoding");
    report("page html (pretext)", ce === "dcz",
           ce === "dcz" ? `ce=dcz vs ${offered}` : `ce=${ce} — the deployed /pd/ deltas may predate this dictionary`);
  }

  const candidates = (await readdir("src/dict/p-dict").catch(() => []))
    .filter((name) => name.startsWith("garage__pretext.") && name.endsWith(".html.br"));
  if (!candidates.length) {
    report("page html per-page tier", true, "no committed pretext snapshot — family tier is the only candidate");
  } else {
    // Try EVERY committed snapshot and pass if any one earns a delta, rather than
    // picking candidates[0] and hoping. Two states make one-candidate probing wrong:
    // readdir order is not adoption order, and a snapshot rolled since the last
    // deploy has no delta built against it yet (deltas are build output). Both read
    // as a broken tier when the tier is fine. "At least one committed snapshot is
    // usable against production right now" is the property worth asserting.
    const tried = [];
    for (const name of candidates) {
      const raw = brotliDecompressSync(await readFile(`src/dict/p-dict/${name}`));
      const ce = (await get("https://aadhar.sh/garage/pretext", b64(raw))).headers.get("content-encoding");
      tried.push(`${name}=${ce}`);
      if (ce === "dcz") break;
    }
    report("page html per-page tier", tried.some((t) => t.endsWith("=dcz")),
           tried.some((t) => t.endsWith("=dcz"))
             ? `ce=dcz vs ${tried.at(-1).replace("=dcz", "")}`
             : `no committed snapshot earned a delta (${tried.join(", ")}) — the deployed /pd/ deltas predate every one of them`);

    // A snapshot is only a dictionary if a BROWSER holds those bytes, so it has to be
    // what the wire sent, not what the build produced. The tier above cannot see the
    // difference: it offers the committed tag, so it passes on a snapshot no browser
    // could ever offer. That is exactly what happened when WebMCP turned on and
    // Cloudflare started injecting `<script src="/.webmcp/bridge.js">` at the edge,
    // downstream of this Worker — every snapshot rolled from `.build/public` hashed
    // to bytes nobody had, and the per-page tier fell back to the family dictionary
    // in total silence.
    //
    // The invariant that catches it in general: a script the live document loads must
    // appear in at least one committed snapshot. Hashed `/a/` refs are normalised away
    // because those legitimately change every deploy; what is left is the set of
    // scripts an EDGE feature can add behind the Worker's back. Fires either when
    // injection is newly on or when a roll read the build, and the remedy is the same
    // for both: re-roll from the wire.
    const srcs = (html) => new Set(
      [...String(html).matchAll(/<script[^>]+src=["']?([^"'\s>]+)/gi)]
        .map((m) => m[1].replace(/\.[0-9a-f]{8}\.(js|css)$/, ".$1")),
    );
    const liveDoc = await (await fetch("https://aadhar.sh/garage/pretext", { headers: { "accept-encoding": "identity" } })).text();
    const held = await Promise.all(candidates.map(async (name) =>
      srcs(brotliDecompressSync(await readFile(`src/dict/p-dict/${name}`)).toString("utf8"))));
    const unheld = [...srcs(liveDoc)].filter((src) => !held.some((set) => set.has(src)));
    report("committed snapshots are WIRE bytes", unheld.length === 0,
           unheld.length === 0
             ? `every script the live page loads appears in a snapshot (${candidates.length} candidates)`
             : `no snapshot carries ${unheld.join(", ")} — an edge feature is rewriting HTML after the Worker, so re-run pnpm run shell:roll (it reads production)`);
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
// 5. the cache key actually SEPARATES dictionaries. Everything above reads
// `content-encoding` and stops there, which cannot see the one failure that would
// actually break visitors: a shared cache that stored one client's delta and hands it
// to a client holding a DIFFERENT dictionary. That response is labelled dcz, arrives
// with a 200, and is undecodable — and every check above it still says PASS, because
// the header is right and only the bytes are wrong.
//
// The separation is not ours to implement. Cloudflare's shared-dictionaries support
// (RFC 9842, open beta 2026-04-30) is what extends the edge cache key to
// `Available-Dictionary` + `Accept-Encoding`; assets.js:182 sets the Vary that asks
// for it. A zone-side regression, or that setting being flipped, would land here as
// two dictionaries collapsing onto one cached body. Verified separating 2026-07-29
// (1072 B / 651 B / 13490 B, all three cf-cache-status: HIT), so this asserts a
// property production HAS rather than one we hope for.
//
// Needs two distinct dictionaries that BOTH earn a delta against the live nav hash,
// so it discovers them instead of hardcoding: a dictionary roll changes which
// committed snapshots still have deltas deployed.
{
  const home = await (await fetch("https://aadhar.sh/", { headers: { "accept-encoding": "identity" } })).text();
  const live = home.match(/\/a\/nav\.([0-9a-f]{8})\.js/)?.[1];
  const url = `https://aadhar.sh/a/nav.${live}.js`;

  const deltas = [];
  for (const name of (await readdir("src/dict/a-dict")).filter((n) => n.startsWith("nav.") && !n.includes(live))) {
    const r = await get(url, b64(await readFile(`src/dict/a-dict/${name}`)));
    const body = Buffer.from(await r.arrayBuffer());
    // dcz is not an encoding undici knows, so these bytes arrive raw — which is the
    // whole point here. Hash rather than compare lengths: two different deltas could
    // coincide in size, and a collapsed cache key would be an EXACT byte match.
    if (r.headers.get("content-encoding") === "dcz") {
      deltas.push({ name, sha: createHash("sha256").update(body).digest("hex").slice(0, 12), bytes: body.length });
    }
  }

  if (deltas.length < 2) {
    report("dcz cache key separates dictionaries", true,
           `inconclusive: ${deltas.length} of the committed nav snapshots still have a deployed delta (needs 2). Not a failure — roll the dictionaries or deploy, then re-run.`);
  } else {
    const [a, b] = deltas;
    report("dcz cache key separates dictionaries", a.sha !== b.sha,
           a.sha === b.sha
             ? `COLLAPSED: ${a.name} and ${b.name} both returned ${a.bytes} B / sha ${a.sha}. One of these clients cannot decode what it was handed.`
             : `${a.name}=${a.bytes} B (${a.sha}) vs ${b.name}=${b.bytes} B (${b.sha})`);
  }

  // The other half of the same key: a client that sends NO dictionary must never be
  // handed a delta. This is the direction that breaks a first-time visitor rather than
  // a returning one, so it is the more expensive of the two to get wrong.
  const plain = await get(url);
  const pce = plain.headers.get("content-encoding");
  try { await plain.body?.cancel(); } catch {}
  report("no dictionary gets no delta", pce !== "dcz",
         pce === "dcz" ? "a request with no Available-Dictionary was served dcz — undecodable" : `ce=${pce}`);
}
console.log("  BLOCKED (by platform, not by us): SSR'd pages — workerd zstd ignores `dictionary`; re-run the scratchpad spike or watch for CF shared-dictionaries Phase 2.");
process.exit(fail ? 1 : 0);
