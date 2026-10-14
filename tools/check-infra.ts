#!/usr/bin/env node
// Diff infra.json against reality.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { siteConfig } from "./lib/site-config.ts";
import { auditActionPins } from "./lib/action-pins.ts";
import { agentSurfaces } from "./lib/agent-representation.ts";
import {
  AGENT_SURFACE_FLOOR, AUX_CONFIGS, SHARED_DICTIONARY_SECTION, ZERO_RTT_SECTION,
  compareAgentCoverage, compareD1Databases, compareDns, compareEdge, compareKvNamespaces, compareR2Buckets,
  compareRepository, compareTokens, compareTree, compareVersionAffinity,
  compareWorkerInventory, compareWorkersBuilds, compareZoneSetting, dnsQueries,
} from "./lib/infra-compare.ts";
import type { EarlyDataResult, WorkflowBlocks } from "./lib/infra-compare.ts";
import {
  cloudflareReader, edgeFetcher, githubReader, readD1Databases, readDns, readEdge,
  readKvNamespaces, readR2Buckets, readRepository, readTokens, readVersionAffinity,
  readAgentAnswers, readWorkerScripts, readWorkersBuilds, readZoneSetting,
} from "./lib/infra-ports.ts";
import { createReport } from "./lib/infra-report.ts";

const execFileP = promisify(execFile);

// TLS 1.3 0-RTT probe. Node's own tls module cannot send early data, so this
// shells out to openssl s_client — and macOS's system openssl is LibreSSL,
// which has no -early_data, so the binary is discovered rather than assumed.
// Two connections: a full handshake that saves the session ticket, then a
// resumption that sends the HTTP request AS early data and reports whether the
// edge accepted it. The first connection is held open ~2s on purpose: TLS 1.3
// delivers NewSessionTicket AFTER the handshake, so a connect-and-hangup saves
// no ticket and the test reads as a false "rejected" (cost one debugging round
// to learn).
//
// Cloudflare is ENTITLED to refuse early data on any given resumption, since
// anti-replay is the whole reason 0-RTT is hedged, so a single rejection is not
// evidence the zone setting is off. Three attempts, spaced, is: the drift is
// reported only when every spaced sample missed, and it names the count so a
// future failure says how much evidence is behind it.
async function probeEarlyData(host: string): Promise<EarlyDataResult> {
  let ossl: string | null = null;
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
    const BACKOFF_MS = [0, 1500, 4000];
    // A resumption only counts as rejected when the handshake before it completed.
    // s_client prints "New, TLSv1.3, Cipher is ..." once it has one; a host it
    // cannot reach (a sandbox with no direct egress) prints only the error, and
    // that run used to report "rejected on 3 spaced resumptions" as drift.
    let resumptions = 0;
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      if (BACKOFF_MS[attempt]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      const first = await execFileP("sh", ["-c",
        `{ cat "${req}"; sleep 2; } | "${ossl}" s_client -connect "${host}:443" -servername "${host}" -sess_out "${sess}" 2>&1`,
      ], { timeout: 20000 }).catch((e) => ({ stdout: `${e.stdout || ""}${e.stderr || ""}` }));
      if (!/^New, TLS/m.test(first.stdout || "")) continue;
      resumptions++;
      const out = await execFileP("sh", ["-c",
        `"${ossl}" s_client -connect "${host}:443" -servername "${host}" -sess_in "${sess}" -early_data "${req}" </dev/null 2>&1`,
      ], { timeout: 20000 }).catch((e) => ({ stdout: `${e.stdout || ""}${e.stderr || ""}` }));
      if (/early data was accepted/i.test(out.stdout || "")) return { accepted: true, attempts: attempt + 1 };
    }
    if (!resumptions) return { skip: `no TLS handshake with ${host}:443 completed in ${BACKOFF_MS.length} attempts, so there was no session to resume` };
    return { accepted: false, attempts: resumptions };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const ROOT = new URL("../", import.meta.url).pathname;
const OFFLINE = process.argv.includes("--offline");
const STRICT = process.argv.includes("--strict");

const report = createReport();
const { hard, fail, warn, pass } = report;

const exists = (rel) => access(join(ROOT, rel)).then(() => true, () => false);

const fetchEdge = edgeFetcher();

async function checkTree(infra, wrangler, aux: Map<string, string>) {
  const presentConsumers = new Set<string>();
  for (const record of infra.dns) {
    if (record.consumer && (await exists(record.consumer))) presentConsumers.add(record.consumer);
  }
  report.add(compareTree(infra, wrangler, { aux, presentConsumers }));

  await checkCodeqlWorkflow(infra.repository);
  await checkTriageDeclaration(infra.repository);
  await checkActionPinning(infra.repository);
}

async function checkActionPinning(repo) {
  const want = repo?.actions_permissions;
  if (!want) return;
  const before = hard.length;

  const io = {
    read: (rel: string) => readFile(join(ROOT, rel), "utf8").then((s) => s, () => null),
    async list(dir: string): Promise<string[]> {
      const out: string[] = [];
      let entries;
      try {
        entries = await readdir(join(ROOT, dir), { withFileTypes: true });
      } catch {
        return out;
      }
      for (const e of entries) {
        if (e.isDirectory()) out.push(...await io.list(`${dir}/${e.name}`));
        else if (e.isFile()) out.push(`${dir}/${e.name}`);
      }
      return out;
    },
  };

  const audit = await auditActionPins(io);

  if (!audit.files.some((f) => f.startsWith(".github/workflows/"))) {
    fail(".github/workflows holds no .yml file, so this scan read nothing. Either every workflow is gone or the walk is broken, and both are worth a red line");
    return;
  }

  const TAIL = "A tag is a mutable pointer owned by somebody else, so an unpinned ref grants that repository arbitrary code execution in CI with no diff here when they repoint it";
  for (const p of audit.problems) {
    const at = p.line ? `${p.file}:${p.line}` : p.file;
    const why = p.why ? ` ${p.why[0].toUpperCase()}${p.why.slice(1).replace(/\.?$/, ".")}` : "";
    if (p.kind === "local-missing") {
      fail(`${at} uses the local action \`${p.ref}\`, which resolves to nothing.${why} A local ref is followed and scanned here rather than exempted, because "it has no upstream owner" is true of the reference and false of the file it points at`);
    } else if (p.kind === "unreadable") {
      fail(`${at} carries a \`uses:\` this scan could not classify${p.ref === null ? "" : `, \`${p.ref}\``}.${why} An unreadable reference FAILS rather than passing: a shape nobody recognised is how three unpinned actions got reported as a clean pass`);
    } else {
      fail(`${at} uses \`${p.ref}\`, which is not pinned to a 40-character commit.${why} ${TAIL}. Pin the commit and keep the version as a trailing comment`);
    }
  }

  if (audit.remote < want.pinned_action_refs) {
    fail(
      `only ${audit.remote} third-party action reference(s) found across ${audit.files.length} file(s) under .github, expected at least ${want.pinned_action_refs}. This floor catches a scan that stopped matching, which reports a clean pass rather than an error; it cannot catch a hidden ref, and failing closed on an unreadable one is what covers that`,
    );
  }

  if (hard.length > before) return;
  pass(
    `all ${audit.remote} third-party action reference(s) across ${audit.files.length} file(s) under .github are commit-pinned (${audit.paths.size} path(s) from ${audit.repos.size} repositor${audit.repos.size === 1 ? "y" : "ies"}, plus ${audit.local} local \`./\` ref(s), every one resolved and scanned)`,
  );
}

async function checkTriageDeclaration(repo) {
  const triage = repo?.triage;
  if (!triage) return;
  const before = hard.length;

  const names = new Set<string>();
  for (const label of triage.labels) {
    const at = `infra.json triage label ${JSON.stringify(label.name)}`;
    if (names.has(label.name)) fail(`${at} is declared twice`);
    names.add(label.name);
    if (!/^[0-9a-f]{6}$/i.test(label.color || "")) fail(`${at} has colour ${JSON.stringify(label.color)}, which is not a 6-digit hex`);
    if (!label.description) fail(`${at} has no description; it is what the label list reads like to anyone but you`);

    if (!label.title && !label.paths && !label.applied_by) {
      fail(`${at} carries no \`title\` route, no \`paths\` route and no \`applied_by\`, so nothing can ever apply it`);
    }
  }

  if (triage.workflow) {
    let workflow;
    try {
      workflow = await readFile(join(ROOT, triage.workflow), "utf8");
    } catch {
      fail(`infra.json declares repository.triage.workflow but ${triage.workflow} is missing, so nothing assigns or labels anything`);
      return;
    }
    if (!workflow.includes("triage.assignee")) {
      fail(`${triage.workflow} does not read \`triage.assignee\` from infra.json; hard-coding the assignee is how the two silently disagree about who owns the inbox`);
    }
  }

  const dir = join(ROOT, ".github/workflows");
  let inline = 0;
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".yml"))) {
    const raw = await readFile(join(dir, file), "utf8");
    const text = raw.replace(/\\\n\s*/g, " ")
      .split("\n")
      .filter((line) => /\bgh\s+(?:pr|issue)\s+(?:create|edit)\b/.test(line))
      .join("\n");
    for (const m of text.matchAll(/--label\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
      const name = m[1] ?? m[2] ?? m[3];
      inline++;
      if (!names.has(name)) {
        fail(`.github/workflows/${file} passes \`--label ${JSON.stringify(name)}\`, which infra.json does not declare. \`gh pr create --label\` fails on an unknown label, so this stops that workflow rather than mislabelling it`);
      }
    }
    for (const m of text.matchAll(/--assignee\s+(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
      const who = m[1] ?? m[2] ?? m[3];
      if (who && who !== triage.assignee) {
        fail(`.github/workflows/${file} assigns ${JSON.stringify(who)} but infra.json declares ${JSON.stringify(triage.assignee)}`);
      }
    }
  }
  if (inline < triage.self_labelling_workflows) {
    fail(`only ${inline} inline \`--label\` flag(s) found across .github/workflows, expected at least ${triage.self_labelling_workflows}. A workflow that opens its own pull request cannot be triaged by triage.yml, so losing its flags is silent`);
  }

  const dbPath = triage.dependabot;
  let dependabot;
  try {
    dependabot = await readFile(join(ROOT, dbPath), "utf8");
  } catch {
    fail(`infra.json declares repository.triage.dependabot but ${dbPath} is missing, so no dependency update PR is labelled or checked`);
    return;
  }

  const scalar = (raw) => {
    const s = raw.trim();
    const quoted = /^(['"])(.*?)\1/.exec(s);
    return quoted ? quoted[2] : s.replace(/\s+#.*$/, "").trim();
  };

  const dbLines = dependabot.split("\n");
  let ecosystems = 0;
  let dbLabels = 0;
  for (let i = 0; i < dbLines.length; i++) {
    if (/^\s*-\s*package-ecosystem:/.test(dbLines[i])) ecosystems++;
    const head = /^(\s*)labels:\s*(.*)$/.exec(dbLines[i]);
    if (!head) continue;

    const listed: { name: string; line: number }[] = [];
    const flow = head[2].trim();
    if (flow.startsWith("[")) {
      for (const part of flow.replace(/^\[/, "").replace(/\]\s*$/, "").split(",")) {
        if (part.trim()) listed.push({ name: scalar(part), line: i + 1 });
      }
    } else {
      for (let j = i + 1; j < dbLines.length; j++) {
        if (/^\s*(#|$)/.test(dbLines[j])) continue;
        const item = /^(\s*)-\s*(.+)$/.exec(dbLines[j]);
        if (!item || item[1].length <= head[1].length) break;
        listed.push({ name: scalar(item[2]), line: j + 1 });
      }
    }

    for (const { name, line } of listed) {
      dbLabels++;
      if (!names.has(name)) {
        fail(`${dbPath} line ${line} asks Dependabot for \`${name}\`, which infra.json does not declare. That key REPLACES Dependabot's default labels and an unknown name is dropped in silence, so the symptom is a pull request MISSING a label rather than an error`);
      }
    }
  }
  if (ecosystems < triage.dependabot_ecosystems) {
    fail(`only ${ecosystems} \`package-ecosystem:\` entr${ecosystems === 1 ? "y" : "ies"} found in ${dbPath}, expected at least ${triage.dependabot_ecosystems}. A line scanner that stops matching this file finds zero labels and reports a clean pass, which is what this floor exists to catch`);
  }

  if (hard.length > before) return;
  pass(`triage declaration is consistent: ${triage.labels.length} labels, all routed or attributed, ${inline} inline flag(s) and ${dbLabels} dependabot label(s) declared across ${ecosystems} ecosystem(s)${triage.workflow ? `, ${triage.workflow} reads the assignee from here` : ""}`);
}

async function checkCodeqlWorkflow(repo) {
  const want = repo?.code_scanning;
  if (!want || want.mode !== "advanced") return;

  let text;
  try {
    text = await readFile(join(ROOT, want.workflow), "utf8");
  } catch {
    fail(`code_scanning declares mode "advanced" but ${want.workflow} is missing. With default setup off (see the API tier), that is NO code scanning at all, which reports exactly like a clean scan`);
    return;
  }

  const before = hard.length;

  const got = [...text.matchAll(/^\s*-\s*language:\s*(\S+)\s*$/gm)].map((m) => m[1]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const declared = [...want.languages].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (got.join(",") !== declared.join(",")) {
    const added = got.filter((l) => !declared.includes(l));
    const dropped = declared.filter((l) => !got.includes(l));
    const parts = [];
    if (added.length) parts.push(`gained ${added.join(", ")}`);
    if (dropped.length) parts.push(`lost ${dropped.join(", ")}`);
    fail(`${want.workflow} ${parts.join(" and ")} (matrix has ${got.join(", ") || "nothing"}); #241 curated this list, so re-read MAINTENANCE.md before widening it`);
  }

  for (const [, ref] of text.matchAll(/uses:\s*(\S+)/g)) {
    if (!/@[0-9a-f]{40}$/.test(ref)) fail(`${want.workflow} uses an unpinned action ${JSON.stringify(ref)}; pin it to a full commit SHA like every other workflow here`);
  }

  if (want.query_suite === "default" && /^\s*queries:/m.test(text)) {
    fail(`${want.workflow} sets \`queries:\` while infra.json declares the ${JSON.stringify(want.query_suite)} suite; extended is a large cost change and both must move together`);
  }
  if (want.threat_model === "remote" && /threat[-_]models?:/.test(text)) {
    fail(`${want.workflow} sets a threat model while infra.json declares ${JSON.stringify(want.threat_model)}; MAINTENANCE.md argues rust and python are droppable BECAUSE the model is remote`);
  }

  if (hard.length > before) return;
  pass(`${want.workflow} matches: ${got.length} analysis job(s) (${got.join(", ")}), ${want.query_suite} suite, ${want.threat_model} threat model, actions SHA-pinned`);
}

async function checkApi(infra, wrangler, token: string) {
  const cf = cloudflareReader(token);
  const pinned = wrangler.account_id;
  let accountId = process.env.CLOUDFLARE_ACCOUNT_ID || pinned;
  if (pinned && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== pinned) {
    warn(`CLOUDFLARE_ACCOUNT_ID (${process.env.CLOUDFLARE_ACCOUNT_ID}) overrides cloudflare.config.ts's accountId pin (${pinned}) — the account tier is checking an account this repo does not deploy to`);
  }
  if (!accountId) {
    const accounts = await cf("/accounts");
    if (accounts.length !== 1) {
      warn(`no accountId in cloudflare.config.ts and the token sees ${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID to pick one`);
      return;
    }
    accountId = accounts[0].id;
  }

  report.add(compareKvNamespaces(wrangler, await readKvNamespaces(cf, accountId)));
  report.add(compareR2Buckets(wrangler, await readR2Buckets(cf, accountId)));
  report.add(compareD1Databases(wrangler, await readD1Databases(cf, accountId)));
  report.add(compareWorkersBuilds(infra.release, await readWorkersBuilds(cf, accountId, infra.release.worker)));
  report.add(compareWorkerInventory(infra.workers, await readWorkerScripts(cf, accountId)));
  report.add(compareTokens(infra, accountId, await readTokens(cf, accountId)));

  const zone = infra.zone.name;
  const zeroRtt = infra.zone?.zero_rtt;
  if (zeroRtt) report.add(compareZoneSetting(ZERO_RTT_SECTION, zeroRtt, zone, await readZoneSetting(cf, zone, zeroRtt.setting)));
  const sharedDictionary = infra.zone?.shared_dictionary;
  if (sharedDictionary) report.add(compareZoneSetting(SHARED_DICTIONARY_SECTION, sharedDictionary, zone, await readZoneSetting(cf, zone, sharedDictionary.setting)));
  const affinity = infra.zone?.version_affinity;
  if (affinity) report.add(compareVersionAffinity(affinity, zone, await readVersionAffinity(cf, zone, affinity.phase)));
}

async function workflowPermissionBlocks(): Promise<WorkflowBlocks> {
  const dir = join(ROOT, ".github/workflows");
  const files = (await readdir(dir).catch(() => [])).filter((f) => /\.ya?ml$/.test(f)).sort();
  const without: string[] = [];
  for (const f of files) {
    const src = await readFile(join(dir, f), "utf8");
    if (!/^permissions\s*:/m.test(src)) without.push(f);
  }
  return { total: files.length, without };
}


async function checkAgentMarkdown() {
  let surfaces;
  try {
    ({ surfaces } = JSON.parse(await readFile(join(ROOT, "config/site-manifest.json"), "utf8")));
  } catch (e) {
    warn(`agent markdown coverage could not run: ${e.message}`);
    return;
  }
  const pages = agentSurfaces(surfaces);
  const answers = pages.length < AGENT_SURFACE_FLOOR ? new Map() : await readAgentAnswers(infra.edge.origin, pages, fetchEdge);
  report.add(compareAgentCoverage(pages, answers));
}

const infra = JSON.parse(await readFile(join(ROOT, "config/infra.json"), "utf8"));
const wrangler = await siteConfig();
const auxConfigs = new Map(
  await Promise.all(AUX_CONFIGS.map(
    async ({ path }): Promise<[string, string]> => [path, await readFile(join(ROOT, path), "utf8")],
  )),
);

await checkTree(infra, wrangler, auxConfigs);

if (OFFLINE) {
  warn("--offline: skipped the DNS and API tiers");
} else {
  report.add(compareDns(infra, await readDns(dnsQueries(infra))));
  report.add(compareEdge(infra.edge, await readEdge(infra.edge, { fetchEdge, probeEarlyData }), {
    hostedRunner: Boolean(process.env.GITHUB_ACTIONS),
  }));
  if (infra.repository) {
    const githubToken = process.env.GITHUB_TOKEN;
    const observed = await readRepository(githubReader(githubToken), infra.repository, await workflowPermissionBlocks());
    report.add(compareRepository(infra.repository, observed, { authenticated: Boolean(githubToken) }));
  }
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

const rendered = report.render({ strict: STRICT });
for (const line of rendered.stdout) console.log(line);
for (const line of rendered.stderr) console.error(line);
if (rendered.exitCode) process.exit(rendered.exitCode);
