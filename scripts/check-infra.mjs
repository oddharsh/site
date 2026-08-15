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
// Five tiers, by what they cost to run:
//
//   tree  no network.  infra.json against the repo. Binding names must line up
//                      with wrangler.jsonc, and every declared `consumer` file
//                      must exist. Catches the bimi.svg class of bug, where the
//                      only thing referencing a file is a DNS record.
//   dns   no secrets.  Public DoH. Every declared record, checked against two
//                      independent resolvers. This is most of the value and it
//                      runs in CI with no credential at all.
//   repo  no secrets.  GitHub repository rulesets, the branch half of the
//                      release model. Public repo, public endpoint, so this
//                      runs on every PR with no credential; GITHUB_TOKEN buys
//                      rate-limit headroom alone.
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

  // The account pin. Both wrangler configs must name the account infra.json
  // declares, because wrangler only auto-selects while the login can see
  // exactly one and that is not a property this repo controls — a second
  // account appearing on the login is enough to break every non-interactive
  // wrangler call at once (2026-08-07). Checking BOTH configs matters: the dev
  // twin is what dev:remote and routes:check:remote reach production through,
  // and build.mjs's drift warning compares binding sets only, so an account_id
  // that went missing from one of them would otherwise be caught by nothing.
  //
  // wrangler.jsonc's account_id is the SOURCE OF TRUTH and the other three are
  // compared against it, rather than against a copy in infra.json. That is this
  // file's existing rule for resource ids, and it is why infra.json's account
  // block declares the invariant without repeating the value.
  const declaredAccount = wrangler.account_id;
  if (!declaredAccount) {
    fail(`wrangler.jsonc lost its account_id — wrangler picks an account by itself only while the login sees exactly one, so every non-interactive call fails the moment a second appears`);
  } else {
    const devWrangler = await readJsonc("wrangler.dev.jsonc").catch(() => null);
    if (!devWrangler) {
      fail(`wrangler.dev.jsonc is missing or unparseable, so its account_id pin cannot be checked`);
    }
    // FOUR copies of this id ship, not two. Both configs carry it as the
    // deploy-time `account_id` pin AND as the runtime var CF_ACCOUNT_ID, which
    // /ledger uses to query this account's own Analytics Engine. The var
    // predates the pin. Check all four against one declaration so the string
    // cannot be half-updated: an account_id and a CF_ACCOUNT_ID that disagree
    // would deploy to one account and read analytics from another, and both
    // halves would look fine on their own.
    //
    // Counted rather than assumed, so the ok line cannot claim everything is
    // pinned while one of these is the reason the run is failing.
    const sites = [
      ["wrangler.jsonc vars.CF_ACCOUNT_ID", wrangler.vars?.CF_ACCOUNT_ID, "/ledger reads this account's Analytics Engine through it"],
      ...(devWrangler ? [
        ["wrangler.dev.jsonc account_id", devWrangler.account_id, "dev:remote and routes:check:remote reach production bindings through this config"],
        ["wrangler.dev.jsonc vars.CF_ACCOUNT_ID", devWrangler.vars?.CF_ACCOUNT_ID, "/ledger reads this account's Analytics Engine through it"],
      ] : []),
    ];
    // infra.json names the same three, so a copy added there without a check
    // here (or the reverse) is itself drift.
    const declared = infra.account?.must_agree || [];
    const named = sites.map(([where]) => where);
    if (declared.join("|") !== named.join("|")) {
      fail(`infra.json's account.must_agree (${JSON.stringify(declared)}) does not match what checkTree verifies (${JSON.stringify(named)})`);
    }
    let agreed = 0;
    for (const [where, value, why] of sites) {
      if (!value) {
        fail(`${where} is missing — ${why}`);
      } else if (value !== declaredAccount) {
        fail(`${where} (${JSON.stringify(value)}) disagrees with wrangler.jsonc's account_id (${JSON.stringify(declaredAccount)})`);
      } else {
        agreed++;
      }
    }
    if (agreed === sites.length && sites.length === 3) {
      pass(`account ${declaredAccount} agrees across all 4 declarations (account_id + vars.CF_ACCOUNT_ID, both configs)`);
    }
  }

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
  // The provisioning flags, on whichever subcommand a deploy command names.
  // Both default to TRUE and both let a publish create real KV/R2/D1 for any
  // id-less binding, which is the one thing no deploy path here may do.
  //
  // EVERY publishing command, from one list. The non-production command ran
  // bare until 2026-08-04 and this loop only read the production one, so a
  // push to any branch published with both flags at their default. The reason
  // it hid for so long is that the rule enumerated deploy paths in prose and a
  // branch build was not among the three it named. So iterate rather than name:
  // the next trigger Cloudflare adds gets checked by being added here, and the
  // failure names which command is loose instead of saying "the deploy command".
  //
  // This is the TREE tier, so it checks the intent recorded in infra.json and
  // runs with no credential on every PR. The api tier below now reads the LIVE
  // dashboard values and compares them, so a command that carries the flags
  // here but lost them upstream is caught there. Keep both: this one fails on a
  // branch that proposes a bad command, before anyone can paste it in.
  const deployCmd = String(infra.release.deploy_command || "");
  const previewCmd = String(infra.release.non_production_deploy_command || "");
  const publishCommands = [
    ["deploy_command", deployCmd],
    // Optional: a repo that turns non-production branch builds off drops the
    // field entirely. An EMPTY string is that, and skipping it is right. A
    // MISSING pin on a present command is the bug this loop exists for.
    ...(previewCmd ? [["non_production_deploy_command", previewCmd]] : []),
  ];
  for (const [field, cmd] of publishCommands) {
    for (const flag of ["--x-provision=false", "--x-auto-create=false"]) {
      if (!cmd.includes(flag)) {
        fail(`infra.json's release.${field} must pin ${flag} (it defaults to TRUE and would let a publish create resources); got ${JSON.stringify(cmd)}`);
      }
    }
    // A publish that moves traffic by itself defeats the ramp. If a deploy
    // command ever goes back to a bare `wrangler deploy`, deploy:promote is dead
    // code and nobody would notice, because the site would keep releasing fine.
    // On the non-production command it is worse than dead code: a feature branch
    // would take production traffic on push.
    if (!/\bversions upload\b/.test(cmd)) {
      fail(`infra.json's release.${field} should be a \`versions upload\` so a publish does not move traffic (scripts/deploy-promote.mjs ramps it); got ${JSON.stringify(cmd)}`);
    }
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

async function fetchEdge(url, headers = {}, opts = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": `${BOT_UA}`, ...headers },
    redirect: opts.redirect || "follow",
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
  // Left verbatim because it is a transcript of that run. Both commands moved
  // from `npx` to `pnpm exec` on 2026-08-14, so a run today prints the same
  // lines with the new prefix.
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

    // The non-production trigger, held to the SAME standard as the production
    // one. This used to test only that the live command said `versions upload`,
    // which it called a low-drama check because that is already the Cloudflare
    // default. The drama was in what the test did not read: the two provisioning
    // flags. A command can pass a `versions upload` match and still publish with
    // --x-provision and --x-auto-create at their default TRUE, which is exactly
    // what this trigger did until 2026-08-04. Compare the whole string, so a
    // dropped flag reads as drift like any other.
    const preview = triggers.find((t) => t !== prod);
    const expectedPreview = String(infra.release.non_production_deploy_command || "");
    if (expectedPreview && !preview) {
      // Declared but absent. Nothing PUBLISHES in this direction, so it is not
      // dangerous, and a trigger list whose shape we guessed at is the case the
      // section header says degrades to a note. Say it and move on.
      warn(`release config partly unchecked: infra.json declares a non-production deploy command but Workers Builds returned no second trigger (branch builds off, or the trigger list is shaped differently than assumed)`);
    } else if (expectedPreview && preview) {
      const live = String(preview.deploy_command ?? "").trim();
      if (live === expectedPreview.trim()) {
        pass(`Workers Builds non_production_deploy_command matches infra.json (${JSON.stringify(live)})`);
      } else {
        // Name the CONSEQUENCE of this particular difference. "the strings
        // differ" sends whoever reads it back to diffing two long commands by
        // eye, and the two differences that matter have very different stakes.
        const missing = ["--x-provision=false", "--x-auto-create=false"].filter((f) => !live.includes(f));
        const why = missing.length
          ? `it is missing ${missing.join(" and ")}, so a push to ANY branch publishes with resource creation ON`
          : !/\bversions upload\b/.test(live)
            ? `it is not a \`versions upload\`, so a branch build would take production traffic on push`
            : `the commands differ in some other way, and the dashboard is what actually runs`;
        fail(`Workers Builds non_production_deploy_command is ${JSON.stringify(live)} but infra.json declares ${JSON.stringify(expectedPreview)} — ${why}. The dashboard is the live value, so fix it there`);
      }
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

  // Version affinity: the Transform Rule that keeps one visitor on one Worker
  // version for the length of a ramp.
  //
  // ZONE-scoped, which makes it the first thing in this tier the account-scoped
  // CI token cannot reach. It needs Zone:Zone:Read to resolve the id and
  // Zone:Transform Rules:Read to read the phase, neither of which is among the
  // six reads CI carries, so IN CI THIS ALWAYS DEGRADES TO A NOTE. That is the
  // same standing as repository.code_scanning: the assertion runs on a
  // workstation and CI reports one advisory naming what it could not read.
  //
  // Worth a section anyway, because the rule is invisible from inside this repo
  // and its absence is silent. Nothing errors when affinity is off. The next
  // ramp that changes a shell asset simply serves part of the audience an
  // unstyled page for the length of the canary, and the release still reports
  // success, because every sampled document came back 200 and the assets that
  // 404ed were never sampled. The arithmetic is in infra.json under
  // zone.version_affinity.
  await section("version affinity", "Zone:Transform Rules:Read and Zone:Zone:Read", async () => {
    const declared = infra.zone?.version_affinity;
    if (!declared) return;

    const zones = await cf(token, `/zones?name=${encodeURIComponent(infra.zone.name)}`);
    const zoneId = zones?.[0]?.id;
    if (!zoneId) {
      warn(`version affinity unchecked: this token sees no zone named ${infra.zone.name}`);
      return;
    }

    let ruleset;
    try {
      ruleset = await cf(token, `/zones/${zoneId}/rulesets/phases/${declared.phase}/entrypoint`);
    } catch (e) {
      // A 404 on the phase entrypoint is NOT "could not check". It is the phase
      // holding no ruleset at all, which is a definite statement that the rule
      // is absent. Anything else is a genuine read failure and belongs to
      // section()'s handling, so rethrow it.
      if (!/\b404\b/.test(e.message)) throw e;
      fail(`no ${declared.phase} ruleset on ${infra.zone.name}, so nothing sets ${declared.header}. ${declared.why}`);
      return;
    }

    const wanted = declared.header.toLowerCase();
    const rule = (ruleset.rules || []).find((r) =>
      Object.keys(r?.action_parameters?.headers || {}).some((h) => h.toLowerCase() === wanted));
    if (!rule) {
      fail(`no Transform Rule on ${infra.zone.name} sets ${declared.header}. ${declared.why}`);
      return;
    }

    // A DISABLED rule is the quietest way for this to be gone: it survives every
    // listing, reads as configured to anyone glancing at the dashboard, and does
    // nothing. Check it before the values, which are meaningless while it is off.
    if (rule.enabled === false) {
      fail(`the ${declared.header} Transform Rule exists on ${infra.zone.name} but is DISABLED, so ramps run without version affinity. ${declared.why}`);
      return;
    }

    const entry = Object.entries(rule.action_parameters.headers).find(([h]) => h.toLowerCase() === wanted)[1];

    // "Set dynamic" comes back as an `expression`; "Set static" comes back as a
    // `value`. The difference is not cosmetic here: a static key is the SAME key
    // for every visitor on earth, which hashes to one version and puts 100% of
    // traffic on one side of a split that reports itself as 10%. That is worse
    // than having no affinity at all, so it gets its own failure.
    if (entry.value !== undefined && entry.expression === undefined) {
      fail(`${declared.header} is set STATICALLY to ${JSON.stringify(entry.value)} on ${infra.zone.name}, so every visitor shares one affinity key and a ramp puts all traffic on one version regardless of the percentages. It must be "Set dynamic" with ${JSON.stringify(declared.value)}`);
      return;
    }
    if (String(entry.expression || "").trim() !== String(declared.value).trim()) {
      fail(`${declared.header} is derived from ${JSON.stringify(entry.expression)} but infra.json declares ${JSON.stringify(declared.value)}. The dashboard is the live value, so fix it there`);
      return;
    }

    // The rule's own filter expression, checked for the ONE property that
    // matters rather than string-equal against the declaration. Cloudflare
    // normalizes expressions, so a textual diff would false-fire on formatting;
    // what has to hold is that the rule SKIPS a request that already carries the
    // header. deploy-promote.mjs sends one key per request so it can still watch
    // the split take from a single IP, and a rule that overwrites those keys
    // collapses every sample onto one version, which the ramp reads as dead and
    // aborts on. Fails closed, and loudly, but it aborts healthy releases.
    if (!String(rule.expression || "").toLowerCase().includes(wanted)) {
      fail(`the ${declared.header} rule matches on ${JSON.stringify(rule.expression)}, which does not exempt requests that already carry the header. It will overwrite the per-request keys deploy:promote sends, and every ramp step will read as "the ramp did not take". infra.json declares: ${declared.expression}`);
      return;
    }

    pass(`version affinity: ${declared.header} set dynamically from ${declared.value}, client-supplied keys exempted`);
  });
}

// ----------------------------------------------------- tier: repository ----

// GitHub repository rulesets, the BRANCH half of the release model. Same class
// as the Workers Builds block: dashboard state no config in this repo can
// derive, load-bearing for what may reach production, and silent when it drifts.
//
// NO CREDENTIAL, because the repo is public and the rulesets endpoint is public
// with it. That is what puts this beside the DNS tier rather than behind a token
// like the account tier. GITHUB_TOKEN, when present, buys rate-limit headroom
// alone (60/hr unauthenticated per IP, which shared Actions runners do exhaust)
// and grants nothing this needs.
//
// Anything we could not READ is an advisory, so GitHub being down cannot redden
// a PR that only touched CSS. Anything we read and found wrong is fatal.
async function ghFetch(path, token) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": BOT_UA,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, {
    headers,
    signal: AbortSignal.timeout(12000),
  });
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    throw new Error(
      remaining === "0"
        ? "GitHub API rate limit exhausted (set GITHUB_TOKEN for headroom)"
        : `GitHub API returned HTTP ${res.status}`,
    );
  }
  if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status} for ${path}`);
  return res.json();
}

async function checkRepo(infra) {
  const repo = infra.repository;
  if (!repo) return;
  const slug = `${repo.owner}/${repo.name}`;
  const token = process.env.GITHUB_TOKEN;

  let meta, live;
  try {
    meta = await ghFetch(`/repos/${slug}`, token);
    live = await ghFetch(`/repos/${slug}/rulesets`, token);
  } catch (e) {
    warn(`repository rulesets could not be read: ${e.message}`);
    return;
  }

  // Visibility first, and as a PRECONDITION rather than a preference: rulesets
  // on a private repo need a paid plan, so a flip back to private silently
  // takes every rule below with it. Failing here names the cause; failing on
  // four missing rules would not.
  if (meta.visibility !== repo.visibility) {
    fail(
      `${slug} is ${JSON.stringify(meta.visibility)} but infra.json declares ${JSON.stringify(repo.visibility)}: rulesets need a paid plan on a private repo, so every branch rule below this line may have gone dark with it`,
    );
    return;
  }

  const byName = new Map(live.map((r) => [r.name, r]));
  for (const want of repo.rulesets) {
    const found = byName.get(want.name);
    byName.delete(want.name);
    if (!found) {
      fail(`${slug} has no ruleset named ${JSON.stringify(want.name)}: the ${want.name} branch is unprotected`);
      continue;
    }

    let detail;
    try {
      detail = await ghFetch(`/repos/${slug}/rulesets/${found.id}`, token);
    } catch (e) {
      warn(`ruleset ${want.name} could not be read in full: ${e.message}`);
      continue;
    }

    const at = `ruleset ${want.name}`;
    if (detail.enforcement !== want.enforcement) {
      fail(
        `${at} is ${JSON.stringify(detail.enforcement)}, declared ${JSON.stringify(want.enforcement)}. If this is the deliberate disable for an infra:check deadlock, flip it back (CLAUDE.md, "Branch protection sharpened this")`,
      );
    }

    // Checked as EMPTY, never against a declared list. A list would invite
    // somebody to add an entry here to turn a red check green, which is exactly
    // the change the check exists to catch: every push in this repo carries the
    // OWNER's credentials, so "bypass for repository admins" exempts precisely
    // the actors the rule is aimed at.
    if (detail.bypass_actors?.length) {
      const who = detail.bypass_actors.map((a) => `${a.actor_type}#${a.actor_id} (${a.bypass_mode})`).join(", ");
      fail(`${at} has ${detail.bypass_actors.length} bypass actor(s): ${who}. Every push here uses the owner's credentials, so a bypass exempts the actors the rule is for`);
    }

    const include = detail.conditions?.ref_name?.include || [];
    if (want.include && include.join(",") !== want.include.join(",")) {
      fail(`${at} covers ${JSON.stringify(include)}, declared ${JSON.stringify(want.include)}`);
    }

    const types = new Set(detail.rules.map((r) => r.type));
    const missing = want.rules.filter((r) => !types.has(r));
    if (missing.length) fail(`${at} lost rule(s) ${missing.join(", ")}`);
    const extra = detail.rules.map((r) => r.type).filter((t) => !want.rules.includes(t));
    if (extra.length) warn(`${at} carries undeclared rule(s) ${extra.join(", ")}: stricter than declared, but declare them so this file stays the source of truth`);

    // A forbidden rule is not an oversight in the declaration. `production`
    // must carry no pull_request rule, because promote-production.yml moves
    // that ref directly and a PR requirement would break the release path.
    for (const banned of want.forbidden_rules || []) {
      if (types.has(banned)) fail(`${at} gained a ${banned} rule, which it must not have. ${want.why}`);
    }

    const rule = (t) => detail.rules.find((r) => r.type === t)?.parameters || {};

    if (want.required_approving_review_count !== undefined && types.has("pull_request")) {
      const got = rule("pull_request").required_approving_review_count;
      if (got !== want.required_approving_review_count) {
        fail(`${at} requires ${got} approving review(s), declared ${want.required_approving_review_count}. GitHub refuses to let anyone approve their own PR, so a solo repo above 0 can never merge`);
      }
    }

    if (want.required_status_checks && types.has("required_status_checks")) {
      const params = rule("required_status_checks");
      const got = params.required_status_checks || [];
      for (const req of want.required_status_checks) {
        const hit = got.find((c) => c.context === req.context);
        if (!hit) fail(`${at} no longer requires the ${JSON.stringify(req.context)} check`);
        else if (hit.integration_id !== req.integration_id) {
          fail(`${at}'s ${JSON.stringify(req.context)} check is pinned to integration_id ${hit.integration_id}, declared ${req.integration_id}. Unpinned, any caller of the commit-status API could satisfy it`);
        }
      }
      if (params.strict_required_status_checks_policy !== want.strict_required_status_checks_policy) {
        fail(`${at}'s strict_required_status_checks_policy is ${params.strict_required_status_checks_policy}, declared ${want.strict_required_status_checks_policy}. Strict makes every Dependabot PR churn a rebase on each unrelated merge`);
      }
    }
  }

  for (const stray of byName.keys()) {
    warn(`${slug} carries an undeclared ruleset ${JSON.stringify(stray)}: add it to infra.json's repository block or delete it`);
  }

  pass(`${slug} is ${meta.visibility} and its ${repo.rulesets.length} declared ruleset(s) match, with no bypass actors${token ? "" : " (unauthenticated read)"}`);

  await checkCodeScanning(repo, slug, token);
}

// CodeQL default setup, declared for the same reason the rulesets are: it is a
// curated decision living in a dashboard, and #241 recorded the language list
// plus the cost argument for it in MAINTENANCE.md while noting infra:check
// could not see it.
//
// WORKSTATION-ONLY, and that is structural rather than a missing setting.
// The endpoint needs the repository **Administration** permission (read), which
// is NOT one of the keys a workflow may grant its GITHUB_TOKEN: the whole list
// is actions, artifact-metadata, attestations, checks, code-quality, contents,
// deployments, discussions, id-token, issues, models, packages, pages,
// pull-requests, repository-projects, security-events and statuses. So no
// `permissions:` block can turn this on in CI, and `security-events: read` in
// particular does nothing here (tried on 2026-08-07: still HTTP 403).
//
// This is the mirror image of the Workers Builds case, where a Read variant of
// the permission existed and made the check possible without widening anything.
// Here the only credential that can read it is a classic PAT with `repo`, which
// is precisely the kind of broad standing credential this repo keeps out of CI.
// So the check runs where the owner runs it, and CI says plainly that it cannot.
async function checkCodeScanning(repo, slug, token) {
  const want = repo.code_scanning;
  if (!want) return;

  let live;
  try {
    live = await ghFetch(`/repos/${slug}/code-scanning/default-setup`, token);
  } catch (e) {
    warn(
      /401|403/.test(e.message)
        ? `CodeQL default setup: not verifiable here, the endpoint needs the repository Administration permission and no GITHUB_TOKEN can hold it. Run \`GITHUB_TOKEN=$(gh auth token) pnpm run infra:check\` on a workstation (any credential with the \`repo\` scope; being logged in is not enough, the script reads GITHUB_TOKEN) to assert it (${e.message})`
        : `CodeQL default setup could not be read: ${e.message}`,
    );
    return;
  }

  // state first. A scanner that is simply off reports nothing, which reads
  // exactly like a clean scan, so every field below is moot if this drifted.
  if (live.state !== want.state) {
    fail(`CodeQL default setup is ${JSON.stringify(live.state)}, declared ${JSON.stringify(want.state)}. A disabled scanner reports no findings, which looks identical to a clean scan`);
    return;
  }

  // The curated list. Compared as a SET, because the API's ordering is not a
  // documented guarantee and reordering is not drift worth failing on.
  const got = [...(live.languages || [])].sort();
  const declared = [...want.languages].sort();
  if (got.join(",") !== declared.join(",")) {
    const added = got.filter((l) => !declared.includes(l));
    const dropped = declared.filter((l) => !got.includes(l));
    const parts = [];
    if (added.length) parts.push(`gained ${added.join(", ")}`);
    if (dropped.length) parts.push(`lost ${dropped.join(", ")}`);
    fail(`CodeQL default setup ${parts.join(" and ")} (live ${got.join(", ")}); #241 curated this list, so re-read MAINTENANCE.md before widening it`);
  }

  // threat_model is what makes the language argument valid: `remote` is why
  // build tooling that never answers a request is safely out of scope.
  if (live.threat_model !== want.threat_model) {
    fail(`CodeQL threat_model is ${JSON.stringify(live.threat_model)}, declared ${JSON.stringify(want.threat_model)}. MAINTENANCE.md argues rust and python are droppable BECAUSE the model is remote, so this change invalidates that reasoning`);
  }

  if (live.query_suite !== want.query_suite) {
    fail(`CodeQL query_suite is ${JSON.stringify(live.query_suite)}, declared ${JSON.stringify(want.query_suite)}`);
  }

  pass(`CodeQL default setup matches: ${got.length} languages (${got.join(", ")}), ${live.query_suite} suite, ${live.threat_model} threat model`);
}

// ------------------------------------------- tier: agent markdown surface ----

// Which pages answer an agent in Markdown, measured on the wire rather than inferred
// from filenames. The twins arrive by three different conventions — /index.md for the
// homepage, www/md/<name>.md for /whoareyou and /bot, build-generated twins for
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
    ({ surfaces } = JSON.parse(await readFile(join(ROOT, "config/site-manifest.json"), "utf8")));
  } catch (e) {
    warn(`agent markdown coverage could not run: ${e.message}`);
    return;
  }
  const pages = surfaces.filter((s) => s.kind === "page" && s.flags?.agents);
  const gaps = [];
  for (const p of pages) {
    try {
      // redirect: "manual". Following one made this probe report the DESTINATION's
      // content-type as the site's, and it named the wrong defect for a full
      // release: /rn was a bare 302 to Spotify, so the advisory read "/rn
      // (text/html)" and sent a reader looking for a page that does not exist.
      // A redirect is its own gap and says so, since an agent that follows one
      // off-origin has left the surface the registry advertised.
      const res = await fetchEdge(`${infra.edge.origin}${p.path}`, { accept: "text/markdown" }, { redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        gaps.push(`${p.path} (${res.status} to ${res.headers.get("location") || "?"})`);
        continue;
      }
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

const infra = JSON.parse(await readFile(join(ROOT, "config/infra.json"), "utf8"));
const wrangler = await readJsonc("wrangler.jsonc");
const lweConfig = await readFile(join(ROOT, "lwe-ask/wrangler.toml"), "utf8");

await checkTree(infra, wrangler, lweConfig);

if (OFFLINE) {
  warn("--offline: skipped the DNS and API tiers");
} else {
  await checkDns(infra);
  await checkEdge(infra);
  await checkRepo(infra);
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
