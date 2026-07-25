#!/usr/bin/env node
// The rebuild path: turn infra.json's declared DNS records back into reality.
//
// check-infra.mjs answers "did it drift". This answers "put it back". They are
// deliberately separate programs: the check runs on every PR and must never be
// able to write, so the write code does not live in the file CI executes.
//
// SCOPE is narrow on purpose (see infra.json's `apply` block for the full
// reasoning): DNS records whose `match` is `exact`, and nothing else. That is
// the exact set where infra.json knows the whole desired value. Records owned
// by someone else (Resend's DKIM, the Cloudflare-managed proxied apex) and
// resources owned by wrangler are excluded because recreating them from here
// would mean inventing values this file never captured.
//
// This is the layer with no other tooling. Wrangler can recreate a KV namespace
// and Workers Builds can redeploy the Worker, but nothing except this rebuilds
// the MX/SPF/DMARC/BIMI/SVCB set, which is also the set that carries mail. That
// is the whole reason it earns a write path.
//
//   node scripts/apply-infra.mjs              plan only, no credential needed
//   node scripts/apply-infra.mjs --confirm    apply (needs the write token)
//   node scripts/apply-infra.mjs --prune      also delete extras on declared names
//
// Refuses to run in CI. A write token in GitHub would undo the property the
// whole release design rests on: that GitHub cannot reach production.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../", import.meta.url).pathname;
const CONFIRM = process.argv.includes("--confirm");
const PRUNE = process.argv.includes("--prune");
const API = "https://api.cloudflare.com/client/v4";
const RRTYPE = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, DS: 43, SVCB: 64 };

const infra = JSON.parse(await readFile(join(ROOT, "infra.json"), "utf8"));
const policy = infra.apply;

// ------------------------------------------------------------- guardrails --

if (process.env.CI) {
  console.error("refusing to run in CI.");
  console.error("");
  console.error("Production is deliberately unreachable from GitHub: Workers Builds is the");
  console.error("only publisher, and CI holds a read-only token so it cannot become a second");
  console.error("one. A write token in CI would dissolve that. Run this from a workstation.");
  process.exit(1);
}

// ---------------------------------------------------------------- desired --

// Only `exact` records carry a complete declared value, so only they can be
// rebuilt. Everything else is reported as out-of-scope with its owner named,
// rather than silently omitted, so the plan is honest about what it will NOT fix.
const managed = infra.dns.filter((r) => r.match === "exact");
const unmanaged = infra.dns.filter((r) => r.match !== "exact");

const OWNER = {
  present: "owned elsewhere (value deliberately unpinned)",
  proxied: "created by Cloudflare with the Worker custom domain",
  sameAs: "created by Cloudflare with the Worker custom domain",
  contains: "generated and rotated by Cloudflare; only its parameters are ours",
};

// A match mode with no OWNER entry falls back to printing its own name, which
// reads as a category rather than a reason ("HTTPS aadhar.sh  contains"). That
// is how the HTTPS RR looked after the `contains` mode arrived in a later
// change than this map. Fail loudly instead, so the next new mode cannot
// quietly degrade the one list whose entire job is explaining what is skipped.
for (const mode of new Set(infra.dns.map((r) => r.match))) {
  if (mode !== "exact" && !OWNER[mode]) {
    console.error(`infra.json uses match mode ${JSON.stringify(mode)}, which has no owner explanation in apply-infra.mjs.`);
    console.error(`Add one to OWNER so the out-of-scope list says who owns those records instead of naming the mode.`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------- live --

// The plan reads live state over DoH, so producing a plan needs no credential
// at all. Only the write below needs a token.
async function liveAnswers(name, type) {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${RRTYPE[type]}`;
  const res = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`resolver returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.Status !== 0 && body.Status !== 3) throw new Error(`resolver returned DNS status ${body.Status}`);
  return (body.Answer || []).filter((a) => a.type === RRTYPE[type]).map((a) => normalize(type, a.data));
}

function normalize(type, data) {
  if (type === "TXT") {
    if (!data.startsWith('"')) return data.trim();
    return [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("").trim();
  }
  return data.trim();
}

// --------------------------------------------------------------- payloads --

// Cloudflare takes most types as a flat `content` string. SVCB is the exception:
// it wants the value split into priority / target / params. Build it explicitly
// so the plan can show exactly what would be sent, which matters more than usual
// here because this path cannot be exercised without a live write token.
function payload(record, value) {
  const name = record.name;
  const ttl = record.ttl ?? policy.default_ttl;
  if (record.type === "SVCB") {
    const [priority, target, ...params] = value.split(" ");
    return { type: "SVCB", name, ttl, data: { priority: Number(priority), target, value: params.join(" ") } };
  }
  if (record.type === "MX") {
    const [priority, ...rest] = value.split(" ");
    return { type: "MX", name, ttl, priority: Number(priority), content: rest.join(" ") };
  }
  return { type: record.type, name, ttl, content: value };
}

// ------------------------------------------------------------------- plan --

const create = [];
const update = [];
const prune = [];
const blocked = [];

for (const record of managed) {
  let live;
  try {
    live = await liveAnswers(record.name, record.type);
  } catch (e) {
    blocked.push(`${record.type} ${record.name}: could not read live state (${e.message})`);
    continue;
  }
  const want = new Set(record.expect);
  const have = new Set(live);

  for (const value of want) if (!have.has(value)) create.push({ record, value });
  for (const value of have) if (!want.has(value)) prune.push({ record, value });
}

// Cloudflare has no "replace this value" primitive for multi-value names; a
// changed TXT is a create plus a delete of the old one. Pair them up so the plan
// reads as the edit it actually is instead of two unrelated operations.
for (const c of [...create]) {
  const paired = prune.find((p) => p.record.name === c.record.name && p.record.type === c.record.type);
  if (paired && c.record.type === "TXT") {
    update.push({ record: c.record, from: paired.value, to: c.value });
    create.splice(create.indexOf(c), 1);
    prune.splice(prune.indexOf(paired), 1);
  }
}

// ------------------------------------------------------------------ print --

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
console.log(`plan for zone ${policy.zone}\n`);

if (!create.length && !update.length && !prune.length) {
  console.log("  nothing to do: every exact-matched record already matches its declaration");
} else {
  for (const { record, value } of create) {
    console.log(`  CREATE  ${record.type} ${record.name}`);
    console.log(`          ${value}`);
    console.log(`          ${JSON.stringify(payload(record, value))}`);
  }
  for (const { record, from, to } of update) {
    console.log(`  UPDATE  ${record.type} ${record.name}`);
    console.log(`          from: ${from}`);
    console.log(`          to:   ${to}`);
    console.log(`          ${JSON.stringify(payload(record, to))}`);
  }
  for (const { record, value } of prune) {
    console.log(`  ${PRUNE ? "DELETE" : "EXTRA "}  ${record.type} ${record.name}`);
    console.log(`          ${value}`);
    if (!PRUNE) console.log(`          (left alone; pass --prune to remove)`);
  }
}

if (blocked.length) {
  console.log("\n  could not plan:");
  for (const line of blocked) console.log(`    ${line}`);
}

console.log(`\n  out of scope (${plural(unmanaged.length, "record")}), by owner:`);
for (const r of unmanaged) {
  console.log(`    ${r.type.padEnd(5)} ${r.name.padEnd(32)} ${OWNER[r.match] || r.match}`);
}
console.log("    resources                                       wrangler creates KV/R2/D1; ids go in wrangler.jsonc");
console.log("    the Worker                                      Workers Builds is the only publisher");

// ----------------------------------------------------------------- apply ---

const pending = create.length + update.length + (PRUNE ? prune.length : 0);

if (!CONFIRM) {
  if (pending) console.log(`\n${plural(pending, "change")} pending. Re-run with --confirm to apply.`);
  process.exit(blocked.length ? 1 : 0);
}

if (!pending) {
  console.log("\nnothing to apply.");
  process.exit(0);
}

const token = process.env[policy.token.env];
if (!token) {
  console.error(`\n${policy.token.env} is unset. Needs: ${policy.token.scopes.join(", ")}.`);
  console.error(`Deliberately a different variable from the read-only token the check uses,`);
  console.error(`so a write token can never be picked up by the check path by accident.`);
  process.exit(1);
}

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error((body.errors || []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`);
  }
  return body.result;
}

const zones = await cf(`/zones?name=${encodeURIComponent(policy.zone)}`);
if (zones.length !== 1) {
  console.error(`\nexpected exactly one zone named ${policy.zone}, got ${zones.length}`);
  process.exit(1);
}
const zoneId = zones[0].id;
console.log(`\napplying to zone ${policy.zone} (${zoneId})\n`);

let done = 0;
const failed = [];

for (const { record, value } of create) {
  try {
    await cf(`/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(payload(record, value)) });
    console.log(`  created ${record.type} ${record.name}`);
    done++;
  } catch (e) { failed.push(`create ${record.type} ${record.name}: ${e.message}`); }
}

for (const { record, from, to } of update) {
  try {
    const existing = await cf(`/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`);
    const target = existing.find((r) => normalize(record.type, r.content) === from);
    if (!target) throw new Error(`no live record matching ${JSON.stringify(from)} to update`);
    await cf(`/zones/${zoneId}/dns_records/${target.id}`, { method: "PATCH", body: JSON.stringify(payload(record, to)) });
    console.log(`  updated ${record.type} ${record.name}`);
    done++;
  } catch (e) { failed.push(`update ${record.type} ${record.name}: ${e.message}`); }
}

if (PRUNE) {
  for (const { record, value } of prune) {
    try {
      const existing = await cf(`/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`);
      const target = existing.find((r) => normalize(record.type, r.content) === value);
      if (!target) throw new Error(`no live record matching ${JSON.stringify(value)} to delete`);
      await cf(`/zones/${zoneId}/dns_records/${target.id}`, { method: "DELETE" });
      console.log(`  deleted ${record.type} ${record.name}`);
      done++;
    } catch (e) { failed.push(`delete ${record.type} ${record.name}: ${e.message}`); }
  }
}

console.log(`\n${plural(done, "change")} applied.`);
if (failed.length) {
  console.error(`\n${plural(failed.length, "failure")}:`);
  for (const line of failed) console.error(`  - ${line}`);
  process.exit(1);
}
console.log("Run `npm run infra:check` to confirm the zone now matches the declaration.");
