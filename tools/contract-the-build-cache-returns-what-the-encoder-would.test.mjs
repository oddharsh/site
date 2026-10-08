// ── the build cache returns what the encoder would ──────────────────────────
// tools/lib/build-cache.ts sits in front of every q11 twin and zstd frame the
// build writes. A cache that returned the wrong bytes would ship them, so each
// way an entry could be wrong is pinned here: stale encoder, corrupt file,
// shared in-flight work, and the off switch CI runs with.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import {
  assert,
  test,
} from "./contract-shared.ts";

const { buildCache, buildCacheEnabled } = await import("./lib/build-cache.ts");

// A counting brotli encoder: how many inputs actually reached it.
function counted(name = "brotli test") {
  const enc = {
    calls: 0,
    name,
    keyOf: (bytes) => [bytes],
    verify: (bytes, out) => brotliDecompressSync(out).equals(bytes),
    encode: async (items) => { enc.calls += items.length; return items.map((b) => brotliCompressSync(b)); },
  };
  return enc;
}
const fresh = () => mkdtempSync(join(tmpdir(), "build-cache-"));
const page = Buffer.from("<p>a page the build would twin</p>".repeat(40));

test("a second build reads the entry the first one wrote, byte for byte", async () => {
  const dir = fresh();
  try {
    const first = counted();
    const [a] = await buildCache({ dir, enabled: true }).many([page], first);
    const second = counted();
    const [b] = await buildCache({ dir, enabled: true }).many([page], second);
    assert.equal(first.calls, 1);
    assert.equal(second.calls, 0, "the second build encoded nothing");
    assert.ok(a.equals(b) && a.equals(brotliCompressSync(page)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an entry that does not decode to its input is recompressed, never returned", async () => {
  const dir = fresh();
  try {
    await buildCache({ dir, enabled: true }).many([page], counted());
    const [entry] = readdirSync(dir);
    writeFileSync(join(dir, entry), brotliCompressSync(Buffer.from("some other page")));
    const enc = counted();
    const [out] = await buildCache({ dir, enabled: true }).many([page], enc);
    assert.equal(enc.calls, 1, "the foreign entry was a miss");
    assert.ok(brotliDecompressSync(out).equals(page));
    writeFileSync(join(dir, entry), Buffer.from("not brotli at all"));
    const again = counted();
    await buildCache({ dir, enabled: true }).many([page], again);
    assert.equal(again.calls, 1, "a decoder that throws is a miss too");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a different encoder name misses every entry", async () => {
  const dir = fresh();
  try {
    await buildCache({ dir, enabled: true }).many([page], counted("brotli q11 bun@aaaa"));
    const next = counted("brotli q11 bun@bbbb");
    await buildCache({ dir, enabled: true }).many([page], next);
    assert.equal(next.calls, 1, "a new runtime build recompressed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("identical inputs encode once, in one call or across calls", async () => {
  for (const enabled of [true, false]) {
    const dir = fresh();
    try {
      const cache = buildCache({ dir, enabled });
      const enc = counted();
      const [x, y] = await cache.many([page, Buffer.from(page)], enc);
      const [z] = await Promise.all([cache.many([page], enc), cache.many([page], enc)]).then((r) => r[0]);
      assert.equal(enc.calls, 1, `enabled=${enabled}: one encode for four requests`);
      assert.ok(x.equals(y) && y.equals(z));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("switched off, the cache never touches the disk", async () => {
  const dir = join(tmpdir(), `build-cache-off-${process.pid}`);
  const enc = counted();
  await buildCache({ dir, enabled: false }).many([page], enc);
  assert.equal(enc.calls, 1);
  assert.throws(() => readdirSync(dir), "no directory was created");
  assert.equal(buildCacheEnabled({ CI: "true" }), false, "GitHub Actions builds cold");
  assert.equal(buildCacheEnabled({ WORKERS_CI: "1" }), false, "Workers Builds builds cold");
  assert.equal(buildCacheEnabled({ BUILD_CACHE: "0" }), false);
  assert.equal(buildCacheEnabled({}), true);
});
