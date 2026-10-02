// ── infra:check compares a declaration against a RECORDED observation ───────
// Split-file suite; shared imports live in contract-shared.ts.
//
// tools/check-infra.ts used to fuse fetching, comparing and printing, and ran
// on import, so the tests that covered it read its SOURCE. A regex over source
// can say "a comparison is written here". It cannot say "a bypass actor fails
// by name", because that needs a response to compare. The comparers are a
// module now (tools/lib/infra-compare.ts) and the adapters take a `fetch`
// (tools/lib/infra-ports.ts), so every drift case below is a fixture.
//
// Each drift test carries its control in the same test: the unmodified fixture
// produces zero failures, so the failure asserted is the mutation's and not
// the fixture's. The declaration is the real config/infra.json throughout.
import { assert, readFileSync, test } from "./contract-shared.ts";
import {
  compareD1Databases, compareDns, compareEdge, compareEdgeCheck, compareKvNamespaces,
  compareLabels, compareR2Buckets, compareReleaseDeclaration, compareRepository,
  compareRulesets, compareTokens, compareVersionAffinity, compareWorkerInventory,
  compareWorkersBuilds, compareZoneSetting, dnsKey, dnsQueries,
  SHARED_DICTIONARY_SECTION, ZERO_RTT_SECTION,
} from "./lib/infra-compare.ts";
import {
  cloudflareReader, edgeFetcher, githubReader, readD1Databases, readDns, readEdge,
  readKvNamespaces, readR2Buckets, readRepository, readTokens, readVersionAffinity,
  readWorkerScripts, readWorkersBuilds, readZoneSetting,
} from "./lib/infra-ports.ts";
import { createReport } from "./lib/infra-report.ts";

const infra = JSON.parse(readFileSync("config/infra.json", "utf8"));
const repo = infra.repository;
const slug = `${repo.owner}/${repo.name}`;

const fails = (findings) => findings.filter((f) => f.level === "fail").map((f) => f.message);
const warns = (findings) => findings.filter((f) => f.level === "warn").map((f) => f.message);
const passes = (findings) => findings.filter((f) => f.level === "pass").map((f) => f.message);
/** A read that succeeded, typed as the port's `Read<T>` success arm.
 *  @template T
 *  @param {T} value
 *  @returns {{ ok: true, value: T }} */
const ok = (value) => ({ ok: true, value });
const clone = (value) => structuredClone(value);

// ---------------------------------------------------------------- fixtures ----

/** A ruleset detail as GitHub returns one, built to match its declaration. */
function rulesetDetail(want) {
  return {
    name: want.name,
    enforcement: want.enforcement,
    bypass_actors: [],
    conditions: { ref_name: { include: want.include, exclude: [] } },
    rules: want.rules.map((type) => {
      if (type === "pull_request") return { type, parameters: { required_approving_review_count: want.required_approving_review_count } };
      if (type === "required_status_checks") {
        return {
          type,
          parameters: {
            required_status_checks: want.required_status_checks,
            strict_required_status_checks_policy: want.strict_required_status_checks_policy,
          },
        };
      }
      return { type };
    }),
  };
}

const liveLabels = () => repo.triage.labels.map((l) => ({ name: l.name, color: l.color, description: l.description }));

/** The repository tier's observation with everything matching. `core` is what
 *  an unauthenticated read sees: no `security_and_analysis` on the metadata. */
function matchingRepository() {
  return {
    core: ok({
      meta: { visibility: repo.visibility },
      rulesets: repo.rulesets.map((r, i) => ({ id: i + 1, name: r.name })),
      details: Object.fromEntries(repo.rulesets.map((r) => [r.name, ok(rulesetDetail(r))])),
    }),
    labels: ok(liveLabels()),
    codeScanning: ok({ state: repo.code_scanning.default_setup_state }),
    actions: ok({
      live: { enabled: true, allowed_actions: repo.actions_permissions.allowed_actions, sha_pinning_required: repo.actions_permissions.sha_pinning_required },
      workflow: {
        default_workflow_permissions: repo.actions_permissions.default_workflow_permissions,
        can_approve_pull_request_reviews: repo.actions_permissions.can_approve_pull_request_reviews,
      },
    }),
    workflowBlocks: { total: 3, without: [] },
  };
}

const anonymous = { authenticated: false };

/** Workers Builds triggers matching the release block. */
const matchingTriggers = () => [
  {
    branch_includes: [infra.release.production_branch],
    deploy_command: infra.release.deploy_command,
    build_command: infra.release.build_command,
    root_directory: "/",
  },
  { branch_includes: ["*"], branch_excludes: [infra.release.production_branch], deploy_command: infra.release.non_production_deploy_command },
];

/** DNS answers matching every declared record. */
function matchingDns() {
  const observed = new Map();
  const answer = (name, type, answers) => observed.set(dnsKey(name, type), { answers: [...answers].sort(), authenticated: true, resolver: "fixture" });
  const edge = ["104.21.0.1", "172.67.0.1"];
  for (const record of infra.dns) {
    if (record.match === "exact") answer(record.name, record.type, record.expect);
    else if (record.match === "contains") answer(record.name, record.type, [`1 . ${record.expect.join(" ")}`]);
    else if (record.match === "present") answer(record.name, record.type, ["v=fixture"]);
    else if (record.match === "proxied") { answer(record.name, "A", edge); answer(record.name, "AAAA", ["2606:4700::1"]); }
    else if (record.match === "sameAs") answer(record.name, record.type, edge);
  }
  answer(infra.zone.name, "NS", infra.zone.nameservers);
  answer(infra.zone.name, "DS", [infra.zone.dnssec.ds]);
  return observed;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ------------------------------------------------------------- repository ----

test("the matching repository fixture is clean, so every drift below is the mutation's", () => {
  const findings = compareRepository(repo, matchingRepository(), anonymous);
  assert.deepEqual(fails(findings), []);
  assert.ok(passes(findings).some((m) => m.includes(`its ${repo.rulesets.length} declared ruleset(s) match`)));
  assert.ok(passes(findings).some((m) => m.includes(`${repo.triage.labels.length} declared label(s) match`)));
});

test("a bypass actor added to the main ruleset fails by name", () => {
  const observed = matchingRepository();
  observed.core.value.details.main.value.bypass_actors = [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }];
  const failed = fails(compareRepository(repo, observed, anonymous));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /^ruleset main has 1 bypass actor\(s\): RepositoryRole#5 \(always\)\./);
});

test("bypass actors are asserted EMPTY: no declaration can turn one green", () => {
  // The control the old shape could not have: declare the same actor in
  // infra.json and the comparer still fails. A diff against a declared list
  // would pass here, which is the change the check exists to catch.
  const declared = clone(repo);
  const actor = { actor_type: "Integration", actor_id: 15368, bypass_mode: "always" };
  declared.rulesets.find((r) => r.name === "main").bypass_actors = [actor];
  const observed = matchingRepository();
  observed.core.value.details.main.value.bypass_actors = [actor];
  assert.equal(fails(compareRepository(declared, observed, anonymous)).length, 1);
});

test("a ruleset with enforcement disabled fails", () => {
  const observed = matchingRepository();
  observed.core.value.details.production.value.enforcement = "disabled";
  const failed = fails(compareRepository(repo, observed, anonymous));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /^ruleset production is "disabled", declared "active"\./);
});

test("visibility private fails FIRST, and nothing under it is compared", () => {
  const observed = matchingRepository();
  observed.core.value.meta.visibility = "private";
  // Drift underneath that must NOT be reported: on a private repo the rules
  // have gone dark, so four missing rules would name the symptom.
  observed.core.value.details.main.value.enforcement = "disabled";
  observed.labels = ok([]);
  const findings = compareRepository(repo, observed, anonymous);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, "fail");
  assert.match(findings[0].message, new RegExp(`^${slug} is "private" but infra\\.json declares "public"`));
});

test("a missing label fails by name; a stray label is an advisory", () => {
  const gone = repo.triage.labels[0].name;
  const observed = matchingRepository();
  observed.labels = ok([...liveLabels().filter((l) => l.name !== gone), { name: "rust", color: "ffffff", description: "" }]);
  const findings = compareLabels(repo, observed.labels, anonymous);
  assert.deepEqual(fails(findings).length, 1);
  assert.ok(fails(findings)[0].startsWith(`${slug} has no label ${JSON.stringify(gone)}.`));
  assert.ok(warns(findings).some((m) => m.includes("1 undeclared label(s): rust")));
  assert.deepEqual(passes(findings), [], "a tier that found drift prints no summary pass beside it");
});

test("a lost rule, a forbidden rule and an unpinned check each fail", () => {
  const observed = matchingRepository();
  const main = observed.core.value.details.main.value;
  main.rules = main.rules.filter((r) => r.type !== "non_fast_forward");
  main.rules.find((r) => r.type === "required_status_checks").parameters.required_status_checks = [{ context: "validate", integration_id: null }];
  observed.core.value.details.production.value.rules.push({ type: "pull_request", parameters: {} });
  const failed = fails(compareRepository(repo, observed, anonymous));
  assert.ok(failed.some((m) => m === "ruleset main lost rule(s) non_fast_forward"));
  assert.ok(failed.some((m) => m.startsWith(`ruleset main's "validate" check is pinned to integration_id null, declared 15368`)));
  assert.ok(failed.some((m) => m.startsWith("ruleset production gained a pull_request rule, which it must not have.")));
});

test("CodeQL default setup switched on beside the committed workflow fails", () => {
  const observed = matchingRepository();
  observed.codeScanning = ok({ state: "configured" });
  const failed = fails(compareRepository(repo, observed, anonymous));
  assert.equal(failed.length, 1);
  assert.match(failed[0], /^CodeQL default setup is "configured", declared "not-configured"/);
});

// ------------------------------------------------- Workers Builds commands ----

const siteConfigFor = (release) => ({ name: release.worker, build: { command: "bun tools/build.ts" }, preview_urls: release.preview_urls });

test("tree tier: a declared deploy command that lost a provisioning pin fails, for either command and either flag", () => {
  assert.deepEqual(fails(compareReleaseDeclaration(infra.release, siteConfigFor(infra.release))), [], "control: the committed release block is clean");

  for (const field of ["deploy_command", "non_production_deploy_command"]) {
    for (const flag of ["--x-provision=false", "--x-auto-create=false"]) {
      const release = { ...infra.release, [field]: infra.release[field].replace(` ${flag}`, "") };
      const failed = fails(compareReleaseDeclaration(release, siteConfigFor(release)));
      assert.equal(failed.length, 1, `${field} without ${flag}`);
      assert.ok(failed[0].startsWith(`infra.json's release.${field} must pin ${flag} `), failed[0]);
    }
  }
});

test("tree tier: a branch build that deploys, and a production command that only uploads, each fail", () => {
  const deploys = { ...infra.release, non_production_deploy_command: infra.release.deploy_command };
  assert.ok(fails(compareReleaseDeclaration(deploys, siteConfigFor(deploys)))[0].includes("must be a `versions upload`"));
  const uploads = { ...infra.release, deploy_command: infra.release.non_production_deploy_command };
  assert.ok(fails(compareReleaseDeclaration(uploads, siteConfigFor(uploads)))[0].includes("should be a `deploy`"));
});

test("API tier: a live deploy command that lost --x-provision=false fails, on both triggers", () => {
  const clean = compareWorkersBuilds(infra.release, ok({ tag: "tag-1", triggers: matchingTriggers() }));
  assert.deepEqual(fails(clean), [], "control: matching triggers are clean");
  assert.equal(passes(clean).length, 4);

  const prod = matchingTriggers();
  prod[0].deploy_command = prod[0].deploy_command.replace(" --x-provision=false", "");
  const prodFailed = fails(compareWorkersBuilds(infra.release, ok({ tag: "tag-1", triggers: prod })));
  assert.equal(prodFailed.length, 1);
  assert.ok(prodFailed[0].startsWith("Workers Builds deploy_command is "));

  const branch = matchingTriggers();
  branch[1].deploy_command = branch[1].deploy_command.replace(" --x-provision=false", "");
  const branchFailed = fails(compareWorkersBuilds(infra.release, ok({ tag: "tag-1", triggers: branch })));
  assert.equal(branchFailed.length, 1);
  assert.ok(branchFailed[0].includes("it is missing --x-provision=false, so a push to ANY branch publishes with resource creation ON"));

  // The wrapped envelope reads the same as the bare list.
  assert.deepEqual(fails(compareWorkersBuilds(infra.release, ok({ tag: "tag-1", triggers: { triggers: matchingTriggers() } }))), []);
});

test("API tier: a triggers payload of an unknown shape is an advisory, and no production trigger is a failure", () => {
  const odd = compareWorkersBuilds(infra.release, ok({ tag: "tag-1", triggers: { surprise: true } }));
  assert.deepEqual(fails(odd), []);
  assert.deepEqual(passes(odd), []);
  assert.match(warns(odd)[0], /^release config unchecked: unexpected triggers response shape/);

  const none = compareWorkersBuilds(infra.release, ok({ tag: "tag-1", triggers: [{ branch_includes: ["staging"] }] }));
  assert.match(fails(none)[0], /^Workers Builds has no trigger matching the production branch/);
});

// -------------------------------------------------------------------- DNS ----

test("a DNS record that drifted fails, naming declared and live", () => {
  assert.deepEqual(fails(compareDns(infra, matchingDns())), [], "control: matching answers are clean");
  assert.deepEqual(warns(compareDns(infra, matchingDns())), []);

  const mx = infra.dns.find((r) => r.type === "MX");
  const observed = matchingDns();
  observed.set(dnsKey(mx.name, "MX"), { answers: ["10 mail.attacker.example."], authenticated: true, resolver: "fixture" });
  const failed = fails(compareDns(infra, observed));
  assert.equal(failed.length, 1);
  assert.ok(failed[0].startsWith(`MX ${mx.name} drifted\n      declared: `));
  assert.ok(failed[0].endsWith("live:     10 mail.attacker.example."));
});

test("a subdomain off the apex's edge, a lost HTTPS parameter and a wrong DS each fail", () => {
  const observed = matchingDns();
  const same = infra.dns.find((r) => r.match === "sameAs");
  observed.set(dnsKey(same.name, "A"), { answers: ["203.0.113.9"], authenticated: true, resolver: "fixture" });
  const https = infra.dns.find((r) => r.match === "contains");
  observed.set(dnsKey(https.name, https.type), { answers: [`1 . ${https.expect[0]}`], authenticated: true, resolver: "fixture" });
  observed.set(dnsKey(infra.zone.name, "DS"), { answers: ["1 13 2 deadbeef"], authenticated: true, resolver: "fixture" });
  const failed = fails(compareDns(infra, observed));
  assert.ok(failed.some((m) => m.startsWith(`${same.name} no longer resolves to the same edge as ${same.expect}`)));
  assert.ok(failed.some((m) => m.startsWith(`${https.type} ${https.name} lost ${JSON.stringify(https.expect[1])}`)));
  assert.ok(failed.some((m) => m.startsWith("DNSSEC DS drifted")));
});

test("a lookup nobody made is an advisory, never a missing record and never a pass", () => {
  const observed = matchingDns();
  const txt = infra.dns.find((r) => r.match === "present");
  observed.delete(dnsKey(txt.name, txt.type));
  const findings = compareDns(infra, observed);
  assert.deepEqual(fails(findings), []);
  assert.deepEqual(warns(findings), [`could not resolve ${txt.type} ${txt.name} (no observation was recorded for this lookup)`]);
  // Control: the EMPTY answer the gap must not be mistaken for is a failure.
  observed.set(dnsKey(txt.name, txt.type), { answers: [], authenticated: true, resolver: "fixture" });
  assert.equal(fails(compareDns(infra, observed)).length, 1);
});

test("the DNS port asks for every lookup the comparer reads", () => {
  const keys = new Set(dnsQueries(infra).map((q) => dnsKey(q.name, q.type)));
  for (const key of matchingDns().keys()) assert.ok(keys.has(key), `${key} is compared but never queried`);
});

// ------------------------------------------------------------------- edge ----

const edgeCheck = (id) => infra.edge.checks.find((c) => c.id === id);

test("edge: a header the zone added is a production drift; its absence passes", () => {
  const check = edgeCheck("speed-brain-off");
  const clean = compareEdgeCheck(check, { kind: "response", headers: {} }, { hostedRunner: false });
  assert.deepEqual(clean, [{ level: "pass", message: "edge speed-brain-off holds" }]);
  const drift = compareEdgeCheck(check, { kind: "response", headers: { "speculation-rules": '"/cdn-cgi/speculation"' } }, { hostedRunner: false });
  assert.equal(drift[0].level, "fail");
  assert.ok(drift[0].message.startsWith('production edge: speed-brain-off: speculation-rules is present ("/cdn-cgi/speculation")'));
});

// Replaces a source-text assertion: the old test sliced check-infra.ts at
// `if (want.earlyData)` and matched `process.env.GITHUB_ACTIONS) warn(` in the
// slice. That passes on any code that merely SPELLS the split. Three spaced
// rejections from GitHub's network have read as drift while the zone was fine
// (2026-08-20, and twice on 2026-09-02); a workstation has never produced one.
test("early data: a rejection is advisory on a hosted runner and a drift on a workstation", () => {
  const check = edgeCheck("tls-0rtt-on");
  /** @type {import("./lib/infra-compare.ts").EdgeObservation} */
  const rejected = { kind: "early-data", result: { accepted: false, attempts: 3 } };

  const hosted = compareEdgeCheck(check, rejected, { hostedRunner: true });
  assert.equal(hosted.length, 1);
  assert.equal(hosted[0].level, "warn");
  assert.ok(hosted[0].message.includes("rejected on 3 spaced resumptions from a hosted runner"));

  const workstation = compareEdgeCheck(check, rejected, { hostedRunner: false });
  assert.equal(workstation[0].level, "fail");
  assert.ok(workstation[0].message.startsWith("production edge: tls-0rtt-on: TLS early data rejected on 3 spaced resumptions"));

  assert.equal(compareEdgeCheck(check, { kind: /** @type {const} */ ("early-data"), result: { accepted: true, attempts: 1 } }, { hostedRunner: true })[0].level, "pass");
  // A machine that cannot run the probe has measured nothing.
  assert.equal(compareEdgeCheck(check, { kind: "early-data", result: { skip: "no openssl" } }, { hostedRunner: false })[0].level, "warn");
});

test("edge: an observation of the wrong kind, a missing body and a missing check are advisories", () => {
  const body = edgeCheck("rocket-loader-off");
  /** @type {(import("./lib/infra-compare.ts").EdgeObservation | undefined)[]} */
  const unusable = [{ kind: "response", headers: {} }, { kind: "prefers", got: "br" }, undefined];
  for (const seen of unusable) {
    const findings = compareEdgeCheck(body, seen, { hostedRunner: false });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].level, "warn", JSON.stringify(seen));
  }
  const compression = edgeCheck("compression-on");
  const partial = compareEdgeCheck(compression, { kind: "compression", got: { zstd: "zstd" } }, { hostedRunner: false });
  assert.equal(partial[0].level, "warn", "an encoding nobody asked for cannot be reported as served");
});

// ------------------------------------------------------- Cloudflare tier ----

const bindings = {
  kv_namespaces: [{ binding: "RN_KV", id: "kv-1" }],
  r2_buckets: [{ binding: "PHOTOS_R2", bucket_name: "aadhar-photos" }],
  d1_databases: [{ binding: "RESTORE_DB", database_id: "d1-1", database_name: "aadhar-restore" }],
};

test("a binding pointing at a resource the account does not hold fails; a renamed D1 fails", () => {
  assert.deepEqual(fails(compareKvNamespaces(bindings, ok([{ id: "kv-1" }]))), []);
  assert.match(fails(compareKvNamespaces(bindings, ok([{ id: "other" }])))[0], /^KV binding RN_KV points at namespace kv-1, which does not exist/);
  assert.match(fails(compareR2Buckets(bindings, ok({ buckets: [] })))[0], /^R2 binding PHOTOS_R2 points at bucket aadhar-photos/);
  assert.match(fails(compareD1Databases(bindings, ok([{ uuid: "d1-1", name: "renamed" }])))[0], /expects aadhar-restore but d1-1 is named renamed$/);
});

test("a retired Worker still deployed fails, and an unaccounted one is an advisory", () => {
  const expected = infra.workers.expected.map((w) => ({ id: w.name }));
  assert.deepEqual(fails(compareWorkerInventory(infra.workers, ok(expected))), []);
  const retired = infra.workers.retired[0];
  const findings = compareWorkerInventory(infra.workers, ok([...expected, { id: retired.name }, { id: "mystery-worker" }]));
  assert.ok(fails(findings)[0].startsWith(`Worker ${retired.name} is retired but still deployed`));
  assert.ok(warns(findings).includes("Worker mystery-worker is deployed but not accounted for in infra.json"));
});

// Replaces a source-text assertion: the old test matched
// `assertZoneSetting(...infra.zone?.shared_dictionary)` in check-infra.ts,
// which proves a call is written and nothing about what it does with
// `disabled`, the one value that drops every dcz tier to plain brotli.
test("zone settings: shared_dictionary_mode disabled and 0-RTT off each fail; an unseen zone is an advisory", () => {
  const shared = infra.zone.shared_dictionary;
  assert.equal(shared.value, "passthrough");
  const on = compareZoneSetting(SHARED_DICTIONARY_SECTION, shared, infra.zone.name, ok({ zoneId: "z", setting: { value: "passthrough" } }));
  assert.deepEqual(on, [{ level: "pass", message: "zone setting shared_dictionary_mode is passthrough" }]);
  const off = compareZoneSetting(SHARED_DICTIONARY_SECTION, shared, infra.zone.name, ok({ zoneId: "z", setting: { value: "disabled" } }));
  assert.ok(fails(off)[0].startsWith(`zone setting shared_dictionary_mode is "disabled" on ${infra.zone.name}, declared "passthrough".`));

  const rtt = compareZoneSetting(ZERO_RTT_SECTION, infra.zone.zero_rtt, infra.zone.name, ok({ zoneId: "z", setting: { value: "off" } }));
  assert.ok(fails(rtt)[0].startsWith('zone setting 0rtt is "off"'));

  const unseen = compareZoneSetting(ZERO_RTT_SECTION, infra.zone.zero_rtt, infra.zone.name, ok({ zoneId: null }));
  assert.deepEqual(unseen, [{ level: "warn", message: `0-RTT unchecked: this token sees no zone named ${infra.zone.name}` }]);
  assert.deepEqual(compareZoneSetting(ZERO_RTT_SECTION, undefined, infra.zone.name, undefined), [], "an undeclared setting is not a check");
});

test("version affinity: no ruleset, a disabled rule and a static key each fail", () => {
  const declared = infra.zone.version_affinity;
  const zone = infra.zone.name;
  const rule = (over = {}) => ({
    enabled: true,
    expression: `not any(http.request.headers.names[*] == "${declared.header.toLowerCase()}")`,
    action_parameters: { headers: { [declared.header]: { operation: "set", expression: declared.value } } },
    ...over,
  });
  const read = (ruleset) => ok({ zoneId: "z", ruleset });

  assert.equal(compareVersionAffinity(declared, zone, read({ rules: [rule()] }))[0].level, "pass");
  assert.ok(fails(compareVersionAffinity(declared, zone, read(null)))[0].startsWith(`no ${declared.phase} ruleset on ${zone}`));
  assert.ok(fails(compareVersionAffinity(declared, zone, read({ rules: [] })))[0].startsWith(`no Transform Rule on ${zone} sets`));
  assert.ok(fails(compareVersionAffinity(declared, zone, read({ rules: [rule({ enabled: false })] })))[0].includes("is DISABLED"));
  const fixed = rule({ action_parameters: { headers: { [declared.header]: { operation: "set", value: "one-key" } } } });
  assert.ok(fails(compareVersionAffinity(declared, zone, read({ rules: [fixed] })))[0].includes("is set STATICALLY"));
  assert.ok(fails(compareVersionAffinity(declared, zone, read({ rules: [rule({ expression: "true" })] })))[0].includes("does not exempt requests"));
});

test("a read-only token carrying an Edit group fails; one carrying none passes", () => {
  const want = infra.tokens.expected.find((t) => t.checked && !t.may_write);
  assert.ok(want, "infra.json no longer declares a checked read-only token");
  const token = (groups) => ok([{ name: want.name, policies: [{ permission_groups: groups.map((name) => ({ name })), resources: { "com.cloudflare.api.account.acct": "*" } }] }]);
  const narrow = compareTokens(infra, "acct", token(["Workers Scripts Read"]));
  assert.deepEqual(fails(narrow), []);
  const wide = compareTokens(infra, "acct", token(["Workers Scripts Read", "Workers KV Storage Write"]));
  assert.ok(fails(wide)[0].startsWith(`token ${want.name} (${want.env}) is declared read-only but carries Workers KV Storage Write`));
});

// ---------------------------------------------- a failed read, per port ----
//
// The invariant: a read that failed or was refused is an ADVISORY. It is never
// a pass, never a hard failure, and never an empty observation that compares
// clean. Each port gets a 401, a 403 and a network throw through its real
// adapter, so the whole seam is exercised and not the comparer alone.

const refusals = {
  401: () => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401),
  403: () => json({ success: false, errors: [{ code: 9109, message: "Unauthorized to access requested resource" }] }, 403),
  throw: () => { throw new Error("fetch failed: socket hang up"); },
};

for (const [how, respond] of Object.entries(refusals)) {
  const fetchImpl = async () => respond();

  test(`Cloudflare port, ${how}: every section is one advisory and nothing else`, async () => {
    const cf = cloudflareReader("unused-token-value", fetchImpl);
    const zone = infra.zone.name;
    /** @type {[string, string, import("./lib/infra-compare.ts").Finding[]][]} */
    const sections = [
      ["KV namespaces", "Workers KV Storage:Read", compareKvNamespaces(bindings, await readKvNamespaces(cf, "acct"))],
      ["R2 buckets", "Workers R2 Storage:Read", compareR2Buckets(bindings, await readR2Buckets(cf, "acct"))],
      ["D1 databases", "D1:Read", compareD1Databases(bindings, await readD1Databases(cf, "acct"))],
      ["Workers Builds release config", "Workers Builds Configuration:Read", compareWorkersBuilds(infra.release, await readWorkersBuilds(cf, "acct", infra.release.worker))],
      ["Worker inventory", "Workers Scripts:Read", compareWorkerInventory(infra.workers, await readWorkerScripts(cf, "acct"))],
      ["API token scoping", "API Tokens Read", compareTokens(infra, "acct", await readTokens(cf, "acct"))],
      ["0-RTT connection resumption", "Zone:Zone Settings:Read and Zone:Zone:Read", compareZoneSetting(ZERO_RTT_SECTION, infra.zone.zero_rtt, zone, await readZoneSetting(cf, zone, "0rtt"))],
      ["version affinity", "Zone:Transform Rules:Read and Zone:Zone:Read", compareVersionAffinity(infra.zone.version_affinity, zone, await readVersionAffinity(cf, zone, infra.zone.version_affinity.phase))],
    ];
    for (const [label, scope, findings] of sections) {
      assert.equal(findings.length, 1, label);
      assert.equal(findings[0].level, "warn", label);
      assert.ok(findings[0].message.startsWith(`${label} unchecked: `), findings[0].message);
      // An unauthorised read names the scope the token is missing. A network
      // failure names no scope, because no scope would have helped.
      assert.equal(findings[0].message.includes(`token is missing ${scope}`), how !== "throw", findings[0].message);
    }
  });

  test(`GitHub port, ${how}: the repository tier is one advisory and nothing else`, async () => {
    const observed = await readRepository(githubReader(undefined, fetchImpl), repo, { total: 0, without: [] });
    const findings = compareRepository(repo, observed, anonymous);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].level, "warn");
    assert.ok(findings[0].message.startsWith("repository rulesets could not be read: "), findings[0].message);
  });

  test(`DNS port, ${how}: every record is an advisory and nothing passes or fails`, async () => {
    const findings = compareDns(infra, await readDns(dnsQueries(infra), fetchImpl));
    assert.deepEqual(fails(findings), []);
    assert.deepEqual(passes(findings), []);
    assert.equal(warns(findings).length, infra.dns.length + 2);
    assert.ok(warns(findings).every((m) => m.startsWith("could not resolve ") || m.startsWith("could not compare ")));
  });

  test(`edge port, ${how}: a response that carries nothing asserted is never a pass by omission`, async () => {
    const port = { fetchEdge: edgeFetcher(fetchImpl), probeEarlyData: async () => ({ skip: "fixture has no openssl" }) };
    const findings = compareEdge(infra.edge, await readEdge(infra.edge, port), { hostedRunner: false });
    if (how === "throw") {
      assert.deepEqual(fails(findings), []);
      assert.deepEqual(passes(findings), []);
      assert.equal(warns(findings).length, infra.edge.checks.length);
    } else {
      // A 401 from production IS an observation: the edge answered, without the
      // headers the declaration requires. It must not read as "holds".
      assert.ok(fails(findings).some((m) => m.startsWith("production edge: hsts-preload: strict-transport-security is ")));
      assert.ok(!passes(findings).some((m) => m.includes("hsts-preload") || m.includes("compression-on")));
    }
  });
}

test("GitHub port: the Administration-gated endpoints answering 401 and 403 are advisories naming the workstation command", async () => {
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname;
    if (path === `/repos/${slug}`) return json({ visibility: repo.visibility });
    if (path === `/repos/${slug}/rulesets`) return json(repo.rulesets.map((r, i) => ({ id: i + 1, name: r.name })));
    const detail = /\/rulesets\/(\d+)$/.exec(path);
    if (detail) return json(rulesetDetail(repo.rulesets[Number(detail[1]) - 1]));
    if (path === `/repos/${slug}/labels`) return json(liveLabels());
    if (path.endsWith("/code-scanning/default-setup")) return json({ message: "Forbidden" }, 403);
    return json({ message: "Requires authentication" }, 401);
  };
  const observed = await readRepository(githubReader(undefined, fetchImpl), repo, { total: 0, without: [] });
  const findings = compareRepository(repo, observed, anonymous);
  assert.deepEqual(fails(findings), []);
  assert.equal(passes(findings).length, 2, "rulesets and labels are public reads and still pass");
  const notes = warns(findings);
  assert.equal(notes.length, 3);
  assert.ok(notes[0].startsWith("CodeQL default setup: not verifiable here"));
  assert.ok(notes[1].startsWith("Actions permissions: not verifiable here"));
  assert.ok(notes[2].startsWith("secret scanning: not verifiable here"));
  assert.ok(notes.every((m) => m.includes("GITHUB_TOKEN=$(gh auth token) bun run infra:check")));
});

test("GitHub port: one ruleset detail failing to load costs that ruleset an advisory, not the tier", async () => {
  const observed = matchingRepository();
  observed.core.value.details.main = { ok: false, error: "GitHub API returned HTTP 502 for /repos/x/rulesets/1" };
  delete observed.core.value.details.production;
  const findings = compareRulesets(repo, observed.core, anonymous).findings;
  assert.deepEqual(fails(findings), []);
  assert.deepEqual(warns(findings), [
    "ruleset main could not be read in full: GitHub API returned HTTP 502 for /repos/x/rulesets/1",
    "ruleset production could not be read in full: no observation was recorded for this read",
  ]);
});

test("a failed read is not an empty read: the empty list it must not become is a failure", async () => {
  // The control for the whole block above. If an adapter swallowed its error
  // and handed back `[]`, these are the findings the run would print.
  const empty = cloudflareReader("unused-token-value", async () => json({ success: true, result: [] }));
  assert.equal(fails(compareKvNamespaces(bindings, await readKvNamespaces(empty, "acct"))).length, 1);
  assert.equal(fails(compareWorkerInventory(infra.workers, await readWorkerScripts(empty, "acct"))).length, infra.workers.expected.length);
  assert.equal(fails(compareLabels(repo, ok([]), anonymous)).length, repo.triage.labels.length);
});

// ------------------------------------------------------------- redaction ----

const TOKEN = "abcd1234abcd1234abcd1234abcd1234abcd1234"; // 40, a Cloudflare token's length

test("a token-shaped string in an adapter error never reaches the output", async () => {
  // The worst realistic leak: an upstream (or a proxy) echoes the bearer token
  // back in its error, and the adapter faithfully puts that text in a finding.
  const echoing = async (_url, init) => { throw new Error(`upstream rejected ${new Headers(init.headers).get("authorization")}`); };
  const cf = cloudflareReader(TOKEN, echoing);
  const findings = [
    ...compareKvNamespaces(bindings, await readKvNamespaces(cf, "acct")),
    ...compareRepository(repo, await readRepository(githubReader(TOKEN, echoing), repo, { total: 0, without: [] }), { authenticated: true }),
  ];
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.message.includes(TOKEN)), "the fixture must really carry the token, or this test proves nothing");

  const env = { CLOUDFLARE_API_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN };
  const report = createReport(env);
  report.add(findings);
  for (const strict of [false, true]) {
    const { stdout, stderr } = report.render({ strict });
    const printed = [...stdout, ...stderr].join("\n");
    assert.equal(printed.includes(TOKEN), false, "the token must not survive into anything a run prints");
    assert.equal(printed.split("[redacted]").length - 1, 2, "and is replaced, once per message, rather than dropped");
  }
  assert.equal([...report.hard, ...report.advisory, ...report.ok].join("\n").includes(TOKEN), false, "the store itself never holds it");

  // Control: the same findings through a report that knows no credential print
  // the token, so the assertion above is the barrier's doing.
  const blind = createReport({});
  blind.add(findings);
  assert.equal(blind.render().stdout.join("\n").includes(TOKEN), true);
});

test("the report renders the three outcomes infra:check has always printed", () => {
  const clean = createReport({});
  clean.add([{ level: "pass", message: "a" }, { level: "warn", message: "b" }]);
  assert.deepEqual(clean.render(), { stdout: ["  ok    a", "  note  b", "\ninfra ok: 1 checks passed, 1 skipped or advisory"], stderr: [], exitCode: 0 });
  assert.deepEqual(clean.render({ strict: true }), { stdout: ["  ok    a", "  note  b"], stderr: ["\n--strict: 1 advisory treated as failures"], exitCode: 1 });

  const drifted = createReport({});
  drifted.add([{ level: "fail", message: "c" }, { level: "pass", message: "a" }]);
  assert.deepEqual(drifted.render(), { stdout: ["  ok    a"], stderr: ["\ninfra drift detected (1):", "  - c"], exitCode: 1 });
});
