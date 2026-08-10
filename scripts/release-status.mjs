#!/usr/bin/env node

// release-status.mjs — where is the release, and what is the next command?
//
// A release here crosses four systems: git (is the work merged), GitHub Actions
// (did CI promote the tested commit), Cloudflare (is a version uploaded, is it
// serving), and D1 (is the changelog recorded). Each of those is knowable and
// none of them was visible in one place, so the honest answer to "what do I run
// now" was to remember six commands and their order.
//
//   pnpm run release
//
// READ-ONLY, always. It runs git fetch and some list calls and changes nothing,
// so it is safe to run at any point, including in the middle of a ramp. Every
// tier degrades on its own: no network, no wrangler login, no gh — each section
// says what it could not read rather than guessing or failing the whole report.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const ROOT = new URL("..", import.meta.url).pathname;

const run = async (cmd, args, opts = {}) => {
  const { stdout } = await exec(cmd, args, { cwd: ROOT, maxBuffer: 32 * 1024 * 1024, ...opts });
  return stdout.trim();
};

// wrangler prints an update notice ("There is a newer version of Wrangler
// available...") to STDOUT alongside --json output, which turns a perfectly
// good response into a parse error. Slice from the first structural character
// rather than trusting the stream to be clean.
const runJson = async (args) => {
  const out = await run("npx", ["wrangler", ...args]);
  const start = Math.min(...[out.indexOf("["), out.indexOf("{")].filter((i) => i >= 0));
  if (!Number.isFinite(start)) throw new Error("no JSON in wrangler output");
  return JSON.parse(out.slice(start));
};

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;

const line = (label, value, note) =>
  console.log(`  ${label.padEnd(13)} ${value}${note ? dim(`  ${note}`) : ""}`);

console.log(bold("\nrelease status\n"));

// ── git ────────────────────────────────────────────────────────────────────
let mainSha = null, prodSha = null, branch = null, dirty = false;
try {
  await run("git", ["fetch", "--quiet", "origin", "main", "production"]).catch(() => {});
  branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  dirty = (await run("git", ["status", "--porcelain"])).length > 0;
  mainSha = await run("git", ["rev-parse", "origin/main"]);
  prodSha = await run("git", ["rev-parse", "origin/production"]).catch(() => null);
  const subject = await run("git", ["log", "-1", "--format=%s", "origin/main"]);
  line("branch", branch + (dirty ? warn("  (uncommitted changes)") : ""));
  line("main", mainSha.slice(0, 8), subject.slice(0, 58));
  if (prodSha) {
    const promoted = prodSha === mainSha;
    line("production", prodSha.slice(0, 8), promoted ? ok("promoted, matches main") : warn("BEHIND main — CI has not promoted this commit"));
  } else line("production", dim("unreadable"));
} catch (e) {
  line("git", dim(`unreadable (${String(e.message || e).slice(0, 60)})`));
}

// ── cloudflare ─────────────────────────────────────────────────────────────
// Versions and deployments are separate facts on purpose: an uploaded version
// that serves nobody is the NORMAL state here, and conflating the two is what
// makes people think a merge shipped something.
let newest = null, serving = [];
try {
  const list = await runJson(["versions", "list", "--json"]);
  newest = [...list].sort((a, b) =>
    new Date(b.metadata?.created_on || 0) - new Date(a.metadata?.created_on || 0))[0];
  const dep = await runJson(["deployments", "status", "--json"]);
  serving = (dep?.versions || []).map((v) => ({ id: v.version_id || v.id, pct: Number(v.percentage ?? 0) }));
  line("newest ver", newest ? newest.id.slice(0, 8) : dim("none"),
    newest?.metadata?.created_on ? new Date(newest.metadata.created_on).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "");
  const desc = serving.map((v) => `${v.id.slice(0, 8)} @ ${v.pct}%`).join(", ");
  const live = serving.find((v) => newest && v.id.slice(0, 8) === newest.id.slice(0, 8));
  line("serving", desc || dim("unknown"),
    live ? (live.pct === 100 ? ok("newest is fully live") : warn(`newest at ${live.pct}%, mid-ramp`)) : warn("newest is serving NOBODY"));
} catch (e) {
  line("cloudflare", dim(`unreadable (${String(e.message || e).slice(0, 60)})`));
  line("", dim("needs a wrangler login; set CLOUDFLARE_ACCOUNT_ID if the account is ambiguous"));
}

// ── the changelog ──────────────────────────────────────────────────────────
// Read from the COMMITTED projection, not D1, because that is what /updates and
// /restore actually render. Pending entries are the normal in-between state.
let staged = [];
try {
  const committed = JSON.parse(await readFile(new URL("../holding/_worker.js/checkpoints.json", import.meta.url), "utf8"));
  const newestEntry = committed[committed.length - 1];
  try {
    const rows = (await runJson(["d1", "execute", "aadhar-restore", "--remote", "--json", "--command", "SELECT vnum FROM checkpoints;"]))[0].results;
    const known = new Set(rows.map((r) => r.vnum));
    staged = committed.filter((r) => !known.has(r.vnum));
    line("changelog", `v${newestEntry.vnum} ${newestEntry.slug}`,
      staged.length ? warn(`${staged.length} staged, not yet recorded in D1`) : ok("recorded"));
  } catch {
    line("changelog", `v${newestEntry.vnum} ${newestEntry.slug}`, dim("D1 unreadable — staged/recorded unknown"));
  }
} catch {
  line("changelog", dim("projection unreadable"));
}

// ── the one next thing ─────────────────────────────────────────────────────
// A status report that lists six possible commands is the problem it was
// written to solve, so this prints exactly one.
const newestLive = serving.find((v) => newest && v.id.slice(0, 8) === newest.id.slice(0, 8));
console.log("");
if (dirty) {
  console.log(`  ${bold("next")}  commit or stash your changes first`);
} else if (prodSha && mainSha && prodSha !== mainSha) {
  console.log(`  ${bold("next")}  wait for CI to promote main to production (or re-run the Promote workflow)`);
} else if (newest && !newestLive) {
  console.log(`  ${bold("next")}  pnpm run deploy:promote          ${dim("ramp the newest version 10 -> 50 -> 100")}`);
} else if (newestLive && newestLive.pct < 100) {
  console.log(`  ${bold("next")}  pnpm run deploy:promote          ${dim(`finish the ramp from ${newestLive.pct}%`)}`);
} else if (staged.length) {
  console.log(`  ${bold("next")}  pnpm run deploy:promote          ${dim("at 100% already; this records the staged changelog rows in D1")}`);
} else {
  console.log(`  ${bold("next")}  nothing. main is promoted, the newest version is fully live, the log is recorded.`);
}
console.log("");
