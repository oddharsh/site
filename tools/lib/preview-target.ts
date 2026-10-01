// Where is a commit's preview? Read it off the check run Workers Builds posts,
// rather than deriving it from the branch name.
//
// Workers Builds uploads every non-production push as a version with a preview
// URL (since aadhar-sh stopped exporting a Durable Object on 2026-09-29), and it
// reports both on the commit as a check run named "Workers Builds: aadhar-sh":
//
//   Version ID: 7bad2dce-93d4-4106-89e5-4fb3fbd93ba1
//   Preview URL: https://7bad2dce-aadhar-sh.aadharsh2010.workers.dev
//   Preview Alias URL: https://claude-served-check-aadhar-sh.aadharsh2010.workers.dev
//
// The VERSION URL is the one to test. It names exactly that upload, while the
// alias follows the branch and moves the moment somebody pushes again. And it is
// read from the check run because Cloudflare documents no rule for turning a
// branch name into an alias (read 2026-10-01: lowercase, digits and dashes,
// 63 characters with the Worker name, and nothing about how a `/` or a long name
// is folded), so a derived alias would be a guess that breaks on the first odd
// branch name.
//
// The summary is text from a third-party app, so it is matched against the one
// host shape it can legitimately name and nothing looser reaches a shell.

export const WORKERS_BUILDS_CHECK = "Workers Builds: aadhar-sh";
export const WORKERS_BUILDS_APP = "cloudflare-workers-and-pages";

const PREVIEW = /^Preview URL: (https:\/\/[0-9a-f]{8}-aadhar-sh\.aadharsh2010\.workers\.dev)\/?\s*$/m;
const VERSION = /^Version ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/m;

export interface PreviewTarget { url: string; version: string }

/** null when the summary names no preview, or names one in a shape we do not trust. */
export function previewFromSummary(summary: string | null | undefined): PreviewTarget | null {
  const url = PREVIEW.exec(summary ?? "")?.[1];
  const version = VERSION.exec(summary ?? "")?.[1];
  if (!url || !version) return null;
  // The version URL's prefix IS the version id's first 8 hex, so the two lines
  // have to agree; a summary where they do not is not one Workers Builds wrote.
  if (!url.startsWith(`https://${version.slice(0, 8)}-`)) return null;
  return { url, version };
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  app?: { slug?: string } | null;
  output?: { summary?: string | null } | null;
}

export type Lookup =
  | { state: "pending" }
  | { state: "failed"; conclusion: string }
  | { state: "ready"; target: PreviewTarget }
  | { state: "unreadable" };

/** Decide from one listing of a commit's check runs. */
export function lookupPreview(runs: CheckRun[]): Lookup {
  const run = runs.find((r) => r.name === WORKERS_BUILDS_CHECK && r.app?.slug === WORKERS_BUILDS_APP);
  if (!run || run.status !== "completed") return { state: "pending" };
  if (run.conclusion !== "success") return { state: "failed", conclusion: run.conclusion ?? "none" };
  const target = previewFromSummary(run.output?.summary);
  return target ? { state: "ready", target } : { state: "unreadable" };
}
