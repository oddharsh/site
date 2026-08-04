#!/usr/bin/env node
// Diff infra.json against reality.
//
// wrangler.jsonc declares the compute layer and CI dry-runs it, so a bad route
// or a missing binding fails a PR today. Everything one level out — the DNS
// records, the resources those bindings point at, the Worker inventory — lived
// only in the Cloudflare dashboard and in prose. This closes that gap without
// adopting Terraform: infra.json is the declaration, this script is the diff,
// and nothing here mutates Cloudflare.
//
// Three tiers, by what they cost to run:
//
//   tree  no network.  infra.json against the repo. Binding names must line up
//                      with wrangler.jsonc, and every declared `consumer` file
//                      must exist. Catches the bimi.svg class of bug, where the
//                      only thing referencing a file is a DNS record.
//   dns   no secrets.  Public DoH. Every declared record, checked against two
//                      independent resolvers. This is most of the value and it
//                      runs in CI with no credential at all.
//   edge  no secrets.  Zone settings that are load-bearing for something this
//                      repo does, read as observed responses from production
//                      rather than as dashboard toggles. A response needs no
//                      credential, and a toggle can read "on" while a cache rule
//                      overrides it for one path.
//   api   needs a token. CLOUDFLARE_API_TOKEN, read-only scopes. Resources the
//                      bindings point at, plus the Worker inventory. Skipped
//                      when the token is absent, so CI stays secret-free.
//
// The edge tier tests PRODUCTION, not the branch under review, so a failure
// there is not caused by the PR that surfaced it. Its findings are prefixed to
// say so, because "your PR broke HSTS" would be a lie worth avoiding.
//
// Hard failures are "we checked and it is wrong". Advisories are "we could not
// check" (resolver unreachable, no token) and never fail the run — same split
// perf-budget.mjs uses, so a flaky network cannot redden an unrelated PR.
//
// Usage:
//   node scripts/check-infra.mjs              tree + dns, api if a token exists
//   node scripts/check-infra.mjs --offline    tree only
//   node scripts/check-infra.mjs --strict     turn advisories into failures

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseJsonc } from "./lib/jsonc.mjs";

const execFileP = promisify(execFile);

// TLS 1.3 0-RTT probe. Node's own tls module cannot send early data, so this
// shells out to openssl s_client — and macOS's system openssl is LibreSSL,
// which has no -early_data, so the binary is discovered rather than assumed.
// Two connections: a full handshake that saves the session ticket, then a
// resumption that sends the HTTP request AS early data and reports whether the
// edge accepted it. The first connection is held open ~2s on purpose: TLS 1.3
// delivers NewSessionTicket AFTER the handshake, so a connect-and-hangup saves
// no ticket and the test reads as a false "rejected" (cost one debugging round
// to learn). One retry on rejection, because a ticket can transiently miss.
async function probeEarlyData(host) {
  let ossl = null;
  for (const c of [process.env.OPENSSL_BIN, "/opt/homebrew/opt/openssl@3/bin/openssl",
                   "/usr/local/opt/openssl@3/bin/openssl", "openssl"].filter(Boolean)) {
    try {
      const { stdout, stderr } = await execFileP(c, ["s_client", "-help"], { timeout: 5000 });
      if (`${stdout}${stderr}`.includes("early_data")) { ossl = c; break; }
    } catch (e) {
      // s_client -help exits non-zero on some builds; the help text still tells us
      if (`${e.stdout || ""}${e.stderr || ""}`.includes("early_data")) { ossl = c; break; }
    }
  }
  if (!ossl) return { skip: "no openssl with -early_data on this machine (LibreSSL lacks it; set OPENSSL_BIN)" };

  const dir = await mkdtemp(join(tmpdir(), "infra-0rtt-"));
  try {
    const sess = join(dir, "sess.pem");
    const req = join(dir, "req.txt");
    await writeFile(req, `GET /favicon.ico HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    for (let attempt = 0; attempt < 2; attempt++) {
      await execFileP("sh", ["-c",
        `{ cat "${req}"; sleep 2; } | "${ossl}" s_client -connect "${host}:443" -servername "${host}" -sess_out "${sess}" >/dev/null 2>&1`,
      ], { timeout: 20000 }).catch(() => {});
      const out = await execFileP("sh", ["-c",
        `"${ossl}" s_client -connect "${host}:443" -servername "${host}" -sess_in "${sess}" -early_data "${req}" </dev/null 2>&1`,
      ], { timeout: 20000 }).catch((e) => ({ stdout: `${e.stdout || ""}${e.stderr || ""}` }));
      if (/early data was accepted/i.test(out.stdout || "")) return { accepted: true };
    }
    return { accepted: false };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const ROOT = new URL("../", import.meta.url).pathname;
const OFFLINE = process.argv.includes("--offline");
const STRICT = process.argv.includes("--strict");

// Identify honestly in the edge tier's own logs, same rule the Worker's
// outbound fetches follow. This is not AadharshBot: it does not sign, and
// pretending otherwise in the access log would be a small lie.
const BOT_UA = "aadhar-sh-infra-check/1.0 (+https://aadhar.sh/bot)";

const hard = [];
const advisory = [];
const ok = [];

const fail = (m) => hard.push(m);
const warn = (m) => advisory.push(m);
const pass = (m) => ok.push(m);

// ---------------------------------------------------------------- JSONC ----

// stripJsonc moved to scripts/lib/jsonc.mjs when gen-remote-config.mjs needed
// the same string-aware walk. One parser, so the two cannot disagree about what
// wrangler.jsonc says.
async function readJsonc(rel) {
  return parseJsonc(await readFile(join(ROOT, rel), "utf8"));
}

const exists = (rel) => access(join(ROOT, rel)).then(() => true, () => false);

// ------------------------------------------------------------------ DoH ----

const RRTYPE = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, DS: 43, SVCB: 64, HTTPS: 65 };

// Two independent resolvers. Google renders SVCB in presentation format;
// Cloudflare returns the RFC 3597 generic form, which decodeSvcb() normalizes
// back. Asking Cloudflare about a Cloudflare-hosted zone is also a bit
// incestuous, which is why Google goes first.
const RESOLVERS = [
  { name: "dns.google", url: (n, t) => `https://dns.google/resolve?name=${n}&type=${t}` },
  { name: "cloudflare-dns.com", url: (n, t) => `https://cloudflare-dns.com/dns-query?name=${n}&type=${t}` },
];

const SVCB_KEYS = { 0: "mandatory", 1: "alpn", 2: "no-default-alpn", 3: "port", 4: "ipv4hint", 5: "ech", 6: "ipv6hint" };

// RFC 3597 generic form ("\\# 37 00 01 06 61 ...") back to presentation format,
// so both resolvers can be compared against one expected string.
function decodeSvcb(generic) {
  const hex = generic.replace(/^\\#\s*\d+\s*/, "").replace(/\s+/g, "");
  const b = Buffer.from(hex, "hex");
  let i = 0;
  const priority = b.readUInt16BE(i); i += 2;
  const labels = [];
  while (b[i] !== 0) { const len = b[i]; labels.push(b.subarray(i + 1, i + 1 + len).toString("ascii")); i += 1 + len; }
  i += 1;
  const target = labels.length ? `${labels.join(".")}.` : ".";
  const params = [];
  while (i < b.length) {
    const key = b.readUInt16BE(i); i += 2;
    const len = b.readUInt16BE(i); i += 2;
    const val = b.subarray(i, i + len); i += len;
    const name = SVCB_KEYS[key] ?? `key${key}`;
    if (name === "mandatory") {
      const keys = [];
      for (let j = 0; j < val.length; j += 2) keys.push(SVCB_KEYS[val.readUInt16BE(j)] ?? `key${val.readUInt16BE(j)}`);
      params.push(`mandatory=${keys.join(",")}`);
    } else if (name === "alpn") {
      const alpns = [];
      for (let j = 0; j < val.length;) { const len2 = val[j]; alpns.push(val.subarray(j + 1, j + 1 + len2).toString("ascii")); j += 1 + len2; }
      params.push(`alpn=${alpns.join(",")}`);
    } else if (name === "port") {
      params.push(`port=${val.readUInt16BE(0)}`);
    } else if (name === "no-default-alpn") {
      params.push(name);
    } else {
      params.push(`${name}=${val.toString("hex")}`);
    }
  }
  return [priority, target, ...params].join(" ");
}

// Long TXT records arrive as concatenated quoted segments. Join them and drop
// the quoting so the declared value can read as the plain string it is.
function normalizeTxt(data) {
  if (!data.startsWith('"')) return data.trim();
  return [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("").trim();
}

function normalize(type, data) {
  if (type === "TXT") return normalizeTxt(data);
  if (type === "SVCB") return data.trim().startsWith("\\#") ? decodeSvcb(data) : data.trim();
  if (type === "DS") return data.replace(/\s+/g, " ").trim();
  return data.trim();
}

async function query(resolver, name, type) {
  const url = resolver.url(encodeURIComponent(name), RRTYPE[type]);
  const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${resolver.name} returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.Status !== 0 && body.Status !== 3) throw new Error(`${resolver.name} returned DNS status ${body.Status}`);
  // Filter by the type we asked for: with DNSSEC in play the Answer section
  // also carries RRSIG (46), and A queries can carry the CNAME that led there.
  const answers = (body.Answer || [])
    .filter((a) => a.type === RRTYPE[type])
    .map((a) => normalize(type, a.data));
  return { answers: answers.sort(), authenticated: body.AD === true };
}

// Try each resolver in turn. A resolver that errors is an availability problem,
// not a drift signal, so it degrades to an advisory rather than a failure.
async function resolveWithFallback(name, type) {
  const errors = [];
  for (const resolver of RESOLVERS) {
    try {
      return { ...(await query(resolver, name, type)), resolver: resolver.name };
    } catch (e) {
      errors.push(`${resolver.name}: ${e.message}`);
    }
  }
  return { unreachable: errors };
}

// ----------------------------------------------------------- tier: tree ----

async function checkTree(infra, wrangler, lwe) {
  // Binding names in infra.json must exist in the config that owns them. This
  // is the join that lets infra.json stay ID-free: wrangler.jsonc remains the
  // single source for IDs, and this stops the two describing different worlds.
  const declared = new Map();
  for (const n of wrangler.kv_namespaces || []) declared.set(n.binding, { kind: "kv", id: n.id });
  for (const b of wrangler.r2_buckets || []) declared.set(b.binding, { kind: "r2", name: b.bucket_name });
  for (const d of wrangler.d1_databases || []) declared.set(d.binding, { kind: "d1", id: d.database_id, name: d.database_name });
  if (/binding\s*=\s*"VECTORIZE"/.test(lwe)) {
    declared.set("VECTORIZE", { kind: "vectorize", name: (lwe.match(/index_name\s*=\s*"([^"]+)"/) || [])[1] });
  }

  const wanted = [
    ...(infra.resources.kv_namespaces || []).map((r) => [r.binding, "kv", r.title]),
    ...(infra.resources.r2_buckets || []).map((r) => [r.binding, "r2", r.bucket]),
    ...(infra.resources.d1_databases || []).map((r) => [r.binding, "d1", r.database]),
    ...(infra.resources.vectorize_indexes || []).map((r) => [r.binding, "vectorize", r.index]),
  ];

  for (const [binding, kind, label] of wanted) {
    const found = declared.get(binding);
    if (!found) { fail(`infra.json declares binding ${binding} (${kind} ${label}) that no Wrangler config binds`); continue; }
    if (found.kind !== kind) { fail(`binding ${binding} is ${kind} in infra.json but ${found.kind} in the Wrangler config`); continue; }
    if (found.name && label && found.name !== label) {
      fail(`binding ${binding} names ${JSON.stringify(label)} in infra.json but ${JSON.stringify(found.name)} in the Wrangler config`);
    }
  }
  pass(`${wanted.length} declared bindings line up with the Wrangler configs`);

  // The point of the `consumer` field: a DNS record that points at a file in
  // this tree makes that file load-bearing, even though nothing here links it.
  let consumers = 0;
  for (const record of infra.dns) {
    if (!record.consumer) continue;
    consumers++;
    if (!(await exists(record.consumer))) {
      fail(`${record.consumer} is missing, but DNS ${record.type} ${record.name} points at it — deleting it breaks mail, not the site`);
    }
  }
  pass(`${consumers} DNS-referenced files present in the tree`);

  // The site Worker's name must match what the release config expects, or
  // Workers Builds refuses the build outright.
  if (wrangler.name !== infra.release.worker) {
    fail(`wrangler.jsonc names the Worker ${JSON.stringify(wrangler.name)} but infra.json's release block expects ${JSON.stringify(infra.release.worker)}`);
  }
  if (infra.release.build_command !== "") {
    fail(`infra.json's release.build_command must stay empty (wrangler.jsonc's build.command owns the build); got ${JSON.stringify(infra.release.build_command)}`);
  }
  if (!wrangler.build?.command) {
    fail(`wrangler.jsonc lost its build.command — the deploy would ship the readable originals`);
  }
  // The provisioning flags, on whichever subcommand the deploy_command names.
  // Both default to TRUE and both let a publish create real KV/R2/D1 for any
  // id-less binding, which is the one thing no deploy path here may do.
  //
  // This is the TREE tier, so it checks the intent recorded in infra.json and
  // runs with no credential on every PR. The api tier below now reads the LIVE
  // dashboard value and compares the two, so a command that carries the flags
  // here but lost them upstream is caught there. Keep both: this one fails on a
  // branch that proposes a bad command, before anyone can paste it in.
  const deployCmd = String(infra.release.deploy_command || "");
  for (const flag of ["--x-provision=false", "--x-auto-create=false"]) {
    if (!deployCmd.includes(flag)) {
      fail(`infra.json's release.deploy_command must pin ${flag} (it defaults to TRUE and would let a publish create resources); got ${JSON.stringify(deployCmd)}`);
    }
  }
  // A publish that moves traffic by itself defeats the ramp. If the deploy
  // command ever goes back to a bare `wrangler deploy`, deploy:promote is dead
  // code and nobody would notice, because the site would keep releasing fine.
  if (!/\bversions upload\b/.test(deployCmd)) {
    fail(`infra.json's release.deploy_command should be a \`versions upload\` so a merge uploads without moving traffic (scripts/deploy-promote.mjs ramps it); got ${JSON.stringify(deployCmd)}`);
  }
  // Preview URLs are what makes an uploaded version worth anything before it
  // serves. `preview_urls` defaults to `workers_dev`, which is false here, so
  // dropping the explicit line silently turns every preview back off.
  if (infra.release.preview_urls !== wrangler.preview_urls) {
    fail(`infra.json's release.preview_urls (${infra.release.preview_urls}) disagrees with wrangler.jsonc's (${wrangler.preview_urls}) — with workers_dev false, an unset value means OFF`);
  }
  pass(`release block agrees with wrangler.jsonc (Worker ${wrangler.name}, build owned by Wrangler, upload-then-ramp, previews ${wrangler.preview_urls ? "on" : "off"})`);
}

// ------------------------------------------------------------ tier: dns ----

async function checkDns(infra) {
  const apex = {};

  for (const record of infra.dns) {
    const { name, type, match } = record;
    const got = await resolveWithFallback(name, type);
    if (got.unreachable) { warn(`could not resolve ${type} ${name} (${got.unreachable.join("; ")})`); continue; }

    // The zone is DNSSEC-signed, so an unauthenticated answer means either the
    // chain broke or something is answering that should not be.
    if (!got.authenticated) warn(`${type} ${name} resolved but was not DNSSEC-authenticated (AD flag unset via ${got.resolver})`);

    if (name === "aadhar.sh" && type === "A") apex.A = got.answers;

    if (match === "exact") {
      const want = [...record.expect].sort();
      const same = want.length === got.answers.length && want.every((v, i) => v === got.answers[i]);
      if (same) pass(`${type} ${name} matches (${got.resolver})`);
      else fail(`${type} ${name} drifted\n      declared: ${want.join(" | ") || "(none)"}\n      live:     ${got.answers.join(" | ") || "(none)"}`);
    } else if (match === "present") {
      if (got.answers.length) pass(`${type} ${name} present (${got.answers.length} record${got.answers.length === 1 ? "" : "s"})`);
      else fail(`${type} ${name} is missing entirely — ${record.why?.split(".")[0] || "declared as required"}`);
    } else if (match === "contains") {
      // For records whose full value is Cloudflare's to rotate (the HTTPS RR's
      // ipv6hint moves, its ech= key rotates hourly) but whose PARAMETERS are
      // ours to insist on. Exact-matching would fail on every key rotation;
      // present-matching would miss the case that matters, a zone toggle
      // silently dropping a parameter out of an otherwise healthy record.
      const joined = got.answers.join(" ");
      const missing = record.expect.filter((needle) => !joined.includes(needle));
      if (!got.answers.length) fail(`${type} ${name} is missing entirely — ${record.why?.split(".")[0] || "declared as required"}`);
      else if (missing.length) fail(`${type} ${name} lost ${missing.map((m) => JSON.stringify(m)).join(", ")}\n      live: ${joined}`);
      else pass(`${type} ${name} carries ${record.expect.map((e) => JSON.stringify(e)).join(", ")}`);
    } else if (match === "proxied") {
      const v6 = await resolveWithFallback(name, "AAAA");
      if (!got.answers.length) fail(`${type} ${name} has no A records — the apex is not resolving`);
      else if (!v6.unreachable && !v6.answers.length) fail(`${name} has A records but no AAAA — the proxy should answer on both families`);
      else pass(`${name} proxied (${got.answers.length}x A, ${v6.answers?.length ?? "?"}x AAAA)`);
    } else if (match === "sameAs") {
      const base = apex.A ?? (await resolveWithFallback(record.expect, "A")).answers;
      if (!base?.length) { warn(`could not compare ${name} against ${record.expect} (no baseline answers)`); continue; }
      const same = base.length === got.answers.length && base.every((v, i) => v === got.answers[i]);
      if (same) pass(`${name} resolves to the same edge as ${record.expect}`);
      else fail(`${name} no longer resolves to the same edge as ${record.expect}\n      ${record.expect}: ${base.join(" | ")}\n      ${name}: ${got.answers.join(" | ") || "(none)"}`);
    } else {
      fail(`infra.json: unknown match mode ${JSON.stringify(match)} on ${type} ${name}`);
    }
  }

  // Zone identity: nameservers and the DS the registrar publishes.
  const ns = await resolveWithFallback(infra.zone.name, "NS");
  if (ns.unreachable) warn(`could not resolve NS ${infra.zone.name}`);
  else {
    const want = [...infra.zone.nameservers].sort();
    const same = want.length === ns.answers.length && want.every((v, i) => v === ns.answers[i]);
    same ? pass(`nameservers match (${want.join(", ")})`)
         : fail(`nameservers drifted\n      declared: ${want.join(" | ")}\n      live:     ${ns.answers.join(" | ")}`);
  }

  const ds = await resolveWithFallback(infra.zone.name, "DS");
  if (ds.unreachable) warn(`could not resolve DS ${infra.zone.name}`);
  else if (ds.answers.includes(infra.zone.dnssec.ds)) pass(`DNSSEC DS matches the registrar-published digest`);
  else fail(`DNSSEC DS drifted\n      declared: ${infra.zone.dnssec.ds}\n      live:     ${ds.answers.join(" | ") || "(none)"}`);
}

// ----------------------------------------------------------- tier: edge ----

async function fetchEdge(url, headers = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": `${BOT_UA}`, ...headers },
    redirect: "follow",
    signal: AbortSignal.timeout(12000),
  });
  return res;
}

// The thumbnail URLs are content-hashed, so a re-encode mints new ones and any
// URL pinned in infra.json would rot within a release. Resolve one from the
// live manifest instead, which is the same indirection the site itself uses.
async function sampleImageUrl(origin) {
  const res = await fetchEdge(`${origin}/images/manifest.json`);
  if (!res.ok) throw new Error(`manifest returned HTTP ${res.status}`);
  const manifest = await res.json();
  const photo = (manifest.photos || manifest.images || [])[0];
  const path = photo?.thumb_jpg || photo?.thumb_avif;
  if (!path) throw new Error("manifest carried no thumbnail path");
  return path.startsWith("http") ? path : `${origin}${path}`;
}

async function checkEdge(infra) {
  const { origin, checks } = infra.edge;
  // Prefix findings so nobody reads a production drift as a regression in the
  // branch being reviewed.
  const drift = (m) => fail(`production edge: ${m}`);

  let sample = null;
  const targetUrl = async (target) => {
    if (target === "homepage") return `${origin}/`;
    if (target === "sample-image") return (sample ??= await sampleImageUrl(origin));
    // The Markdown twins are their own target because they are their own content
    // type, and content type is what compression is keyed on. /index.md is the
    // stable one: it is served from a committed file rather than generated, so it
    // exists on every deploy and cannot go missing the way a per-page twin could.
    if (target === "markdown-twin") return `${origin}/index.md`;
    throw new Error(`unknown edge target ${JSON.stringify(target)}`);
  };

  for (const check of checks) {
    let url;
    try {
      url = await targetUrl(check.target);
    } catch (e) {
      warn(`edge check ${check.id} could not resolve its target: ${e.message}`);
      continue;
    }

    try {
      const { assert: want } = check;

      // Compression is the one assertion that needs its own request per
      // encoding: ask for exactly one and require the edge to answer in it.
      if (want.compression) {
        const missing = [];
        for (const encoding of want.compression) {
          const res = await fetchEdge(url, { "accept-encoding": encoding });
          const got = (res.headers.get("content-encoding") || "").trim().toLowerCase();
          if (got !== encoding) missing.push(`${encoding} (got ${got || "none"})`);
        }
        missing.length ? drift(`${check.id}: edge did not compress as ${missing.join(", ")} — ${check.why.split(".")[0]}`)
                       : pass(`edge ${check.id}: ${want.compression.join(", ")} all served`);
        continue;
      }

      // "can the edge do X" and "which X does it PICK" are different questions,
      // and only the second one describes what a visitor receives. Every real
      // browser offers several encodings at once, so the choice among them is
      // the whole behaviour — and it is invisible to the check above, which
      // offers exactly one at a time and so can never observe a preference.
      // Offer the full set a browser sends and require a specific winner.
      if (want.compressionPrefers) {
        const { offer, expect } = want.compressionPrefers;
        const res = await fetchEdge(url, { "accept-encoding": offer });
        const got = (res.headers.get("content-encoding") || "").trim().toLowerCase();
        got !== expect
          ? drift(`${check.id}: offered "${offer}" and the edge chose ${got || "none"}, declared ${expect} — ${check.why.split(".")[0]}`)
          : pass(`edge ${check.id}: chose ${expect} from "${offer}"`);
        continue;
      }

      // TLS-layer assertion: no HTTP response can carry it, so it gets its own
      // probe (openssl, see probeEarlyData) instead of a fetchEdge. A machine
      // that cannot run the probe warns rather than drifts — an unmeasurable
      // check must not report the zone broken.
      if (want.earlyData) {
        const r = await probeEarlyData(new URL(url).hostname);
        if (r.skip) warn(`edge check ${check.id} skipped: ${r.skip}`);
        else if (r.accepted) pass(`edge ${check.id}: TLS early data accepted (0-RTT on)`);
        else drift(`${check.id}: TLS early data rejected on a fresh resumption — ${check.why.split(".")[0]}`);
        continue;
      }

      // A check may need to ASK for something before it can assert what comes back.
      // Content negotiation is the case that forced this: "the zone is not converting
      // our HTML" is only observable on a request that says `Accept: text/markdown`,
      // and a check that cannot set a request header cannot see it at all.
      const res = await fetchEdge(url, check.request || {});
      const problems = [];

      for (const name of want.headerAbsent || []) {
        const got = res.headers.get(name);
        if (got !== null) problems.push(`${name} is present (${got})`);
      }
      // headerPresent exists because headerContains cannot express it: every string
      // contains "", so `headerContains: {x: ""}` passes on an ABSENT header and
      // asserts nothing at all. That mistake shipped in the first draft of
      // markdown-for-agents-off below and was caught only by deleting the check's
      // request header and watching it still pass.
      for (const name of want.headerPresent || []) {
        if (res.headers.get(name) === null) problems.push(`${name} is absent`);
      }
      for (const [name, expected] of Object.entries(want.headerEquals || {})) {
        const got = (res.headers.get(name) || "").trim();
        if (got !== expected) problems.push(`${name} is ${JSON.stringify(got || "(absent)")}, declared ${JSON.stringify(expected)}`);
      }
      for (const [name, needle] of Object.entries(want.headerContains || {})) {
        const got = res.headers.get(name) || "";
        if (!got.includes(needle)) problems.push(`${name} does not contain ${JSON.stringify(needle)} (got ${JSON.stringify(got || "(absent)")})`);
      }
      if (want.bodyLacks) {
        const body = await res.text();
        for (const needle of want.bodyLacks) {
          if (body.includes(needle)) problems.push(`response body contains ${JSON.stringify(needle)}`);
        }
      }

      problems.length ? drift(`${check.id}: ${problems.join("; ")} — ${check.why.split(".")[0]}`)
                      : pass(`edge ${check.id} holds`);
    } catch (e) {
      // Production being unreachable is an availability problem, not drift.
      warn(`edge check ${check.id} could not run: ${e.message}`);
    }
  }
}

// ------------------------------------------------------------ tier: api ----

const API = "https://api.cloudflare.com/client/v4";

async function cf(token, path) {
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const detail = (body.errors || []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`${path}: ${detail}`);
  }
  return body.result;
}

// Each resource class is checked independently. A token missing ONE read scope
// must not blank the whole tier: the first version batched these into a
// Promise.all under a single catch, so an absent R2 scope silently took KV, D1
// and the Worker inventory down with it and reported one opaque auth error.
// Cloudflare returns 10000 for both "bad token" and "token lacks this scope",
// so name the scope each section needs and let the reader tell them apart.
async function section(label, scope, fn) {
  try {
    await fn();
  } catch (e) {
    // Cloudflare is not consistent here: the same missing scope surfaces as
    // 10000 "Authentication error" on some endpoints and 9106 "Authentication
    // failed" on others, so match the family rather than one code.
    const authy = /\b(10000|9106|9109)\b|authentication|unauthorized|forbidden/i.test(e.message);
    warn(authy ? `${label} unchecked: token is missing ${scope} (${e.message})`
               : `${label} unchecked: ${e.message}`);
  }
}

async function checkApi(infra, wrangler, token) {
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    const accounts = await cf(token, "/accounts");
    if (accounts.length !== 1) {
      warn(`token sees ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID to pick one`);
      return;
    }
    accountId = accounts[0].id;
  }

  // Resources the bindings point at. wrangler deploy --dry-run validates the
  // config's shape but never asks whether the IDs resolve to anything.
  await section("KV namespaces", "Workers KV Storage:Read", async () => {
    const kv = await cf(token, `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
    const ids = new Set(kv.map((n) => n.id));
    for (const n of wrangler.kv_namespaces || []) {
      ids.has(n.id) ? pass(`KV ${n.binding} resolves (${n.id})`)
                    : fail(`KV binding ${n.binding} points at namespace ${n.id}, which does not exist in this account`);
    }
  });

  await section("R2 buckets", "Workers R2 Storage:Read", async () => {
    const r2 = await cf(token, `/accounts/${accountId}/r2/buckets`);
    const names = new Set((r2.buckets || r2).map((b) => b.name));
    for (const b of wrangler.r2_buckets || []) {
      names.has(b.bucket_name) ? pass(`R2 ${b.binding} resolves (${b.bucket_name})`)
                               : fail(`R2 binding ${b.binding} points at bucket ${b.bucket_name}, which does not exist`);
    }
  });

  await section("D1 databases", "D1:Read", async () => {
    const d1 = await cf(token, `/accounts/${accountId}/d1/database?per_page=100`);
    const dbs = new Map(d1.map((d) => [d.uuid, d.name]));
    for (const d of wrangler.d1_databases || []) {
      if (!dbs.has(d.database_id)) fail(`D1 binding ${d.binding} points at database ${d.database_id}, which does not exist`);
      else if (dbs.get(d.database_id) !== d.database_name) fail(`D1 binding ${d.binding} expects ${d.database_name} but ${d.database_id} is named ${dbs.get(d.database_id)}`);
      else pass(`D1 ${d.binding} resolves (${d.database_name})`);
    }
  });

  // The Workers Builds release config. This is the ONE setting in the whole
  // release path that lives outside the repo and can be changed with nothing
  // noticing: a bare `wrangler deploy` in the dashboard's Deploy command turns
  // every merge back into an instant 100% release and makes deploy:promote dead
  // code, and releases keep working, so the failure never surfaces.
  //
  // It used to be unverifiable and infra.json said so at length. That is no
  // longer true (checked 2026-08-04): Workers Builds has a REST API, the
  // permission is `Workers Builds Configuration` and it HAS a Read variant, so
  // this fits the read-only token rule with no exception carved for it.
  //
  // PROVEN AGAINST THE LIVE API, run 30927021869 on 2026-08-04. Both the
  // endpoint path and the response envelope below were originally written from
  // Cloudflare's docs without a live call, and both turned out right first try:
  //   ok  Workers Builds deploy_command matches infra.json ("npx wrangler versions upload ...")
  //   ok  Workers Builds build_command matches infra.json ("")
  //   ok  Workers Builds root_directory matches infra.json (".")
  //   ok  Workers Builds non-production trigger uploads without deploying
  //
  // A SHAPE SURPRISE STILL DEGRADES TO A NOTE rather than failing, and that is
  // now a doctrine call rather than a hedge. This file's own header draws the
  // line: hard failures mean "we checked and it is wrong", advisories mean "we
  // could not check". An endpoint that moves or an envelope that changes is
  // squarely the second, and a Cloudflare API revision must not redden a PR that
  // only touched CSS. Only a value successfully READ that disagrees with
  // infra.json is fatal, which is the case this section exists for.
  await section("Workers Builds release config", "Workers Builds Configuration:Read", async () => {
    const scripts = await cf(token, `/accounts/${accountId}/workers/scripts`);
    const script = (scripts || []).find((s) => s.id === infra.release.worker);
    const tag = script?.tag || script?.external_script_id;
    if (!tag) {
      warn(`release config unchecked: no worker tag for ${infra.release.worker} in the script listing`);
      return;
    }

    const raw = await cf(token, `/accounts/${accountId}/builds/workers/${tag}/triggers`);
    // The docs show a bare trigger object; a list endpoint may wrap it. Accept
    // either rather than guessing which, and say so if it is neither.
    const triggers = Array.isArray(raw) ? raw : (Array.isArray(raw?.triggers) ? raw.triggers : null);
    if (!triggers) {
      warn(`release config unchecked: unexpected triggers response shape (${JSON.stringify(raw).slice(0, 160)})`);
      return;
    }

    const branch = infra.release.production_branch;
    // The dashboard's "Deploy command" and "Non-production branch deploy
    // command" are two TRIGGERS in the API, told apart by their branch filters.
    const prod = triggers.find((t) => (t.branch_includes || []).includes(branch));
    if (!prod) {
      fail(`Workers Builds has no trigger matching the ${branch} branch — nothing publishes this Worker`);
      return;
    }

    const checks = [
      ["deploy_command",  infra.release.deploy_command],
      ["build_command",   infra.release.build_command],
      ["root_directory",  infra.release.root_directory],
    ];
    for (const [field, expected] of checks) {
      const live = prod[field] ?? "";
      // root_directory is written "." here and may come back "" or "/" upstream;
      // treat those three as the same statement about a monorepo root.
      const same = field === "root_directory"
        ? [".", "", "/"].includes(String(live)) === [".", "", "/"].includes(String(expected))
        : String(live).trim() === String(expected).trim();
      same
        ? pass(`Workers Builds ${field} matches infra.json (${JSON.stringify(live)})`)
        : fail(`Workers Builds ${field} is ${JSON.stringify(live)} but infra.json declares ${JSON.stringify(expected)} — the dashboard is the live value, so fix it there`);
    }

    // The non-production trigger. Its default is already `versions upload`, so
    // this is a low-drama check, but a branch build that DEPLOYS would put a
    // feature branch straight onto production traffic.
    const preview = triggers.find((t) => t !== prod);
    if (preview && infra.release.non_production_deploy_command) {
      const live = String(preview.deploy_command ?? "").trim();
      /\bversions upload\b/.test(live)
        ? pass(`Workers Builds non-production trigger uploads without deploying (${JSON.stringify(live)})`)
        : fail(`Workers Builds non-production deploy command is ${JSON.stringify(live)} — a branch build must not deploy to production traffic`);
    }
  });

  // Worker inventory. A retired Worker that is still deployed keeps its routes,
  // which is invisible from inside this repo.
  await section("Worker inventory", "Workers Scripts:Read", async () => {
    const scripts = await cf(token, `/accounts/${accountId}/workers/scripts`);
    const live = new Set(scripts.map((s) => s.id));
    for (const w of infra.workers.expected) {
      live.has(w.name) ? pass(`Worker ${w.name} deployed`) : fail(`Worker ${w.name} is declared but not deployed`);
    }
    for (const w of infra.workers.retired) {
      if (live.has(w.name)) fail(`Worker ${w.name} is retired but still deployed — ${w.why}`);
      else pass(`retired Worker ${w.name} is gone`);
    }
    const known = new Set([...infra.workers.expected, ...infra.workers.retired, ...infra.workers.unmanaged].map((w) => w.name));
    for (const name of live) if (!known.has(name)) warn(`Worker ${name} is deployed but not accounted for in infra.json`);
  });
}

// ------------------------------------------- tier: agent markdown surface ----

// Which pages answer an agent in Markdown, measured on the wire rather than inferred
// from filenames. The twins arrive by three different conventions — /index.md for the
// homepage, holding/md/<name>.md for /whoareyou and /bot, build-generated twins for
// /garage/* and /lwe/* — so a local file check would have to know all three and would
// still be guessing about production. One request per page settles it.
//
// site-manifest.json's `flags.agents` already declares which surfaces are part of the
// agent-facing catalog, so it is the right denominator: an agents:true page that hands
// back HTML is a page the registry advertises to agents and then serves for humans.
//
// WARN, not fail. Which pages deserve a twin is a content judgement (a Markdown
// rendering of /rn's live playlist is obviously useful; one of /lens, an interactive
// tool, mostly is not), and this check has no business turning a taste call into a red
// build. The value is that the gap stops being invisible.
async function checkAgentMarkdown() {
  let surfaces;
  try {
    ({ surfaces } = JSON.parse(await readFile(join(ROOT, "site-manifest.json"), "utf8")));
  } catch (e) {
    warn(`agent markdown coverage could not run: ${e.message}`);
    return;
  }
  const pages = surfaces.filter((s) => s.kind === "page" && s.flags?.agents);
  const gaps = [];
  for (const p of pages) {
    try {
      const res = await fetchEdge(`${infra.edge.origin}${p.path}`, { accept: "text/markdown" });
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (ct !== "text/markdown") gaps.push(`${p.path} (${ct || "no content-type"})`);
    } catch (e) {
      warn(`agent markdown probe failed for ${p.path}: ${e.message}`);
    }
  }
  gaps.length
    ? warn(`agent markdown coverage: ${pages.length - gaps.length}/${pages.length} agents:true pages answer Accept: text/markdown. No twin: ${gaps.join(", ")} — give each one a twin or drop flags.agents so the registry stops advertising it`)
    : pass(`agent markdown coverage: all ${pages.length} agents:true pages answer in Markdown`);
}

// ----------------------------------------------------------------- main ----

const infra = JSON.parse(await readFile(join(ROOT, "infra.json"), "utf8"));
const wrangler = await readJsonc("wrangler.jsonc");
const lweConfig = await readFile(join(ROOT, "lwe-ask/wrangler.toml"), "utf8");

await checkTree(infra, wrangler, lweConfig);

if (OFFLINE) {
  warn("--offline: skipped the DNS and API tiers");
} else {
  await checkDns(infra);
  await checkEdge(infra);
  await checkAgentMarkdown();

  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    warn("CLOUDFLARE_API_TOKEN unset: skipped the account tier (resource existence, Worker inventory)");
  } else {
    try {
      await checkApi(infra, wrangler, token);
    } catch (e) {
      warn(`account tier could not run: ${e.message}`);
    }
  }
}

if (!infra.release.verifiable) {
  warn(`release config is not API-verifiable — review by hand: production branch ${JSON.stringify(infra.release.production_branch)}, root ${JSON.stringify(infra.release.root_directory)}, build command empty, deploy ${JSON.stringify(infra.release.deploy_command)}`);
}

for (const line of ok) console.log(`  ok    ${line}`);
for (const line of advisory) console.log(`  note  ${line}`);

if (hard.length) {
  console.error(`\ninfra drift detected (${hard.length}):`);
  for (const line of hard) console.error(`  - ${line}`);
  process.exit(1);
}

if (STRICT && advisory.length) {
  console.error(`\n--strict: ${advisory.length} advisor${advisory.length === 1 ? "y" : "ies"} treated as failures`);
  process.exit(1);
}

console.log(`\ninfra ok: ${ok.length} checks passed, ${advisory.length} skipped or advisory`);
