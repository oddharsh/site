#!/usr/bin/env node
// check-dictionary-support.mjs — is shared-dictionary compression OPERATIONAL, per
// surface class, against PRODUCTION? (bun run dcz:check)
//
// Synthesizes Available-Dictionary from the committed dictionary sets, exactly the way a
// returning Chromium visitor would send it, and asserts the wire answer. Local builds
// cannot answer this (gotcha 13/14: three platform behaviors were mis-diagnosed locally),
// so every probe here hits aadhar.sh. Loader-class rules this encodes:
//   js/css  dcz expected  (proven in production 2026-07-27)
//   html    dcz expected  (server side proven; document-loader client check post-deploy)
//   svg     dcz expected  (image loader, proven in production 2026-09-26; #119 was
//           the reason it sat out, and it never reproduced)
//   SSR     blocked: workerd's zstd ignores `dictionary`; revisit via scratchpad spike
import { readdir, readFile } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { PAGE_FAMILY_MATCH } from "../src/worker/lib/assets.ts";
import { FAMILY_DICT_DIR, readCommittedFamily, type CommittedFamily } from "./lib/page-family.ts";
import { SHELL_DISCOVERY_ROOTS, shellAssetRefs } from "./lib/shell-roots.ts";
import { parseFamilyDictionary, parseShellAsset } from "../src/worker/lib/dictionary-names.ts";

const b64 = (buf) => `:${createHash("sha256").update(buf).digest("base64")}:`;
const get = (url, dict?, extra: Record<string, string> = {}) => {
  const headers: Record<string, string> = { "accept-encoding": "zstd, br, dcz", ...extra };
  if (dict) headers["available-dictionary"] = dict;
  return fetch(url, { headers, redirect: "manual" });
};

let fail = 0;
const report = (name, ok, detail) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`); if (!ok) fail++; };

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
// The question a returning visitor asks is the opposite one. They hold whatever `/a/` asset
// production served them last, they offer ITS hash, and they get a delta only if that hash
// was in a-dict when the new version was built. So the assertion is coverage of the LIVE
// shell, which is the same shape as the "committed snapshots are WIRE bytes" check the page
// tier already has (gotcha 20). Without it the shell tier can go months uncovered while every
// row here reads PASS. Measured 2026-08-12, live nav.1c6af07b.js and luna.1523f4f6.css were
// absent while a-dict still held the three candidates from #178 on 2026-07-30.
{
  const committed = (await readdir("src/dict/a-dict")).filter((n) => parseShellAsset(n));
  const bases = new Set(committed.map((n) => parseShellAsset(n)!.base));

  const body = new Map();
  const assetRefs = (buf) => shellAssetRefs(buf.toString("utf8"));
  const fetchLive = async (path) => {
    let r;
    try { r = await fetch(`https://aadhar.sh${path}`, { headers: { "accept-encoding": "identity" } }); }
    catch { return null; }
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  };

  const refs = new Map();
  const see = (name) => refs.set(name, parseShellAsset(name)?.base ?? name);
  for (const path of SHELL_DISCOVERY_ROOTS) {
    const doc = await fetchLive(path);
    if (doc) for (const n of assetRefs(doc)) see(n);
  }
  const queue = [...refs.keys()], walked = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (!name.endsWith(".js") || walked.has(name)) continue;
    walked.add(name);
    const buf = await fetchLive(`/a/${name}`);
    if (!buf) continue;
    body.set(name, buf);
    for (const n of assetRefs(buf)) if (!refs.has(n)) { see(n); queue.push(n); }
  }

  const tracked = [...refs].filter(([, base]) => bases.has(base));
  const missing = [];
  for (const [name] of tracked) {
    if (!committed.includes(name)) { missing.push(name); continue; }
    // A matching FILENAME is not a matching dictionary. The hash is only 8 hex of a
    // sha256, and the browser keys on the full digest of the bytes it stored, so the
    // committed copy has to be those bytes exactly.
    const served = body.get(name) ?? await fetchLive(`/a/${name}`);
    if (!served) { missing.push(`${name} (could not be read from production)`); continue; }
    if (!served.equals(await readFile(`src/dict/a-dict/${name}`))) missing.push(`${name} (filename matches, bytes do not)`);
  }
  if (!refs.size) missing.push("no /a/ references found at aadhar.sh");
  const skipped = [...refs].filter(([, base]) => !bases.has(base)).map(([n]) => n);
  report("live shell is covered by a-dict", missing.length === 0,
         missing.length
           ? `run \`bun run shell:roll\` from the DEPLOYED commit. Uncovered: ${missing.join(", ")}`
           : `${tracked.length} live asset(s) present in a-dict${skipped.length ? `; ${skipped.length} untracked base(s) skipped: ${skipped.join(", ")}` : ""}`);
}

{
  let committed: CommittedFamily | null = null, problem: string | null = null;
  try { committed = await readCommittedFamily(); } catch (e) { problem = e instanceof Error ? e.message : String(e); }
  const home = await fetch("https://aadhar.sh/", { headers: { "accept-encoding": "identity" } });
  const offered = home.headers.get("link")?.match(/<([^>]+)>;\s*rel="compression-dictionary"/)?.[1] || null;
  try { await home.body?.cancel(); } catch {}
  const liveHash = parseFamilyDictionary(offered?.split("/").pop() ?? "");
  if (problem) report("family dictionary is committed", false, problem);
  else if (!liveHash) report("family dictionary is committed", false, "production's homepage advertises no rel=compression-dictionary Link");
  else if (!committed) report("family dictionary is committed", false, `${FAMILY_DICT_DIR} is empty while production serves ${liveHash}; run \`bun run dict:roll\``);
  else report("family dictionary is committed", committed.hash8 === liveHash,
              committed.hash8 === liveHash
                ? `live and committed agree on ${liveHash}`
                : `production serves ${liveHash}, ${FAMILY_DICT_DIR} holds ${committed.hash8}; run \`bun run dict:roll\` (or the last deploy re-minted on purpose and the roll has not run yet)`);
}

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
    try { raw = brotliDecompressSync(body); } catch { }
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
             : `no snapshot carries ${unheld.join(", ")} — an edge feature is rewriting HTML after the Worker, so re-run bun run shell:roll (it reads production)`);
  }
}
{
  const home = await (await fetch("https://aadhar.sh/", { headers: { "accept-encoding": "identity" } })).text();
  const live = home.match(/\/a\/icons\.([0-9a-f]{8})\.svg/)?.[1] ?? "";
  if (!live) report("svg (icons)", false, "the homepage names no /a/icons.<hash8>.svg, so there is no sprite to probe");
  const url = `https://aadhar.sh/a/icons.${live}.svg`;
  const on = await get(url);
  const offer = on.headers.get("use-as-dictionary") || "";
  report("svg offers (icons)", offer.includes('match-dest=("image")') && !/\bcookie\b/i.test(on.headers.get("vary") || ""),
    `use-as-dictionary=${offer || "(none)"} vary=${on.headers.get("vary")}`);
  const cand = (await readdir("src/dict/a-dict")).find((n) => /^icons\.[0-9a-f]{8}\.svg$/.test(n) && !n.includes(live));
  if (!cand) console.log("  SKIP  svg delta (icons)  no non-live sprite in a-dict yet; it arrives with the first sprite change after a roll");
  else {
    const r = await get(url, b64(await readFile(`src/dict/a-dict/${cand}`)));
    const ce = r.headers.get("content-encoding");
    report("svg delta (icons)", ce === "dcz", `ce=${ce} vs candidate ${cand}`);
  }
}
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
  //   max-age=3600, must-revalidate          (2026-09-23)  REGISTERED, for the max-age
  //   max-age=3600, no-cache                 (2026-09-23)  no
  //   max-age=3600, no-store                 (2026-09-23)  no
  //
  // So no-cache and no-store each veto it outright, and must-revalidate only cancels
  // the swr window: the lifetime is max-age plus swr, or max-age alone under
  // must-revalidate. s-maxage is invisible (a browser is a private cache). This
  // mirrors canRegisterAsDictionary in src/worker/lib/assets.ts; the point of checking
  // it HERE is that production's cache-control for these pages comes from _headers,
  // which that function never sees.
  const canRegister = (cc) => {
    const v = (cc || "").toLowerCase();
    if (/\b(?:no-store|no-cache)\b/.test(v)) return false;
    const secs = (n) => Number(v.match(new RegExp(`\\b${n}=(\\d+)`))?.[1] || 0);
    const stale = /\bmust-revalidate\b/.test(v) ? 0 : secs("stale-while-revalidate");
    return secs("max-age") + stale > 0;
  };
  const p = await get("https://aadhar.sh/garage/pretext");
  const puad = p.headers.get("use-as-dictionary");
  const pcc = p.headers.get("cache-control") || "";
  try { await p.body?.cancel(); } catch {}
  report("page self-offer matches what the policy can keep", !!puad === canRegister(pcc),
         puad
           ? `offers itself (${puad}) under "${pcc}"${canRegister(pcc) ? "" : " — stale on arrival, so no browser can keep it"}`
           : `no self-offer under "${pcc}"${canRegister(pcc) ? " — but this policy WOULD register; the tier is dark for nothing" : " (correct; the family dictionary carries the page tier)"}`);
  const swr = Number(pcc.match(/\bstale-while-revalidate=(\d+)/)?.[1] || 0);
  report("page dictionary lifetime is useful", !puad || swr === 0 || swr >= 86400,
         swr ? `stale-while-revalidate=${swr}s of dictionary lifetime` : "(freshness, not swr, carries the lifetime)");
}
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

  const plain = await get(url);
  const pce = plain.headers.get("content-encoding");
  try { await plain.body?.cancel(); } catch {}
  report("no dictionary gets no delta", pce !== "dcz",
         pce === "dcz" ? "a request with no Available-Dictionary was served dcz — undecodable" : `ce=${pce}`);
}
console.log("  BLOCKED (by platform, not by us): SSR'd pages — workerd zstd ignores `dictionary`; re-run the scratchpad spike or watch for CF shared-dictionaries Phase 2.");
process.exit(fail ? 1 : 0);
