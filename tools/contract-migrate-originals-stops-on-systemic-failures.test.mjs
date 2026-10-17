// migrate-originals.ts stops itself once the network or the login is gone.
// On 2026-10-07 a run lost DNS, then wrangler's OAuth refresh, and logged 105
// failures over three hours before exiting. These run the real script against
// a stub wrangler and count how many photos it tries: three failures in a row
// that name the connection or the login stop it, and anything about one photo
// doesn't.
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, test } from "./contract-shared.ts";

const REPO = fileURLToPath(new URL("../", import.meta.url));
const BUN = process.versions.bun ? process.execPath : "bun";
const STEMS = Array.from({ length: 10 }, (_, i) => `P${i}`);

const AUTH = "✘ [ERROR] Your auth token has expired and could not be refreshed because the Cloudflare auth server could not be reached.";
const DNS = "✘ [ERROR] Unable to resolve Cloudflare's API hostname (api.cloudflare.com or dash.cloudflare.com).";
const PHOTO = "✘ [ERROR] Something about this one object.";
const MISSING = "✘ [ERROR] The specified key does not exist.";

// `script` is one stderr message per wrangler call, in order; the last repeats.
async function migrate(script) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "migrate-originals-")));
  const put = async (rel, text, mode) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
    if (mode) await chmod(path.join(root, rel), mode);
  };
  for (const rel of ["tools/photos/migrate-originals.ts", "tools/photos/pipeline-json.ts", "tools/lib/photo-indexes.ts"]) {
    await put(rel, await readFile(path.join(REPO, rel), "utf8"));
  }
  const index = Object.fromEntries(STEMS.map((s) => [s, { full: `${s}.jpg`, size: 1, uploaded: "2026-07-27T00:00:00.000Z" }]));
  await put("src/worker/photo-index.json", JSON.stringify(index, null, 2) + "\n");
  await put("script", script.join("\n") + "\n");
  // Every call fails; wrangler's last stderr line is its log path, as in production.
  await put("node_modules/.bin/wrangler", `#!/bin/bash
n=$(( $(wc -l < "$FIXTURE_ROOT/calls" 2>/dev/null || echo 0) + 1 ))
echo "$*" >> "$FIXTURE_ROOT/calls"
line=$(sed -n "\${n}p" "$FIXTURE_ROOT/script"); [ -n "$line" ] || line=$(tail -n 1 "$FIXTURE_ROOT/script")
printf '%s\\n🪵  Logs were written to "/tmp/wrangler.log"\\n' "$line" >&2
exit 1
`, 0o755);
  for (const bin of ["cjxl", "djxl"]) await put(`bin/${bin}`, "#!/bin/bash\nexit 0\n", 0o755);
  const r = spawnSync(BUN, ["tools/photos/migrate-originals.ts", "--jobs", "1"], {
    cwd: root, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE_ROOT: root, PHOTO_SOURCE_ORIGIN: "http://127.0.0.1:9" },
  });
  const calls = (await readFile(path.join(root, "calls"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { status: r.status, stderr: r.stderr, calls };
}

test("three connection or login failures in a row stop the run before it tries the rest", async () => {
  const { status, stderr, calls } = await migrate([DNS, AUTH, AUTH]);
  assert.equal(status, 1, stderr);
  assert.equal(calls.length, 3, "a fourth photo was tried after the login was gone");
  assert.match(stderr, /stopped after 3 connection or login failures in a row, 7 photos not attempted: .*auth token has expired/);
  // The failure line names wrangler's ERROR, not its log path.
  assert.match(stderr, /✗ P0: r2 get P0\.jxl: .*Unable to resolve/);
  assert.doesNotMatch(stderr, /✗ P\d: .*Logs were written/);
});

test("failures about single photos never stop the run", async () => {
  const { status, stderr, calls } = await migrate([PHOTO]);
  assert.equal(status, 1, stderr);
  assert.equal(calls.length, 10, "every photo is tried");
  assert.doesNotMatch(stderr, /stopped after/);
});

test("the stop needs the failures in a row: a photo that gets through resets the count", async () => {
  // A missing .jxl is a skip without --delete, which is a photo that got through.
  const { stderr, calls } = await migrate([AUTH, AUTH, MISSING, AUTH, AUTH, MISSING, AUTH, AUTH, MISSING, AUTH]);
  assert.equal(calls.length, 10, stderr);
  assert.doesNotMatch(stderr, /stopped after/);
  assert.match(stderr, /✗ P9: .*auth token has expired/);
});
