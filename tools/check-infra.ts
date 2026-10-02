#!/usr/bin/env node
// Diff infra.json against reality.
//
// cloudflare.config.ts declares the compute layer and CI dry-runs it, so a bad route
// or a missing binding fails a PR today. Everything one level out — the DNS
// records, the resources those bindings point at, the Worker inventory — lived
// only in the Cloudflare dashboard and in prose. This closes that gap without
// adopting Terraform: infra.json is the declaration, this script is the diff,
// and nothing here mutates Cloudflare.
//
// Five tiers, by what they cost to run:
//
//   tree  no network.  infra.json against the repo. Binding names must line up
//                      with cloudflare.config.ts, and every declared `consumer` file
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
//   node tools/check-infra.ts              tree + dns, api if a token exists
//   node tools/check-infra.ts --offline    tree only
//   node tools/check-infra.ts --strict     turn advisories into failures
//
// THIS FILE IS THE COMPOSITION, and only that: adapters, comparers, printing,
// exit code. The comparers (declaration plus observation in, findings out) are
// tools/lib/infra-compare.ts and never fetch. The adapters (DNS, edge,
// Cloudflare, GitHub) are tools/lib/infra-ports.ts and never judge. The store
// that redacts and renders is tools/lib/infra-report.ts. What stays here is
// what reads this tree or this machine: the three file-walking tree checks,
// the openssl probe, and the production Markdown sweep.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { siteConfig } from "./lib/site-config.ts";
import { auditActionPins } from "./lib/action-pins.ts";
import { agentRepresentation, agentSurfaces } from "./lib/agent-representation.ts";
import {
  AUX_CONFIGS, SHARED_DICTIONARY_SECTION, ZERO_RTT_SECTION,
  compareD1Databases, compareDns, compareEdge, compareKvNamespaces, compareR2Buckets,
  compareRepository, compareTokens, compareTree, compareVersionAffinity,
  compareWorkerInventory, compareWorkersBuilds, compareZoneSetting, dnsQueries,
} from "./lib/infra-compare.ts";
import type { EarlyDataResult, WorkflowBlocks } from "./lib/infra-compare.ts";
import {
  cloudflareReader, edgeFetcher, githubReader, readD1Databases, readDns, readEdge,
  readKvNamespaces, readR2Buckets, readRepository, readTokens, readVersionAffinity,
  readWorkerScripts, readWorkersBuilds, readZoneSetting,
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
// It retries on rejection, and the SPACING is the load-bearing part rather than
// the count. Two back-to-back attempts are close to one sample: same second,
// same edge node, same ticket-issuance conditions, so a transient refusal fails
// both and the zone reads as 0-RTT off. That is what happened on 2026-08-20,
// when five concurrent CI jobs probed production at once and one job's pair of
// attempts both missed, failing `validate` on a PR that changed a tsconfig
// include. The same probe run 5 times from a workstation minutes later was
// accepted 5 times.
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
    // Spacing between attempts, never before the first: a healthy zone answers on
    // attempt 1 and pays none of this. Only a probe already heading for a drift
    // report spends the extra seconds, which is the run where being right matters.
    const BACKOFF_MS = [0, 1500, 4000];
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      if (BACKOFF_MS[attempt]) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      await execFileP("sh", ["-c",
        `{ cat "${req}"; sleep 2; } | "${ossl}" s_client -connect "${host}:443" -servername "${host}" -sess_out "${sess}" >/dev/null 2>&1`,
      ], { timeout: 20000 }).catch(() => {});
      const out = await execFileP("sh", ["-c",
        `"${ossl}" s_client -connect "${host}:443" -servername "${host}" -sess_in "${sess}" -early_data "${req}" </dev/null 2>&1`,
      ], { timeout: 20000 }).catch((e) => ({ stdout: `${e.stdout || ""}${e.stderr || ""}` }));
      if (/early data was accepted/i.test(out.stdout || "")) return { accepted: true, attempts: attempt + 1 };
    }
    return { accepted: false, attempts: BACKOFF_MS.length };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const ROOT = new URL("../", import.meta.url).pathname;
const OFFLINE = process.argv.includes("--offline");
const STRICT = process.argv.includes("--strict");

// The store every message lands in. It redacts on the way IN (see
// tools/lib/infra-report.ts), so nothing below can print a credential, and the
// four names are the ones the tree checks in this file have always called.
const report = createReport();
const { hard, fail, warn, pass } = report;

const exists = (rel) => access(join(ROOT, rel)).then(() => true, () => false);

const fetchEdge = edgeFetcher();

// ----------------------------------------------------------- tier: tree ----

// The config half of the tree tier is compareTree; this gathers the two local
// observations it wants and then runs the three checks that walk files.
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

// Every action reference under .github is pinned to a commit, asserted from
// COMMITTED SOURCE. No network, no credential, so this runs on every pull
// request beside the DNS tier rather than degrading to a note like the two API
// halves of the same declaration.
//
// WHY IT IS THE HALF WORTH HAVING. `sha_pinning_required` is the same rule
// enforced by GitHub, and it rejects at RUN time: the workflow starts, the step
// fails, and you find out from a red check on a branch. This fails at REVIEW
// time, in the diff that introduced the tag. It also holds while the setting is
// off, which it is today, so the declaration above can run ahead of reality
// without leaving the repo unguarded in the meantime.
//
// THE SCAN LIVES IN tools/lib/action-pins.ts AND FAILS CLOSED, which is the
// repair for three shapes that walked past the first version of this check and
// were each reported as "all 32 third-party action references are
// commit-pinned": a flow-style step (`- {name: x, uses: attacker/evil@main}`),
// a plain scalar on the line after `uses:`, and a nested or out-of-tree
// composite reached through a local `./` ref the walk never opened. A reference
// this scanner cannot read is now an ERROR naming the file, the line and the
// text it could not classify.
//
// LOCAL `./` REFERENCES ARE RESOLVED RATHER THAN EXEMPTED, and the old
// exemption is the lesson worth keeping. "A path reference has no upstream
// owner" is true and is not the question: the file it points AT is a place a tag
// can hide, at any depth and outside .github entirely, since GitHub resolves a
// local ref against the repository root. A target that cannot be found fails.
//
// FLOOR, and what it is FOR is narrower than it looks. It catches a scan that
// stopped matching, which is a real failure this repo has shipped: a pattern
// that matches nothing reports a clean pass, and a control proved this one goes
// to 0 of 24 when the matcher breaks. It CANNOT catch an evasion, because a
// hidden unpinned ref moves the count by zero or one. Coverage is held by
// failing closed above and by the contract test's fixtures, never by this
// number.
async function checkActionPinning(repo) {
  const want = repo?.actions_permissions;
  if (!want) return;
  const before = hard.length;

  // .github/workflows is a PRECONDITION and .github/actions is not. GitHub
  // reads workflows at one level and requires none of them to be composites, so
  // an absent actions directory is a repository with no composite actions
  // rather than a walk that failed. Hard-failing on it (ENOENT from readdir)
  // made a required check depend on a directory this repo happens to carry.
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

  // One sentence per CLASS, because the three findings want different fixes and
  // a single template said "not pinned to a 40-character commit" about a local
  // ref whose target was simply missing.
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

// The triage declaration, asserted WITHOUT a network call. The live half (do
// these labels exist, with these colours) is in checkLabels below; this is the
// half that can run on a plane, and it is the half that catches the failure
// that matters most.
//
// THE FAILURE IT CATCHES: POST /issues/:n/labels CREATES a label that does not
// exist. So a routing rule naming `area: garagee` does not error, it mints a
// second label and the pull request looks triaged. Nothing reports it. What
// makes that catchable here is that infra.json holds the routing and the label
// set in ONE list, so a route can only ever name a label declared beside it.
// That is the whole argument for not splitting this block in two.
//
// The `gh --label` scan is the other direction, and it is the one with teeth.
// A workflow that opens its own pull request passes `--label` at creation,
// because an event created with the default GITHUB_TOKEN never triggers
// triage.yml. `gh pr create --label` FAILS OUTRIGHT on an unknown label, so a
// rename here without a sync does not mislabel the nightly roll, it stops it.
//
// Dependabot is the QUIET direction, and nothing read that file until #620 was
// noticed. Its `labels:` key REPLACES the defaults it would apply, and a name
// GitHub does not have is dropped without a word, so the symptom is a pull
// request carrying FEWER labels than an unconfigured block gets. The
// github-actions block asked for a `github-actions` label that has never
// existed in this repository and lost `dependencies` to get it.
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

    // A label nothing can apply is decoration. Either something in this repo
    // routes to it, or an outside actor is named as the one that applies it.
    if (!label.title && !label.paths && !label.applied_by) {
      fail(`${at} carries no \`title\` route, no \`paths\` route and no \`applied_by\`, so nothing can ever apply it`);
    }
  }

  // triage.yml was deleted 2026-09-28, so `workflow` is optional: the label
  // set stays declared because the self-opening workflows and dependabot still
  // pass these names to `--label`, which fails outright on an unknown one.
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

  // The self-opening workflows. FLOOR included, for the reason every scanner in
  // this repo carries one: a regex that matches nothing reports a clean pass,
  // and this one is scanning for a flag that is easy to spell three ways.
  //
  // SCOPED TO `gh`, and the first draft was not. `--label` is also a flag on
  // `bun run perf:snapshot record`, where it names a build rather than a GitHub
  // label, so a bare scan for the flag reported three drifts against workflows
  // that touch no label at all. Backslash continuations are folded first
  // because every one of these invocations is wrapped across lines, and each
  // passes `--label` before the multi-line `--body` that ends the logical line.
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

  // Dependabot's own `labels:` lists, scanned the same way and for the opposite
  // failure. It walks LINES rather than reaching for `Bun.YAML`, because the
  // usage header above documents `node tools/check-infra.ts` and a bun global
  // would delete that invocation to save a dozen lines. A `labels:` key takes
  // either a flow sequence on its own line or the indented `- item` list
  // beneath it, and comments and blanks between items are skipped.
  //
  // Cross-checked against a real parser rather than trusted, 2026-08-27:
  // `Bun.YAML.parse` read the same 5 ecosystems and the same 1 label out of
  // this file that the walk below finds. Re-run that if the shape changes.
  //
  // The FLOOR is STRUCTURAL rather than an inventory of ecosystems. A file with
  // no `labels:` key anywhere is a legitimate state (the defaults apply), so
  // counting labels would floor at zero and prove nothing; counting
  // `package-ecosystem:` items asserts the scanner still recognises this file's
  // shape. `- package-ecosystem:` matches the LIST-ITEM form on purpose, since
  // the header comment discusses `package-ecosystem: bun` in prose.
  const dbPath = triage.dependabot;
  let dependabot;
  try {
    dependabot = await readFile(join(ROOT, dbPath), "utf8");
  } catch {
    fail(`infra.json declares repository.triage.dependabot but ${dbPath} is missing, so no dependency update PR is labelled or checked`);
    return;
  }

  // One YAML scalar: an inline `# comment` is stripped, a quoted value is taken
  // whole so a `#` inside it survives.
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

// The CodeQL language curation, asserted from the COMMITTED workflow rather
// than from the dashboard. This is the whole reason advanced setup was worth
// the move on 2026-08-15: the same decision used to live in default setup's
// config, where the only credential that could read it was a broad standing
// `repo` token, so it was workstation-only and went unasserted for weeks. A
// committed matrix is a tree check that runs on every PR with no credential.
//
// It asserts the three things the declaration actually rests on. `languages`
// is #241's curation. `query_suite` and `threat_model` are asserted as
// ABSENCES, because CodeQL's defaults are `default` and `remote`: the workflow
// setting neither key IS the declaration holding. That is why each check below
// tests for a key rather than a value.
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

  // Count failures rather than falling through: an earlier version emitted the
  // summary `pass` line even on a drift, so one run reported both "2 analysis
  // jobs, matches" and "gained rust". A check that prints a pass beside its own
  // failure is worse than one that stays quiet, because the pass is what gets
  // skimmed.
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

  // A floating tag on a security scanner is a supply-chain hole with write
  // access to security-events. Every other `uses:` in this repo is pinned.
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

// ------------------------------------------------------------ tier: api ----

async function checkApi(infra, wrangler, token: string) {
  const cf = cloudflareReader(token);
  // The account id, in the order it should be trusted. cloudflare.config.ts's accountId pin is
  // the SOURCE OF TRUTH per infra.json's account block, and checkTree has
  // already proven all 7 declarations agree by the time this runs.
  //
  // SECOND READER of that field, and deliberately not shared with the first:
  // tools/print-account-id.ts makes exactly this argument in its header and
  // emits the value for ramp.yml's $GITHUB_ENV. It cannot be imported, because
  // it reads and writes at module scope, so importing it to borrow the lookup
  // would print to stdout as a side effect. Two readers of one committed
  // string, both failing loudly when it is absent, is the cheap shape here.
  //
  // What this replaces: a jump straight from the env var to enumerating
  // /accounts, which is a network call for a value sitting in the object this
  // function is handed, and a `return` that BLANKS THE WHOLE TIER when the
  // count is not 1. The owner's interactive login sees two accounts, which is
  // the 2026-08-07 failure that made pinning account_id necessary in the first
  // place; this path still had the pre-pin shape, so a workstation run would
  // check nothing here while reporting one tidy note about an env var.
  //
  // The env var still wins, because aiming the tier at another account on
  // purpose is legitimate. A disagreement is reported rather than failed.
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

  // One read and one comparer per section, in the order the tier prints. Each
  // resource class is read independently, so a token missing ONE scope costs
  // that section an advisory and leaves the rest standing.
  report.add(compareKvNamespaces(wrangler, await readKvNamespaces(cf, accountId)));
  report.add(compareR2Buckets(wrangler, await readR2Buckets(cf, accountId)));
  report.add(compareD1Databases(wrangler, await readD1Databases(cf, accountId)));
  report.add(compareWorkersBuilds(infra.release, await readWorkersBuilds(cf, accountId, infra.release.worker)));
  report.add(compareWorkerInventory(infra.workers, await readWorkerScripts(cf, accountId)));
  report.add(compareTokens(infra, accountId, await readTokens(cf, accountId)));

  // The three zone-scoped sections. The account-scoped CI token cannot reach
  // them, so in CI each degrades to a note. An undeclared one is not read.
  const zone = infra.zone.name;
  const zeroRtt = infra.zone?.zero_rtt;
  if (zeroRtt) report.add(compareZoneSetting(ZERO_RTT_SECTION, zeroRtt, zone, await readZoneSetting(cf, zone, zeroRtt.setting)));
  const sharedDictionary = infra.zone?.shared_dictionary;
  if (sharedDictionary) report.add(compareZoneSetting(SHARED_DICTIONARY_SECTION, sharedDictionary, zone, await readZoneSetting(cf, zone, sharedDictionary.setting)));
  const affinity = infra.zone?.version_affinity;
  if (affinity) report.add(compareVersionAffinity(affinity, zone, await readVersionAffinity(cf, zone, affinity.phase)));
}

// ----------------------------------------------------- tier: repository ----

/** How many workflows carry a TOP-LEVEL `permissions:` block, counted rather
 *  than remembered.
 *
 *  The argument for flipping `default_workflow_permissions` to `read` rests
 *  entirely on this number: an explicit block always beats the repository
 *  default, so today's `write` governs zero jobs only while every workflow
 *  carries one. That sentence was written as "all 13 workflows" in three
 *  places, two of which this script PRINTS, and there were 14. A number typed
 *  into a message is a claim nobody re-checks, so the message says what the
 *  count is at the moment it prints and names the workflows that lack a block.
 *
 *  Column 0 is the whole discriminator: a job-level `permissions:` is indented
 *  and does not govern a job that omits one. */
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


// ------------------------------------------- tier: agent markdown surface ----

// Which pages answer an agent in Markdown, measured on the wire rather than inferred
// from filenames. The twins arrive by three different conventions — /index.md for the
// homepage, src/content/md/<name>.md for /whoareyou and /bot, build-generated twins for
// /garage/* and /lwe/* — so a local file check would have to know all three and would
// still be guessing about production. One request per page settles it.
//
// site-manifest.json's `flags.agents` already declares which surfaces are part of the
// agent-facing catalog, so it is the right denominator: an agents:true page that hands
// back HTML is a page the registry advertises to agents and then serves for humans.
//
// EVERY agents:true surface, whatever its kind, since 2026-09-30. This read
// `kind === "page"` alone until then, which left 60 of the 68 outside it (39
// content, 17 utility, 4 section), and six of those were answering HTML
// (/ledger, /inbox, /reading, /lens/census, /serendipity, /search) while the
// tier printed a clean pass. The
// expected type is agent-representation.ts's rule, so the terminal tools pass on
// the text/plain frame they declare and /rn on its live Markdown.
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
  const pages = agentSurfaces(surfaces);
  if (pages.length < 40) {
    warn(`agent markdown coverage read only ${pages.length} agents:true surfaces. Has the registry stopped parsing?`);
    return;
  }
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
      if (ct !== agentRepresentation(p)) gaps.push(`${p.path} (${ct || "no content-type"})`);
    } catch (e) {
      warn(`agent markdown probe failed for ${p.path}: ${e.message}`);
    }
  }
  gaps.length
    ? warn(`agent markdown coverage: ${pages.length - gaps.length}/${pages.length} agents:true surfaces answer Accept: text/markdown in their declared representation. No twin: ${gaps.join(", ")}. Give each one a twin, declare the representation its route serves (mimeType), or drop flags.agents so the registry stops advertising it`)
    : pass(`agent markdown coverage: all ${pages.length} agents:true surfaces answer an agent in their declared representation`);
}

// ----------------------------------------------------------------- main ----

const infra = JSON.parse(await readFile(join(ROOT, "config/infra.json"), "utf8"));
// The site config in its legacy shape (tools/lib/site-config.ts): every check
// below reads wrangler.jsonc's field names, and cloudflare.config.ts replaced
// that file on 2026-09-28.
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
