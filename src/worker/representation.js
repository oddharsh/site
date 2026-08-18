// HTTP representation vault. It captures bounded, normalized observations of
// a public URL under several request profiles. Raw response bodies are parsed
// only long enough to derive a title/word count and are never persisted.
import { lensFetch, validateLensTarget } from "./lens.js";
import { extractTitle } from "./lib/http.ts";
import { readResponseCapped } from "./lib/crawl.ts";

const BODY_CAP = 1024 * 1024;
const PROFILES = {
  browser: {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    userAgent: "Mozilla/5.0 (compatible; aadhar.sh representation vault)",
  },
  bot: {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    userAgent: "AadharshBot/1.0 (+https://aadhar.sh/bot)",
  },
  markdown: {
    accept: "text/markdown;q=1,text/html;q=0.1,*/*;q=0.01",
    userAgent: "AadharshBot/1.0 (+https://aadhar.sh/bot)",
  },
  identity: { accept: "*/*", userAgent: "aadhar.sh representation vault", identity: true },
};

const TABLE = `
CREATE TABLE IF NOT EXISTS http_representation_vault (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  profile TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  final_url TEXT,
  status INTEGER,
  content_type TEXT,
  content_encoding TEXT,
  content_length INTEGER,
  cache_control TEXT,
  vary TEXT,
  etag TEXT,
  last_modified TEXT,
  server TEXT,
  age TEXT,
  cf_cache_status TEXT,
  body_bytes INTEGER,
  body_hash TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  word_count INTEGER
);`;

function error(message) { return { _error: String(message).slice(0, 400) }; }

function database(env) { return env.RESTORE_DB || null; }

async function ensureTable(db) {
  await db.prepare(TABLE).run();
}

function profileNames(value) {
  const names = Array.isArray(value) && value.length ? value : ["browser", "markdown", "identity"];
  const unique = [...new Set(names.map((name) => String(name)))];
  return unique.length <= 4 && unique.every((name) => PROFILES[name]) ? unique : null;
}

function wordCount(text) {
  const plain = text.replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot);/gi, " ")
    .replace(/\s+/g, " ").trim();
  return plain ? plain.split(" ").length : 0;
}

function headerInt(headers, name) {
  const value = headers.get(name);
  const parsed = value === null ? null : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchProfile(url, profile, env) {
  const spec = PROFILES[profile];
  const signal = AbortSignal.timeout(8000);
  let response;
  try {
    if (profile === "bot" || profile === "markdown") {
      response = await lensFetch(url, env, signal, spec.accept);
    } else {
      const headers = { accept: spec.accept, "user-agent": spec.userAgent };
      if (spec.identity) headers["accept-encoding"] = "identity";
      response = await fetch(url, { method: "GET", headers, redirect: "follow", signal, cf: { cacheTtl: 0 } });
    }
  } catch {
    return { error: "request failed" };
  }
  const final = validateLensTarget(response.url || url);
  if (!final.ok) return { error: "request redirected to a disallowed target" };
  const body = await readResponseCapped(response, BODY_CAP);
  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const textual = contentType.startsWith("text/") || contentType.includes("html") || contentType.includes("json") || contentType.includes("xml");
  const title = textual && (contentType.includes("html") || contentType === "text/html") ? extractTitle(body.text) : "";
  return {
    id: crypto.randomUUID(), url, profile, observed_at: Date.now(), final_url: final.url,
    status: response.status, content_type: contentType || null,
    content_encoding: response.headers.get("content-encoding"), content_length: headerInt(response.headers, "content-length"),
    cache_control: response.headers.get("cache-control"), vary: response.headers.get("vary"),
    etag: response.headers.get("etag"), last_modified: response.headers.get("last-modified"),
    server: response.headers.get("server"), age: response.headers.get("age"),
    cf_cache_status: response.headers.get("cf-cache-status"), body_bytes: body.bytesRead,
    body_hash: body.digest || null, truncated: body.truncated ? 1 : 0,
    title: title ? title.slice(0, 300) : null, word_count: textual ? wordCount(body.text) : null,
  };
}

function rowForOutput(row) {
  if (!row) return null;
  return {
    id: row.id, url: row.url, profile: row.profile, observedAt: new Date(row.observed_at).toISOString(),
    finalUrl: row.final_url, status: row.status, contentType: row.content_type,
    contentEncoding: row.content_encoding, contentLength: row.content_length,
    cacheControl: row.cache_control, vary: row.vary, etag: row.etag,
    lastModified: row.last_modified, server: row.server, age: row.age,
    cfCacheStatus: row.cf_cache_status, bodyBytes: row.body_bytes, bodyHash: row.body_hash,
    truncated: !!row.truncated, title: row.title, wordCount: row.word_count,
  };
}

async function store(db, row) {
  await db.prepare(`INSERT OR REPLACE INTO http_representation_vault
    (id,url,profile,observed_at,final_url,status,content_type,content_encoding,content_length,cache_control,vary,etag,last_modified,server,age,cf_cache_status,body_bytes,body_hash,truncated,title,word_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(row.id, row.url, row.profile, row.observed_at, row.final_url, row.status, row.content_type, row.content_encoding,
      row.content_length, row.cache_control, row.vary, row.etag, row.last_modified, row.server, row.age, row.cf_cache_status,
      row.body_bytes, row.body_hash, row.truncated, row.title, row.word_count).run();
}

export async function captureRepresentation(args, env) {
  const target = validateLensTarget(args.url || "");
  if (!target.ok) return error(target.error);
  const profiles = profileNames(args.profiles);
  if (!profiles) return error("profiles must contain up to four of browser, bot, markdown, or identity");
  const db = database(env);
  if (!db) return error("representation vault is not configured on this deployment");
  await ensureTable(db);
  const rows = [];
  for (const profile of profiles) {
    const row = await fetchProfile(target.url, profile, env);
    if (row.error) rows.push({ url: target.url, profile, error: row.error });
    else { await store(db, row); rows.push(rowForOutput(row)); }
  }
  return { url: target.url, profiles, persistence: "normalized headers, metadata, and body digests only", snapshots: rows };
}

export async function readRepresentation(args, env) {
  const db = database(env);
  if (!db) return error("representation vault is not configured on this deployment");
  await ensureTable(db);
  const result = await db.prepare("SELECT * FROM http_representation_vault WHERE id = ? LIMIT 1").bind(String(args.snapshot_id || "")).all();
  const row = result.results?.[0];
  return row ? { snapshot: rowForOutput(row), persistence: "normalized headers, metadata, and body digests only" } : error("snapshot_id was not found");
}

const COMPARE_FIELDS = ["final_url", "status", "content_type", "content_encoding", "content_length", "cache_control", "vary", "etag", "last_modified", "server", "age", "cf_cache_status", "body_bytes", "body_hash", "truncated", "title", "word_count"];

export async function compareRepresentation(args, env) {
  const db = database(env);
  if (!db) return error("representation vault is not configured on this deployment");
  await ensureTable(db);
  const result = await db.prepare("SELECT * FROM http_representation_vault WHERE id = ? LIMIT 1").bind(String(args.snapshot_id || "")).all();
  const before = result.results?.[0];
  if (!before) return error("snapshot_id was not found");
  const target = validateLensTarget(args.url || before.url);
  if (!target.ok) return error(target.error);
  const current = await fetchProfile(target.url, before.profile, env);
  if (current.error) return error(`current representation could not be fetched: ${current.error}`);
  await store(db, current);
  const changes = {};
  for (const field of COMPARE_FIELDS) if ((before[field] ?? null) !== (current[field] ?? null)) changes[field] = { before: before[field] ?? null, after: current[field] ?? null };
  return {
    url: target.url, profile: before.profile, previousSnapshotId: before.id, snapshotId: current.id,
    changed: Object.keys(changes).length > 0, changes, before: rowForOutput(before), after: rowForOutput(current),
    persistence: "normalized headers, metadata, and body digests only",
  };
}
