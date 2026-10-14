// Every action reference under .github, and whether it names a commit.

const PINNED = /^[^/@\s]+\/[^@\s]+@[0-9a-f]{40}$/;

const REMOTE = /^[^/@\s]+\/[^@\s]+@\S+$/;

const DOCKER_DIGEST = /^docker:\/\/.+@sha256:[0-9a-f]{64}$/;

const USES_KEY = /(?:^|[\s{,[])["']?uses["']?\s*:/g;

const BARE_REF = /(?<![\w./@-])([A-Za-z0-9][\w.-]*\/[\w./-]+@[\w./-]+)/g;

function usesValue(rest: string): string | null {
  const s = rest.trim();
  if (!s || s.startsWith("#")) return null;
  const quoted = /^(['"])((?:\\.|[^\\])*?)\1/.exec(s);
  if (quoted) return quoted[2];
  // A plain scalar ends at flow punctuation or an inline `#` comment.
  const plain = s.split(/[,}\]]/)[0].replace(/\s+#.*$/, "").trim();
  return plain || null;
}

export type ActionRef = {
  file: string;
  line: number;
  ref: string | null;
  kind: "pinned" | "unpinned" | "local" | "unreadable";
  target?: string;
  why?: string;
};

export function classifyRef(ref: string | null): Pick<ActionRef, "kind" | "why"> {
  if (ref === null) {
    return {
      kind: "unreadable",
      why: "the line ends after `uses:`, so the ref sits on a following line where this scanner will not follow it. Put the ref on the same line as the key",
    };
  }
  if (ref.startsWith("./")) return { kind: "local" };
  if (ref.startsWith("docker://")) {
    return DOCKER_DIGEST.test(ref)
      ? { kind: "pinned" }
      : { kind: "unpinned", why: "a `docker://` image tag is mutable the same way a git tag is. Name the image by `@sha256:` digest" };
  }
  if (PINNED.test(ref)) return { kind: "pinned" };
  if (REMOTE.test(ref)) return { kind: "unpinned" };
  return {
    kind: "unreadable",
    why: "this is not `owner/repo[/path]@ref`, `./path` or `docker://image`, so it cannot be checked. An unrecognised shape fails rather than passing, because a shape nobody recognised is how the last three holes here worked",
  };
}

export function scanActionRefs(file: string, source: string): ActionRef[] {
  const out: ActionRef[] = [];
  const lines = source.split("\n");
  for (const [i, line] of lines.entries()) {
    const claimed = new Set<string>();
    USES_KEY.lastIndex = 0;
    for (let m = USES_KEY.exec(line); m; m = USES_KEY.exec(line)) {
      const ref = usesValue(line.slice(m.index + m[0].length));
      if (ref !== null) claimed.add(ref);
      out.push({ file, line: i + 1, ref, ...classifyRef(ref) });
    }
    BARE_REF.lastIndex = 0;
    for (let m = BARE_REF.exec(line); m; m = BARE_REF.exec(line)) {
      const ref = m[1];
      if (claimed.has(ref)) continue;
      const kind = classifyRef(ref);
      if (kind.kind === "pinned") continue;
      out.push({
        file, line: i + 1, ref, kind: "unpinned",
        why: "an action reference by shape, on a line carrying no `uses:` key this scanner could read. YAML's explicit-key form spells the key on its own line, so a ref found this way may well be live",
      });
    }
  }
  return out;
}

/** Where a `./` reference points, as a repo-relative path, or null when it
 *  escapes the checkout. GitHub resolves a local ref against the REPOSITORY
 *  ROOT rather than against the referencing file, so this is root-relative on
 *  purpose. `..` is normalised and a ref that climbs out returns null, since a
 *  path outside the checkout is unresolvable rather than merely unusual. */
export function localTargetDir(ref: string): string | null {
  const parts: string[] = [];
  for (const seg of ref.slice(2).split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join("/");
}

export interface ActionIo {
  read(rel: string): Promise<string | null>;
  list(dir: string): Promise<string[]>;
}

export type ActionProblem = {
  file: string;
  line: number;
  ref: string | null;
  kind: "unpinned" | "unreadable" | "local-missing";
  why: string;
};

export type ActionAudit = {
  files: string[];
  refs: ActionRef[];
  remote: number;
  local: number;
  repos: Set<string>;
  paths: Set<string>;
  problems: ActionProblem[];
};

export async function auditActionPins(io: ActionIo): Promise<ActionAudit> {
  const audit: ActionAudit = {
    files: [], refs: [], remote: 0, local: 0,
    repos: new Set(), paths: new Set(), problems: [],
  };

  const workflows = (await io.list(".github/workflows"))
    .filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
    .sort();
  const composites = (await io.list(".github/actions"))
    .filter((f) => /(^|\/)action\.ya?ml$/.test(f))
    .sort();

  const queue = [...workflows, ...composites];
  const seen = new Set(queue);

  for (let i = 0; i < queue.length; i++) {
    const rel = queue[i];
    const source = await io.read(rel);
    if (source === null) {
      audit.problems.push({ file: rel, line: 0, ref: null, kind: "unreadable", why: "the file disappeared between the walk and the read" });
      continue;
    }
    audit.files.push(rel);

    for (const found of scanActionRefs(rel, source)) {
      audit.refs.push(found);
      if (found.kind === "unreadable" || found.kind === "unpinned") {
        audit.problems.push({ file: rel, line: found.line, ref: found.ref, kind: found.kind as ActionProblem["kind"], why: found.why ?? "" });
        continue;
      }
      if (found.kind === "pinned") {
        audit.remote++;
        const path = found.ref!.split("@")[0];
        audit.paths.add(path);
        audit.repos.add(path.split("/").slice(0, 2).join("/"));
        continue;
      }

      audit.local++;
      const dir = localTargetDir(found.ref!);
      if (dir === null) {
        audit.problems.push({
          file: rel, line: found.line, ref: found.ref, kind: "local-missing",
          why: "it climbs above the repository root, so it names nothing inside this checkout",
        });
        continue;
      }
      // A local reusable WORKFLOW names the file; a local ACTION names the
      // directory holding action.yml. Try the file first, then both spellings.
      const candidates = /\.ya?ml$/.test(dir) ? [dir] : [`${dir}/action.yml`, `${dir}/action.yaml`].map((p) => p.replace(/^\//, ""));
      let target: string | null = null;
      for (const c of candidates) {
        if ((await io.read(c)) !== null) { target = c; break; }
      }
      if (!target) {
        audit.problems.push({
          file: rel, line: found.line, ref: found.ref, kind: "local-missing",
          why: `there is no action file at ${candidates.join(" or ")}`,
        });
        continue;
      }
      found.target = target;
      if (!seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }

  return audit;
}
