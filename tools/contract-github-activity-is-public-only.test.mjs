// /github.json feeds the desktop GitHub shortcut's infotip (src/worker/github.ts).
// Two things about it can be wrong without anything looking broken: a private
// repository reaching a public card, and the tiers ranking by something other
// than how much work went where. Both are asserted here, each with a control.
import { assert, test } from "./contract-shared.ts";
import {
  BUSIEST_REPO, githubQueries, normalizeCommits, normalizeIssues, normalizePrs, windowStart, GITHUB_USER,
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
  // The split: everything but the busiest repo gets the page, the busiest gets a count.
  assert.ok(decodeURIComponent(q.commits).includes(`-repo:${BUSIEST_REPO}`));
  assert.ok(decodeURIComponent(q.busiest).includes(`repo:${BUSIEST_REPO}`));
  assert.equal(new URL(q.busiest).searchParams.get("per_page"), "1", "the busiest repo is read for its total_count alone");
});

test("a private commit never reaches the payload, and a missing flag counts as private", () => {
  const out = normalizeCommits({
    total_count: 3,
    items: [
      commit("oddharsh/doors", "public one", "2026-10-01T00:00:00Z"),
      commit("oddharsh/secret", "private one", "2026-10-01T00:00:00Z", true),
      { ...commit("oddharsh/unknown", "no flag", "2026-10-01T00:00:00Z"), repository: { full_name: "oddharsh/unknown" } },
    ],
  }, { total_count: 0, items: [] }, SINCE);
  assert.deepEqual(out.repos.map((r) => r.repo), ["oddharsh/doors"]);
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
  const items = [commit("oddharsh/doors", "a", "2026-09-30T00:00:00Z"), commit("oddharsh/doors", "b", "2026-09-28T12:00:00Z")];
  const none = { total_count: 0, items: [] };
  assert.equal(normalizeCommits({ total_count: 2, items }, none, SINCE).coveredSince, SINCE, "complete page covers the window");
  // The control: same two items, but GitHub says there were 500.
  assert.equal(normalizeCommits({ total_count: 500, items }, none, SINCE).coveredSince, "2026-09-28");
});

test("the busiest repo counts by total_count, ranks first, and is never counted twice", () => {
  const rest = { total_count: 3, items: [
    commit("oddharsh/doors", "d1", "2026-09-30T00:00:00Z"),
    commit("oddharsh/doors", "d2", "2026-09-20T00:00:00Z"),
    // A busiest-repo commit that slipped past -repo: must not add to its count.
    commit(BUSIEST_REPO, "leaked", "2026-10-01T00:00:00Z"),
  ] };
  const busiest = { total_count: 308, items: [commit(BUSIEST_REPO, "newest site commit", "2026-10-02T00:00:00Z")] };
  const out = normalizeCommits(rest, busiest, SINCE);
  assert.deepEqual(out.repos.map((r) => [r.repo, r.count]), [[BUSIEST_REPO, 308], ["oddharsh/doors", 2]]);
  assert.equal(out.repos[0].latest.message, "newest site commit");
  assert.equal(out.total, 2 + 308, "the leaked commit leaves rest's total too");
  assert.equal(out.coveredSince, SINCE, "rest's page held every commit it counted");
});

test("a busiest-repo count with no public item to name it is not shown", () => {
  // If the repository went private, is:public empties the items; a stale or odd
  // total_count alone must not resurrect it on a public card.
  const out = normalizeCommits({ total_count: 0, items: [] },
    { total_count: 308, items: [commit(BUSIEST_REPO, "x", "2026-10-02T00:00:00Z", true)] }, SINCE);
  assert.deepEqual(out.repos, []);
  assert.equal(out.total, 0);
});

test("a malformed response degrades to empty rather than to [object Object]", () => {
  const out = normalizePrs({ total_count: "lots", items: [{ repository_url: {}, title: { x: 1 } }] });
  assert.equal(out.total, 0);
  assert.deepEqual(out.repos, []);
  assert.equal(windowStart(new Date("2026-10-02T12:00:00Z")), "2026-09-02");
});
