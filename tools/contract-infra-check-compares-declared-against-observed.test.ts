// ── infra:check compares a declaration against a RECORDED observation ───────
//
// These tests drive responses through the comparers instead of reading
// tools/check-infra.ts's SOURCE. A regex over source can say "a comparison is
// written here". It cannot say "a bypass actor fails by name", because that
// needs a response to compare. The comparers are a module
// (tools/lib/infra-compare.ts) and the adapters take a `fetch`
// (tools/lib/infra-ports.ts), so every drift case below is a fixture.
//
// Each drift test carries its control in the same test: the unmodified fixture
// produces zero failures, so the failure asserted is the mutation's and not
// the fixture's. The declaration is the real config/infra.json throughout.
import { assert, readFileSync, test } from "./contract-shared.ts";
import { agentRepresentation, agentSurfaces } from "./lib/agent-representation.ts";
import {
  AGENT_SURFACE_FLOOR, compareAgentCoverage,
  compareD1Databases, compareDns, compareEdge, compareEdgeCheck, compareKvNamespaces,
  compareLabels, compareR2Buckets, compareReleaseDeclaration, compareRepository,
  compareRulesets, compareTokens, compareVersionAffinity, compareWorkerInventory,
  compareWorkersBuilds, compareZoneSetting, dnsKey, dnsQueries,
  SHARED_DICTIONARY_SECTION, ZERO_RTT_SECTION,
} from "./lib/infra-compare.ts";
import {
  cloudflareReader, edgeFetcher, githubReader, readAgentAnswers, readD1Databases, readDns, readEdge,
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
 *
 *
 * */
const ok = <T>(value: T): { ok: true, value: T } => ({ ok: true, value });
const clone = (value) => structuredClone(value);

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
  const answer = (name, type, answers) => observed.set(dnsKey(name, type), { answers: [...answers].sort((a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0), authenticated: true, resolver: "fixture" });
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
/** A response as Cloudflare's edge serves one: whatever the status, it carries
 *  cf-ray. The edge port measures nothing that lacks it (gotcha 60).
 * */
const edgeServed = (res: Response) => { res.headers.set("cf-ray", "8f1e2d3c4b5a6978-SJC"); return res; };

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

const edgeCheck = (id) => infra.edge.checks.find((c) => c.id === id);

test("edge: a header the zone added is a production drift; its absence passes", () => {
  const check = edgeCheck("speed-brain-off");
  const clean = compareEdgeCheck(check, { kind: "response", headers: {} }, { hostedRunner: false });
  assert.deepEqual(clean, [{ level: "pass", message: "edge speed-brain-off holds" }]);
  const drift = compareEdgeCheck(check, { kind: "response", headers: { "speculation-rules": '"/cdn-cgi/speculation"' } }, { hostedRunner: false });
  assert.equal(drift[0].level, "fail");
  assert.ok(drift[0].message.startsWith('production edge: speed-brain-off: speculation-rules is present ("/cdn-cgi/speculation")'));
});

// The probe goes to a page with no twin and asks for Markdown, so the zone
// converting it is the only way text/markdown comes back. Driven through the
// real port: a target that resolved to the homepage would hold a twin, and the
// worker's own Markdown would read as the zone's.
test("edge: Markdown for Agents converting a page with no twin is a drift; the page's own HTML passes", async () => {
  const check = edgeCheck("markdown-for-agents-converts-nothing");
  const edge = { origin: "https://aadhar.sh", checks: [check] };
  const seen: any[] = [];
  const portAnswering = (contentType) => ({
    probeEarlyData: async () => ({ skip: "unused" }),
    fetchEdge: async (url, headers: Record<string, any> = {}) => {
      seen.push({ url, accept: headers.accept });
      if (url.endsWith("/writing/posts.json")) return edgeServed(json([{ slug: "colophon" }, { slug: "in-flux" }]));
      return edgeServed(new Response("body", { headers: { "content-type": contentType } }));
    },
  });

  const clean = compareEdge(edge, await readEdge(edge, portAnswering("text/html; charset=utf-8")), { hostedRunner: false });
  assert.deepEqual(clean, [{ level: "pass", message: "edge markdown-for-agents-converts-nothing holds" }]);
  assert.deepEqual(seen.at(-1), { url: "https://aadhar.sh/writing/colophon", accept: "text/markdown" });

  const converted = compareEdge(edge, await readEdge(edge, portAnswering("text/markdown; charset=utf-8")), { hostedRunner: false });
  assert.equal(converted[0].level, "fail");
  assert.ok(converted[0].message.startsWith('production edge: markdown-for-agents-converts-nothing: content-type does not contain "text/html"'), converted[0].message);

  // No post to probe is an unmeasured check, never a pass.
  const empty = { probeEarlyData: async () => ({ skip: "unused" }), fetchEdge: async () => edgeServed(json([])) };
  const unresolved = compareEdge(edge, await readEdge(edge, empty), { hostedRunner: false });
  assert.equal(unresolved[0].level, "warn");
  assert.ok(unresolved[0].message.includes("could not resolve its target: posts.json carried no post slug"), unresolved[0].message);
});

// Replaces a source-text assertion: the old test sliced check-infra.ts at
// `if (want.earlyData)` and matched `process.env.GITHUB_ACTIONS) warn(` in the
// slice. That passes on any code that merely SPELLS the split. Three spaced
// rejections from GitHub's network have read as drift while the zone was fine
// (2026-08-20, and twice on 2026-09-02); a workstation has never produced one.
test("early data: a rejection is advisory on a hosted runner and a drift on a workstation", () => {
  const check = edgeCheck("tls-0rtt-on");

  const rejected: import("./lib/infra-compare.ts").EdgeObservation = { kind: "early-data", result: { accepted: false, attempts: 3 } };

  const hosted = compareEdgeCheck(check, rejected, { hostedRunner: true });
  assert.equal(hosted.length, 1);
  assert.equal(hosted[0].level, "warn");
  assert.ok(hosted[0].message.includes("rejected on 3 spaced resumptions from a hosted runner"));

  const workstation = compareEdgeCheck(check, rejected, { hostedRunner: false });
  assert.equal(workstation[0].level, "fail");
  assert.ok(workstation[0].message.startsWith("production edge: tls-0rtt-on: TLS early data rejected on 3 spaced resumptions"));

  assert.equal(compareEdgeCheck(check, { kind:  ("early-data" as const), result: { accepted: true, attempts: 1 } }, { hostedRunner: true })[0].level, "pass");
  // A machine that cannot run the probe has measured nothing.
  assert.equal(compareEdgeCheck(check, { kind: "early-data", result: { skip: "no openssl" } }, { hostedRunner: false })[0].level, "warn");
});

test("edge: an observation of the wrong kind, a missing body and a missing check are advisories", () => {
  const body = edgeCheck("rocket-loader-off");

  const unusable: (import("./lib/infra-compare.ts").EdgeObservation | undefined)[] = [{ kind: "response", headers: {} }, { kind: "prefers", got: "br" }, undefined];
  for (const seen of unusable) {
    const findings = compareEdgeCheck(body, seen, { hostedRunner: false });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].level, "warn", JSON.stringify(seen));
  }
  const compression = edgeCheck("compression-on");
  const partial = compareEdgeCheck(compression, { kind: "compression", got: { zstd: "zstd" } }, { hostedRunner: false });
  assert.equal(partial[0].level, "warn", "an encoding nobody asked for cannot be reported as served");
});

// The registry these tests judge is the real one, so a surface added tomorrow
// is covered by them without an edit.

type AgentSurface = import("./lib/agent-representation.ts").AgentSurface;

type AgentAnswer = import("./lib/infra-compare.ts").AgentAnswer;

const agentPages: AgentSurface[] = agentSurfaces(JSON.parse(readFileSync("config/site-manifest.json", "utf8")).surfaces);

const agentPage = (i: number) => {
  const p = agentPages[i];
  if (!p) throw new Error(`the registry has no agents surface at ${i}`);
  return p;
};
/** Every surface answering in its declared representation.
 * */
const agentAnswersOk = (): Map<string, AgentAnswer> => new Map(agentPages.map((p) => [p.path, { kind: "answer", contentType: agentRepresentation(p) }]));

const pageServing = (type: string) => {
  const p = agentPages.find((s) => agentRepresentation(s) === type);
  if (!p) throw new Error(`no agents surface declares ${type}`);
  return p;
};
const markdownPage = () => pageServing("text/markdown");
const plainPage = () => pageServing("text/plain");

test("agent coverage: every surface in its declared representation is the one pass", () => {
  assert.ok(agentPages.length >= AGENT_SURFACE_FLOOR, `the registry reads ${agentPages.length} agents surfaces`);
  assert.deepEqual(compareAgentCoverage(agentPages, agentAnswersOk()), [
    { level: "pass", message: `agent markdown coverage: all ${agentPages.length} agents:true surfaces answer an agent in their declared representation` },
  ]);
});

test("agent coverage: HTML where Markdown is owed, and a redirect, are gaps named by path", () => {
  const html = markdownPage();
  const moved = agentPage(agentPages[0] === html ? 1 : 0);
  const answers = agentAnswersOk();
  answers.set(html.path, { kind: "answer", contentType: "text/html" });
  answers.set(moved.path, { kind: "redirect", status: 302, location: "https://open.spotify.com/" });
  const n = agentPages.length;
  // Gaps are listed in registry order.
  const named = agentPages.filter((p) => p === html || p === moved)
    .map((p) => (p === html ? `${p.path} (text/html)` : `${p.path} (302 to https://open.spotify.com/)`));
  assert.deepEqual(compareAgentCoverage(agentPages, answers), [{
    level: "warn",
    message: `agent markdown coverage: ${n - 2}/${n} measured agents:true surfaces answer Accept: text/markdown in their declared representation. No twin: ${named.join(", ")}. Give each one a twin, declare the representation its route serves (mimeType), or drop flags.agents so the registry stops advertising it`,
  }]);
  // The rule is per surface: text/plain is right for a terminal tool and a gap
  // where Markdown is owed.
  const swapped = agentAnswersOk();
  swapped.set(plainPage().path, { kind: "answer", contentType: "text/markdown" });
  assert.equal(compareAgentCoverage(agentPages, swapped)[0].level, "warn");
});

test("agent coverage: an unmeasured surface blocks the pass and is never counted as a twin", () => {
  const answers = agentAnswersOk();
  const lost = plainPage();
  answers.set(lost.path, { kind: "unmeasured", reason: "HTTP 403 without cf-ray" });
  const findings = compareAgentCoverage(agentPages, answers);
  assert.deepEqual(findings, [{ level: "warn", message: `agent markdown coverage left 1/${agentPages.length} surfaces unmeasured: ${lost.path} (HTTP 403 without cf-ray)` }]);

  // Alongside a gap, the gap's denominator is what was measured.
  answers.set(markdownPage().path, { kind: "answer", contentType: "text/html" });
  const both = compareAgentCoverage(agentPages, answers);
  assert.equal(both.length, 2);
  assert.ok(both[1].message.startsWith(`agent markdown coverage: ${agentPages.length - 2}/${agentPages.length - 1} measured `), both[1].message);
  assert.ok(both.every((f) => f.level === "warn"));
});

test("agent coverage: nothing measured is 'could not run', whether every probe threw or the port never asked", () => {

  const threw: Map<string, AgentAnswer> = new Map(agentPages.map((p) => [p.path, { kind: "unmeasured", reason: "fetch failed: socket hang up" }]));
  assert.deepEqual(compareAgentCoverage(agentPages, threw), [{
    level: "warn",
    message: `agent markdown coverage could not run: Cloudflare's edge answered none of the ${agentPages.length} probes (first: ${agentPage(0).path} (fetch failed: socket hang up))`,
  }]);
  const never = compareAgentCoverage(agentPages, new Map());
  assert.equal(never.length, 1);
  assert.equal(never[0].level, "warn");
  assert.ok(never[0].message.endsWith(`(first: ${agentPage(0).path} (no observation was recorded))`), never[0].message);
});

test("agent coverage: a registry under the floor says so and judges nothing", () => {
  const few = agentPages.slice(0, AGENT_SURFACE_FLOOR - 1);
  assert.deepEqual(compareAgentCoverage(few, agentAnswersOk()), [
    { level: "warn", message: `agent markdown coverage read only ${few.length} agents:true surfaces. Has the registry stopped parsing?` },
  ]);
});

test("agent port: asks manually, records what the edge served, and records the rest as unmeasured", async () => {
  const [a, b, c, d, e] = [0, 1, 2, 3, 4].map(agentPage);
  const asked: any[] = [];
  const fetchImpl = async (url, init) => {
    asked.push({ path: new URL(url).pathname, accept: init.headers.accept, redirect: init.redirect });
    const path = new URL(url).pathname;
    if (path === a.path) return edgeServed(new Response("# twin", { headers: { "content-type": "text/markdown; charset=utf-8" } }));
    if (path === b.path) return edgeServed(new Response(null, { status: 302, headers: { location: "https://open.spotify.com/" } }));
    if (path === c.path) return new Response('request blocked: no rule or allowlist entry allows host "aadhar.sh"', { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    if (path === d.path) throw new Error("fetch failed: socket hang up");
    return edgeServed(new Response("<!doctype html>", { headers: { "content-type": "text/html" } }));
  };
  const answers = await readAgentAnswers("https://aadhar.sh", [a, b, c, d, e], edgeFetcher(fetchImpl));
  assert.deepEqual([...answers], [
    [a.path, { kind: "answer", contentType: "text/markdown" }],
    [b.path, { kind: "redirect", status: 302, location: "https://open.spotify.com/" }],
    [c.path, { kind: "unmeasured", reason: "HTTP 403 without cf-ray" }],
    [d.path, { kind: "unmeasured", reason: "fetch failed: socket hang up" }],
    [e.path, { kind: "answer", contentType: "text/html" }],
  ]);
  assert.ok(asked.every((q) => q.accept === "text/markdown" && q.redirect === "manual"), JSON.stringify(asked));
});

// The run that started this, end to end: the sandbox proxy's 403 for every
// probe. Port plus comparer print exactly what infra:check printed there.
test("agent port and comparer: a proxy answering every probe reads as 'could not run'", async () => {
  const proxy = async () => new Response('request blocked: no rule or allowlist entry allows host "aadhar.sh"', { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  const findings = compareAgentCoverage(agentPages, await readAgentAnswers("https://aadhar.sh", agentPages, edgeFetcher(proxy)));
  assert.deepEqual(findings, [{
    level: "warn",
    message: `agent markdown coverage could not run: Cloudflare's edge answered none of the ${agentPages.length} probes (first: ${agentPage(0).path} (HTTP 403 without cf-ray))`,
  }]);
});

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
  const rule = (over: Record<string, any> = {}) => ({
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

    const sections: [string, string, import("./lib/infra-compare.ts").Finding[]][] = [
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
    // Nothing here carries cf-ray, so no answer came from the edge.
    assert.deepEqual(fails(findings), []);
    assert.deepEqual(passes(findings), []);
    assert.equal(warns(findings).length, infra.edge.checks.length);
  });

  if (how !== "throw") {
    test(`edge port, ${how} from the edge itself: an observation, never a pass by omission`, async () => {
      const port = { fetchEdge: edgeFetcher(async () => edgeServed(respond())), probeEarlyData: async () => ({ skip: "fixture has no openssl" }) };
      const findings = compareEdge(infra.edge, await readEdge(infra.edge, port), { hostedRunner: false });
      // A 401 from production IS an observation: the edge answered, without the
      // headers the declaration requires. It must not read as "holds".
      assert.ok(fails(findings).some((m) => m.startsWith("production edge: hsts-preload: strict-transport-security is ")));
      assert.ok(!passes(findings).some((m) => m.includes("hsts-preload") || m.includes("compression-on")));
    });
  }
}

// Measured 2026-10-13: an agent sandbox's egress proxy answered every request to
// aadhar.sh with exactly this, and a whole infra:check run read it as production.
// The absence checks held and the presence checks drifted, all on a page that
// never left the sandbox. The control stamps cf-ray on the same bytes and gets
// the old passes back, so cf-ray is the one thing standing between them.
test("edge port: an egress proxy's 403 is unmeasured; the same bytes from the edge are measured", async () => {
  const proxy = () => new Response('request blocked: no rule or allowlist entry allows host "aadhar.sh"', {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
  const absences = ["speed-brain-off", "rocket-loader-off", "webmcp-bridge-off"];
  const edge = { origin: "https://aadhar.sh", checks: infra.edge.checks.filter((c) => absences.includes(c.id) || c.id === "hsts-preload") };
  const port = (respond) => ({ fetchEdge: edgeFetcher(async () => respond()), probeEarlyData: async () => ({ skip: "unused" }) });

  const blocked = compareEdge(edge, await readEdge(edge, port(proxy)), { hostedRunner: false });
  assert.deepEqual(passes(blocked), []);
  assert.deepEqual(fails(blocked), []);
  assert.equal(warns(blocked).length, edge.checks.length);
  assert.ok(warns(blocked).every((m) => m.includes("answered HTTP 403 without cf-ray")), warns(blocked).join("\n"));

  const served = compareEdge(edge, await readEdge(edge, port(() => edgeServed(proxy()))), { hostedRunner: false });
  assert.deepEqual(passes(served).sort(), absences.map((id) => `edge ${id} holds`).sort());
  assert.ok(fails(served).some((m) => m.startsWith("production edge: hsts-preload: ")));
});

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
