// ── The playlist id has one reader ───────────────────────────────────────────
// Split-file convention: shared imports live in contract-shared.ts.
import { assert, test } from "./contract-shared.ts";

const GOOD = "0raTdu2MZH4dNvfG5keVAL";
const FALLBACK = "4IRq9W1N2tOWHhH0O3vXiF";

function kvEnv(value, { throws = false } = {}) {
  const calls = [];
  return {
    calls,
    env: {
      RN_KV: {
        async get(key, opts) {
          calls.push({ key, opts });
          if (throws) throw new Error("kv down");
          return value;
        },
      },
    },
  };
}

test("readPlaylistId: a valid id, else null; KV failures propagate", async () => {
  const { readPlaylistId, PLAYLIST_ID_CACHE_TTL } = await import("../src/worker/rn.ts");
  const ok = kvEnv(GOOD);
  assert.equal(await readPlaylistId(ok.env), GOOD);
  assert.deepEqual(ok.calls, [{ key: "playlist-id", opts: { cacheTtl: PLAYLIST_ID_CACHE_TTL } }], "request-path reads use the colo cache");

  const fresh = kvEnv(GOOD);
  await readPlaylistId(fresh.env, { fresh: true });
  assert.equal(fresh.calls[0].opts, undefined, "fresh skips cacheTtl, for the cron");

  assert.equal(await readPlaylistId(kvEnv(null).env), null);
  assert.equal(await readPlaylistId(kvEnv("not-an-id").env), null);
  assert.equal(await readPlaylistId(kvEnv(GOOD + "x").env), null, "23 characters is not an id");
  assert.equal(await readPlaylistId({}), null, "no binding reads as unset");
  await assert.rejects(readPlaylistId(kvEnv(GOOD, { throws: true }).env), /kv down/);
});

test("currentPlaylistId: the stored id, else the fallback playlist, even when KV fails", async () => {
  const { currentPlaylistId, RN_FALLBACK } = await import("../src/worker/rn.ts");
  assert.ok(RN_FALLBACK.endsWith(FALLBACK));
  assert.equal(await currentPlaylistId(kvEnv(GOOD).env), GOOD);
  assert.equal(await currentPlaylistId(kvEnv(null).env), FALLBACK);
  assert.equal(await currentPlaylistId(kvEnv("bad").env), FALLBACK);
  assert.equal(await currentPlaylistId({}), FALLBACK);
  assert.equal(await currentPlaylistId(kvEnv(GOOD, { throws: true }).env), FALLBACK);
});

test("/rn redirects to the stored playlist, else the fallback", async () => {
  const { handleRn } = await import("../src/worker/rn.ts");
  const go = async (env) => (await handleRn(new Request("https://aadhar.sh/rn"), env, {})).headers.get("location");
  assert.equal(await go(kvEnv(GOOD).env), `https://open.spotify.com/playlist/${GOOD}`);
  assert.equal(await go(kvEnv("bad").env), `https://open.spotify.com/playlist/${FALLBACK}`);
  assert.equal(await go(kvEnv(GOOD, { throws: true }).env), `https://open.spotify.com/playlist/${FALLBACK}`);
});
