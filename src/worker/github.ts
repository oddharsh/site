// github.ts — /github.json, what I've been doing on GitHub lately.
//
// The desktop's GitHub shortcut draws this as its infotip (infotip.js), ranked
// the way the work matters: pull requests to OTHER people's repositories first,
// then issues I've filed on other people's repositories, then commits to my
// own. A visitor pointing at the icon is asking "what is he up to", and an
// upstream PR answers that better than the forty commits a day this site gets.
//
// SEARCH CALLS, NOT THE EVENTS API. Events is the obvious source and the
// wrong one: it caps at 300 events and 90 days, mixes every kind of activity
// into one stream that would need paging to separate, and its PushEvent
// payloads no longer carry commit messages. Search answers each tier with a
// request or two (commits take two, see BUSIEST_REPO), scoped to a window, and
// reports a total_count alongside the page.
//
// `is:public` IS IN EVERY QUERY, and that is the privacy boundary, not a
// filter applied afterwards. An issue search result carries no `private` flag
// to filter on, and an authenticated search returns private repositories the
// token can see: measured 2026-10-02, the owner's gh token returned 271 PRs
// where `is:public` returns 64, the other 207 in a private org. Unauthenticated
// it cannot see them at all, which is how this runs today, but a query that is
// only safe because of the credential it happens to run with is one token away
// from publishing somebody's private work.
//
// Unauthenticated search allows 10 requests a minute per IP, and a Worker's
// egress IP is shared, so a refusal is expected rather than exceptional. SWR
// in KV is what makes that survivable: a refresh that fails stores nothing and
// the last good payload keeps serving (shouldStore below requires every
// tier). Absence from one read is not evidence that the activity stopped.
import { signedFetch } from "./lib/botauth.ts";
import { swrKV } from "./lib/cache.ts";
import { asList, asNumber, asRecord, asText } from "./lib/parse.ts";

export const GITHUB_USER = "oddharsh";
export const GITHUB_CACHE_KEY = "github:activity:v1";
const GITHUB_TTL = 3600;          // an hour; four searches an hour at most
export const WINDOW_DAYS = 30;
const PER_PAGE = 100;             // search's maximum, one page per tier
const API = "https://api.github.com";
const REPO_PREFIX = API + "/repos/";

type PrState = "merged" | "open" | "closed";
type Pr = { repo: string; title: string; url: string; state: PrState; at: string };
type Issue = { repo: string; title: string; url: string; state: "open" | "closed"; at: string };
type Commit = { repo: string; message: string; url: string; at: string };

export type GithubActivity = {
  user: string;
  fetchedAt: string;
  windowDays: number;
  since: string;   // YYYY-MM-DD, the window's first day
  prs: {
    total: number;
    merged: number;
    open: number;
    repos: { repo: string; count: number; merged: number; open: number; latest: Pr }[];
  };
  issues: { total: number; repoCount: number; items: Issue[] };
  commits: {
    total: number;
    // The day the counts actually reach back to. Search returns one page, so on
    // a busy month the per-repo counts cover fewer days than the window, and a
    // card that said "30 days" over 100 commits from the last 4 would be lying.
    coveredSince: string;
    repos: { repo: string; count: number; latest: Commit }[];
  };
};

// A string, or "" for anything else: an object here is a shape GitHub changed,
// and printing "[object Object]" into a card would hide that.
const text = (v: unknown): string => asText(v) ?? "";
const clip = (s: unknown, n: number) => text(s).replace(/\s+/g, " ").trim().slice(0, n);
const day = (iso: unknown) => text(iso).slice(0, 10);
const repoOf = (repositoryUrl: unknown) =>
  text(repositoryUrl).startsWith(REPO_PREFIX) ? text(repositoryUrl).slice(REPO_PREFIX.length) : "";
// Only a github.com URL reaches the payload. Nothing renders these as links
// today, but an agent reading /github.json might follow one.
const ghUrl = (u: unknown) => (text(u).startsWith("https://github.com/") ? text(u) : "");
const items = (body: unknown): any[] => asList(asRecord(body)?.items);
const totalOf = (body: unknown) => Math.max(0, Math.trunc(asNumber(asRecord(body)?.total_count) ?? 0));

/** Pull requests, newest first, grouped by repository and ranked by volume. */
export function normalizePrs(body: unknown): GithubActivity["prs"] {
  const prs: Pr[] = items(body).map((it) => ({
    repo: repoOf(it?.repository_url),
    title: clip(it?.title, 140),
    url: ghUrl(it?.html_url),
    state: (it?.pull_request?.merged_at ? "merged" : it?.state === "open" ? "open" : "closed") as PrState,
    at: text(it?.created_at),
  })).filter((p) => p.repo && p.title);
  const byRepo = new Map<string, { repo: string; count: number; merged: number; open: number; latest: Pr }>();
  for (const p of prs) {
    const g = byRepo.get(p.repo) ?? { repo: p.repo, count: 0, merged: 0, open: 0, latest: p };
    g.count++;
    if (p.state === "merged") g.merged++;
    if (p.state === "open") g.open++;
    if (p.at > g.latest.at) g.latest = p;
    byRepo.set(p.repo, g);
  }
  const repos = [...byRepo.values()].sort((a, b) => b.count - a.count || b.latest.at.localeCompare(a.latest.at));
  return {
    total: totalOf(body),
    merged: prs.filter((p) => p.state === "merged").length,
    open: prs.filter((p) => p.state === "open").length,
    repos,
  };
}

/** Issues, newest first. Titles carry the content here, so they stay a list. */
export function normalizeIssues(body: unknown): GithubActivity["issues"] {
  const list: Issue[] = items(body).map((it) => ({
    repo: repoOf(it?.repository_url),
    title: clip(it?.title, 140),
    url: ghUrl(it?.html_url),
    state: (it?.state === "open" ? "open" : "closed") as Issue["state"],
    at: text(it?.created_at),
  })).filter((i) => i.repo && i.title).sort((a, b) => b.at.localeCompare(a.at));
  return { total: totalOf(body), repoCount: new Set(list.map((i) => i.repo)).size, items: list };
}

// The repository that would otherwise fill the commit page on its own. This
// site takes about ten commits a day, so one page of 100 reached back only
// five days and showed two other repositories where six had commits that
// month. It gets a query of its own that reads total_count alone, which is
// exact however many pages it spans, and the page goes to everything else.
export const BUSIEST_REPO = `${GITHUB_USER}/site`;

const toCommit = (it: any): Commit => ({
  repo: text(it?.repository?.full_name),
  message: clip(text(it?.commit?.message).split("\n")[0], 140),
  url: ghUrl(it?.html_url),
  at: text(it?.commit?.author?.date),
});
// Belt and braces under `is:public`: commit results DO carry the flag, so a
// private repository that slipped the query still never reaches the payload.
const publicCommits = (body: unknown) =>
  items(body).filter((it) => it?.repository?.private === false).map(toCommit).filter((c) => c.repo && c.message);

/**
 * Commits to my own repositories, grouped by repository. `rest` is every
 * repository but BUSIEST_REPO, one page; `busiest` is that repository alone,
 * asked for one item, so its count is total_count and its latest is item 0.
 */
export function normalizeCommits(rest: unknown, busiest: unknown, since: string): GithubActivity["commits"] {
  // A busiest-repo commit in `rest` would be counted twice, so it is dropped
  // here whatever the query said, from the items AND from rest's total_count.
  const all = publicCommits(rest);
  const list = all.filter((c) => c.repo !== BUSIEST_REPO);
  const leaked = all.length - list.length;
  const byRepo = new Map<string, { repo: string; count: number; latest: Commit }>();
  for (const c of list) {
    const g = byRepo.get(c.repo) ?? { repo: c.repo, count: 0, latest: c };
    g.count++;
    if (c.at > g.latest.at) g.latest = c;
    byRepo.set(c.repo, g);
  }
  const top = publicCommits(busiest).find((c) => c.repo === BUSIEST_REPO);
  // Without a public item to name the repository by, its count is not shown:
  // total_count alone cannot say the repository is still the public one.
  const busiestCount = top ? totalOf(busiest) : 0;
  if (top && busiestCount) byRepo.set(BUSIEST_REPO, { repo: BUSIEST_REPO, count: busiestCount, latest: top });
  const restTotal = Math.max(0, totalOf(rest) - leaked);
  const oldest = list.reduce((min, c) => (c.at && c.at < min ? c.at : min), "9999");
  return {
    total: restTotal + busiestCount,
    coveredSince: restTotal > list.length && list.length ? day(oldest) : since,
    repos: [...byRepo.values()].sort((a, b) => b.count - a.count || b.latest.at.localeCompare(a.latest.at)),
  };
}

export function githubQueries(since: string) {
  const u = GITHUB_USER;
  const issues = (q: string) =>
    `${API}/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=${PER_PAGE}`;
  const commits = (q: string, perPage: number) =>
    `${API}/search/commits?q=${encodeURIComponent(q)}&sort=author-date&order=desc&per_page=${perPage}`;
  return {
    prs: issues(`author:${u} is:pr is:public -user:${u} created:>=${since}`),
    issues: issues(`author:${u} is:issue is:public -user:${u} created:>=${since}`),
    commits: commits(`author:${u} user:${u} is:public -repo:${BUSIEST_REPO} author-date:>=${since}`, PER_PAGE),
    busiest: commits(`author:${u} repo:${BUSIEST_REPO} is:public author-date:>=${since}`, 1),
  };
}

export function windowStart(now: Date, days = WINDOW_DAYS) {
  return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

// Four requests in parallel under ONE deadline, the shape reading.ts uses for
// Curius. A tier that fails throws, and the whole build fails with it: a card
// missing its PR section would read as "no PRs this month", which is false.
async function buildGithubActivity(env): Promise<GithubActivity> {
  const now = new Date();
  const since = windowStart(now);
  const q = githubQueries(since);
  const signal = AbortSignal.timeout(5000);
  const get = async (url: string) => {
    const res = await signedFetch(url, env, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      signal,
    });
    if (!res.ok) { await res.body?.cancel(); throw new Error(`GitHub search ${res.status}`); }
    return res.json();
  };
  const [prs, issues, commits, busiest] = await Promise.all([get(q.prs), get(q.issues), get(q.commits), get(q.busiest)]);
  return {
    user: GITHUB_USER,
    fetchedAt: now.toISOString(),
    windowDays: WINDOW_DAYS,
    since,
    prs: normalizePrs(prs),
    issues: normalizeIssues(issues),
    commits: normalizeCommits(commits, busiest, since),
  };
}

const isActivity = (p: unknown): p is GithubActivity =>
  !!asRecord(p) && Array.isArray((p as GithubActivity).prs?.repos) &&
  Array.isArray((p as GithubActivity).issues?.items) && Array.isArray((p as GithubActivity).commits?.repos);

export async function handleGithubJson(request, env, ctx) {
  let payload: GithubActivity | null = null;
  try {
    payload = await swrKV<GithubActivity>(env, ctx, GITHUB_CACHE_KEY, GITHUB_TTL, () => buildGithubActivity(env), {
      isValid: isActivity,
      shouldStore: isActivity,
    });
  } catch (e) {
    console.error("github.json: first build failed", e);
  }
  if (!payload) {
    // Only reachable before the first good build ever lands in KV. The infotip
    // falls back to the plain shortcut card on anything but a 200.
    return new Response(JSON.stringify({ pending: true, note: "GitHub activity has not been read yet" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "retry-after": "300", "x-robots-tag": "noindex", "cache-control": "no-store" },
    });
  }
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-robots-tag": "noindex",
      "access-control-allow-origin": "*",
    },
  });
}
