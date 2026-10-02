// infra-compare.ts — the comparers behind `bun run infra:check`.
//
// One interface: a DECLARATION (a block of config/infra.json) plus an
// OBSERVATION (what a port read) go in, and a list of findings comes out. No
// function here fetches, reads a file, reads the environment, or prints. That
// is the seam tools/check-infra.ts used to lack: fetching, comparing and
// printing were one 2000-line script that ran on import, so the valuable part
// (declared state against observed state) could not be handed a recorded
// response, and the tests that covered it read its source text instead.
//
// The ports are in tools/lib/infra-ports.ts. Production has one adapter per
// port (DNS-over-HTTPS, the Cloudflare API, the GitHub API, the edge); the
// recorded fixtures in the contract suite are the second adapter, which is what
// makes the seam real rather than hypothetical.
//
// THREE LEVELS, and the split is this tool's doctrine (check-infra.ts header):
//
//   fail  "we checked and it is wrong"
//   warn  "we could not check": a resolver down, a 401, a missing scope
//   pass  "we checked and it matches"
//
// A FAILED READ IS AN OBSERVATION TOO. Every port hands back `Read<T>`, and the
// failed arm carries the error text. A comparer given one returns an advisory
// naming what could not be read. It never returns a pass, never a hard failure,
// and never treats the gap as an empty observation that compares clean. A
// missing observation is read the same way, so a port that forgot to ask reads
// as "could not check" rather than as agreement.
//
// MESSAGES ARE THE CONTRACT. Every string below moved here verbatim from
// check-infra.ts, and `infra:check --offline` prints byte-identical output
// before and after the move. Nothing here redacts: findings are plain data, and
// tools/lib/infra-report.ts redacts every message on the way into its store.

export type Level = "fail" | "warn" | "pass";
export type Finding = { level: Level; message: string };

/** What a port hands back: the value it read, or why it could not. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

export type Collector = {
  list: Finding[];
  fail: (message: string) => void;
  warn: (message: string) => void;
  pass: (message: string) => void;
  /** Whether THIS comparer found drift, which is what gates its summary line. */
  failed: () => boolean;
};

export function collector(): Collector {
  const list: Finding[] = [];
  return {
    list,
    fail: (message) => { list.push({ level: "fail", message }); },
    warn: (message) => { list.push({ level: "warn", message }); },
    pass: (message) => { list.push({ level: "pass", message }); },
    failed: () => list.some((f) => f.level === "fail"),
  };
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ----------------------------------------------------------- tier: tree ----

// The three auxiliary Workers, whose configs stopped being one format on
// 2026-08-23: cf-garage moved to wrangler's experimental TypeScript config,
// where the account pin is an `accountId` key on the default export (it sat on
// a separate `settings` export until workers-sdk#15713, 2026-09-21; the
// line-anchored regex below matched both) rather than a toml `account_id`.
// The pattern and the label travel WITH the path, so a
// fourth format joins by adding a row instead of by widening one regex until it
// matches every shape and asserts nothing about any of them.
export const AUX_CONFIGS = [
  { path: "cf-garage/cloudflare.config.ts", key: "accountId", pattern: /^\s*accountId:\s*"([^"]+)"/m },
  // lwe-ask and lens-reader joined cf-garage on 2026-09-28 (`cf migrate`), so all
  // three rows share one shape today. They stay three rows rather than a loop
  // over a directory list for the reason above: the next format is a row.
  { path: "lwe-ask/cloudflare.config.ts", key: "accountId", pattern: /^\s*accountId:\s*"([^"]+)"/m },
  { path: "lens-reader/cloudflare.config.ts", key: "accountId", pattern: /^\s*accountId:\s*"([^"]+)"/m },
  // aadhar-counter hosts the site's Counter Durable Object (CLAUDE.md, "Moving
  // Counter out"). It stays on JSONC deliberately: the transfer's lifecycle
  // states were rehearsed in that form, and the key is quoted there.
  { path: "counter/wrangler.jsonc", key: "account_id", pattern: /^\s*"account_id":\s*"([^"]+)"/m },
];

/** What the tree tier observed: the auxiliary configs' text, keyed by path,
 *  and which DNS-referenced files exist. Both are local reads. */
export type TreeObservation = {
  aux: Map<string, string>;
  presentConsumers: Set<string>;
};

export function compareBindings(infra, wrangler, aux: Map<string, string>): Finding[] {
  const out = collector();
  const lwe = aux.get("lwe-ask/cloudflare.config.ts") ?? "";
  // Binding names in infra.json must exist in the config that owns them. This
  // is the join that lets infra.json stay ID-free: cloudflare.config.ts remains the
  // single source for IDs, and this stops the two describing different worlds.
  const declared = new Map();
  for (const n of wrangler.kv_namespaces || []) declared.set(n.binding, { kind: "kv", id: n.id });
  for (const b of wrangler.r2_buckets || []) declared.set(b.binding, { kind: "r2", name: b.bucket_name });
  for (const d of wrangler.d1_databases || []) declared.set(d.binding, { kind: "d1", id: d.database_id, name: d.database_name });
  // The binding NAME is the env key and the index is `name:` on the helper,
  // since lwe-ask moved to cloudflare.config.ts (2026-09-28). A match that stops
  // finding it reports the binding as unbound below, so a format change fails
  // loudly rather than skipping the join.
  const vectorize = lwe.match(/^\s*VECTORIZE:\s*bindings\.vectorize\(\{\s*name:\s*"([^"]+)"/m);
  if (vectorize) declared.set("VECTORIZE", { kind: "vectorize", name: vectorize[1] });

  const wanted = [
    ...(infra.resources.kv_namespaces || []).map((r) => [r.binding, "kv", r.title]),
    ...(infra.resources.r2_buckets || []).map((r) => [r.binding, "r2", r.bucket]),
    ...(infra.resources.d1_databases || []).map((r) => [r.binding, "d1", r.database]),
    ...(infra.resources.vectorize_indexes || []).map((r) => [r.binding, "vectorize", r.index]),
  ];

  for (const [binding, kind, label] of wanted) {
    const found = declared.get(binding);
    if (!found) { out.fail(`infra.json declares binding ${binding} (${kind} ${label}) that no Wrangler config binds`); continue; }
    if (found.kind !== kind) { out.fail(`binding ${binding} is ${kind} in infra.json but ${found.kind} in the Wrangler config`); continue; }
    if (found.name && label && found.name !== label) {
      out.fail(`binding ${binding} names ${JSON.stringify(label)} in infra.json but ${JSON.stringify(found.name)} in the Wrangler config`);
    }
  }
  out.pass(`${wanted.length} declared bindings line up with the Wrangler configs`);
  return out.list;
}

// The point of the `consumer` field: a DNS record that points at a file in
// this tree makes that file load-bearing, even though nothing here links it.
export function compareConsumers(dns, presentConsumers: Set<string>): Finding[] {
  const out = collector();
  let consumers = 0;
  for (const record of dns) {
    if (!record.consumer) continue;
    consumers++;
    if (!presentConsumers.has(record.consumer)) {
      out.fail(`${record.consumer} is missing, but DNS ${record.type} ${record.name} points at it — deleting it breaks mail, not the site`);
    }
  }
  out.pass(`${consumers} DNS-referenced files present in the tree`);
  return out.list;
}

// The account pin. The site config must name the account infra.json
// declares, because wrangler only auto-selects while the login can see
// exactly one and that is not a property this repo controls — a second
// account appearing on the login is enough to break every non-interactive
// wrangler call at once (2026-08-07). Local dev needs the same pin (dev:remote
// reaches production bindings) and INHERITS it: config/dev/ spreads
// cloudflare.config.ts, so since 2026-10-01 there is no dev copy to check.
//
// cloudflare.config.ts's accountId is the SOURCE OF TRUTH and every copy below is
// compared against it, rather than against a copy in infra.json. That is this
// file's existing rule for resource ids, and it is why infra.json's account
// block declares the invariant without repeating the value.
export function compareAccountPins(infra, wrangler, aux: Map<string, string>): Finding[] {
  const out = collector();
  const declaredAccount = wrangler.account_id;
  if (!declaredAccount) {
    out.fail(`cloudflare.config.ts lost its accountId — wrangler picks an account by itself only while the login sees exactly one, so every non-interactive call fails the moment a second appears`);
    return out.list;
  }
  // TWO copies ship in the site config, not one: the deploy-time
  // `account_id` pin AND the runtime var CF_ACCOUNT_ID, which /ledger uses
  // to query this account's own Analytics Engine. The var predates the pin.
  // Check both against one declaration so the string cannot be half-updated:
  // an account_id and a CF_ACCOUNT_ID that disagree would deploy to one
  // account and read analytics from another, and both halves would look fine
  // on their own.
  //
  // Counted rather than assumed, so the ok line cannot claim everything is
  // pinned while one of these is the reason the run is failing.
  const sites = [
    ["cloudflare.config.ts env.CF_ACCOUNT_ID", wrangler.vars?.CF_ACCOUNT_ID, "/ledger reads this account's Analytics Engine through it"],
    ...AUX_CONFIGS.map(({ path, key, pattern }) => [
      `${path} ${key}`,
      ((aux.get(path) ?? "").match(pattern) || [])[1],
      "this Worker deploys from its own directory, so wrangler resolves the account from this file and never sees the root config",
    ]),
  ];
  // infra.json names the same five, so a copy added there without a check
  // here (or the reverse) is itself drift.
  const declared = infra.account?.must_agree || [];
  const named = sites.map(([where]) => where);
  if (declared.join("|") !== named.join("|")) {
    out.fail(`infra.json's account.must_agree (${JSON.stringify(declared)}) does not match what checkTree verifies (${JSON.stringify(named)})`);
  }
  let agreed = 0;
  for (const [where, value, why] of sites) {
    if (!value) {
      out.fail(`${where} is missing — ${why}`);
    } else if (value !== declaredAccount) {
      out.fail(`${where} (${JSON.stringify(value)}) disagrees with cloudflare.config.ts's accountId (${JSON.stringify(declaredAccount)})`);
    } else {
      agreed++;
    }
  }
  if (agreed === sites.length && sites.length === 6) {
    out.pass(`account ${declaredAccount} agrees across all 7 declarations (account_id + vars.CF_ACCOUNT_ID on both site configs, the account pin on all 3 auxiliary Workers)`);
  }
  return out.list;
}

// The two provisioning flags every publishing command must pin. Both default
// to TRUE and both let a publish create real KV/R2/D1 for any id-less binding,
// which is the one thing no deploy path here may do. One list, read by the
// tree tier (the declared string) and the API tier (the live dashboard value).
export const PROVISIONING_PINS = ["--x-provision=false", "--x-auto-create=false"];

// The release block against the site config. This is the TREE tier's half of
// the Workers Builds check: it reads the intent recorded in infra.json and
// runs with no credential on every PR. compareWorkersBuilds below reads the
// LIVE dashboard values, so a command that carries the flags here but lost
// them upstream is caught there. Keep both: this one fails on a branch that
// proposes a bad command, before anyone can paste it in.
export function compareReleaseDeclaration(release, wrangler): Finding[] {
  const out = collector();
  // The site Worker's name must match what the release config expects, or
  // Workers Builds refuses the build outright.
  if (wrangler.name !== release.worker) {
    out.fail(`cloudflare.config.ts names the Worker ${JSON.stringify(wrangler.name)} but infra.json's release block expects ${JSON.stringify(release.worker)}`);
  }
  if (release.build_command !== "") {
    out.fail(`infra.json's release.build_command must stay empty (wrangler.config.ts's build.command owns the build); got ${JSON.stringify(release.build_command)}`);
  }
  if (!wrangler.build?.command) {
    out.fail(`wrangler.config.ts lost its build.command — the deploy would ship the readable originals`);
  }
  // EVERY publishing command, from one list. The non-production command ran
  // bare until 2026-08-04 and this loop only read the production one, so a
  // push to any branch published with both flags at their default. The reason
  // it hid for so long is that the rule enumerated deploy paths in prose and a
  // branch build was not among the three it named. So iterate rather than name:
  // the next trigger Cloudflare adds gets checked by being added here, and the
  // failure names which command is loose instead of saying "the deploy command".
  const deployCmd = String(release.deploy_command || "");
  const previewCmd = String(release.non_production_deploy_command || "");
  const publishCommands = [
    ["deploy_command", deployCmd],
    // Optional: a repo that turns non-production branch builds off drops the
    // field entirely. An EMPTY string is that, and skipping it is right. A
    // MISSING pin on a present command is the bug this loop exists for.
    ...(previewCmd ? [["non_production_deploy_command", previewCmd]] : []),
  ];
  for (const [field, cmd] of publishCommands) {
    for (const flag of PROVISIONING_PINS) {
      if (!cmd.includes(flag)) {
        out.fail(`infra.json's release.${field} must pin ${flag} (it defaults to TRUE and would let a publish create resources); got ${JSON.stringify(cmd)}`);
      }
    }
    // Since 2026-09-28 the two commands have OPPOSITE jobs. Production deploys
    // at 100% (the ramp was deleted as overhead), while a branch build must only
    // UPLOAD: every push to every branch builds against production's bindings,
    // so a `deploy` there would hand a feature branch production traffic.
    if (field === "non_production_deploy_command" && !/\bversions upload\b/.test(cmd)) {
      out.fail(`infra.json's release.${field} must be a \`versions upload\` so a branch build never takes production traffic; got ${JSON.stringify(cmd)}`);
    }
    if (field === "deploy_command" && !/\bdeploy-wrangler\.sh deploy\b/.test(cmd)) {
      out.fail(`infra.json's release.${field} should be a \`deploy\`: nothing ramps an uploaded version any more, so a \`versions upload\` here ships nothing; got ${JSON.stringify(cmd)}`);
    }
  }
  // Preview URLs are what makes an uploaded version worth anything before it
  // serves. `preview_urls` defaults to `workers_dev`, which is false here, so
  // dropping the explicit line silently turns every preview back off.
  if (release.preview_urls !== wrangler.preview_urls) {
    out.fail(`infra.json's release.preview_urls (${release.preview_urls}) disagrees with cloudflare.config.ts's previewUrls (${wrangler.preview_urls}) — with workers_dev false, an unset value means OFF`);
  }
  out.pass(`release block agrees with cloudflare.config.ts (Worker ${wrangler.name}, build owned by Wrangler, production deploys and branches only upload, previews ${wrangler.preview_urls ? "on" : "off"})`);
  return out.list;
}

/** The config half of the tree tier, in the order check-infra prints it. */
export function compareTree(infra, wrangler, tree: TreeObservation): Finding[] {
  return [
    ...compareBindings(infra, wrangler, tree.aux),
    ...compareConsumers(infra.dns, tree.presentConsumers),
    ...compareAccountPins(infra, wrangler, tree.aux),
    ...compareReleaseDeclaration(infra.release, wrangler),
  ];
}

// ------------------------------------------------------------ tier: dns ----

// The two arms are DECLARED, and the `?: undefined` members on each are what
// make them narrow. A lookup is either an answer or an unreachable report, and
// callers separate them with `if (got.unreachable) … continue;`. Left to
// inference that guard narrows nothing, because neither property exists on the
// other arm.
export type DnsResolved = { answers: string[]; authenticated: boolean; resolver: string; unreachable?: undefined };
export type DnsUnreachable = { unreachable: string[]; answers?: undefined; authenticated?: undefined; resolver?: undefined };
export type DnsObservation = DnsResolved | DnsUnreachable;
export type DnsObservations = Map<string, DnsObservation>;

export const dnsKey = (name: string, type: string) => `${type} ${name}`;

/** Every lookup compareDns will ask for, so the port can answer them up front.
 *  `proxied` wants the AAAA beside the A, `sameAs` wants the baseline's A, and
 *  the zone identity wants NS and DS. Deduplicated, in first-use order. */
export function dnsQueries(infra): { name: string; type: string }[] {
  const seen = new Set<string>();
  const out: { name: string; type: string }[] = [];
  const want = (name: string, type: string) => {
    const key = dnsKey(name, type);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type });
  };
  for (const record of infra.dns) {
    want(record.name, record.type);
    if (record.match === "proxied") want(record.name, "AAAA");
    if (record.match === "sameAs") want(record.expect, "A");
  }
  want(infra.zone.name, "NS");
  want(infra.zone.name, "DS");
  return out;
}

export function compareDns(infra, observed: DnsObservations): Finding[] {
  const out = collector();
  // A lookup the port never made is "could not check", never "no records": an
  // empty answer list would read as a missing record and fail, and a silent
  // skip would read as agreement.
  const look = (name: string, type: string): DnsObservation =>
    observed.get(dnsKey(name, type)) ?? { unreachable: ["no observation was recorded for this lookup"] };

  for (const record of infra.dns) {
    const { name, type, match } = record;
    const got = look(name, type);
    if (got.unreachable) { out.warn(`could not resolve ${type} ${name} (${got.unreachable.join("; ")})`); continue; }

    // The zone is DNSSEC-signed, so an unauthenticated answer means either the
    // chain broke or something is answering that should not be.
    if (!got.authenticated) out.warn(`${type} ${name} resolved but was not DNSSEC-authenticated (AD flag unset via ${got.resolver})`);

    if (match === "exact") {
      const want = [...record.expect].sort(byCodeUnit);
      const same = want.length === got.answers.length && want.every((v, i) => v === got.answers[i]);
      if (same) out.pass(`${type} ${name} matches (${got.resolver})`);
      else out.fail(`${type} ${name} drifted\n      declared: ${want.join(" | ") || "(none)"}\n      live:     ${got.answers.join(" | ") || "(none)"}`);
    } else if (match === "present") {
      if (got.answers.length) out.pass(`${type} ${name} present (${got.answers.length} record${got.answers.length === 1 ? "" : "s"})`);
      else out.fail(`${type} ${name} is missing entirely — ${record.why?.split(".")[0] || "declared as required"}`);
    } else if (match === "contains") {
      // For records whose full value is Cloudflare's to rotate (the HTTPS RR's
      // ipv6hint moves, its ech= key rotates hourly) but whose PARAMETERS are
      // ours to insist on. Exact-matching would fail on every key rotation;
      // present-matching would miss the case that matters, a zone toggle
      // silently dropping a parameter out of an otherwise healthy record.
      const joined = got.answers.join(" ");
      const missing = record.expect.filter((needle) => !joined.includes(needle));
      if (!got.answers.length) out.fail(`${type} ${name} is missing entirely — ${record.why?.split(".")[0] || "declared as required"}`);
      else if (missing.length) out.fail(`${type} ${name} lost ${missing.map((m) => JSON.stringify(m)).join(", ")}\n      live: ${joined}`);
      else out.pass(`${type} ${name} carries ${record.expect.map((e) => JSON.stringify(e)).join(", ")}`);
    } else if (match === "proxied") {
      const v6 = look(name, "AAAA");
      if (!got.answers.length) out.fail(`${type} ${name} has no A records — the apex is not resolving`);
      else if (!v6.unreachable && !v6.answers.length) out.fail(`${name} has A records but no AAAA — the proxy should answer on both families`);
      else out.pass(`${name} proxied (${got.answers.length}x A, ${v6.answers?.length ?? "?"}x AAAA)`);
    } else if (match === "sameAs") {
      const base = look(record.expect, "A").answers;
      if (!base?.length) { out.warn(`could not compare ${name} against ${record.expect} (no baseline answers)`); continue; }
      const same = base.length === got.answers.length && base.every((v, i) => v === got.answers[i]);
      if (same) out.pass(`${name} resolves to the same edge as ${record.expect}`);
      else out.fail(`${name} no longer resolves to the same edge as ${record.expect}\n      ${record.expect}: ${base.join(" | ")}\n      ${name}: ${got.answers.join(" | ") || "(none)"}`);
    } else {
      out.fail(`infra.json: unknown match mode ${JSON.stringify(match)} on ${type} ${name}`);
    }
  }

  // Zone identity: nameservers and the DS the registrar publishes.
  const ns = look(infra.zone.name, "NS");
  if (ns.unreachable) out.warn(`could not resolve NS ${infra.zone.name}`);
  else {
    const want = [...infra.zone.nameservers].sort(byCodeUnit);
    const same = want.length === ns.answers.length && want.every((v, i) => v === ns.answers[i]);
    if (same) out.pass(`nameservers match (${want.join(", ")})`);
    else out.fail(`nameservers drifted\n      declared: ${want.join(" | ")}\n      live:     ${ns.answers.join(" | ")}`);
  }

  const ds = look(infra.zone.name, "DS");
  if (ds.unreachable) out.warn(`could not resolve DS ${infra.zone.name}`);
  else if (ds.answers.includes(infra.zone.dnssec.ds)) out.pass(`DNSSEC DS matches the registrar-published digest`);
  else out.fail(`DNSSEC DS drifted\n      declared: ${infra.zone.dnssec.ds}\n      live:     ${ds.answers.join(" | ") || "(none)"}`);

  return out.list;
}

// ----------------------------------------------------------- tier: edge ----

export type EarlyDataResult = { skip: string; accepted?: undefined; attempts?: undefined }
  | { accepted: boolean; attempts: number; skip?: undefined };

/** What the edge port saw for one declared check. The first two arms are the
 *  failed reads: a target that could not be resolved to a URL, and a request
 *  that never came back. */
export type EdgeObservation =
  | { kind: "no-target"; error: string }
  | { kind: "unreachable"; error: string }
  // One request per declared encoding, each offering exactly that encoding.
  | { kind: "compression"; got: Record<string, string> }
  // One request offering the full set a browser sends.
  | { kind: "prefers"; got: string }
  | { kind: "early-data"; result: EarlyDataResult }
  // Header names are lower-cased; `body` is present when the check reads it.
  | { kind: "response"; headers: Record<string, string>; body?: string };

export type EdgeOptions = {
  /** GITHUB_ACTIONS is set: a 0-RTT rejection is an advisory rather than a
   *  drift there, for the measured reason at the early-data arm below. */
  hostedRunner: boolean;
};

export function compareEdgeCheck(check, seen: EdgeObservation | undefined, opts: EdgeOptions): Finding[] {
  const out = collector();
  // Prefix findings so nobody reads a production drift as a regression in the
  // branch being reviewed.
  const drift = (m: string) => out.fail(`production edge: ${m}`);

  if (!seen) {
    out.warn(`edge check ${check.id} could not run: no observation was recorded for it`);
    return out.list;
  }
  if (seen.kind === "no-target") {
    out.warn(`edge check ${check.id} could not resolve its target: ${seen.error}`);
    return out.list;
  }
  if (seen.kind === "unreachable") {
    // Production being unreachable is an availability problem, not drift.
    out.warn(`edge check ${check.id} could not run: ${seen.error}`);
    return out.list;
  }

  // An assertion handed the wrong kind of observation was not checked. Say so
  // rather than letting a response without the headers it wants compare clean.
  const expect = <K extends EdgeObservation["kind"]>(kind: K) => {
    if (seen.kind !== kind) throw new Error(`the observation is ${JSON.stringify(seen.kind)} where this assertion needs ${JSON.stringify(kind)}`);
    return seen as Extract<EdgeObservation, { kind: K }>;
  };

  try {
    const { assert: want } = check;

    // Compression is the one assertion that needs its own request per
    // encoding: ask for exactly one and require the edge to answer in it.
    if (want.compression) {
      const { got } = expect("compression");
      const missing: string[] = [];
      for (const encoding of want.compression) {
        if (!(encoding in got)) throw new Error(`no response was recorded for accept-encoding ${encoding}`);
        if (got[encoding] !== encoding) missing.push(`${encoding} (got ${got[encoding] || "none"})`);
      }
      if (missing.length) drift(`${check.id}: edge did not compress as ${missing.join(", ")} — ${check.why.split(".")[0]}`);
      else out.pass(`edge ${check.id}: ${want.compression.join(", ")} all served`);
      return out.list;
    }

    // "can the edge do X" and "which X does it PICK" are different questions,
    // and only the second one describes what a visitor receives. Every real
    // browser offers several encodings at once, so the choice among them is
    // the whole behaviour — and it is invisible to the check above, which
    // offers exactly one at a time and so can never observe a preference.
    // Offer the full set a browser sends and require a specific winner.
    if (want.compressionPrefers) {
      const { offer, expect: expected } = want.compressionPrefers;
      const { got } = expect("prefers");
      if (got !== expected) drift(`${check.id}: offered "${offer}" and the edge chose ${got || "none"}, declared ${expected} — ${check.why.split(".")[0]}`);
      else out.pass(`edge ${check.id}: chose ${expected} from "${offer}"`);
      return out.list;
    }

    // TLS-layer assertion: no HTTP response can carry it, so it gets its own
    // probe (openssl, see probeEarlyData in check-infra.ts). A machine
    // that cannot run the probe warns rather than drifts — an unmeasurable
    // check must not report the zone broken.
    //
    // A REJECTION IS A DRIFT ON A WORKSTATION AND AN ADVISORY IN HOSTED CI,
    // and the split is measured rather than cautious. Cloudflare may refuse
    // early data on any resumption (anti-replay is why 0-RTT is hedged), so
    // the probe already takes three spaced samples before calling it drift.
    // From GitHub's runners all three have now missed on three separate runs
    // while the zone was fine: 2026-08-20 (five concurrent jobs), and twice
    // on 2026-09-02, run 33652822639 on MAIN and the first attempt of
    // 33654520873 on a PR, each accepted on a plain re-run minutes later and
    // accepted 5 of 5 from a workstation in between. The main failure is the
    // expensive one: `validate` gates promotion, so a merged PR sat
    // unpromoted until somebody noticed and re-ran CI. That is the deadlock
    // CLAUDE.md's release notes describe, arriving through a probe whose
    // subject (a shared egress address's ticket-issuance conditions) has
    // nothing to do with any diff. So on a hosted runner the rejection is
    // reported, with its sample count, as something a workstation must
    // confirm, and it fails nothing; a workstation keeps the hard failure,
    // because there the three samples have never been wrong. GITHUB_ACTIONS
    // rather than CI, since CI=1 is what this repo sets by hand to exercise
    // the release guard locally (see the ramp-token control in CLAUDE.md).
    if (want.earlyData) {
      const r = expect("early-data").result;
      if (r.skip) out.warn(`edge check ${check.id} skipped: ${r.skip}`);
      else if (r.accepted) out.pass(`edge ${check.id}: TLS early data accepted (0-RTT on)`);
      else if (opts.hostedRunner) out.warn(`edge check ${check.id}: TLS early data rejected on ${r.attempts} spaced resumptions from a hosted runner; not a drift here (three false rejections on record from this network), confirm from a workstation with \`bun run infra:check\``);
      else drift(`${check.id}: TLS early data rejected on ${r.attempts} spaced resumptions — ${check.why.split(".")[0]}`);
      return out.list;
    }

    const res = expect("response");
    const header = (name: string): string | null => res.headers[name.toLowerCase()] ?? null;
    const problems: string[] = [];

    for (const name of want.headerAbsent || []) {
      const got = header(name);
      if (got !== null) problems.push(`${name} is present (${got})`);
    }
    // headerPresent exists because headerContains cannot express it: every string
    // contains "", so `headerContains: {x: ""}` passes on an ABSENT header and
    // asserts nothing at all. That mistake shipped in the first draft of
    // markdown-for-agents-off and was caught only by deleting the check's
    // request header and watching it still pass.
    for (const name of want.headerPresent || []) {
      if (header(name) === null) problems.push(`${name} is absent`);
    }
    for (const [name, expected] of Object.entries(want.headerEquals || {})) {
      const got = (header(name) || "").trim();
      if (got !== expected) problems.push(`${name} is ${JSON.stringify(got || "(absent)")}, declared ${JSON.stringify(expected)}`);
    }
    for (const [name, needle] of Object.entries(want.headerContains || {}) as [string, string][]) {
      const got = header(name) || "";
      if (!got.includes(needle)) problems.push(`${name} does not contain ${JSON.stringify(needle)} (got ${JSON.stringify(got || "(absent)")})`);
    }
    if (want.bodyLacks) {
      // A body nobody read cannot be shown to lack anything.
      if (res.body === undefined) throw new Error("the response body was not recorded");
      for (const needle of want.bodyLacks) {
        if (res.body.includes(needle)) problems.push(`response body contains ${JSON.stringify(needle)}`);
      }
    }

    if (problems.length) drift(`${check.id}: ${problems.join("; ")} — ${check.why.split(".")[0]}`);
    else out.pass(`edge ${check.id} holds`);
  } catch (e) {
    out.warn(`edge check ${check.id} could not run: ${e.message}`);
  }
  return out.list;
}

export function compareEdge(edge, observed: Map<string, EdgeObservation>, opts: EdgeOptions): Finding[] {
  return edge.checks.flatMap((check) => compareEdgeCheck(check, observed.get(check.id), opts));
}

// ------------------------------------------------------------ tier: api ----

// Each resource class is checked independently. A token missing ONE read scope
// must not blank the whole tier: the first version batched these into a
// Promise.all under a single catch, so an absent R2 scope silently took KV, D1
// and the Worker inventory down with it and reported one opaque auth error.
// Cloudflare returns 10000 for both "bad token" and "token lacks this scope",
// so name the scope each section needs and let the reader tell them apart.
export function sectionFailure(label: string, scope: string, error: string): Finding {
  // Cloudflare is not consistent here: the same missing scope surfaces as
  // 10000 "Authentication error" on some endpoints and 9106 "Authentication
  // failed" on others, so match the family rather than one code.
  const authy = /\b(10000|9106|9109)\b|authentication|unauthorized|forbidden/i.test(error);
  return {
    level: "warn",
    message: authy ? `${label} unchecked: token is missing ${scope} (${error})`
                   : `${label} unchecked: ${error}`,
  };
}

/** One account-tier section: a failed read is the advisory above, and a
 *  response whose SHAPE surprises the comparer degrades to the same advisory
 *  rather than failing. An endpoint that moves or an envelope that changes is
 *  "we could not check", and a Cloudflare API revision must not redden a PR
 *  that only touched CSS. Only a value successfully READ that disagrees with
 *  infra.json is fatal. */
function section<T>(label: string, scope: string, read: Read<T> | undefined, compare: (value: T, out: Collector) => void): Finding[] {
  if (!read) return [sectionFailure(label, scope, "no observation was recorded for this section")];
  if (!read.ok) return [sectionFailure(label, scope, read.error)];
  const out = collector();
  try {
    compare(read.value, out);
  } catch (e) {
    out.list.push(sectionFailure(label, scope, `${e?.message}`));
  }
  return out.list;
}

// Resources the bindings point at. wrangler deploy --dry-run validates the
// config's shape but never asks whether the IDs resolve to anything.
export function compareKvNamespaces(wrangler, namespaces: Read<any[]> | undefined): Finding[] {
  return section("KV namespaces", "Workers KV Storage:Read", namespaces, (kv, out) => {
    const ids = new Set(kv.map((n) => n.id));
    for (const n of wrangler.kv_namespaces || []) {
      if (ids.has(n.id)) out.pass(`KV ${n.binding} resolves (${n.id})`);
      else out.fail(`KV binding ${n.binding} points at namespace ${n.id}, which does not exist in this account`);
    }
  });
}

export function compareR2Buckets(wrangler, buckets: Read<any> | undefined): Finding[] {
  return section("R2 buckets", "Workers R2 Storage:Read", buckets, (r2, out) => {
    const names = new Set((r2.buckets || r2).map((b) => b.name));
    for (const b of wrangler.r2_buckets || []) {
      if (names.has(b.bucket_name)) out.pass(`R2 ${b.binding} resolves (${b.bucket_name})`);
      else out.fail(`R2 binding ${b.binding} points at bucket ${b.bucket_name}, which does not exist`);
    }
  });
}

export function compareD1Databases(wrangler, databases: Read<any[]> | undefined): Finding[] {
  return section("D1 databases", "D1:Read", databases, (d1, out) => {
    const dbs = new Map(d1.map((d) => [d.uuid, d.name])) as Map<string, string>;
    for (const d of wrangler.d1_databases || []) {
      if (!dbs.has(d.database_id)) out.fail(`D1 binding ${d.binding} points at database ${d.database_id}, which does not exist`);
      else if (dbs.get(d.database_id) !== d.database_name) out.fail(`D1 binding ${d.binding} expects ${d.database_name} but ${d.database_id} is named ${dbs.get(d.database_id)}`);
      else out.pass(`D1 ${d.binding} resolves (${d.database_name})`);
    }
  });
}

/** The Workers Builds port's answer: the script's build tag (null when the
 *  script listing carries none for this Worker) and the raw triggers payload. */
export type WorkersBuildsObservation = { tag: string | null; triggers?: unknown };

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
export function compareWorkersBuilds(release, builds: Read<WorkersBuildsObservation> | undefined): Finding[] {
  return section("Workers Builds release config", "Workers Builds Configuration:Read", builds, ({ tag, triggers: raw }, out) => {
    if (!tag) {
      out.warn(`release config unchecked: no worker tag for ${release.worker} in the script listing`);
      return;
    }

    // The docs show a bare trigger object; a list endpoint may wrap it. Accept
    // either rather than guessing which, and say so if it is neither.
    const wrapped = raw as { triggers?: unknown } | null | undefined;
    const triggers: any[] | null = Array.isArray(raw) ? raw : (Array.isArray(wrapped?.triggers) ? wrapped.triggers : null);
    if (!triggers) {
      out.warn(`release config unchecked: unexpected triggers response shape (${JSON.stringify(raw).slice(0, 160)})`);
      return;
    }

    const branch = release.production_branch;
    // The dashboard's "Deploy command" and "Non-production branch deploy
    // command" are two TRIGGERS in the API, told apart by their branch filters.
    const prod = triggers.find((t) => (t.branch_includes || []).includes(branch));
    if (!prod) {
      out.fail(`Workers Builds has no trigger matching the ${branch} branch — nothing publishes this Worker`);
      return;
    }

    const checks = [
      ["deploy_command",  release.deploy_command],
      ["build_command",   release.build_command],
      ["root_directory",  release.root_directory],
    ];
    for (const [field, expected] of checks) {
      const live = prod[field] ?? "";
      // root_directory is written "." here and may come back "" or "/" upstream;
      // treat those three as the same statement about a monorepo root.
      const same = field === "root_directory"
        ? [".", "", "/"].includes(String(live)) === [".", "", "/"].includes(String(expected))
        : String(live).trim() === String(expected).trim();
      if (same) out.pass(`Workers Builds ${field} matches infra.json (${JSON.stringify(live)})`);
      else out.fail(`Workers Builds ${field} is ${JSON.stringify(live)} but infra.json declares ${JSON.stringify(expected)} — the dashboard is the live value, so fix it there`);
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
    const expectedPreview = String(release.non_production_deploy_command || "");
    if (expectedPreview && !preview) {
      // Declared but absent. Nothing PUBLISHES in this direction, so it is not
      // dangerous, and a trigger list whose shape we guessed at is the case the
      // section header says degrades to a note. Say it and move on.
      out.warn(`release config partly unchecked: infra.json declares a non-production deploy command but Workers Builds returned no second trigger (branch builds off, or the trigger list is shaped differently than assumed)`);
    } else if (expectedPreview && preview) {
      const live = String(preview.deploy_command ?? "").trim();
      if (live === expectedPreview.trim()) {
        out.pass(`Workers Builds non_production_deploy_command matches infra.json (${JSON.stringify(live)})`);
      } else {
        // Name the CONSEQUENCE of this particular difference. "the strings
        // differ" sends whoever reads it back to diffing two long commands by
        // eye, and the two differences that matter have very different stakes.
        const missing = PROVISIONING_PINS.filter((f) => !live.includes(f));
        const why = missing.length
          ? `it is missing ${missing.join(" and ")}, so a push to ANY branch publishes with resource creation ON`
          : !/\bversions upload\b/.test(live)
            ? `it is not a \`versions upload\`, so a branch build would take production traffic on push`
            : `the commands differ in some other way, and the dashboard is what actually runs`;
        out.fail(`Workers Builds non_production_deploy_command is ${JSON.stringify(live)} but infra.json declares ${JSON.stringify(expectedPreview)} — ${why}. The dashboard is the live value, so fix it there`);
      }
    }
  });
}

// Worker inventory. A retired Worker that is still deployed keeps its routes,
// which is invisible from inside this repo.
export function compareWorkerInventory(workers, scripts: Read<any[]> | undefined): Finding[] {
  return section("Worker inventory", "Workers Scripts:Read", scripts, (listing, out) => {
    const live = new Set(listing.map((s) => s.id)) as Set<string>;
    for (const w of workers.expected) {
      if (live.has(w.name)) out.pass(`Worker ${w.name} deployed`);
      else out.fail(`Worker ${w.name} is declared but not deployed`);
    }
    for (const w of workers.retired) {
      if (live.has(w.name)) out.fail(`Worker ${w.name} is retired but still deployed — ${w.why}`);
      else out.pass(`retired Worker ${w.name} is gone`);
    }
    const known = new Set([...workers.expected, ...workers.retired, ...workers.unmanaged].map((w) => w.name));
    for (const name of live) if (!known.has(name)) out.warn(`Worker ${name} is deployed but not accounted for in infra.json`);
  });
}

// API token scoping. Granular Workers permissions (2026-08-29) made the ramp
// token's blast radius a CHOICE rather than a platform limit, so it is worth
// declaring and therefore worth checking. infra.json's `tokens` block carries
// the long argument; three things about this section decide how it behaves.
//
// IT IS WORKSTATION-ONLY, and that is deliberate rather than a gap. Reading a
// token's policies costs API Tokens Read, which lets the bearer enumerate
// every token on the account and read what each one may do. Granting that to
// the CI credential to verify that the CI credential is narrow would be a
// wider grant than the one being verified. So this degrades to a note in CI,
// the same standing as repository.code_scanning and zone.version_affinity.
//
// THE HARD FAILURES ARE NEGATIVES, and both are chosen so they hold without
// knowing what Cloudflare ends up calling the new roles. A token declared
// read-only must carry no group whose name matches write/edit/admin, and a
// token declared resource-scoped must not hold the bare account resource.
// Neither depends on a permission-group name or a resource-key format that
// nobody here has observed yet.
//
// EVERYTHING ELSE IS A REPORT. The declared permission_groups are dashboard
// labels and the API may spell them differently, so a mismatch prints both
// lists rather than failing. The first run against a real token is the
// measurement: it prints the observed resource keys, which is what fills in
// `resource_key` in infra.json. Asserting against a string invented here
// would be a check that only ever agreed with itself.
export function compareTokens(infra, accountId: string, tokens: Read<any[]> | undefined): Finding[] {
  return section("API token scoping", "API Tokens Read", tokens, (listing, out) => {
    const accountResource = `com.cloudflare.api.account.${accountId}`;
    const writeGroup = new RegExp(infra.tokens.write_group_pattern, "i");

    const byName = new Map((listing || []).map((t) => [t.name, t])) as Map<string, any>;

    // `checked` is an explicit flag rather than a read of `location`, and the
    // first draft is why: it filtered on location.includes("GitHub"), and the
    // DNS token's location reads "workstation only, never GitHub", which
    // contains it. The one entry the filter existed to exclude was the one it
    // selected. A prose field must never carry a machine decision.
    for (const want of infra.tokens.expected.filter((t) => t.checked)) {
      const live = byName.get(want.name);
      if (!live) {
        // A rename is indistinguishable from a deletion from here, and both are
        // worth a look, so say what was searched for rather than guessing which.
        out.warn(`token ${want.name} (${want.env}) is declared but no account token carries that name — renamed, deleted, or user-owned rather than account-owned`);
        continue;
      }

      const policies = live.policies || [];
      const groups = policies.flatMap((p) => (p.permission_groups || []).map((g) => g.name));
      const resources = [...new Set(policies.flatMap((p) => Object.keys(p.resources || {})))];

      // 1. A read-only token may hold nothing that writes. Asserted against the
      //    NAME rather than against want.permission_groups, on the same
      //    reasoning bypass_actors is asserted empty: diffing against a
      //    declared list means the way to turn this green is to add the write
      //    scope to infra.json, which is the exact change worth catching.
      if (!want.may_write) {
        const offenders = groups.filter((g) => writeGroup.test(g));
        if (offenders.length) out.fail(`token ${want.name} (${want.env}) is declared read-only but carries ${offenders.join(", ")} — this credential is a GitHub secret on a PUBLIC repository`);
        else out.pass(`token ${want.name} carries no write permission (${groups.length} groups, all read)`);
      }

      // 2. The Workers half of a resource-scoped token must not hold the whole
      //    account. PER POLICY, and only the policies carrying the declared
      //    group: D1 Edit and Account Settings Read have no per-resource form,
      //    so a real ramp token is necessarily account-wide for those, and the
      //    first draft's flat "no resource may name the account" failed the
      //    clean control. The narrow grant and the wide one both ramp
      //    perfectly, so undoing this is silent by construction.
      if (want.resource_scoped_group) {
        const guard = new RegExp(want.resource_scoped_group, "i");
        const guarded = policies.filter((p) => (p.permission_groups || []).some((g) => guard.test(g.name)));
        if (!guarded.length) {
          // A guard pointed at nothing that reports success is the silent pass
          // this file exists to refuse. Cloudflare's API name for the granular
          // Workers roles is unmeasured here, so a rename can do exactly that.
          out.fail(`token ${want.name} (${want.env}) declares resource_scoped_group /${want.resource_scoped_group}/i but no permission group on it matches — the scoping guard is pointed at nothing. Observed ${JSON.stringify(groups)}; correct the pattern in infra.json`);
        } else {
          const wide = guarded.filter((p) => Object.keys(p.resources || {}).includes(accountResource));
          if (wide.length) out.fail(`token ${want.name} (${want.env}) is declared resource-scoped but its Workers policy names the whole account (${accountResource}), so it can write to every Worker rather than just ${infra.release.worker}`);
          else out.pass(`token ${want.name}: Workers grant is scoped below the account (${guarded.flatMap((p) => Object.keys(p.resources || {})).join(", ")})`);
        }
      }

      // 3. Report the shape, so infra.json can be corrected from evidence.
      if (!want.resource_key) out.warn(`token ${want.name}: resource_key is unrecorded in infra.json — observed ${JSON.stringify(resources)}`);
      else if (!resources.includes(want.resource_key)) out.warn(`token ${want.name}: declared resource_key ${want.resource_key} is not among the observed ${JSON.stringify(resources)}`);

      const missing = want.permission_groups.filter((g) => !groups.some((n) => n.toLowerCase() === g.toLowerCase()));
      if (missing.length) out.warn(`token ${want.name}: declared groups ${JSON.stringify(missing)} were not found by that name — observed ${JSON.stringify(groups)}. These are dashboard labels and the API may spell them differently, so correct infra.json from the observed list rather than treating this as drift`);
    }
  });
}

/** The zone-setting port's answer: the zone id (null when the token sees no
 *  zone by that name) and the setting object Cloudflare returned for it. */
export type ZoneSettingObservation = { zoneId: string | null; setting?: { value?: unknown } | null };

// One declared zone setting (0-RTT, shared dictionaries). Zone-scoped, which
// puts it outside the account-scoped CI token: it needs Zone:Zone:Read to
// resolve the id and Zone:Zone Settings:Read to read the value, so IN CI THIS
// ALWAYS DEGRADES TO A NOTE and a workstation run asserts it.
export function compareZoneSetting(
  section_: { label: string; scope: string; short: string },
  declared, zoneName: string, observed: Read<ZoneSettingObservation> | undefined,
): Finding[] {
  if (!declared) return [];
  return section(section_.label, section_.scope, observed, ({ zoneId, setting }, out) => {
    if (!zoneId) {
      out.warn(`${section_.short} unchecked: this token sees no zone named ${zoneName}`);
      return;
    }
    const value = setting?.value;
    if (value !== declared.value) {
      out.fail(`zone setting ${declared.setting} is "${String(value)}" on ${zoneName}, declared "${declared.value}". ${declared.why}`);
      return;
    }
    out.pass(`zone setting ${declared.setting} is ${String(value)}`);
  });
}

// 0-RTT. The value is declared "on" together with the Worker's early-data
// guard (lib/early-data.ts); the arithmetic and the pairing argument are in
// infra.json under zone.zero_rtt.
export const ZERO_RTT_SECTION = { label: "0-RTT connection resumption", scope: "Zone:Zone Settings:Read and Zone:Zone:Read", short: "0-RTT" };
// Shared Dictionaries passthrough. The docs say `disabled` strips
// Use-As-Dictionary and refuses to cache dcb/dcz, which would drop every
// dictionary tier to plain brotli without an error. infra.json under
// zone.shared_dictionary says what is and is not measured about that.
export const SHARED_DICTIONARY_SECTION = { label: "shared dictionaries passthrough", scope: "Zone:Zone Settings:Read and Zone:Zone:Read", short: "shared dictionaries" };

/** The version-affinity port's answer. `ruleset: null` is the phase entrypoint
 *  answering 404, which is a definite statement that the phase holds no
 *  ruleset rather than a failed read. */
export type VersionAffinityObservation = { zoneId: string | null; ruleset?: any };

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
export function compareVersionAffinity(declared, zoneName: string, observed: Read<VersionAffinityObservation> | undefined): Finding[] {
  if (!declared) return [];
  return section("version affinity", "Zone:Transform Rules:Read and Zone:Zone:Read", observed, ({ zoneId, ruleset }, out) => {
    if (!zoneId) {
      out.warn(`version affinity unchecked: this token sees no zone named ${zoneName}`);
      return;
    }
    if (ruleset === null) {
      out.fail(`no ${declared.phase} ruleset on ${zoneName}, so nothing sets ${declared.header}. ${declared.why}`);
      return;
    }

    const wanted = declared.header.toLowerCase();
    const rule = (ruleset.rules || []).find((r) =>
      Object.keys(r?.action_parameters?.headers || {}).some((h) => h.toLowerCase() === wanted));
    if (!rule) {
      out.fail(`no Transform Rule on ${zoneName} sets ${declared.header}. ${declared.why}`);
      return;
    }

    // A DISABLED rule is the quietest way for this to be gone: it survives every
    // listing, reads as configured to anyone glancing at the dashboard, and does
    // nothing. Check it before the values, which are meaningless while it is off.
    if (rule.enabled === false) {
      out.fail(`the ${declared.header} Transform Rule exists on ${zoneName} but is DISABLED, so ramps run without version affinity. ${declared.why}`);
      return;
    }

    const entry = Object.entries(rule.action_parameters.headers)
      .find(([h]) => h.toLowerCase() === wanted)![1] as { value?: string; expression?: string };

    // "Set dynamic" comes back as an `expression`; "Set static" comes back as a
    // `value`. The difference is not cosmetic here: a static key is the SAME key
    // for every visitor on earth, which hashes to one version and puts 100% of
    // traffic on one side of a split that reports itself as 10%. That is worse
    // than having no affinity at all, so it gets its own failure.
    if (entry.value !== undefined && entry.expression === undefined) {
      out.fail(`${declared.header} is set STATICALLY to ${JSON.stringify(entry.value)} on ${zoneName}, so every visitor shares one affinity key and a ramp puts all traffic on one version regardless of the percentages. It must be "Set dynamic" with ${JSON.stringify(declared.value)}`);
      return;
    }
    if (String(entry.expression || "").trim() !== String(declared.value).trim()) {
      out.fail(`${declared.header} is derived from ${JSON.stringify(entry.expression)} but infra.json declares ${JSON.stringify(declared.value)}. The dashboard is the live value, so fix it there`);
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
      out.fail(`the ${declared.header} rule matches on ${JSON.stringify(rule.expression)}, which does not exempt requests that already carry the header. It will overwrite the per-request keys deploy:promote sends, and every ramp step will read as "the ramp did not take". infra.json declares: ${declared.expression}`);
      return;
    }

    out.pass(`version affinity: ${declared.header} set dynamically from ${declared.value}, client-supplied keys exempted`);
  });
}

// ----------------------------------------------------- tier: repository ----

/** What the GitHub port read for the rulesets: the repository metadata, the
 *  ruleset listing, and each declared ruleset's full detail by name. A detail
 *  is its own Read, because one ruleset failing to load must not blank the
 *  others. */
export type RulesetsObservation = {
  meta: any;
  rulesets: any[];
  details: Record<string, Read<any>>;
};

/** How many workflows carry a TOP-LEVEL `permissions:` block. A tree
 *  observation the Actions comparer quotes in one message. */
export type WorkflowBlocks = { total: number; without: string[] };

export type RepositoryObservation = {
  core: Read<RulesetsObservation>;
  labels?: Read<any[]>;
  codeScanning?: Read<any>;
  actions?: Read<{ live: any; workflow: any }>;
  workflowBlocks: WorkflowBlocks;
};

export type RepositoryOptions = {
  /** GITHUB_TOKEN was sent. It buys rate-limit headroom on the public
   *  endpoints and is what the three Administration-gated ones need. */
  authenticated: boolean;
};

const UNOBSERVED = "no observation was recorded for this read";

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
//
// Returns `proceed`: false when the read failed or visibility drifted, which is
// when the rest of the repository tier has nothing to stand on.
export function compareRulesets(repo, core: Read<RulesetsObservation> | undefined, opts: RepositoryOptions): { findings: Finding[]; proceed: boolean } {
  const out = collector();
  const slug = `${repo.owner}/${repo.name}`;

  if (!core || !core.ok) {
    out.warn(`repository rulesets could not be read: ${core ? core.error : UNOBSERVED}`);
    return { findings: out.list, proceed: false };
  }
  const { meta, rulesets: live, details } = core.value;

  // Visibility first, and as a PRECONDITION rather than a preference: rulesets
  // on a private repo need a paid plan, so a flip back to private silently
  // takes every rule below with it. Failing here names the cause; failing on
  // four missing rules would not.
  if (meta.visibility !== repo.visibility) {
    out.fail(
      `${slug} is ${JSON.stringify(meta.visibility)} but infra.json declares ${JSON.stringify(repo.visibility)}: rulesets need a paid plan on a private repo, so every branch rule below this line may have gone dark with it`,
    );
    return { findings: out.list, proceed: false };
  }

  const byName = new Map(live.map((r) => [r.name, r]));
  for (const want of repo.rulesets) {
    const found = byName.get(want.name) as { id?: string } | undefined;
    byName.delete(want.name);
    if (!found) {
      out.fail(`${slug} has no ruleset named ${JSON.stringify(want.name)}: the ${want.name} branch is unprotected`);
      continue;
    }

    const read = details[want.name];
    if (!read || !read.ok) {
      out.warn(`ruleset ${want.name} could not be read in full: ${read ? read.error : UNOBSERVED}`);
      continue;
    }
    const detail = read.value;

    const at = `ruleset ${want.name}`;
    if (detail.enforcement !== want.enforcement) {
      out.fail(
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
      out.fail(`${at} has ${detail.bypass_actors.length} bypass actor(s): ${who}. Every push here uses the owner's credentials, so a bypass exempts the actors the rule is for`);
    }

    const include = detail.conditions?.ref_name?.include || [];
    if (want.include && include.join(",") !== want.include.join(",")) {
      out.fail(`${at} covers ${JSON.stringify(include)}, declared ${JSON.stringify(want.include)}`);
    }

    const types = new Set(detail.rules.map((r) => r.type));
    const missing = want.rules.filter((r) => !types.has(r));
    if (missing.length) out.fail(`${at} lost rule(s) ${missing.join(", ")}`);
    const extra = detail.rules.map((r) => r.type).filter((t) => !want.rules.includes(t));
    if (extra.length) out.warn(`${at} carries undeclared rule(s) ${extra.join(", ")}: stricter than declared, but declare them so this file stays the source of truth`);

    // A forbidden rule is not an oversight in the declaration. `production`
    // must carry no pull_request rule, because promote-production.yml moves
    // that ref directly and a PR requirement would break the release path.
    for (const banned of want.forbidden_rules || []) {
      if (types.has(banned)) out.fail(`${at} gained a ${banned} rule, which it must not have. ${want.why}`);
    }

    const rule = (t) => detail.rules.find((r) => r.type === t)?.parameters || {};

    if (want.required_approving_review_count !== undefined && types.has("pull_request")) {
      const got = rule("pull_request").required_approving_review_count;
      if (got !== want.required_approving_review_count) {
        out.fail(`${at} requires ${got} approving review(s), declared ${want.required_approving_review_count}. GitHub refuses to let anyone approve their own PR, so a solo repo above 0 can never merge`);
      }
    }

    if (want.required_status_checks && types.has("required_status_checks")) {
      const params = rule("required_status_checks");
      const got = params.required_status_checks || [];
      for (const req of want.required_status_checks) {
        const hit = got.find((c) => c.context === req.context);
        if (!hit) out.fail(`${at} no longer requires the ${JSON.stringify(req.context)} check`);
        else if (hit.integration_id !== req.integration_id) {
          out.fail(`${at}'s ${JSON.stringify(req.context)} check is pinned to integration_id ${hit.integration_id}, declared ${req.integration_id}. Unpinned, any caller of the commit-status API could satisfy it`);
        }
      }
      if (params.strict_required_status_checks_policy !== want.strict_required_status_checks_policy) {
        out.fail(`${at}'s strict_required_status_checks_policy is ${params.strict_required_status_checks_policy}, declared ${want.strict_required_status_checks_policy}. Strict makes every Dependabot PR churn a rebase on each unrelated merge`);
      }
    }
  }

  for (const stray of byName.keys()) {
    out.warn(`${slug} carries an undeclared ruleset ${JSON.stringify(stray)}: add it to infra.json's repository block or delete it`);
  }

  out.pass(`${slug} is ${meta.visibility} and its ${repo.rulesets.length} declared ruleset(s) match, with no bypass actors${opts.authenticated ? "" : " (unauthenticated read)"}`);
  return { findings: out.list, proceed: true };
}

// The live half of the triage declaration. Same tier as the rulesets above and
// for the same reason: /repos/:slug/labels is public on a public repo, so this
// runs on every pull request with no credential rather than degrading to a note
// like the account tier.
//
// A MISSING LABEL IS FATAL, and the reason is not tidiness. Three things break
// on one: `gh pr create --label` fails outright, so the nightly dictionary roll
// stops opening pull requests; triage.yml silently CREATES the label instead,
// because the add-labels endpoint invents what it is handed; and the label list
// stops being the thing you can filter the repository by, which is the only
// reason any of this exists.
//
// Colour and description drift is fatal too, which looks strict for something
// cosmetic. It is one command to fix and it is the only signal that somebody
// edited the set from the web UI, where the next edit is a rename.
export function compareLabels(repo, labels: Read<any[]> | undefined, opts: RepositoryOptions): Finding[] {
  const triage = repo.triage;
  if (!triage) return [];
  const out = collector();
  const slug = `${repo.owner}/${repo.name}`;

  if (!labels || !labels.ok) {
    out.warn(`repository labels could not be read: ${labels ? labels.error : UNOBSERVED}`);
    return out.list;
  }

  const byName = new Map<string, any>(labels.value.map((l) => [l.name, l]));
  for (const want of triage.labels) {
    const got = byName.get(want.name);
    byName.delete(want.name);
    if (!got) {
      out.fail(`${slug} has no label ${JSON.stringify(want.name)}. Run \`bun run labels:sync -- --confirm\`: until then triage.yml will invent it with a colour nobody chose, and any workflow passing it to \`gh --label\` fails outright`);
      continue;
    }
    if (got.color.toLowerCase() !== want.color.toLowerCase()) {
      out.fail(`label ${JSON.stringify(want.name)} is #${got.color}, declared #${want.color} (\`bun run labels:sync -- --confirm\`)`);
    }
    if ((got.description ?? "") !== want.description) {
      out.fail(`label ${JSON.stringify(want.name)} reads ${JSON.stringify(got.description ?? "")}, declared ${JSON.stringify(want.description)} (\`bun run labels:sync -- --confirm\`)`);
    }
  }

  // Strays WARN, matching the ruleset tier. GitHub ships a stock label set on
  // every new repository, so failing here would make the first run of this
  // check red for something nobody chose.
  const strays = [...byName.keys()];
  if (strays.length) {
    out.warn(`${slug} carries ${strays.length} undeclared label(s): ${strays.join(", ")}. Declare them in infra.json or remove them with \`bun run labels:sync -- --confirm --prune\` (a deletion strips the label from every issue that carried it)`);
  }

  if (out.failed()) return out.list;
  out.pass(`${slug}'s ${triage.labels.length} declared label(s) match on name, colour and description${strays.length ? `, with ${strays.length} stray` : ""}${opts.authenticated ? "" : " (unauthenticated read)"}`);
  return out.list;
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
export function compareCodeScanning(repo, setup: Read<any> | undefined): Finding[] {
  const want = repo.code_scanning;
  if (!want) return [];
  const out = collector();

  if (!setup || !setup.ok) {
    const error = setup ? setup.error : UNOBSERVED;
    out.warn(
      /401|403/.test(error)
        ? `CodeQL default setup: not verifiable here, the endpoint needs the repository Administration permission and no GITHUB_TOKEN can hold it. Run \`GITHUB_TOKEN=$(gh auth token) bun run infra:check\` on a workstation (any credential with the \`repo\` scope; being logged in is not enough, the script reads GITHUB_TOKEN) to assert it (${error})`
        : `CodeQL default setup could not be read: ${error}`,
    );
    return out.list;
  }
  const live = setup.value;

  // Under ADVANCED setup this tier has exactly one job: prove default setup is
  // still OFF. Both on would analyze every commit twice and file duplicate
  // alerts, and the dashboard is one click from doing it. The curation itself
  // moved to checkCodeqlWorkflow, which needs no credential.
  if (want.mode === "advanced") {
    if (live.state !== want.default_setup_state) {
      out.fail(`CodeQL default setup is ${JSON.stringify(live.state)}, declared ${JSON.stringify(want.default_setup_state)}. With ${want.workflow} committed, both being on double-scans every commit and files duplicate alerts`);
      return out.list;
    }
    out.pass(`CodeQL default setup is ${live.state}, leaving ${want.workflow} the only scanner`);
    return out.list;
  }

  // state first. A scanner that is simply off reports nothing, which reads
  // exactly like a clean scan, so every field below is moot if this drifted.
  if (live.state !== want.state) {
    out.fail(`CodeQL default setup is ${JSON.stringify(live.state)}, declared ${JSON.stringify(want.state)}. A disabled scanner reports no findings, which looks identical to a clean scan`);
    return out.list;
  }

  // The curated list. Compared as a SET, because the API's ordering is not a
  // documented guarantee and reordering is not drift worth failing on.
  const got = [...(live.languages || [])].sort(byCodeUnit);
  const declared = [...want.languages].sort(byCodeUnit);
  if (got.join(",") !== declared.join(",")) {
    const added = got.filter((l) => !declared.includes(l));
    const dropped = declared.filter((l) => !got.includes(l));
    const parts: string[] = [];
    if (added.length) parts.push(`gained ${added.join(", ")}`);
    if (dropped.length) parts.push(`lost ${dropped.join(", ")}`);
    out.fail(`CodeQL default setup ${parts.join(" and ")} (live ${got.join(", ")}); #241 curated this list, so re-read MAINTENANCE.md before widening it`);
  }

  if (live.threat_model !== want.threat_model) {
    out.fail(`CodeQL threat_model is ${JSON.stringify(live.threat_model)}, declared ${JSON.stringify(want.threat_model)}. MAINTENANCE.md argues rust and python are droppable BECAUSE the model is remote, so this change invalidates that reasoning`);
  }

  if (live.query_suite !== want.query_suite) {
    out.fail(`CodeQL query_suite is ${JSON.stringify(live.query_suite)}, declared ${JSON.stringify(want.query_suite)}`);
  }

  out.pass(`CodeQL default setup matches: ${got.length} languages (${got.join(", ")}), ${live.query_suite} suite, ${live.threat_model} threat model`);
  return out.list;
}

// The Actions policy, on the two endpoints that hold it. Same tier as
// compareCodeScanning above and workstation-only for the same measured reason:
// /repos/:slug/actions/permissions and .../permissions/workflow each answer
// HTTP 401 unauthenticated on this public repo (2026-08-27), so no PR run can
// assert them and CI says so in one advisory instead of pretending.
//
// TWO OF THESE ARE DECLARED AHEAD OF LIVE STATE ON PURPOSE, so this reports
// drift today and is meant to. zone.version_affinity set that precedent: the
// declaration is the intent, the red line is the to-do, and the check goes
// green when the owner flips the toggle rather than when somebody edits the
// declaration down to match a dashboard nobody chose.
//
// `can_approve_pull_request_reviews` runs the OTHER WAY and is the sharp one.
// It is true today and declared true to KEEP it, because the dashboard control
// it maps to is "Allow GitHub Actions to create and approve pull requests" and
// clearing it stops the default GITHUB_TOKEN from CREATING one. The scheduled
// PR-opening workflows moved to an App token on 2026-09-28 (a github.token PR
// now needs a human to approve its CI), so nothing here depends on it today;
// it stays declared so that clearing it is a diff rather than a surprise.
export function compareActionsPermissions(repo, actions: Read<{ live: any; workflow: any }> | undefined, blocks: WorkflowBlocks): Finding[] {
  const want = repo.actions_permissions;
  if (!want) return [];
  const out = collector();
  const slug = `${repo.owner}/${repo.name}`;

  if (!actions || !actions.ok) {
    const error = actions ? actions.error : UNOBSERVED;
    out.warn(
      /401|403/.test(error)
        ? `Actions permissions: not verifiable here, both endpoints answer 401 unauthenticated even on a public repo. Run \`GITHUB_TOKEN=$(gh auth token) bun run infra:check\` on a workstation (being logged in is not enough, the script reads GITHUB_TOKEN) to assert them (${error})`
        : `Actions permissions could not be read: ${error}`,
    );
    return out.list;
  }
  const { live, workflow } = actions.value;

  // SHAPE BEFORE VALUES, and this guard is what keeps the tier out of CI's way
  // rather than a defensive reflex. CI reads with the workflow's own
  // GITHUB_TOKEN, which holds no Administration permission, so the expected
  // answer is a 403 the arm above turns into an advisory. What this covers is
  // the other shape: a 200 carrying a body without these fields. Read as values
  // that are simply absent, `undefined !== true` fails, and a required check
  // goes red over a credential rather than over a setting. Unverifiable is the
  // honest reading of a payload that never named the thing.
  const policyAbsent = (live.enabled !== true && live.enabled !== false) || !workflow.default_workflow_permissions;
  if (policyAbsent) {
    out.warn(
      `Actions permissions: the API answered without the policy fields, so this tier is not verifiable with the credential in use. Run \`GITHUB_TOKEN=$(gh auth token) bun run infra:check\` on a workstation to assert it`,
    );
    return out.list;
  }

  // enabled first, as a PRECONDITION rather than a field. With Actions off the
  // three settings below govern nothing, and so does every workflow in this
  // repo, which is a much larger fact than any drift underneath it.
  if (live.enabled !== true) {
    out.fail(`${slug} has GitHub Actions DISABLED, so every workflow here is dead and the policy below governs nothing`);
    return out.list;
  }

  if (live.allowed_actions !== want.allowed_actions) {
    out.fail(
      `Actions allowed_actions is ${JSON.stringify(live.allowed_actions)}, declared ${JSON.stringify(want.allowed_actions)}. \`selected\` needs an explicit allowlist of every action and reusable workflow, which is a second registry beside the commit pins`,
    );
  }

  if (live.sha_pinning_required !== want.sha_pinning_required) {
    out.fail(
      `Actions sha_pinning_required is ${live.sha_pinning_required}, declared ${want.sha_pinning_required}. Flip it under Settings, Actions, General: every third-party ref here is already commit-pinned by hand (the tree tier proves it), so this costs nothing today and is what stops the next one arriving on a tag`,
    );
  }

  if (workflow.default_workflow_permissions !== want.default_workflow_permissions) {
    out.fail(
      `Actions default_workflow_permissions is ${JSON.stringify(workflow.default_workflow_permissions)}, declared ${JSON.stringify(want.default_workflow_permissions)}. An explicit \`permissions:\` block beats the default and ${blocks.without.length ? `${blocks.total - blocks.without.length} of ${blocks.total} workflows carry one (missing: ${blocks.without.join(", ")}), which already inherit the default` : `all ${blocks.total} workflows carry one`}, so the flip governs the next workflow added without one rather than anything running today`,
    );
  }

  // Asserted TRUE, which is the reverse of every other line here. See the
  // header: this field gates CREATING pull requests, not only approving them.
  if (workflow.can_approve_pull_request_reviews !== want.can_approve_pull_request_reviews) {
    out.fail(
      `Actions can_approve_pull_request_reviews is ${workflow.can_approve_pull_request_reviews}, declared ${want.can_approve_pull_request_reviews}. That checkbox reads "create AND approve", so turning it off stops \`gh pr create\` on the default token in dictionary-roll.yml, bun-pin.yml, og-cards.yml and photo-pipeline.yml. The nightly dictionary roll then fails silently inside a scheduled job`,
    );
  }

  if (out.failed()) return out.list;
  out.pass(
    `Actions policy matches: ${live.allowed_actions} actions allowed, sha pinning ${live.sha_pinning_required ? "required" : "off"}, default token ${workflow.default_workflow_permissions}, PR creation ${workflow.can_approve_pull_request_reviews ? "allowed" : "BLOCKED"}`,
  );
  return out.list;
}

// Secret scanning, read off the repo metadata the rulesets read already
// fetched for its `visibility` precondition. No third call:
// `security_and_analysis` rides on that same payload, so this tier costs one
// field rather than one request.
//
// IT READS BOTH DIRECTIONS, which the first version did not. Looping the
// DECLARED keys answers "is every setting I named still right" and is silent
// about a setting GitHub added or the owner switched on;
// `dependabot_security_updates` was live and undeclared the day this landed.
// The stray pass below is an advisory, matching the undeclared-ruleset
// line: an undeclared setting is a declaration to write.
//
// THE ABSENT-OBJECT CASE IS THE TRAP AND IS WHY THIS IS NOT A BARE LOOP. /repos/:slug answers HTTP 200 with NO credential and simply omits
// `security_and_analysis` (measured 2026-08-27), which is sharper than the 401s
// the Actions endpoints give: a checker written against the anonymous shape
// gets a successful read of an object that is not there, and every `?.status`
// under it comes back undefined. Reported as four settings being off, that is a
// false alarm on every unauthenticated run, meaning every run in CI. So the
// missing key is an advisory naming the credential, and only a PRESENT object
// is ever compared.
export function compareSecretScanning(repo, meta): Finding[] {
  const want = repo.security_and_analysis;
  if (!want) return [];
  const out = collector();
  const slug = `${repo.owner}/${repo.name}`;

  const live = meta?.security_and_analysis;
  if (!live) {
    out.warn(
      `secret scanning: not verifiable here, /repos/${slug} omits \`security_and_analysis\` unless the read is authenticated (it answers 200 either way, so absence is not a failure). Run \`GITHUB_TOKEN=$(gh auth token) bun run infra:check\` on a workstation to assert it`,
    );
    return out.list;
  }

  const fields = Object.keys(want).filter((k) => !k.startsWith("$") && k !== "why");
  for (const key of fields) {
    const got = live[key]?.status;
    if (got === undefined) {
      out.fail(`${slug} reports no \`${key}\` at all; GitHub renamed or withdrew it, so this declaration is asserting a field that no longer exists`);
      continue;
    }
    if (got !== want[key]) {
      out.fail(`secret scanning: \`${key}\` is ${JSON.stringify(got)}, declared ${JSON.stringify(want[key])}. Flip it under Settings, Advanced Security`);
    }
  }

  // The OTHER direction, which a loop over declared keys structurally cannot
  // see. Iterating the declaration answers "is every setting I named still
  // right" and says nothing about a setting GitHub added or the owner switched
  // on, so this file quietly stops being the source of truth for that object.
  // `dependabot_security_updates` was live and undeclared the day this landed.
  //
  // ADVISORY rather than fatal, matching the undeclared-ruleset line in
  // compareRulesets above: a setting the repo carries and this file does not
  // name is a declaration to write, not a security state to be red about, and
  // GitHub adding a field should not fail a PR that touched CSS.
  const strays = Object.keys(live).filter((k) => !fields.includes(k));
  if (strays.length) {
    out.warn(
      `${slug} carries ${strays.length} undeclared \`security_and_analysis\` setting(s): ${strays.map((k) => `${k} ${live[k]?.status}`).join(", ")}. Declare them in infra.json's repository.security_and_analysis block so this file stays the source of truth for that object`,
    );
  }

  if (out.failed()) return out.list;
  out.pass(`security_and_analysis matches on all ${fields.length} declared setting(s): ${fields.map((k) => `${k.replace(/^secret_scanning_?/, "") || "secret_scanning"} ${live[k].status}`).join(", ")}`);
  return out.list;
}

/** The whole repository tier, in the order check-infra prints it: rulesets
 *  (visibility first), labels, CodeQL default setup, the Actions policy, then
 *  secret scanning off the metadata the rulesets read carried. */
export function compareRepository(repo, observed: RepositoryObservation, opts: RepositoryOptions): Finding[] {
  if (!repo) return [];
  const { findings, proceed } = compareRulesets(repo, observed.core, opts);
  if (!proceed || !observed.core.ok) return findings;
  return [
    ...findings,
    ...compareLabels(repo, observed.labels, opts),
    ...compareCodeScanning(repo, observed.codeScanning),
    ...compareActionsPermissions(repo, observed.actions, observed.workflowBlocks),
    ...compareSecretScanning(repo, observed.core.value.meta),
  ];
}
