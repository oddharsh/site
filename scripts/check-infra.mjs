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

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

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

// wrangler.jsonc carries // comments AND string values like "https://aadhar.sh",
// so a naive comment strip corrupts the config. Walk it string-aware instead.
function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i++; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  // trailing commas, now that comments are gone and we are outside strings
  return out.replace(/,(\s*[}\]])/g, "$1");
}

async function readJsonc(rel) {
  return JSON.parse(stripJsonc(await readFile(join(ROOT, rel), "utf8")));
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
  pass(`release block agrees with wrangler.jsonc (Worker ${wrangler.name}, build owned by Wrangler)`);
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

      const res = await fetchEdge(url);
      const problems = [];

      for (const name of want.headerAbsent || []) {
        const got = res.headers.get(name);
        if (got !== null) problems.push(`${name} is present (${got})`);
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
  warn(`release config is not API-verifiable (no public Workers Builds endpoint) — review by hand: production branch ${JSON.stringify(infra.release.production_branch)}, root ${JSON.stringify(infra.release.root_directory)}, build command empty, deploy ${JSON.stringify(infra.release.deploy_command)}`);
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
