// user-bytes.ts: what a change to minification or compression does to what
// real visitors download and wait for. The CLI is tools/user-bytes.ts.
//
// Every byte claim before this (2026-11-22) was a flat sum of q11 brotli over
// the 77 pages plus /a/. That sum counts each page once, gives a Chromium
// visitor who holds the family dictionary the same bytes as a first-time
// Safari visitor, and has no notion of the deploy that re-mints a page. This
// module prices one visit instead, from three inputs:
//
//   traffic   page views by path and visitor class, from Workers Logs
//             (classifyRequest decides who is a person and what they hold)
//   a tree    a built .build/public: the .br twins, the /pd/ and /ad/ deltas,
//             the family dictionary (readTree)
//   a link    bandwidth and round-trip time (criticalMs)
//
// and answers two questions: what a visit costs once everyone has settled on
// a build (steady state), and what the first visit after deploying B over A
// costs a returning visitor (the re-mint). The second is the one a flat sum
// can't see: a returning Chromium visitor holds A's family dictionary and A's
// /a/ files, and B may have deltas for neither.
//
// Pure apart from readTree, which reads the files it is pointed at.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { matchCrawler, text } from "../../src/worker/ledger.ts";
import type { AnalyticsCell, AnalyticsRow } from "../../src/worker/ledger.ts";
import {
  pageDeltaPaths,
  parseFamilyDictionary,
  parseShellAsset,
  shellDeltaName,
  tagFromAvailableDictionary,
  tagOfDigest,
} from "../../src/worker/lib/dictionary-names.ts";

// ── traffic ──────────────────────────────────────────────────────────────────

/** One Workers Logs row, as tools/user-bytes.ts selects it. Every field is the
 *  log's own value; null when the request did not carry it. */
export type LogRow = {
  path: string;
  ua: string | null;
  /** cf.clientAcceptEncoding: what the CLIENT sent (gotcha 114). */
  ae: string | null;
  dict: string | null;
  chua: string | null;
  site: string | null;
  ref: string | null;
  vbot: string | null;
  asorg: string | null;
  rtt: number | null;
  status: number;
  method: string;
  /** Workers Logs head sampling: this row stands for `si` requests. */
  si: number;
};

/** The Workers Logs SQL for LogRow: document requests only, with exactly
 *  the columns classifyRequest reads. The Accept-Encoding is the cf object's
 *  clientAcceptEncoding, never the request header (docs/GOTCHAS.md gotcha 114). */
export function rowsQuery(days: number): string {
  const h = (name: string) => `attributes['$workers.event.request.headers.${name}']`;
  const c = (name: string) => `attributes['$workers.event.request.cf.${name}']`;
  return [
    `SELECT attributes['$workers.event.path'] AS path, ${h("user-agent")} AS ua, ${c("clientAcceptEncoding")} AS ae,`,
    `${h("available-dictionary")} AS dict, ${h("sec-ch-ua")} AS chua, ${h("sec-fetch-site")} AS site, ${h("referer")} AS ref,`,
    `${c("verifiedBotCategory")} AS vbot, ${c("asOrganization")} AS asorg, ${c("clientTcpRtt")} AS rtt,`,
    `httpStatus AS status, attributes['$workers.event.request.method'] AS method, sampleInterval AS si`,
    `FROM logs.workersLogs WHERE scriptName = 'aadhar-sh' AND timestamp >= NOW() - INTERVAL '${days}' DAY`,
    `AND ${h("sec-fetch-dest")} = 'document' LIMIT 100000`,
  ].join(" ");
}

// The SQL API answers a string per header cell, a number per numeric one,
// and null for a header the request didn't carry (ledger.ts, AnalyticsCell).
const optional = (v: AnalyticsCell): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const count = (v: AnalyticsCell, dflt: number): number => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);

/** One SQL row as a LogRow, at the boundary, so nothing past it re-checks. */
export const parseLogRow = (r: AnalyticsRow): LogRow => ({
  path: text(r.path, "/"),
  ua: optional(r.ua),
  ae: optional(r.ae),
  dict: optional(r.dict),
  chua: optional(r.chua),
  site: optional(r.site),
  ref: optional(r.ref),
  vbot: optional(r.vbot),
  asorg: optional(r.asorg),
  rtt: optional(r.rtt) === null ? null : count(r.rtt, 0) || null,
  status: count(r.status, 0),
  method: text(r.method, "GET"),
  si: count(r.si, 1),
});

/** Who a request was. A person carries what decides their bytes: whether
 *  their engine can take dcz, the dictionary tag they hold, and whether their
 *  cache already has the shell (`warm`). */
export type Visitor =
  { kind: "person"; chromium: boolean; tag: string | null; warm: boolean } | { kind: "bot"; reason: BotReason } | { kind: "skip"; reason: "method" | "status" };

/** The bot rules, in the order they run. The first four are facts about the
 *  request; the last three are inferences, which is why `rule: "loose"` stops
 *  before them and the CLI prints the answer under both. */
export const BOT_REASONS = ["ledger", "verified", "ua-token", "no-ua", "no-client-hints", "header-mismatch", "datacenter"] as const;
export type BotReason = (typeof BOT_REASONS)[number];
const INFERRED: ReadonlySet<BotReason> = new Set(["no-client-hints", "header-mismatch", "datacenter"]);

// Tokens no shipping browser puts in its UA. The aadhar-sh-, AadharshBot and
// probe entries are this repo's own browser:check, lens and runtime-dcz-probe
// runs, which were 70 of 101 dictionary-holding rows on 2026-11-22.
const TOOL_UA =
  /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|curl\/|wget|python|go-http|node-fetch|undici|axios|java\/|okhttp|aadhar-sh-|aadharsh|probe|scan|preview/i;

// Hosting networks a page view from is a script, not a reader. Read off the
// 2026-11-22 week: these orgs sent Chromium UAs with client hints and no
// dictionary, from Singapore and Shanghai cloud ranges, at crawl cadence.
const DATACENTER =
  /amazon|google llc|microsoft corp|anthropic|digitalocean|linode|akamai|ovh|hetzner|leaseweb|tencent|alibaba|huawei|oracle|contabo|vultr|choopa|scaleway|m247|datacamp|code200|palo alto|zscaler|colocrossing|hostinger|aceville|collyer quay|egihosting/i;

const CHROMIUM_UA = /\b(?:Chrome|Chromium|Edg)\/\d/;
const IOS_SHELL = /\b(?:CriOS|EdgiOS|FxiOS)\//; // WebKit underneath, whatever the name

export function classifyRequest(row: LogRow, rule: "strict" | "loose"): Visitor {
  if (row.method !== "GET") return { kind: "skip", reason: "method" };
  if (row.status !== 200) return { kind: "skip", reason: "status" };
  const ua = row.ua ?? "";
  const bot = botReason(row, ua);
  if (bot && (rule === "strict" || !INFERRED.has(bot))) return { kind: "bot", reason: bot };
  const tag = tagFromAvailableDictionary(row.dict);
  const offersDcz = /\bdcz\b/.test(row.ae ?? "");
  const chromium = CHROMIUM_UA.test(ua) && !IOS_SHELL.test(ua);
  // Chromium sends Available-Dictionary only for a dictionary it stored, so a
  // tag is proof of an earlier visit. same-origin is proof of an earlier page
  // in this session. Anything else may still be a returning visitor whose
  // cache we can't see; see the README of the CLI's output, "cold".
  const warm = (tag !== null && offersDcz) || row.site === "same-origin";
  return { kind: "person", chromium, tag: offersDcz ? tag : null, warm };
}

function botReason(row: LogRow, ua: string): BotReason | null {
  if (matchCrawler(ua)) return "ledger";
  if (row.vbot) return "verified";
  if (!ua) return "no-ua";
  if (TOOL_UA.test(ua)) return "ua-token";
  // Chromium has sent Sec-CH-UA on every secure request since 89; a Chromium
  // UA without it is a spoofed string.
  if (CHROMIUM_UA.test(ua) && !IOS_SHELL.test(ua) && !row.chua) return "no-client-hints";
  // A browser sends a Referer only for a navigation that came from a page, and
  // marks that navigation same-origin or cross-site, never "none".
  if (row.site === "none" && row.ref) return "header-mismatch";
  if (row.asorg && DATACENTER.test(row.asorg)) return "datacenter";
  return null;
}

/** Page views of one path by one visitor class: the unit the model prices. */
export type Views = { path: string; chromium: boolean; tag: string | null; warm: boolean; views: number };

export type Traffic = {
  days: number;
  rule: "strict" | "loose";
  views: Views[];
  bots: Partial<Record<BotReason, number>>;
  skipped: number;
  /** Median client TCP round trip over person rows, ms. */
  rttMs: number | null;
  /** Sampled rows behind `views`, for the bootstrap. */
  rows: Views[];
};

export function aggregate(rows: LogRow[], days: number, rule: "strict" | "loose"): Traffic {
  const out = new Map<string, Views>();
  const sampled: Views[] = [];
  const bots: Partial<Record<BotReason, number>> = {};
  const rtts: number[] = [];
  let skipped = 0;
  for (const row of rows) {
    const v = classifyRequest(row, rule);
    if (v.kind === "skip") {
      skipped += row.si;
      continue;
    }
    if (v.kind === "bot") {
      bots[v.reason] = (bots[v.reason] ?? 0) + row.si;
      continue;
    }
    if (row.rtt && row.rtt > 0) rtts.push(row.rtt);
    const path = normalizePath(row.path);
    const one: Views = { path, chromium: v.chromium, tag: v.tag, warm: v.warm, views: row.si };
    sampled.push(one);
    const key = `${path}\0${v.chromium}\0${v.tag}\0${v.warm}`;
    const have = out.get(key);
    if (have) have.views += row.si;
    else out.set(key, { ...one });
  }
  rtts.sort((a, b) => a - b);
  return { days, rule, views: [...out.values()], bots, skipped, rttMs: rtts.length ? rtts[rtts.length >> 1] : null, rows: sampled };
}

// /garage/ redirects to /garage, so both are the page /garage; a query never
// selects a different static file.
export const normalizePath = (path: string): string => {
  const bare = path.split(/[?#]/)[0] || "/";
  return bare.length > 1 ? bare.replace(/\/+$/, "") : "/";
};

// ── a built tree ─────────────────────────────────────────────────────────────

/** A same-origin file a page loads. `blocking` is a stylesheet or classic
 *  script in the document, which holds first paint until it arrives. */
export type Load = { url: string; blocking: boolean };

export type Page = { brBytes: number; deltas: Map<string, number>; loads: Load[] };

export type Asset = {
  name: string;
  /** `nav.js` for /a/nav.<hash8>.js: what stays the same across builds, so
   *  the key that finds this file's predecessor in another tree. The
   *  extension is part of it, since nav-run.js and nav-run.css are two files. */
  lineage: string | null;
  /** First 16 hex of SHA-256 over the asset's bytes: the tag a browser holding
   *  it sends back, and so the key of another build's delta against it. */
  tag: string;
  brBytes: number;
  deltas: Map<string, number>;
};

export type Tree = {
  root: string;
  pages: Map<string, Page>;
  assets: Map<string, Asset>;
  family: { tag: string; brBytes: number; url: string } | null;
};

const sizeOf = (path: string): number | null => (existsSync(path) ? statSync(path).size : null);
const sha16 = (bytes: Uint8Array): string => tagOfDigest(new Uint8Array(createHash("sha256").update(bytes).digest()));

/** The route's static file, with the same two candidates serveStaticPage
 *  tries (lib/dictionary-names.ts, pageDeltaPaths). null for a route the
 *  Worker renders, which no tree holds. */
export function pageFile(root: string, path: string): { rel: string; file: string } | null {
  const rel = path === "/" ? "index" : path.slice(1);
  for (const file of [`${rel}.html`, `${rel}/index.html`]) if (existsSync(join(root, file))) return { rel, file };
  return null;
}

// Minified HTML drops attribute quotes, so the value is either quoted or runs
// to the next space or `>`.
const TAG = /<(link|script|img)\b([^>]*)>/gi;
const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`(?:^|\\s)${name}(?:=(?:"([^"]*)"|'([^']*)'|([^\\s>]+)))?(?=\\s|$|/)`, "i"));
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? "";
};
const SAME_ORIGIN_A = /^\/a\/[^#?]+/;
const NOSCRIPT = /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi;
const INLINE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const LITERAL_A = /\/a\/[\w.-]+\.[0-9a-f]{8}\.(?:json|js|css|svg)\b/g;

/**
 * What a page loads from /a/ before anyone touches it, deduplicated by URL:
 * the files its markup names, and the ones its inline scripts import.
 *
 * Two readings that look right and aren't, both caught by --verify on
 * 2026-11-22. Walking into the loaded files for /a/ literals listed the 10
 * modules nav.js imports only when the Start menu or a tray icon is used,
 * which Chrome never fetched on load. And the homepage names luna.css as a
 * blocking sheet inside <noscript>, the fallback for its media=print swap,
 * which a scripting browser never parses. A third: Chrome reports a sheet or
 * script in <body> as non-blocking (renderBlockingStatus), so only the head's
 * count, and minified HTML may omit </head>, so the head ends at <body too.
 */
export function pageLoads(html: string): Load[] {
  html = html.replace(NOSCRIPT, "");
  const headEnd = html.search(/<\/head>|<body\b/i);
  const inHead = (index: number) => headEnd === -1 || index < headEnd;
  const seen = new Map<string, Load>();
  const add = (url: string, blocking: boolean) => {
    const have = seen.get(url);
    if (have) have.blocking ||= blocking;
    else seen.set(url, { url, blocking });
  };
  for (const match of html.matchAll(TAG)) {
    const [, tag, attrs] = match;
    const name = tag.toLowerCase();
    const head = inHead(match.index);
    const ref = name === "link" ? attr(attrs, "href") : attr(attrs, "src");
    const url = ref?.match(SAME_ORIGIN_A)?.[0];
    if (!url) continue;
    if (name === "link") {
      const rel = (attr(attrs, "rel") ?? "").toLowerCase().split(/\s+/);
      if (rel.includes("stylesheet")) add(url, head && isBlockingMedia(attr(attrs, "media")));
      else if (rel.includes("preload") || rel.includes("modulepreload")) add(url, false);
      // rel=compression-dictionary and the rest are idle fetches the family
      // handles on its own (priceVisit).
    } else if (name === "script") {
      const module = (attr(attrs, "type") ?? "").toLowerCase() === "module";
      add(url, head && !module && attr(attrs, "defer") === null && attr(attrs, "async") === null);
    } else {
      add(url, false);
    }
  }
  for (const [, attrs, body] of html.matchAll(INLINE_SCRIPT)) {
    if (attr(attrs, "src") !== null) continue;
    // JSON islands (ld+json, quiz data) are data, and name nothing to fetch.
    if (/json/i.test(attr(attrs, "type") ?? "")) continue;
    for (const [url] of body.matchAll(LITERAL_A)) add(url, false);
  }
  return [...seen.values()];
}

const isBlockingMedia = (media: string | null): boolean => media === null || /^(?:all|screen)$/i.test(media.trim());

/** Read the files `paths` names from a built tree. Pages the tree doesn't
 *  hold are left out, and the caller reports them as Worker-rendered. */
export function readTree(root: string, paths: Iterable<string>): Tree {
  const assets = new Map<string, Asset>();
  const assetDir = join(root, "a");
  const deltaDir = join(root, "ad");
  const deltaFiles = existsSync(deltaDir) ? readdirSync(deltaDir) : [];
  let family: Tree["family"] = null;
  for (const name of existsSync(assetDir) ? readdirSync(assetDir) : []) {
    if (name.endsWith(".br") || name.includes(".src.")) continue;
    const bytes = readFileSync(join(assetDir, name));
    const brBytes = sizeOf(join(assetDir, `${name}.br`)) ?? bytes.length;
    if (parseFamilyDictionary(name)) {
      family = { tag: sha16(bytes), brBytes, url: `/a/${name}` };
      continue;
    }
    const shell = parseShellAsset(name);
    const deltas = new Map<string, number>();
    if (shell) {
      const prefix = shellDeltaName(shell, "").replace(/\.dcz$/, "");
      for (const file of deltaFiles) {
        if (!file.startsWith(prefix) || !file.endsWith(".dcz")) continue;
        deltas.set(file.slice(prefix.length, -".dcz".length), statSync(join(deltaDir, file)).size);
      }
    }
    assets.set(name, { name, lineage: shell ? `${shell.base}.${shell.ext}` : null, tag: sha16(bytes), brBytes, deltas });
  }
  const pages = new Map<string, Page>();
  for (const path of paths) {
    const found = pageFile(root, path);
    if (!found) continue;
    const html = readFileSync(join(root, found.file), "utf8");
    const brBytes = sizeOf(join(root, `${found.file}.br`)) ?? Buffer.byteLength(html);
    pages.set(path, { brBytes, deltas: pageDeltas(root, found.rel), loads: pageLoads(html) });
  }
  return { root, pages, assets, family };
}

function pageDeltas(root: string, rel: string): Map<string, number> {
  const deltas = new Map<string, number>();
  const dir = join(root, "pd");
  if (!existsSync(dir)) return deltas;
  // Both candidate slugs, as the Worker tries them; the probe tag is replaced.
  const prefixes = pageDeltaPaths(rel, "x").map((p) => p.slice("/pd/".length, -"x.dcz".length));
  for (const file of readdirSync(dir)) {
    for (const prefix of prefixes) {
      if (!file.startsWith(prefix) || !file.endsWith(".dcz")) continue;
      const tag = file.slice(prefix.length, -".dcz".length);
      if (/^[0-9a-f]{16}$/.test(tag)) deltas.set(tag, statSync(join(dir, file)).size);
    }
  }
  return deltas;
}

// ── a link ───────────────────────────────────────────────────────────────────

export type Link = { mbps: number; rttMs: number };

// TCP and QUIC start a connection at 10 packets of about 1,460 bytes (RFC
// 6928) and double the window each round trip until the link is full. That is
// why a byte count understates time: 14,600 B and 14,700 B differ by one round
// trip on a cold connection, while 20 KB and 25 KB differ by none.
const INITIAL_WINDOW_BYTES = 14_600;

/** One response's transfer on a connection whose window is `window`. Returns
 *  the ms spent and the window left for the next response. */
function transfer(bytes: number, window: number, link: Link): { ms: number; window: number } {
  const bytesPerMs = (link.mbps * 1e6) / 8 / 1000;
  const fullLink = bytesPerMs * link.rttMs; // bytes in flight that fill the pipe
  let left = bytes;
  let ms = 0;
  let w = window;
  // Bounded: the window doubles every round, so 64 rounds is past any link.
  for (let round = 0; left > 0; round++) {
    if (round >= 64) throw new Error("transfer: 64 rounds without filling the link");
    if (w >= fullLink) {
      ms += left / bytesPerMs;
      left = 0;
      break;
    }
    const sent = Math.min(left, w);
    left -= sent;
    // The last partial window costs its serialization, not a whole round trip.
    ms += left > 0 ? link.rttMs : sent / bytesPerMs;
    if (left > 0) w *= 2;
  }
  return { ms, window: w };
}

/** First-paint network time on one warm-handshake connection: a round trip
 *  for the document and its bytes, then, if any render-blocking file isn't
 *  cached, a round trip for them and their bytes on the same window. The TLS
 *  handshake is left out: it is the same for both builds, and this model
 *  exists to subtract. */
export function criticalMs(htmlBytes: number, blockingBytes: number, link: Link): number {
  const doc = transfer(htmlBytes, INITIAL_WINDOW_BYTES, link);
  let ms = link.rttMs + doc.ms;
  if (blockingBytes > 0) ms += link.rttMs + transfer(blockingBytes, doc.window, link).ms;
  return ms;
}

// ── pricing a visit ──────────────────────────────────────────────────────────

/** What one page view downloads: the document, render-blocking files, other
 *  files, and the family dictionary Chromium fetches at idle. */
export type Cost = { html: number; blocking: number; deferred: number; dictionary: number };
export const total = (c: Cost): number => c.html + c.blocking + c.deferred + c.dictionary;

/**
 * Steady state on `tree`: everyone who has been here holds this tree's
 * family dictionary and /a/ files. A returning Chromium visitor gets the
 * family delta; a cold visitor gets every file as brotli.
 *
 * `before` turns this into the first visit after deploying `tree` over
 * `before`: a returning visitor holds BEFORE's dictionary and files, so the
 * page takes a delta only if `tree` built one against that dictionary, and
 * each file it loads is free when the same URL was loaded before, a delta
 * when Chromium holds the previous file of that base and `tree` built one
 * against it, and brotli otherwise.
 */
export function priceVisit(v: Views, tree: Tree, before?: Tree): Cost | null {
  const page = tree.pages.get(v.path);
  if (!page) return null;
  const held = before ?? tree;
  const heldTag = v.tag !== null ? (held.family?.tag ?? null) : null;
  const html = heldTag !== null && page.deltas.has(heldTag) ? page.deltas.get(heldTag)! : page.brBytes;
  const cost: Cost = { html, blocking: 0, deferred: 0, dictionary: 0 };
  const heldPage = held.pages.get(v.path);
  const heldUrls = new Set((heldPage ?? page).loads.map((l) => l.url));
  // A visitor with any dictionary has been here, so every shell file from the
  // tree they hold is cached, not only the ones this page loaded last time.
  const heldAssets = held.assets;
  for (const load of page.loads) {
    const name = load.url.slice("/a/".length);
    const asset = tree.assets.get(name);
    if (!asset) continue;
    let bytes = asset.brBytes;
    if (v.warm) {
      if (heldAssets.has(name) && (v.tag !== null || heldUrls.has(load.url))) bytes = 0;
      else if (v.chromium && v.tag !== null && asset.lineage) {
        const previous = [...heldAssets.values()].find((a) => a.lineage === asset.lineage);
        const delta = previous ? asset.deltas.get(previous.tag) : undefined;
        if (delta !== undefined) bytes = delta;
      }
    }
    if (load.blocking) cost.blocking += bytes;
    else cost.deferred += bytes;
  }
  // Chromium fetches the family dictionary at idle when it doesn't hold this
  // tree's: on a cold visit, and on the first visit after a roll. A warm page
  // with no tag is a session whose first page already asked for it.
  const fetchesFamily = v.warm ? v.tag !== null && heldTag !== tree.family?.tag : true;
  if (v.chromium && tree.family && fetchesFamily) cost.dictionary = tree.family.brBytes;
  return cost;
}

// ── comparing two trees ──────────────────────────────────────────────────────

export type Side = { bytes: number; ms: number };
export type Comparison = {
  /** Views the model priced, and views to pages no tree holds. */
  priced: number;
  unpriced: number;
  /** Per priced view, weighted by traffic. */
  steady: { a: Side; b: Side };
  /** Views that hold a dictionary, which are the only ones a log can prove
   *  are returning: their first visit after B replaces A, against the same
   *  views once settled on B. */
  remint: { returning: number; first: Side; settled: Side };
  byClass: { label: string; views: number; a: number; b: number }[];
};

const classLabel = (v: Views): string =>
  v.tag !== null
    ? "chromium, holds dictionary"
    : v.warm
      ? v.chromium
        ? "chromium, warm, no dictionary"
        : "other engine, warm"
      : v.chromium
        ? "chromium, cold"
        : "other engine, cold";

export function compare(views: Views[], a: Tree, b: Tree, link: Link): Comparison {
  let priced = 0;
  let unpriced = 0;
  const sum = { a: { bytes: 0, ms: 0 }, b: { bytes: 0, ms: 0 }, first: { bytes: 0, ms: 0 }, settled: { bytes: 0, ms: 0 } };
  let returning = 0;
  const classes = new Map<string, { label: string; views: number; a: number; b: number }>();
  for (const v of views) {
    const ca = priceVisit(v, a);
    const cb = priceVisit(v, b);
    if (!ca || !cb) {
      unpriced += v.views;
      continue;
    }
    priced += v.views;
    sum.a.bytes += v.views * total(ca);
    sum.b.bytes += v.views * total(cb);
    sum.a.ms += v.views * criticalMs(ca.html, ca.blocking, link);
    sum.b.ms += v.views * criticalMs(cb.html, cb.blocking, link);
    const label = classLabel(v);
    const c = classes.get(label) ?? { label, views: 0, a: 0, b: 0 };
    c.views += v.views;
    c.a += v.views * total(ca);
    c.b += v.views * total(cb);
    classes.set(label, c);
    if (v.tag !== null) {
      const first = priceVisit(v, b, a)!;
      returning += v.views;
      sum.first.bytes += v.views * total(first);
      sum.first.ms += v.views * criticalMs(first.html, first.blocking, link);
      sum.settled.bytes += v.views * total(cb);
      sum.settled.ms += v.views * criticalMs(cb.html, cb.blocking, link);
    }
  }
  const per = (s: Side, n: number): Side => (n ? { bytes: s.bytes / n, ms: s.ms / n } : { bytes: 0, ms: 0 });
  return {
    priced,
    unpriced,
    steady: { a: per(sum.a, priced), b: per(sum.b, priced) },
    remint: { returning, first: per(sum.first, returning), settled: per(sum.settled, returning) },
    byClass: [...classes.values()].sort((x, y) => y.views - x.views),
  };
}

/** The steady per-view byte delta (B minus A) over `rounds` resamples of the
 *  sampled rows, for a 90% interval. Seeded, so a run replays. */
export function bootstrapDelta(rows: Views[], a: Tree, b: Tree, rounds: number, seed: number): { lo: number; hi: number } {
  if (rounds > 10_000) throw new Error("bootstrapDelta: rounds over 10,000");
  const priced = rows.flatMap((v) => {
    const ca = priceVisit(v, a);
    const cb = priceVisit(v, b);
    return ca && cb ? [total(cb) - total(ca)] : [];
  });
  if (priced.length === 0) return { lo: 0, hi: 0 };
  let state = seed >>> 0 || 1;
  const next = () => {
    // xorshift32: small, seeded, and the same on every runtime.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  const means: number[] = [];
  for (let r = 0; r < rounds; r++) {
    let s = 0;
    for (let i = 0; i < priced.length; i++) s += priced[Math.floor(next() * priced.length)];
    means.push(s / priced.length);
  }
  means.sort((x, y) => x - y);
  return { lo: means[Math.floor(rounds * 0.05)], hi: means[Math.floor(rounds * 0.95)] };
}
