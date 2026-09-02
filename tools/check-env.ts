#!/usr/bin/env bun
// check-env.ts — src/worker/lib/env.ts agrees with wrangler.jsonc, in both
// directions, by NAME.
//
// env.ts is the site Worker's binding surface as one hand-written type, and
// its header explains why it is hand-written rather than generated: the
// required/optional split (tiers 4 and 5) is the part that buys something and
// is the part `wrangler types` cannot see. The cost of writing it by hand is
// that it can drift from the config it describes, silently, in both
// directions: a binding added to wrangler.jsonc and never typed is `undefined`
// at the first read with no diagnostic, and a binding removed from the config
// while its type survives lets code read a thing wrangler no longer carries.
// env.ts's header promised a `bun run env:check` that diffs the two. This is
// it; it did not exist until 2026-09-02, and the header had described it for
// three weeks.
//
// WHAT IS COMPARED. Tiers 1 to 3 (bindings, vars, required secrets) must equal
// the config's declared set exactly. Tier 4 (degrading secrets) must be absent
// from `secrets.required`, because the whole point of a `?` there is that
// wrangler does NOT gate the deploy on it; a name in both places is a type that
// lies. Tier 5 (injected) must be absent from the config entirely, since those
// are spread in by callers and nothing in Cloudflare configuration adds them.
//
// BINDINGS ARE FOUND GENERICALLY, WITH TWO NAMED EXCEPTIONS. Most binding
// kinds (kv, r2, d1, analytics engine, browser, images, version metadata,
// assets, workflows) declare their name in a `binding` field, so the walk
// collects every string `binding` anywhere in the config rather than
// enumerating kinds, and a kind Cloudflare adds next month is covered the day
// it is declared here. Two kinds spell it `name` instead, measured against
// this config on 2026-09-02: `durable_objects.bindings[].name` and
// `ratelimits[].name`. Those two are read by path, because a generic walk over
// `name` would also collect `workflows[].name` (the workflow's own name, not
// its binding) and the Worker's `name`. `vars` keys and `secrets.required` are
// the other two sources. A floor on the count catches the walk finding nothing.
//
// env.ts is read as TEXT, not compiled: the tiers are the five exported
// interfaces, and a member line is `NAME: ...` or `NAME?: ...` at two-space
// indent. A floor on each tier catches the regex quietly matching nothing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lib/jsonc.ts";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const config = parseJsonc(readFileSync(join(REPO, "wrangler.jsonc"), "utf8"));
const envSource = readFileSync(join(REPO, "src/worker/lib/env.ts"), "utf8");

// ── what the config declares ─────────────────────────────────────────────
// A binding name is a non-empty string; anything else under that key (an
// object, a number, null) is a config error wrangler will refuse, not a name.
const asName = (v: unknown) => (String(v) === v && v.length ? v : null);
const bindings = new Set<string>();
(function walk(node: unknown) {
  if (Array.isArray(node)) { for (const n of node) walk(n); return; }
  if (node instanceof Object) {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const name = k === "binding" ? asName(v) : null;
      if (name) bindings.add(name);
      else walk(v);
    }
  }
})(config);
for (const b of config.durable_objects?.bindings ?? []) { const n = asName(b.name); if (n) bindings.add(n); }
for (const r of config.ratelimits ?? []) { const n = asName(r.name); if (n) bindings.add(n); }
const vars = new Set(Object.keys(config.vars ?? {}));
const required = new Set<string>(config.secrets?.required ?? []);
if (bindings.size < 20) fail(`the binding walk found only ${bindings.size} names in wrangler.jsonc; the config carried 30+ when this was written`);
if (vars.size < 5 || required.size < 5) fail(`vars (${vars.size}) or secrets.required (${required.size}) read as nearly empty`);

// ── what env.ts types ────────────────────────────────────────────────────
function tier(name: string, floor: number) {
  const m = envSource.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) fail(`env.ts no longer exports interface ${name}`);
  const names = [...m![1].matchAll(/^  ([A-Z][A-Z0-9_]*)\??:/gm)].map((x) => x[1]);
  if (names.length < floor) fail(`env.ts ${name} matched only ${names.length} member(s); the scanner is reading nothing`);
  return new Set(names);
}
const t1 = tier("EnvBindings", 20);
const t2 = tier("EnvVars", 5);
const t3 = tier("EnvSecrets", 5);
const t4 = tier("EnvOptionalSecrets", 3);
const t5 = tier("EnvInjected", 1);

// ── the comparison, both directions per tier ─────────────────────────────
const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).sort();
const problems: string[] = [];
const both = (label: string, typed: Set<string>, declared: Set<string>, where: string) => {
  for (const n of diff(declared, typed)) problems.push(`${n} is in wrangler.jsonc ${where} but not typed in env.ts ${label}`);
  for (const n of diff(typed, declared)) problems.push(`${n} is typed in env.ts ${label} but wrangler.jsonc ${where} does not declare it`);
};
both("EnvBindings", t1, bindings, "as a binding");
both("EnvVars", t2, vars, "vars");
both("EnvSecrets", t3, required, "secrets.required");
for (const n of [...t4].filter((x) => required.has(x))) problems.push(`${n} is optional in env.ts (EnvOptionalSecrets) but wrangler.jsonc gates the deploy on it in secrets.required: one of the two is wrong`);
for (const n of [...t5].filter((x) => bindings.has(x) || vars.has(x) || required.has(x))) problems.push(`${n} is typed as injected (EnvInjected) but wrangler.jsonc declares it`);
// A name typed in two tiers is a name whose optionality is ambiguous.
const all = [t1, t2, t3, t4, t5];
for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
  for (const n of [...all[i]].filter((x) => all[j].has(x))) problems.push(`${n} appears in two env.ts tiers`);

if (problems.length) {
  console.error(`env:check: env.ts and wrangler.jsonc disagree (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`env:check: env.ts agrees with wrangler.jsonc (${bindings.size} bindings, ${vars.size} vars, ${required.size} required secrets, ${t4.size} degrading, ${t5.size} injected)`);

function fail(msg: string): never {
  console.error(`env:check: ${msg}`);
  process.exit(1);
}
