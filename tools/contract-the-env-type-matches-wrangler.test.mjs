// ── the Env type matches cloudflare.config.ts ─────────────────────────────
// Shared imports live in contract-shared.ts.
import {
  configText,
  assert,
  readFileSync,
  test,
} from "./contract-shared.ts";

// Bun's checker supplies diagnostics and file discovery, but exposes no AST
// API. The scanner below therefore keeps its depth-counting implementation
// and floors, which detect a source scan that quietly stops matching.

const ENV_TS = "src/worker/lib/env.ts";
const WRANGLER = "cloudflare.config.ts";

const BINDING_SOURCES = [
  { key: "kv_namespaces", name: "binding" },
  { key: "r2_buckets", name: "binding" },
  { key: "d1_databases", name: "binding" },
  { key: "analytics_engine_datasets", name: "binding" },
  { key: "ratelimits", name: "name" },
  { key: "workflows", name: "binding" },
];

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
  const cfg = parseJsonc(await configText(WRANGLER));
  const names = new Set();

  for (const { key, name } of BINDING_SOURCES) {
    for (const entry of cfg[key] ?? []) names.add(entry[name]);
  }
  for (const key of ["assets", "browser", "images", "ai", "analytics", "version_metadata"]) {
    if (cfg[key]?.binding) names.add(cfg[key].binding);
  }
  for (const c of cfg.durable_objects?.bindings ?? []) names.add(c.name);

  return { names, cfg };
}

test("every site config binding, var and required secret has an Env member, and vice versa", async () => {
  const byInterface = await members();
  const { names: declared, cfg } = await wranglerBindings();

  assert.ok(byInterface.size >= 5, `env.ts parsed to ${byInterface.size} interfaces — the parse broke, not the file`);
  const total = [...byInterface.values()].reduce((n, ms) => n + ms.length, 0);
  assert.ok(total >= 50, `env.ts parsed to ${total} members across ${byInterface.size} interfaces — the parse broke`);
  assert.ok(declared.size >= 20, `cloudflare.config.ts parsed to ${declared.size} bindings — the parse broke`);

  const tier = (n) => new Set((byInterface.get(n) ?? []).map((m) => m.name));
  const bindings = tier("EnvBindings");
  const vars = tier("EnvVars");
  const secrets = tier("EnvSecrets");

  for (const name of declared) {
    assert.ok(bindings.has(name), `cloudflare.config.ts declares binding ${name}, EnvBindings has no member for it`);
  }
  for (const name of bindings) {
    assert.ok(declared.has(name), `EnvBindings declares ${name}, cloudflare.config.ts has no such binding`);
  }

  const declaredVars = new Set(Object.keys(cfg.vars ?? {}));
  assert.ok(declaredVars.size >= 10, `cloudflare.config.ts parsed to ${declaredVars.size} vars — the parse broke`);
  assert.deepEqual([...vars].sort(), [...declaredVars].sort(), "EnvVars and cloudflare.config.ts vars disagree");

  const declaredSecrets = new Set(cfg.secrets?.required ?? []);
  assert.ok(declaredSecrets.size >= 5, `cloudflare.config.ts parsed to ${declaredSecrets.size} required secrets — the parse broke`);
  assert.deepEqual([...secrets].sort(), [...declaredSecrets].sort(), "EnvSecrets and cloudflare.config.ts secrets.required disagree");
});

test("required Env members are non-optional and degrading ones are optional", async () => {
  const byInterface = await members();
  const required = ["EnvBindings", "EnvVars", "EnvSecrets"];
  const degrading = ["EnvOptionalSecrets", "EnvInjected"];

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

test("no degrading or injected Env member is declared in the site config", async () => {
  const byInterface = await members();
  const { names: declared, cfg } = await wranglerBindings();
  const configured = new Set([...declared, ...Object.keys(cfg.vars ?? {}), ...(cfg.secrets?.required ?? [])]);
  assert.ok(configured.size >= 20, `the site config parsed to ${configured.size} configured names — the parse broke`);

  for (const iface of ["EnvOptionalSecrets", "EnvInjected"]) {
    for (const { name } of byInterface.get(iface) ?? []) {
      assert.ok(
        !configured.has(name),
        `${name} is in ${iface} but cloudflare.config.ts configures it — promote it to the matching required tier`,
      );
    }
  }
});
