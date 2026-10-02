// The build WRITES dictionary deltas and the Worker LOOKS THEM UP, and a
// disagreement between the two has no symptom: a delta the Worker cannot find
// degrades to plain brotli, a correct page at a larger size. /garage asked for
// `garage.<tag>.dcz` while the build wrote `garage__index.<tag>.dcz`, and it
// cost 16% on that page until somebody measured it (2026-07-28).
//
// Both sides now name files through src/worker/lib/dictionary-names.ts. This
// test plays each side with the calls that side makes and requires the reader
// to land on the file the writer wrote. Each assertion has a control: the old
// reader, run against the same fixtures, must MISS.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import {
  DCZ_HEADER_BYTES, DCZ_ZSTD_LEVEL, dczHeader, familyDictionaryName, pageDeltaName, pageDeltaPaths, pageSlug,
  pageSnapshotName, parseDcz, parseFamilyDictionary, parsePageDelta, parsePageSnapshot, parseShellAsset,
  parseShellDelta, shellAssetName, shellDeltaName, shellDeltaPath, tagFromAvailableDictionary, tagOfDigest,
} from "../src/worker/lib/dictionary-names.ts";
import { dczEncode, dictionaryTag, frameDcz } from "./lib/dcz.ts";

const sha = (bytes) => createHash("sha256").update(bytes).digest();
// What a browser holding `dict` sends: a Structured Field Byte Sequence.
const available = (dict) => `:${sha(dict).toString("base64")}:`;
// The request path as serveStaticPage reduces it before any lookup.
const relOf = (route) => route === "/" ? "index" : route.replace(/^\/+/, "").replace(/\/+$/, "");

const DICT = Buffer.from("the bytes a returning browser already holds");
// [staged asset path, the route html_handling serves it at]
const PAGES = [
  ["index.html", "/"],
  ["garage/index.html", "/garage"],
  ["garage/pretext.html", "/garage/pretext"],
  ["lwe/index.html", "/lwe"],
  ["access/index.html", "/access"],
  ["updates.html", "/updates"],
];
const SHELL = ["nav.1a2b3c4d.js", "luna.00ff00ff.css", "icons.deadbeef.svg", "nav-run.e943e545.js", "a.b.c0ffee00.js"];

// The writer's half, as build.ts step 8 calls it.
const writtenPageDelta = (page, dict) => `/pd/${pageDeltaName(pageSlug(page), frameDcz(Buffer.alloc(0), dict).tag)}`;
// A header the Worker accepts always yields a tag; null here is a test bug.
const tagFrom = (header) => { const tag = tagFromAvailableDictionary(header); assert.ok(tag, String(header)); return tag; };
// The reader's half, as lib/assets.ts calls it.
const pageLookups = (route, header) => pageDeltaPaths(relOf(route), tagFrom(header));
// The reader before 2026-07-28: one candidate, named after the ROUTE.
const oldPageLookups = (route, header) => [`/pd/${relOf(route).replace(/\//g, "__")}.${tagFromAvailableDictionary(header)}.dcz`];

test("a page delta is found at the name the build wrote it under, section indexes included", () => {
  for (const [page, route] of PAGES) {
    const written = writtenPageDelta(page, DICT);
    assert.ok(pageLookups(route, available(DICT)).includes(written), `${route}: the Worker never asks for ${written}`);
  }
  // direct name first: a sub-page costs one lookup
  assert.equal(pageLookups("/garage/pretext", available(DICT))[0], writtenPageDelta("garage/pretext.html", DICT));
  assert.equal(writtenPageDelta("garage/index.html", DICT), `/pd/garage__index.${dictionaryTag(DICT)}.dcz`);
});

test("control: the old route-named lookup misses every section index and nothing else", () => {
  const missed = PAGES.filter(([page, route]) => !oldPageLookups(route, available(DICT)).includes(writtenPageDelta(page, DICT)))
    .map(([page]) => page);
  assert.deepEqual(missed, ["garage/index.html", "lwe/index.html", "access/index.html"]);
});

test("a shell delta is found at the name the build wrote it under", () => {
  for (const name of SHELL) {
    const asset = parseShellAsset(name);
    assert.ok(asset, name);
    const written = `/ad/${shellDeltaName(asset, dczEncode(Buffer.from("new shell bytes"), DICT).tag)}`;
    assert.equal(shellDeltaPath(`/a/${name}`, tagFrom(available(DICT))), written);
    // control: a reader that keeps the extension in the stem asks for a file nobody wrote
    assert.notEqual(`/ad/${name}.${dictionaryTag(DICT)}.dcz`, written);
  }
  assert.equal(shellDeltaPath("/a/nav.1a2b3c4d.js", dictionaryTag(DICT)), `/ad/nav.1a2b3c4d.${dictionaryTag(DICT)}.dcz`);
  // nothing a delta could exist for: no lookup at all
  for (const pathname of ["/a/page-family.1a2b3c4d.dict", "/a/quiz-x.1a2b3c4d.json", "/a/nav.js", "/a/nav.1a2b3c4d.js.br", "/b/nav.1a2b3c4d.js"]) {
    assert.equal(shellDeltaPath(pathname, dictionaryTag(DICT)), null, pathname);
  }
});

test("the tag the build writes is the tag the Worker derives from Available-Dictionary", () => {
  const tag = dictionaryTag(DICT);
  assert.match(tag, /^[0-9a-f]{16}$/);
  assert.equal(tag, sha(DICT).toString("hex").slice(0, 16));
  assert.equal(tagOfDigest(sha(DICT)), tag);
  assert.equal(tagFromAvailableDictionary(available(DICT)), tag);
  assert.equal(tagFromAvailableDictionary(`  ${available(DICT)} `), tag);
  // This value selects a file path, so anything unexpected is null.
  const short = `:${Buffer.alloc(16).toString("base64")}:`;
  for (const bad of [null, undefined, "", sha(DICT).toString("base64"), short, ":../../etc/passwd:", ":%2e%2e:", `:${sha(DICT).toString("base64")}`, "::"]) {
    assert.equal(tagFromAvailableDictionary(bad), null, String(bad));
  }
  assert.throws(() => tagOfDigest(new Uint8Array(16)), /32-byte/);
});

test("every name family parses back to what formatted it", () => {
  const tag = dictionaryTag(DICT);
  for (const name of SHELL) {
    const asset = parseShellAsset(name);
    assert.ok(asset, name);
    assert.equal(shellAssetName(asset), name);
    assert.deepEqual(parseShellDelta(shellDeltaName(asset, tag)), { base: asset.base, hash8: asset.hash8, tag });
  }
  assert.deepEqual(parseShellAsset("a.b.c0ffee00.js"), { base: "a.b", hash8: "c0ffee00", ext: "js", name: "a.b.c0ffee00.js" });
  for (const not of ["nav.js", "nav.1a2b3c4d.js.br", "page-family.1a2b3c4d.dict", "nav.1A2B3C4D.js", ".1a2b3c4d.js", "nav.1a2b3c4.js"]) {
    assert.equal(parseShellAsset(not), null, not);
  }
  for (const [page] of PAGES) {
    const slug = pageSlug(page);
    assert.ok(!slug.includes("/") && !slug.endsWith(".html"), slug);
    assert.equal(pageSlug(page.replace(/\.html$/, "")), slug, "an extensionless stem folds the same way");
    assert.deepEqual(parsePageDelta(pageDeltaName(slug, tag)), { slug, tag });
    const snapshot = pageSnapshotName(slug, tag);
    assert.deepEqual(parsePageSnapshot(snapshot), { slug, tag, name: snapshot });
  }
  assert.equal(pageSlug("garage/index.html"), "garage__index");
  assert.equal(parsePageDelta("garage__index.0123.dcz"), null);
  assert.equal(parsePageSnapshot(`garage__index.${tag}.dcz`), null);
  assert.equal(familyDictionaryName("1a2b3c4d"), "page-family.1a2b3c4d.dict");
  assert.equal(parseFamilyDictionary(familyDictionaryName("1a2b3c4d")), "1a2b3c4d");
  for (const not of ["page-family.1a2b3c4d.dict.br", "a/page-family.1a2b3c4d.dict", "page-family.dict", "nav.1a2b3c4d.js"]) {
    assert.equal(parseFamilyDictionary(not), null, not);
  }
});

test("the dcz header is the RFC 9842 skippable frame, byte for byte", () => {
  const digest = Uint8Array.from({ length: 32 }, (_, i) => i);
  // magic 0x184D2A5E little-endian, a 4-byte LE length of 32, then the digest
  const expected = Buffer.from([
    0x5e, 0x2a, 0x4d, 0x18,
    0x20, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
  ]);
  assert.equal(DCZ_HEADER_BYTES, 40);
  assert.equal(DCZ_ZSTD_LEVEL, 19);
  assert.deepEqual(Buffer.from(dczHeader(digest)), expected);
  assert.throws(() => dczHeader(new Uint8Array(20)), /32-byte/);

  const frame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01]);
  const { out, digest: named, tag } = frameDcz(frame, DICT);
  assert.deepEqual(out, Buffer.concat([Buffer.from([0x5e, 0x2a, 0x4d, 0x18, 0x20, 0, 0, 0]), sha(DICT), frame]));
  assert.deepEqual(named, sha(DICT));
  assert.equal(tag, dictionaryTag(DICT));

  const parsed = parseDcz(out);
  assert.ok(parsed);
  assert.deepEqual(parsed.digest, sha(DICT));
  assert.deepEqual(parsed.frame, frame);
  // control: one wrong byte in the magic or the length is not a dcz body
  for (const at of [0, 3, 4, 7]) {
    const broken = Buffer.from(out);
    broken[at] ^= 0xff;
    assert.equal(parseDcz(broken), null, `byte ${at}`);
  }
  assert.equal(parseDcz(out.subarray(0, 39)), null);
});

test("an encoded delta decodes against its dictionary once the header is parsed off", async () => {
  const dict = await readFile(new URL("../src/worker/lib/dictionary-names.ts", import.meta.url));
  const target = Buffer.concat([dict, Buffer.from("\n// one more line\n")]);
  const { out, tag } = dczEncode(target, dict);
  const parsed = parseDcz(out);
  assert.ok(parsed);
  assert.equal(tagOfDigest(parsed.digest), tag);
  assert.deepEqual(zstdDecompressSync(parsed.frame, { dictionary: dict }), target);
  assert.ok(out.length < target.length / 10, `${out.length} B against ${target.length} B: the dictionary was not honoured`);
});

test("the build and the Worker name deltas through the module, never by hand", async () => {
  const sources = {
    "src/worker/lib/assets.ts": ["pageDeltaPaths(", "shellDeltaPath(", "tagFromAvailableDictionary("],
    "tools/build.ts": ["pageDeltaName(", "shellDeltaName(", "pageSlug(", "parseShellAsset", "parsePageSnapshot"],
  };
  for (const [file, calls] of Object.entries(sources)) {
    const text = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    for (const call of calls) assert.ok(text.includes(call), `${file} no longer calls ${call}`);
    // the three restatements that existed: the slug fold, the tag slice, the frame magic
    assert.ok(!/replace(All)?\(\s*(\/\\\/\/g|"\/")\s*,\s*"__"\s*\)/.test(text), `${file} folds a page slug by hand`);
    assert.ok(!/\.slice\(0,\s*16\)/.test(text), `${file} cuts a 16-hex tag by hand`);
    assert.ok(!/0x5e,\s*0x2a/i.test(text), `${file} writes the dcz magic by hand`);
  }
  // the Worker's copy must load outside workerd and outside node
  const names = await readFile(new URL("../src/worker/lib/dictionary-names.ts", import.meta.url), "utf8");
  assert.ok(!/from\s+"(node|cloudflare):/.test(names), "dictionary-names.ts must stay pure");
});
