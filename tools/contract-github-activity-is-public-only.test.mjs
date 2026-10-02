// /github.json feeds the desktop GitHub shortcut's infotip (src/worker/github.ts).
// Two things about it can be wrong without anything looking broken: a private
// repository reaching a public card, and the tiers ranking by something other
// than how much work went where. Both are asserted here, each with a control.
import { assert, test } from "./contract-shared.ts";
import {
  githubQueries, normalizeCommits, normalizeIssues, normalizePrs, windowStart, GITHUB_USER,
} from "../src/worker/github.ts";

const SINCE = "2026-09-02";
const pr = (repo, title, created, extra = {}) => ({
  repository_url: `https://api.github.com/repos/${repo}`,
  html_url: `https://github.com/${repo}/pull/1`,
  title, created_at: created, state: "closed", pull_request: { merged_at: null }, ...extra,
});
const commit = (repo, message, date, isPrivate = false) => ({
  repository: { full_name: repo, private: isPrivate },
  html_url: `https://github.com/${repo}/commit/abc`,
  commit: { message, author: { date } },
});

test("every query names is:public, because the result cannot be filtered after", () => {
  const q = githubQueries(SINCE);
  for (const [tier, url] of Object.entries(q)) {
    const query = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
    assert.ok(query.includes("is:public"), `${tier}: ${query}`);
    assert.ok(query.includes(`author:${GITHUB_USER}`), `${tier} is not scoped to the owner`);
  }
  // PRs and issues are OUTWARD work; commits are to the owner's own repos.
  assert.ok(decodeURIComponent(q.prs).includes(`-user:${GITHUB_USER}`));
  assert.ok(decodeURIComponent(q.issues).includes(`-user:${GITHUB_USER}`));
  assert.ok(decodeURIComponent(q.commits).includes(` user:${GITHUB_USER}`));
});

test("a private commit never reaches the payload, and a missing flag counts as private", () => {
  const out = normalizeCommits({
    total_count: 3,
    items: [
      commit("oddharsh/site", "public one", "2026-10-01T00:00:00Z"),
      commit("oddharsh/secret", "private one", "2026-10-01T00:00:00Z", true),
      { ...commit("oddharsh/unknown", "no flag", "2026-10-01T00:00:00Z"), repository: { full_name: "oddharsh/unknown" } },
    ],
  }, SINCE);
  assert.deepEqual(out.repos.map((r) => r.repo), ["oddharsh/site"]);
});

test("PR repositories rank by volume, then recency, and count merged and open", () => {
  const out = normalizePrs({
    total_count: 4,
    items: [
      pr("a/one", "first", "2026-09-10T00:00:00Z", { pull_request: { merged_at: "2026-09-11T00:00:00Z" } }),
      pr("b/two", "lone but newest", "2026-10-01T00:00:00Z", { state: "open" }),
      pr("a/one", "second", "2026-09-20T00:00:00Z", { state: "open" }),
      pr("c/three", "older lone", "2026-09-05T00:00:00Z"),
    ],
  });
  assert.deepEqual(out.repos.map((r) => r.repo), ["a/one", "b/two", "c/three"]);
  assert.equal(out.repos[0].count, 2);
  assert.equal(out.repos[0].latest.title, "second", "latest is by date, not by array order");
  assert.equal(out.merged, 1);
  assert.equal(out.open, 2);
  assert.equal(out.repos[2].latest.state, "closed", "closed unmerged is its own state");
});

test("issues are newest first and a non-github URL is dropped", () => {
  const out = normalizeIssues({
    total_count: 2,
    items: [
      { ...pr("x/old", "old", "2026-09-03T00:00:00Z"), html_url: "https://evil.example/x" },
      pr("y/new", "new", "2026-09-30T00:00:00Z"),
    ],
  });
  assert.deepEqual(out.items.map((i) => i.title), ["new", "old"]);
  assert.equal(out.items[1].url, "");
  assert.equal(out.repoCount, 2);
});

test("commit counts say how far back they reach when the page was truncated", () => {
  const items = [commit("oddharsh/site", "a", "2026-09-30T00:00:00Z"), commit("oddharsh/site", "b", "2026-09-28T12:00:00Z")];
  assert.equal(normalizeCommits({ total_count: 2, items }, SINCE).coveredSince, SINCE, "complete page covers the window");
  // The control: same two items, but GitHub says there were 500.
  assert.equal(normalizeCommits({ total_count: 500, items }, SINCE).coveredSince, "2026-09-28");
});

test("a malformed response degrades to empty rather than to [object Object]", () => {
  const out = normalizePrs({ total_count: "lots", items: [{ repository_url: {}, title: { x: 1 } }] });
  assert.equal(out.total, 0);
  assert.deepEqual(out.repos, []);
  assert.equal(windowStart(new Date("2026-10-02T12:00:00Z")), "2026-09-02");
});
