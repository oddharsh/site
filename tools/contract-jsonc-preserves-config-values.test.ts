import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "./lib/jsonc.ts";

test("JSONC keeps strings literal while removing comments and trailing commas", () => {
  const values = [",]", ",}", "a, \t]", "https://aadhar.sh/", "/* literal */ // literal",
    'escaped " quote,] and backslash \\', "*/30 * * * *", "line\nfeed", "雪", ""];
  for (const value of values) {
    const literal = JSON.stringify(value);
    assert.deepEqual(parseJsonc(`{/* lead */${literal}: [${literal},/* tail */],}`), { [value]: [value] });
  }
  assert.deepEqual(parseJsonc('// CR line\r{"n": -1.25e+2, "a": [true, false, null,],}// EOF'),
    { n: -125, a: [true, false, null] });
  assert.deepEqual(parseJsonc('[1,/* comma survives comment removal */2,// CRLF\r\n3,]'), [1, 2, 3]);
  for (const value of [null, true, false, 0, -4, "", [], {}]) {
    assert.deepEqual(parseJsonc(`/* before */${JSON.stringify(value)}/* after */`), value);
  }
});

test("remote config generation preserves literal values and refuses malformed input before writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jsonc-config-"));
  const source = join(dir, "input.jsonc");
  const output = join(dir, "output.jsonc");
  const cli = fileURLToPath(new URL("./gen-remote-config.ts", import.meta.url));
  // This CLI only writes a local config. It does not boot a proxy or call bindings.
  const env = { ...process.env, CI: "" };
  const config = {
    vars: { LITERAL: ",]", URL: "https://example.com/a,}" },
    kv_namespaces: [{ binding: "CACHE", id: "fixture" }],
    d1_databases: [{ binding: "DB", database_id: "fixture" }],
    triggers: { crons: ["*/30 * * * *"] },
  };
  try {
    await writeFile(source, `// fixture\n${JSON.stringify(config)}\n`);
    execFileSync(process.execPath, [cli, source, "--out", output], { env, stdio: "pipe" });
    const generated = JSON.parse((await readFile(output, "utf8")).split("\n").slice(2).join("\n"));
    assert.deepEqual(generated, {
      ...config, kv_namespaces: [{ ...config.kv_namespaces[0], remote: true }], triggers: {},
    });
    // A malformed replacement must not overwrite the previously generated config.
    const previous = await readFile(output, "utf8");
    await writeFile(source, '{"vars": {}, "values": [1/* split */2]}');
    const failed = spawnSync(process.execPath, [cli, source, "--out", output], { env, encoding: "utf8" });
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /SyntaxError/);
    assert.equal(await readFile(output, "utf8"), previous);
    const ci = spawnSync(process.execPath, [cli, source, "--out", output],
      { env: { ...env, CI: "true" }, encoding: "utf8" });
    assert.equal(ci.status, 2, ci.stderr);
    assert.match(ci.stderr, /refusing to run in CI/);
    assert.equal(await readFile(output, "utf8"), previous);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JSONC rejects malformed input instead of repairing tokens", () => {
  for (const source of [
    '[1/* split */2]', '[1// split\n2]', 't/* split */rue',
    '{}/* unterminated', '{}/*/', '/*', '{"x": 1,/* unterminated}',
    '[1,,]', '[,]', '{,}', '{"x":,}', '{"x": 1,,}', '{"x": 1 "y": 2}',
    '{"x": "unterminated}', '{"x": "raw\nnewline"}', String.raw`{"x": "bad\q"}`,
    '{"x": "tail\\', 'undefined', 'NaN', '01', '+1', '1 2', '',
  ]) assert.throws(() => parseJsonc(source), SyntaxError, source);
});
