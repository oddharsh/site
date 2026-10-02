// infra-ports.ts — the adapters behind `bun run infra:check`.
//
// Four ports, one production adapter each: DNS-over-HTTPS, the edge
// (production over the wire), the Cloudflare API and the GitHub API. An adapter
// FETCHES and hands back an observation. It decides nothing about drift: that
// is tools/lib/infra-compare.ts, which takes the observation as plain data.
//
// EVERY ADAPTER IS READ-ONLY. Each request here is a GET. The one write path in
// this repository, tools/apply-infra.ts, keeps its own client on purpose, so
// nothing here can ever be handed CLOUDFLARE_API_TOKEN_WRITE by sharing code.
//
// A FAILED READ COMES BACK AS A VALUE. The readers return `Read<T>`, whose
// failed arm carries the error text, so a 401, a 403 and a dropped socket all
// reach the comparer as "could not check" rather than as an exception that
// skips a tier or an empty list that compares clean.
//
// `fetchImpl` is a parameter on each adapter so the contract suite can stand a
// recorded response in for the network. That second adapter is what makes
// these seams real.
import type {
  DnsObservation, DnsObservations, EarlyDataResult, EdgeObservation, Read,
  RepositoryObservation, RulesetsObservation, VersionAffinityObservation,
  WorkersBuildsObservation, ZoneSettingObservation,
} from "./infra-compare.ts";
import { dnsKey } from "./infra-compare.ts";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const globalFetch: Fetch = (input, init) => fetch(input, init);

// Identify honestly in the edge tier's own logs, same rule the Worker's
// outbound fetches follow. This is not AadharshBot: it does not sign, and
// pretending otherwise in the access log would be a small lie.
export const BOT_UA = "aadhar-sh-infra-check/1.0 (+https://aadhar.sh/bot)";

/** Run one read and hand its outcome back as a value. */
export async function attempt<T>(read: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    return { ok: false, error: `${e?.message}` };
  }
}

// ------------------------------------------------------------- port: DoH ----

const RRTYPE = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28, DS: 43, SVCB: 64, HTTPS: 65 };

// Two independent resolvers. Google renders SVCB in presentation format;
// Cloudflare returns the RFC 3597 generic form, which decodeSvcb() normalizes
// back. Asking Cloudflare about a Cloudflare-hosted zone is also a bit
// incestuous, which is why Google goes first.
const RESOLVERS = [
  { name: "dns.google", url: (n, t) => `https://dns.google/resolve?name=${n}&type=${t}` },
  { name: "cloudflare-dns.com", url: (n, t) => `https://cloudflare-dns.com/dns-query?name=${n}&type=${t}` },
];

const SVCB_KEYS = { 0: "mandatory", 1: "alpn", 2: "no-default-alpn", 3: "port", 4: "ipv4hint", 5: "ech", 6: "ipv6hint" };

// RFC 3597 generic form ("\\# 37 00 01 06 61 ...") back to presentation format,
// so both resolvers can be compared against one expected string.
export function decodeSvcb(generic: string) {
  const hex = generic.replace(/^\\#\s*\d+\s*/, "").replace(/\s+/g, "");
  const b = Buffer.from(hex, "hex");
  let i = 0;
  const priority = b.readUInt16BE(i); i += 2;
  const labels: string[] = [];
  while (b[i] !== 0) { const len = b[i]; labels.push(b.subarray(i + 1, i + 1 + len).toString("ascii")); i += 1 + len; }
  i += 1;
  const target = labels.length ? `${labels.join(".")}.` : ".";
  const params: string[] = [];
  while (i < b.length) {
    const key = b.readUInt16BE(i); i += 2;
    const len = b.readUInt16BE(i); i += 2;
    const val = b.subarray(i, i + len); i += len;
    const name = SVCB_KEYS[key] ?? `key${key}`;
    if (name === "mandatory") {
      const keys: string[] = [];
      for (let j = 0; j < val.length; j += 2) keys.push(SVCB_KEYS[val.readUInt16BE(j)] ?? `key${val.readUInt16BE(j)}`);
      params.push(`mandatory=${keys.join(",")}`);
    } else if (name === "alpn") {
      const alpns: string[] = [];
      for (let j = 0; j < val.length;) { const len2 = val[j]; alpns.push(val.subarray(j + 1, j + 1 + len2).toString("ascii")); j += 1 + len2; }
      params.push(`alpn=${alpns.join(",")}`);
    } else if (name === "port") {
      params.push(`port=${val.readUInt16BE(0)}`);
    } else if (name === "no-default-alpn") {
      params.push(name);
    } else {
      params.push(`${name}=${val.toString("hex")}`);
    }
  }
  return [priority, target, ...params].join(" ");
}

// Long TXT records arrive as concatenated quoted segments. Join them and drop
// the quoting so the declared value can read as the plain string it is.
function normalizeTxt(data: string) {
  if (!data.startsWith('"')) return data.trim();
  return [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("").trim();
}

export function normalizeRecord(type: string, data: string) {
  if (type === "TXT") return normalizeTxt(data);
  if (type === "SVCB") return data.trim().startsWith("\\#") ? decodeSvcb(data) : data.trim();
  if (type === "DS") return data.replace(/\s+/g, " ").trim();
  return data.trim();
}

async function query(fetchImpl: Fetch, resolver, name: string, type: string) {
  const url = resolver.url(encodeURIComponent(name), RRTYPE[type]);
  const res = await fetchImpl(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${resolver.name} returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.Status !== 0 && body.Status !== 3) throw new Error(`${resolver.name} returned DNS status ${body.Status}`);
  // Filter by the type we asked for: with DNSSEC in play the Answer section
  // also carries RRSIG (46), and A queries can carry the CNAME that led there.
  const answers: string[] = (body.Answer || [])
    .filter((a) => a.type === RRTYPE[type])
    .map((a) => normalizeRecord(type, a.data));
  return { answers: answers.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), authenticated: body.AD === true };
}

// Try each resolver in turn. A resolver that errors is an availability problem,
// not a drift signal, so it comes back as an unreachable report (which the
// comparer turns into an advisory) rather than as an empty answer.
export async function resolveWithFallback(name: string, type: string, fetchImpl: Fetch = globalFetch): Promise<DnsObservation> {
  const errors: string[] = [];
  for (const resolver of RESOLVERS) {
    try {
      return { ...(await query(fetchImpl, resolver, name, type)), resolver: resolver.name };
    } catch (e) {
      errors.push(`${resolver.name}: ${e.message}`);
    }
  }
  return { unreachable: errors };
}

/** Answer every lookup the comparer will ask for (see dnsQueries). */
export async function readDns(queries: { name: string; type: string }[], fetchImpl: Fetch = globalFetch): Promise<DnsObservations> {
  const observed: DnsObservations = new Map();
  for (const { name, type } of queries) observed.set(dnsKey(name, type), await resolveWithFallback(name, type, fetchImpl));
  return observed;
}

// ------------------------------------------------------------ port: edge ----

export type EdgeFetch = (url: string, headers?: Record<string, string>, opts?: { redirect?: RequestRedirect }) => Promise<Response>;

export function edgeFetcher(fetchImpl: Fetch = globalFetch): EdgeFetch {
  return (url, headers = {}, opts = {}) => fetchImpl(url, {
    headers: { "user-agent": `${BOT_UA}`, ...headers },
    redirect: opts.redirect || "follow",
    signal: AbortSignal.timeout(12000),
  });
}

// The thumbnail URLs are content-hashed, so a re-encode mints new ones and any
// URL pinned in infra.json would rot within a release. Resolve one from the
// live manifest instead, which is the same indirection the site itself uses.
async function sampleImageUrl(fetchEdge: EdgeFetch, origin: string) {
  const res = await fetchEdge(`${origin}/images/manifest.json`);
  if (!res.ok) throw new Error(`manifest returned HTTP ${res.status}`);
  const manifest = await res.json();
  const photo = (manifest.photos || manifest.images || [])[0];
  const path = photo?.thumb_jpg || photo?.thumb_avif;
  if (!path) throw new Error("manifest carried no thumbnail path");
  return path.startsWith("http") ? path : `${origin}${path}`;
}

export type EdgePort = {
  fetchEdge: EdgeFetch;
  /** The TLS 0-RTT probe. No HTTP response can carry that answer, so it is its
   *  own instrument (openssl, in check-infra.ts) handed in here. */
  probeEarlyData: (host: string) => Promise<EarlyDataResult>;
};

/** One observation per declared edge check, keyed by its id. What to ASK is
 *  read off the check's `assert` (an encoding to offer, a body to keep); what
 *  the answer MEANS is the comparer's. */
export async function readEdge(edge, port: EdgePort): Promise<Map<string, EdgeObservation>> {
  const { origin, checks } = edge;
  const { fetchEdge } = port;
  const encodingOf = (res: Response) => (res.headers.get("content-encoding") || "").trim().toLowerCase();

  let sample: string | null = null;
  const targetUrl = async (target) => {
    if (target === "homepage") return `${origin}/`;
    if (target === "sample-image") return (sample ??= await sampleImageUrl(fetchEdge, origin));
    // The Markdown twins are their own target because they are their own content
    // type, and content type is what compression is keyed on. /index.md is the
    // stable one: it is served from a committed file rather than generated, so it
    // exists on every deploy and cannot go missing the way a per-page twin could.
    if (target === "markdown-twin") return `${origin}/index.md`;
    throw new Error(`unknown edge target ${JSON.stringify(target)}`);
  };

  const observed = new Map<string, EdgeObservation>();
  for (const check of checks) {
    let url: string;
    try {
      url = await targetUrl(check.target);
    } catch (e) {
      observed.set(check.id, { kind: "no-target", error: `${e.message}` });
      continue;
    }

    try {
      const want = check.assert;
      if (want.compression) {
        const got: Record<string, string> = {};
        for (const encoding of want.compression) got[encoding] = encodingOf(await fetchEdge(url, { "accept-encoding": encoding }));
        observed.set(check.id, { kind: "compression", got });
      } else if (want.compressionPrefers) {
        const res = await fetchEdge(url, { "accept-encoding": want.compressionPrefers.offer });
        observed.set(check.id, { kind: "prefers", got: encodingOf(res) });
      } else if (want.earlyData) {
        observed.set(check.id, { kind: "early-data", result: await port.probeEarlyData(new URL(url).hostname) });
      } else {
        // A check may need to ASK for something before it can assert what comes back.
        // Content negotiation is the case that forced this: "the zone is not converting
        // our HTML" is only observable on a request that says `Accept: text/markdown`,
        // and a check that cannot set a request header cannot see it at all.
        const res = await fetchEdge(url, check.request || {});
        const headers: Record<string, string> = {};
        // Through get(), so a repeated header reads exactly as the comparer's
        // old `res.headers.get(name)` did. keys() names only headers that are
        // present, so the `?? ""` arm never runs; it is there for the type.
        for (const name of res.headers.keys()) headers[name.toLowerCase()] = res.headers.get(name) ?? "";
        observed.set(check.id, want.bodyLacks ? { kind: "response", headers, body: await res.text() } : { kind: "response", headers });
      }
    } catch (e) {
      // Production being unreachable is an availability problem, not drift.
      observed.set(check.id, { kind: "unreachable", error: `${e.message}` });
    }
  }
  return observed;
}

// ------------------------------------------------------ port: Cloudflare ----

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export type CloudflareGet = (path: string) => Promise<any>;

/** A read-only Cloudflare API client: GET, bearer token, the v4 envelope
 *  unwrapped. It throws on a refusal, naming the path and Cloudflare's own
 *  error codes, which is what the comparer matches a missing scope on. */
export function cloudflareReader(token: string, fetchImpl: Fetch = globalFetch): CloudflareGet {
  return async (path) => {
    const res = await fetchImpl(`${CLOUDFLARE_API}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      const detail = (body.errors || []).map((e) => `${e.code} ${e.message}`).join("; ") || `HTTP ${res.status}`;
      throw new Error(`${path}: ${detail}`);
    }
    return body.result;
  };
}

export const readKvNamespaces = (cf: CloudflareGet, accountId: string) =>
  attempt<any[]>(() => cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`));

export const readR2Buckets = (cf: CloudflareGet, accountId: string) =>
  attempt<any>(() => cf(`/accounts/${accountId}/r2/buckets`));

export const readD1Databases = (cf: CloudflareGet, accountId: string) =>
  attempt<any[]>(() => cf(`/accounts/${accountId}/d1/database?per_page=100`));

export const readWorkerScripts = (cf: CloudflareGet, accountId: string) =>
  attempt<any[]>(() => cf(`/accounts/${accountId}/workers/scripts`));

export const readTokens = (cf: CloudflareGet, accountId: string) =>
  attempt<any[]>(() => cf(`/accounts/${accountId}/tokens?per_page=100`));

/** The Workers Builds triggers for one Worker. Two reads: the script listing
 *  carries the build tag, and the tag names the triggers endpoint. */
export function readWorkersBuilds(cf: CloudflareGet, accountId: string, worker: string): Promise<Read<WorkersBuildsObservation>> {
  return attempt(async () => {
    const scripts = await cf(`/accounts/${accountId}/workers/scripts`);
    const script = (scripts || []).find((s) => s.id === worker);
    const tag = script?.tag || script?.external_script_id;
    if (!tag) return { tag: null };
    return { tag, triggers: await cf(`/accounts/${accountId}/builds/workers/${tag}/triggers`) };
  });
}

async function zoneIdFor(cf: CloudflareGet, zoneName: string): Promise<string | null> {
  const zones = await cf(`/zones?name=${encodeURIComponent(zoneName)}`);
  return zones?.[0]?.id || null;
}

export function readZoneSetting(cf: CloudflareGet, zoneName: string, setting: string): Promise<Read<ZoneSettingObservation>> {
  return attempt(async () => {
    const zoneId = await zoneIdFor(cf, zoneName);
    if (!zoneId) return { zoneId: null };
    return { zoneId, setting: await cf(`/zones/${zoneId}/settings/${setting}`) };
  });
}

export function readVersionAffinity(cf: CloudflareGet, zoneName: string, phase: string): Promise<Read<VersionAffinityObservation>> {
  return attempt(async () => {
    const zoneId = await zoneIdFor(cf, zoneName);
    if (!zoneId) return { zoneId: null };
    try {
      return { zoneId, ruleset: await cf(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`) };
    } catch (e) {
      // A 404 on the phase entrypoint is NOT "could not check". It is the phase
      // holding no ruleset at all, which is a definite statement that the rule
      // is absent. Anything else is a genuine read failure, so rethrow it.
      if (!/\b404\b/.test(e.message)) throw e;
      return { zoneId, ruleset: null };
    }
  });
}

// ---------------------------------------------------------- port: GitHub ----

export type GithubGet = (path: string) => Promise<any>;

/** A read-only GitHub API client. The token is optional: on the public
 *  endpoints it buys rate-limit headroom alone. */
export function githubReader(token: string | undefined, fetchImpl: Fetch = globalFetch): GithubGet {
  return async (path) => {
    // authorization is added below when a token is present.
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": BOT_UA,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(12000),
    });
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      throw new Error(
        remaining === "0"
          ? "GitHub API rate limit exhausted (set GITHUB_TOKEN for headroom)"
          : `GitHub API returned HTTP ${res.status}`,
      );
    }
    if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status} for ${path}`);
    return res.json();
  };
}

/** Everything the repository tier compares, read in the order the tier used to
 *  ask for it. `repo` is the declaration, read only for WHAT to fetch: the
 *  slug, the declared ruleset names, and which optional blocks exist. When the
 *  first read fails nothing else is attempted, since every later comparer
 *  stands on it. */
export async function readRepository(gh: GithubGet, repo, workflowBlocks: RepositoryObservation["workflowBlocks"]): Promise<RepositoryObservation> {
  const slug = `${repo.owner}/${repo.name}`;

  const core = await attempt<RulesetsObservation>(async () => {
    const meta = await gh(`/repos/${slug}`);
    const rulesets = await gh(`/repos/${slug}/rulesets`);
    return { meta, rulesets, details: {} };
  });
  if (!core.ok) return { core, workflowBlocks };

  const declared = new Set((repo.rulesets || []).map((r) => r.name));
  for (const found of core.value.rulesets) {
    if (!declared.has(found.name)) continue;
    core.value.details[found.name] = await attempt(() => gh(`/repos/${slug}/rulesets/${found.id}`));
  }

  const observed: RepositoryObservation = { core, workflowBlocks };

  if (repo.triage) {
    observed.labels = await attempt(async () => {
      const live: any[] = [];
      for (let page = 1; ; page++) {
        const batch = await gh(`/repos/${slug}/labels?per_page=100&page=${page}`);
        live.push(...batch);
        if (batch.length < 100) break;
      }
      return live;
    });
  }
  if (repo.code_scanning) {
    observed.codeScanning = await attempt(() => gh(`/repos/${slug}/code-scanning/default-setup`));
  }
  if (repo.actions_permissions) {
    observed.actions = await attempt(async () => {
      const live = await gh(`/repos/${slug}/actions/permissions`);
      const workflow = await gh(`/repos/${slug}/actions/permissions/workflow`);
      return { live, workflow };
    });
  }
  return observed;
}
