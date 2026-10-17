// Every action reference under .github, and whether it names a commit.
//
// WHY THIS IS A MODULE RATHER THAN TWENTY LINES INSIDE check-infra.ts. The
// first version was twenty lines inside check-infra.ts and three shapes walked
// straight past it, each reported as a clean pass. It lives here so a contract
// test can drive it with fixtures for those exact shapes, which is the only way
// this repo has ever kept a scanner honest.
//
// WHAT A TAG ACTUALLY IS, since the rule looks like pedantry until you say it:
// a tag is a mutable pointer owned by somebody else. `actions/checkout@v7`
// resolves to whatever that repository last pushed there, so the reference is a
// standing grant of arbitrary code execution in CI to a party who can change
// what it means later, with no diff here and no notification.
//
// IT FAILS CLOSED, which is the whole design and was the whole defect. A `uses:`
// this scanner cannot read is an ERROR, never silence. The three shapes that
// evaded the anchored `/^\s*(?:-\s+)?uses:/` matcher, each of which ran under
// GitHub and reported "all 32 references are commit-pinned":
//
//   - {name: x, uses: attacker/evil@main}   a flow-style step, `uses:` mid-line
//     uses:                                 a plain scalar on the NEXT line, so
//       attacker/evil@main                  the anchored form matched nothing
//     uses: ./.github/actions/a/b           a nested composite the walk never
//                                           opened, exempted for being local
//
// LOCAL `./` REFERENCES ARE RESOLVED, NOT EXEMPTED. The exemption was the third
// hole. A path reference has no upstream owner, which is true and is not the
// question: the file it points AT is a place a tag can hide, and a composite is
// free to sit at any depth or outside .github entirely. GitHub resolves `./`
// against the repository root, so every target is locatable, and one that
// cannot be located fails rather than passing for being local.

/** A pinned ref names a 40-character commit: `owner/repo[/path]@<40 hex>`. */
const PINNED = /^[^/@\s]+\/[^@\s]+@[0-9a-f]{40}$/;

/** The general remote shape, pinned or not. Anything matching this but not
 *  PINNED is an unpinned action; anything matching NEITHER is unreadable and
 *  fails on that ground instead of being waved through. */
const REMOTE = /^[^/@\s]+\/[^@\s]+@\S+$/;

/** A container action. `docker://` names an image by tag unless it carries a
 *  digest, so the same mutable-pointer argument applies one registry over. */
const DOCKER_DIGEST = /^docker:\/\/.+@sha256:[0-9a-f]{64}$/;

/** Every `uses:` key on one line, wherever it sits.
 *
 *  ANCHORING WAS THE BUG. The matcher this replaces required `uses:` at the
 *  start of a line after an optional list dash, so a flow-style step carried an
 *  unpinned action past it with no match at all, and no match reads as no
 *  finding. This matches the key after a line start, whitespace, a list dash, or
 *  any flow punctuation, and accepts the JSON spelling `"uses":` that a YAML
 *  file is equally free to use. */
const USES_KEY = /(?:^|[\s{,[])["']?uses["']?\s*:/g;

/** An action reference by SHAPE, wherever it sits on a line.
 *
 *  The second pass, and it exists because the first pass is still a rule about
 *  a KEY. USES_KEY is far wider than the anchored matcher it replaces and it is
 *  still one spelling of one word: YAML's explicit-key form (`? uses` on one
 *  line, `: value` on the next) puts no `uses:` on either line, and GitHub reads
 *  it. So anything shaped like `owner/repo[/path]@ref` that the key pass did not
 *  already account for is checked on its own.
 *
 *  MEASURED BEFORE IT WAS ADOPTED, 2026-08-28: 0 hits across all 15 walked
 *  files, so it costs no false positive today.
 *
 *  NEITHER PASS EXCLUDES COMMENTS, and that is deliberate rather than an
 *  oversight. A `# uses: actions/checkout@v7` inside a workflow fails here, and
 *  so does a bare `owner/repo@v7` in prose; the walked files carry zero of
 *  either today, measured the same day. Excluding comments is where a scanner
 *  starts modelling YAML, and the fix when this fires is to not write a tag ref
 *  in a file whose whole rule is that the string is forbidden. A PINNED ref in
 *  prose passes untouched, so the tree's own `# v7.0.1` trailers are safe. */
const BARE_REF = /(?<![\w./@-])([A-Za-z0-9][\w.-]*\/[\w./-]+@[\w./-]+)/g;

/** The value of one `uses:`, read from the rest of its own line.
 *
 *  SAME LINE ONLY, and that is a decision rather than a limitation. YAML lets
 *  the value sit on the next line as a plain scalar, and GitHub reads it, so a
 *  scanner that stops at the colon finds nothing where a real action runs. The
 *  alternative to reading the continuation is refusing it, and refusing is what
 *  this does: modelling YAML block context in a regex is how the next hole gets
 *  built. Returns null when the line ends after the colon, which the caller
 *  reports as unreadable with the one-line fix. */
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
  /** repo-relative path of the file the ref was read from */
  file: string;
  /** 1-indexed line */
  line: number;
  /** exactly what the file said, quotes and comment stripped */
  ref: string | null;
  kind: "pinned" | "unpinned" | "local" | "unreadable";
  /** for local refs, the repo-relative action file this resolves to */
  target?: string;
  /** why an unreadable ref could not be classified */
  why?: string;
};

/** Classify one `uses:` value. Pure, so the contract test drives it directly. */
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

/** Every action reference in one file's source, in line order. Both passes:
 *  every `uses:` key wherever it sits, then every bare `owner/repo@ref` shape
 *  the key pass did not already read off that same line. */
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

/** The filesystem this audit reads, injected so the contract test can hand it
 *  a fixture tree instead of writing files. Two methods, both repo-relative. */
export interface ActionIo {
  /** utf8 contents, or null when the path does not exist. */
  read(rel: string): Promise<string | null>;
  /** every regular file under a directory, recursively, repo-relative. An
   *  absent directory is an empty list rather than a throw: .github/actions is
   *  OPTIONAL in GitHub Actions, and hard-failing on its absence made a
   *  required check depend on a directory this repo happens to have. */
  list(dir: string): Promise<string[]>;
}

/** One finding, classified so the caller can say what is actually wrong.
 *  `unpinned` is a live third-party ref on a mutable pointer; `unreadable` is a
 *  shape this scanner refuses to guess at; `local-missing` is a `./` ref whose
 *  target could not be found, which used to be waved through as exempt. */
export type ActionProblem = {
  file: string;
  line: number;
  ref: string | null;
  kind: "unpinned" | "unreadable" | "local-missing";
  why: string;
};

export type ActionAudit = {
  /** every file opened, in the order it was opened */
  files: string[];
  refs: ActionRef[];
  /** third-party refs seen, pinned or not */
  remote: number;
  local: number;
  /** distinct `owner/repo` */
  repos: Set<string>;
  /** distinct `owner/repo[/path]`, which is larger: codeql-action contributes
   *  `init` and `analyze` from one repository at one commit */
  paths: Set<string>;
  problems: ActionProblem[];
};

/** Walk .github, follow every local ref, and classify every `uses:` found.
 *
 *  THE WALK IS THREE SOURCES and the third is the one the first version
 *  lacked. `.github/workflows` at one level, because GitHub reads workflows at
 *  one level and a `.yml` in a subdirectory is not one. `.github/actions`
 *  RECURSIVELY, so a composite at any depth is opened even when nothing
 *  references it yet. And the TARGET of every local ref, transitively, which is
 *  what covers a composite living outside .github entirely: `./ci-actions/x` is
 *  a reference GitHub honours and no walk of .github can see. */
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

      // local. Resolve it or fail; never exempt it.
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
