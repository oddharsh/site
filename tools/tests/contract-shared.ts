// contract-shared.ts: node builtins and the test doubles more than one section uses.
//
// Only helpers used by MORE THAN ONE section live here, plus whatever those
// helpers themselves reference. That transitive step is not optional: the first
// attempt moved terminalEnv without TERMINAL_ASSETS and 44 tests failed on a
// helper that had been left behind.
//
// It imports node builtins and nothing from the repo (gotcha 111). Every test
// loads this file, so a repo module imported here becomes an input of every
// test, and traced selection (tools/test-inputs.ts) reruns the whole suite when
// it changes. Until 2026-11-22 it re-exported 107 Worker and tool names, and a
// change to any route handler selected about 210 test files. A helper that
// needs a repo module gets its own file, like contract-config.ts and
// contract-terminal.ts.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const ROOT = new URL("../../", import.meta.url);

const PLAYLIST_ID = "4IRq9W1N2tOWHhH0O3vXiF";

const TRACKS = {
  playlist_id: PLAYLIST_ID,
  playlist_name: "rn",
  tracks: [
    {
      id: "track-1",
      title: "A <song>",
      artists_text: "An Artist",
      artists: [
        {
          id: "artist-1",
          name: "An Artist",
          spotify_url: "https://open.spotify.com/artist/artist-1",
          image_url: null,
        },
      ],
      song_link_url: "https://song.link/s/track-1",
      duration_ms: 65000,
      image_url: null,
      is_explicit: false,
    },
  ],
};

function context() {
  return { waitUntil() {} };
}

function fakeImages() {
  return {
    async info(bytes) {
      return { format: "jpeg", width: 100, height: 50, fileSize: bytes.byteLength, animated: false };
    },
    input(bytes) {
      return {
        transform(options) {
          this.options = options;
          return this;
        },
        async output(options) {
          const marker = new TextEncoder().encode(JSON.stringify({ input: bytes.byteLength, options: this.options || {}, output: options }));
          return {
            response() {
              return new Response(marker, { headers: { "content-type": options.format } });
            },
          };
        },
      };
    },
  };
}

function representationD1() {
  const rows: Record<string, any>[] = [];
  let batches = 0;
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              if (/INSERT OR REPLACE INTO http_representation_vault/i.test(sql)) {
                const [
                  id,
                  url,
                  profile,
                  observed_at,
                  final_url,
                  status,
                  content_type,
                  content_encoding,
                  content_length,
                  cache_control,
                  vary,
                  etag,
                  last_modified,
                  server,
                  age,
                  cf_cache_status,
                  body_bytes,
                  body_hash,
                  truncated,
                  title,
                  word_count,
                ] = args;
                const row = {
                  id,
                  url,
                  profile,
                  observed_at,
                  final_url,
                  status,
                  content_type,
                  content_encoding,
                  content_length,
                  cache_control,
                  vary,
                  etag,
                  last_modified,
                  server,
                  age,
                  cf_cache_status,
                  body_bytes,
                  body_hash,
                  truncated,
                  title,
                  word_count,
                };
                const index = rows.findIndex((existing) => existing.id === id);
                if (index >= 0) rows[index] = row;
                else rows.push(row);
              }
              return { success: true, meta: { changes: 1 } };
            },
            async all() {
              if (/WHERE id = \?/i.test(sql)) return { results: rows.filter((row) => row.id === args[0]) };
              return { results: rows };
            },
          };
        },
        async run() {
          return { success: true, meta: { changes: 0 } };
        },
      };
    },
    async batch(statements) {
      batches++;
      return Promise.all(statements.map((statement) => statement.run()));
    },
    get batchCount() {
      return batches;
    },
    rows,
  };
}

function kvType(typeOrOptions) {
  if (typeOrOptions && typeof typeOrOptions === "object") return typeOrOptions.type || "text";
  return typeOrOptions || "text";
}

function kvForTracks() {
  const kv = {
    async get(key, typeOrOptions) {
      const type = kvType(typeOrOptions);
      if (key === "playlist-id") return PLAYLIST_ID;
      if (key === `tracks:${PLAYLIST_ID}`) return type === "json" ? TRACKS : JSON.stringify(TRACKS);
      return null;
    },
    // swrKV asks for the value and its freshness stamp in ONE read, so the fake
    // has to answer that call. The stamp is now, which is what the retired
    // `tracks:<pid>:fresh` sentinel used to say: these tests read a warm cache
    // and must never fire a background rescrape.
    async getWithMetadata(key, typeOrOptions) {
      const value = await kv.get(key, typeOrOptions);
      return { value, metadata: value === null ? null : { t: Date.now() } };
    },
  };
  return kv;
}

function assertFullDocument(html) {
  assert.match(html, /^<!DOCTYPE html>/i);
  assert.match(html, /<html\b/i);
  assert.match(html, /<head\b/i);
  assert.match(html, /<body\b/i);
  assert.match(html, /<\/html>/i);
}

function labels(headers) {
  return (headers.get("signature-input").match(/(^|, )(sig\d+)=/g) || []).map((m) => m.replace(/^, /, "").replace(/=$/, ""));
}

function staticAssets(files) {
  return {
    async fetch(input) {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      if (!(path in files)) return new Response("not found", { status: 404 });
      return Response.json(files[path]);
    },
  };
}

function fakeD1() {
  const rows: Record<string, any>[] = [];
  const statements: string[] = [];
  const run = (sql, args) => {
    const s = sql.replace(/\s+/g, " ").trim();
    statements.push(s);
    if (/^CREATE/i.test(s)) return { results: [], meta: { changes: 0 } };
    if (/^INSERT INTO webmentions/i.test(s)) {
      const [id, source, target, kind, author, author_url, title, excerpt, received_at] = args;
      const existing = rows.find((r) => r.source === source && r.target === target);
      if (existing) Object.assign(existing, { kind, author, author_url, title, excerpt, received_at });
      else rows.push({ id, source, target, kind, author, author_url, title, excerpt, status: "pending", received_at, approved_at: null });
      if (/RETURNING status/i.test(s)) return existing || rows.at(-1);
      return { meta: { changes: 1 } };
    }
    if (/^SELECT status FROM webmentions WHERE id/i.test(s)) {
      return rows.find((r) => r.id === args[0]) || null;
    }
    if (/^SELECT status FROM webmentions/i.test(s)) {
      const [source, target] = args;
      return rows.find((r) => r.source === source && r.target === target) || null;
    }
    // Both decisions: SET status = '<to>' [, approved_at = ?] WHERE id = ? [AND status = 'pending'].
    const decision = /^UPDATE webmentions SET status = '(\w+)'/i.exec(s);
    if (decision) {
      const to = decision[1];
      const id = args.at(-1);
      const r = rows.find((x) => x.id === id && (!/AND status = 'pending'/i.test(s) || x.status === "pending"));
      if (r) {
        r.status = to;
        if (to === "approved") r.approved_at = args[0];
      }
      return { meta: { changes: r ? 1 : 0 } };
    }
    if (/^DELETE FROM webmentions WHERE source/i.test(s)) {
      const [source, target] = args;
      const keepDeclined = /AND status != 'declined'/i.test(s);
      const i = rows.findIndex((x) => x.source === source && x.target === target && !(keepDeclined && x.status === "declined"));
      if (i >= 0) rows.splice(i, 1);
      return { meta: { changes: i >= 0 ? 1 : 0 } };
    }
    if (/^SELECT source, target/i.test(s)) {
      return { results: rows.filter((r) => r.status === "approved").sort((a, b) => b.approved_at - a.approved_at) };
    }
    return { results: [], meta: { changes: 0 } };
  };
  return {
    rows,
    statements,
    prepare(sql) {
      let bound = [];
      const api = {
        bind: (...a) => {
          bound = a;
          return api;
        },
        run: async () => run(sql, bound),
        all: async () => run(sql, bound),
        first: async () => run(sql, bound),
      };
      return api;
    },
  };
}

const WM_SECRET = "test-signing-secret";

function wmEnv(db) {
  return {
    SOCIAL_DB: db,
    SIGNING_SECRET: WM_SECRET,
    ASSETS: staticAssets({ "/writing/posts.json": [{ slug: "in-flux", title: "in flux", date: "2026-01-01" }] }),
  };
}

function deferredContext() {
  const pending: Promise<unknown>[] = [];
  return { waitUntil: (p: Promise<unknown>) => pending.push(p), settle: () => Promise.all(pending) };
}

const wmPost = (source, target) =>
  new Request("https://aadhar.sh/webmention", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ source, target }).toString(),
  });

const mcpPost = (body, headers = {}) =>
  new Request("https://aadhar.sh/mcp", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });

const MODERN_META = {
  _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  },
};

// The globals, typed loosely for TEST DOUBLES.
//
// bun types `globalThis.fetch` as `typeof fetch`, which carries a `preconnect`
// method. A double that answers three URLs has no business implementing it, and
// adding a stub `preconnect` to sixteen arrow functions would be inventing
// conformance rather than testing anything. Assigning through here says what is
// happening once: a partial stand-in is being installed on the global.
//
// It is deliberately NOT a general escape hatch. Reach for it to install a
// double; anything else wants a real type.
const testGlobals: any = globalThis;

// The subset of JSON Schema that lib/openapi.ts writes: type (one or a list),
// properties, required, items, enum, const, anyOf/oneOf and additionalProperties.
// Returns every violation with its path, so a failure names the field.
function schemaViolations(schema, value, at = "$"): string[] {
  if (schema.anyOf || schema.oneOf) {
    const branches = (schema.anyOf || schema.oneOf).map((branch) => schemaViolations(branch, value, at));
    return branches.some((b) => b.length === 0) ? [] : [`${at}: matches no branch (${branches.map((b) => b[0]).join("; ")})`];
  }
  if ("const" in schema && value !== schema.const) return [`${at}: ${JSON.stringify(value)} is not the const ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} is not in ${JSON.stringify(schema.enum)}`];
  if (schema.type) {
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    const allowed = [schema.type].flat();
    const fits = allowed.includes(kind) || (kind === "integer" && allowed.includes("number"));
    if (!fits) return [`${at}: ${kind}, the schema says ${allowed.join("|")}`];
  }
  const out: string[] = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of schema.required ?? []) if (!(key in value)) out.push(`${at}.${key}: required and missing`);
    for (const [key, child] of Object.entries(value)) {
      const sub = schema.properties?.[key];
      if (sub) out.push(...schemaViolations(sub, child, `${at}.${key}`));
      else if (schema.additionalProperties === false) out.push(`${at}.${key}: not in the schema`);
      else if (typeof schema.additionalProperties === "object") out.push(...schemaViolations(schema.additionalProperties, child, `${at}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => out.push(...schemaViolations(schema.items, item, `${at}[${i}]`)));
  return out;
}

export {
  testGlobals,
  MODERN_META,
  PLAYLIST_ID,
  ROOT,
  TRACKS,
  WM_SECRET,
  assert,
  assertFullDocument,
  brotliCompressSync,
  context,
  deferredContext,
  existsSync,
  fakeD1,
  fakeImages,
  kvForTracks,
  kvType,
  labels,
  mcpPost,
  readFile,
  readFileSync,
  readdir,
  representationD1,
  schemaViolations,
  staticAssets,
  test,
  wmEnv,
  wmPost,
  zlibConstants,
};
