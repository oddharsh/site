// Fetch the served manifest ci.yml cut for a commit, and the commit an origin
// reports it was built from. Shared by tools/check-served.ts (does production
// serve what CI built) and tools/indexnow.ts (which pages did a release change).

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gh = (args: string[]) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export async function originBuild(origin: string): Promise<{ commit: string | null; version: string | null }> {
  const r = await fetch(new URL("/whoareyou.json", origin), { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${origin}/whoareyou.json answered ${r.status}`);
  const j = await r.json();
  return { commit: j?.build?.commit ?? null, version: j?.build?.version ?? null };
}

export function downloadManifest(repo: string, commit: string): string | null {
  const runs = JSON.parse(gh(["run", "list", "--repo", repo, "--workflow", "ci.yml", "--commit", commit, "--event", "push", "--json", "databaseId,conclusion", "--limit", "5"]));
  const run = runs.find((r: { conclusion: string }) => r.conclusion === "success") ?? runs[0];
  if (!run) return null;
  const dir = mkdtempSync(join(tmpdir(), "served-manifest-"));
  try {
    gh(["run", "download", String(run.databaseId), "--repo", repo, "--name", "served-manifest", "--dir", dir]);
  } catch {
    return null;
  }
  return join(dir, "served-manifest.json");
}
