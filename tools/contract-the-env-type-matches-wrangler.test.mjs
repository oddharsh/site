// ── the Env type matches wrangler.jsonc ─────────────────────────────
// Shared imports live in contract-shared.ts.
import {
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

// src/worker/lib/env.ts is a DECLARATION of the Worker's binding surface, and a
// declaration nothing diffs is a comment with extra syntax. This is the diff.
// Same argument infra.json makes about dashboard state, one layer down: the
// authority is wrangler.jsonc, the readable copy is the type, and drift in
// EITHER direction is a failure.
//
// The two directions catch different bugs and both have happened here. A
// binding in wrangler.jsonc with no member is a binding no handler can read
// without an `any` cast, which is the state this type was written to end. A
// member with no binding is worse: it type-checks every read of something that
// will be `undefined` at runtime, which is precisely the wrangler.jsonc
// `secrets` comment naming EXA_API_KEY and PARALLEL_API_KEY while nothing set
// or read either.
//
// COMMENTS ARE STRIPPED BEFORE ANY MEMBER IS READ, and that is not a
// precaution. env.ts documents bindings in prose that is shaped exactly like a
// member: `` `aadhar-photos`: the SOOC originals `` and `SLOT_MINUTES is "30"``
// both match a line-anchored /^\s*(\w+)\??:/, so the naive scanner reports
// members that are sentences. Every naive scanner this repo has written over
// its own source has been caught the same way, by content that looks like
// syntax: the CSP attribute scanner read a demo XSS payload as an event
// handler, the link scanner read 33 of 2645 refs because minify-html unquotes
// attributes.
//
// THE TYPESCRIPT COMPILER IS NOT AVAILABLE FOR THIS, which is worth knowing
// before anyone rewrites the scanner to use it. This repo pins TypeScript
// 7.0.2, the Go port, and its JS entry exports exactly two things: measured
// here, `Object.keys(require("typescript"))` is `["version",
// "versionMajorMinor"]`. There is no createSourceFile, no ScriptTarget, no AST.
// That is the same limit CLAUDE.md records as the reason typescript-eslint
// cannot run here and the type-aware lint rules go through tsgolint instead;
// it reaches source-reading tests too. So the scanner below is hand-rolled, in
// the same depth-counting idiom the `new Response(` scanner already uses, and
// it carries FLOORS because a scanner that quietly stops matching is how a set
// comparison passes over a file it never read.

const ENV_TS = "src/worker/lib/env.ts";
const WRANGLER = "wrangler.jsonc";

// The four wrangler.jsonc shapes that declare a binding, since the key naming
// the binding is not the same one in each. Anything not listed here is not a
// binding (build config, routes, observability, compatibility flags).
const BINDING_SOURCES = [
  { key: "kv_namespaces", name: "binding" },
  { key: "r2_buckets", name: "binding" },
  { key: "d1_databases", name: "binding" },
  { key: "analytics_engine_datasets", name: "binding" },
  { key: "ratelimits", name: "name" },
  { key: "workflows", name: "binding" },
];

// Drop every comment and the inside of every string, so nothing prose-shaped
// survives to be read as a member. Quote handling is here only to stop a `//`
// or `/*` inside a string literal from eating the rest of the file.
function stripComments(src) {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && d === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === "\\") i++;
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

// Members of one interface body, read only at brace/paren depth 0 so a nested
// object or function type cannot contribute one.
function bodyMembers(body) {
  const found = [];
  let depth = 0, lineStart = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[") { depth++; lineStart = false; continue; }
    if (c === "}" || c === ")" || c === "]") { depth--; lineStart = false; continue; }
    if (c === "\n") { lineStart = true; continue; }
    if (c === " " || c === "\t") continue;
    if (lineStart && depth === 0) {
      const m = /^([A-Za-z_$][\w$]*)(\??)\s*:/.exec(body.slice(i));
      if (m) found.push({ name: m[1], optional: m[2] === "?" });
    }
    lineStart = false;
  }
  return found;
}

async function members() {
  const src = stripComments(readFileSync(ENV_TS, "utf8"));
  const byInterface = new Map();
  const re = /\binterface\s+([A-Za-z0-9_$]+)[^{]*\{/g;
  for (let m; (m = re.exec(src)); ) {
    const open = m.index + m[0].length;
    let depth = 1, j = open;
    for (; j < src.length && depth > 0; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
    }
    if (depth !== 0) continue;
    byInterface.set(m[1], bodyMembers(src.slice(open, j - 1)));
  }
  return byInterface;
}

async function wranglerBindings() {
  const { parseJsonc } = await import("./lib/jsonc.ts");
  const cfg = parseJsonc(readFileSync(WRANGLER, "utf8"));
  const names = new Set();

  for (const { key, name } of BINDING_SOURCES) {
    for (const entry of cfg[key] ?? []) names.add(entry[name]);
  }
  // The five singletons, each declared as its own object rather than in a list.
  for (const key of ["assets", "browser", "images", "version_metadata"]) {
    if (cfg[key]?.binding) names.add(cfg[key].binding);
  }
  for (const c of cfg.durable_objects?.bindings ?? []) names.add(c.name);

  return { names, cfg };
}

test("every wrangler.jsonc binding, var and required secret has an Env member, and vice versa", async () => {
  const byInterface = await members();
  const { names: declared, cfg } = await wranglerBindings();

  // FLOORS FIRST. Every assertion below is a set comparison, and two empty sets
  // agree perfectly. A parser that silently stops finding anything is how this
  // check reports a pass over a file it never read, which is the failure the
  // guard scanners in tools:check carry floors for.
  assert.ok(byInterface.size >= 5, `env.ts parsed to ${byInterface.size} interfaces — the parse broke, not the file`);
  const total = [...byInterface.values()].reduce((n, ms) => n + ms.length, 0);
  assert.ok(total >= 50, `env.ts parsed to ${total} members across ${byInterface.size} interfaces — the parse broke`);
  assert.ok(declared.size >= 20, `wrangler.jsonc parsed to ${declared.size} bindings — the parse broke`);

  const tier = (n) => new Set((byInterface.get(n) ?? []).map((m) => m.name));
  const bindings = tier("EnvBindings");
  const vars = tier("EnvVars");
  const secrets = tier("EnvSecrets");

  // Tier 1, both directions.
  for (const name of declared) {
    assert.ok(bindings.has(name), `wrangler.jsonc declares binding ${name}, EnvBindings has no member for it`);
  }
  for (const name of bindings) {
    assert.ok(declared.has(name), `EnvBindings declares ${name}, wrangler.jsonc has no such binding`);
  }

  // Tier 2 and tier 3, both directions.
  const declaredVars = new Set(Object.keys(cfg.vars ?? {}));
  assert.ok(declaredVars.size >= 10, `wrangler.jsonc parsed to ${declaredVars.size} vars — the parse broke`);
  assert.deepEqual([...vars].sort(), [...declaredVars].sort(), "EnvVars and wrangler.jsonc vars disagree");

  const declaredSecrets = new Set(cfg.secrets?.required ?? []);
  assert.ok(declaredSecrets.size >= 5, `wrangler.jsonc parsed to ${declaredSecrets.size} required secrets — the parse broke`);
  assert.deepEqual([...secrets].sort(), [...declaredSecrets].sort(), "EnvSecrets and wrangler.jsonc secrets.required disagree");
});

test("required Env members are non-optional and degrading ones are optional", async () => {
  const byInterface = await members();
  const required = ["EnvBindings", "EnvVars", "EnvSecrets"];
  const degrading = ["EnvOptionalSecrets", "EnvInjected"];

  // This is the assertion that carries the whole design. wrangler refuses to
  // publish a Worker missing a declared binding or a required secret, so tiers
  // 1 to 3 are guaranteed present and a `?` on one would make every reader
  // write a null check for a case that cannot happen. Tiers 4 and 5 are
  // genuinely absent in normal operation, and dropping a `?` there is the edit
  // that silently converts a documented degradation into an unchecked read.
  for (const name of required) {
    const ms = byInterface.get(name) ?? [];
    assert.ok(ms.length, `${name} parsed to no members`);
    const opt = ms.filter((m) => m.optional).map((m) => m.name);
    assert.deepEqual(opt, [], `${name} members are guaranteed by the deploy gate and must not be optional: ${opt.join(", ")}`);
  }
  for (const name of degrading) {
    const ms = byInterface.get(name) ?? [];
    assert.ok(ms.length, `${name} parsed to no members`);
    const req = ms.filter((m) => !m.optional).map((m) => m.name);
    assert.deepEqual(req, [], `${name} members are absent in normal operation and must stay optional: ${req.join(", ")}`);
  }
});

test("no degrading or injected Env member is declared in wrangler.jsonc", async () => {
  const byInterface = await members();
  const { names: declared, cfg } = await wranglerBindings();
  const configured = new Set([...declared, ...Object.keys(cfg.vars ?? {}), ...(cfg.secrets?.required ?? [])]);
  assert.ok(configured.size >= 20, `wrangler.jsonc parsed to ${configured.size} configured names — the parse broke`);

  // The tiers are only meaningful if they are disjoint. A name that reaches
  // both lists is one whose optionality now depends on which file you read, and
  // the compiler would believe the looser of the two. Promoting a degrading
  // secret to `secrets.required` is a real and expected change (wrangler.jsonc
  // says to make it the day one becomes load-bearing) — this fails until the
  // member moves tiers with it, which is the whole point.
  for (const iface of ["EnvOptionalSecrets", "EnvInjected"]) {
    for (const { name } of byInterface.get(iface) ?? []) {
      assert.ok(
        !configured.has(name),
        `${name} is in ${iface} but wrangler.jsonc configures it — promote it to the matching required tier`,
      );
    }
  }
});
