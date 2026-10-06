import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { installedMatchesPin, readPin, writePin } from "./lib/bun-pin.ts";

const REVISION = "bbdc5a519e0a06d1b3133b564f91096b9ba10a31";
const INSTALLER = new URL("../.github/install-bun.sh", import.meta.url).pathname;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rolling-bun-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, content, mode) => {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), typeof content === "string" ? content : JSON.stringify(content), mode ? { mode } : undefined);
  };
  return { root, write };
}

test("rolling source round-trips and baseline identity comes from the installation receipt", (t) => {
  const { root, write } = fixture(t);
  write("config/bun-pin.json", { bun: "1.4.2" });
  writePin(root, "canary");
  assert.equal(readPin(root).version, "canary");
  const executable = join(root, "bun");
  const running = { version: "1.4.3", revision: REVISION };
  assert.equal(installedMatchesPin("canary", executable, running).ok, false, "a floating source alone proves no installation");
  write("bun.install.json", { source: "canary", revision: REVISION });
  assert.equal(installedMatchesPin("canary", executable, running).ok, true);
  assert.equal(installedMatchesPin("canary", executable, { ...running, revision: "f".repeat(40) }).ok, false);
  write("bun.install.json", { source: "npm", revision: REVISION });
  assert.equal(installedMatchesPin("canary", executable, running).ok, false);
  write("bun.install.json", { source: "canary", revision: REVISION.slice(0, 9) });
  assert.equal(installedMatchesPin("canary", executable, running).ok, false, "the receipt must hold the full commit");
  write("bun.install.json", "invalid JSON");
  assert.equal(installedMatchesPin("canary", executable, running).ok, false);
});

for (const scenario of ["valid", "valid Linux", "checksum mismatch", "revision mismatch", "no checker", "wrong download host", "missing digest"]) {
  test(`rolling installer: ${scenario}`, (t) => {
    const { root, write } = fixture(t);
    const linux = scenario === "valid Linux";
    const platform = linux ? "bun-linux-x64" : "bun-darwin-aarch64";
    write("config/bun-pin.json", { bun: "canary" });
    write("bin/uname", `#!/bin/sh\ncase "$1" in -s) echo ${linux ? "Linux" : "Darwin"};; -m) echo ${linux ? "x86_64" : "arm64"};; *) exit 1;; esac\n`, 0o755);
    write(`archive/${platform}/bun`, `#!/bin/sh\ncase "$1" in\n -p) echo '${scenario === "revision mismatch" ? "f".repeat(40) : REVISION}';;\n --version) echo '1.4.3';;\n --revision) echo '1.4.3-canary.1+bbdc5a519';;\n check) exit ${scenario === "no checker" ? 1 : 0};;\n *) exit 1;;\nesac\n`, 0o755);
    const zipped = spawnSync("zip", ["-qr", join(root, "bun.zip"), platform], { cwd: join(root, "archive"), encoding: "utf8" });
    assert.equal(zipped.status, 0, zipped.stderr);
    const digest = createHash("sha256").update(readFileSync(join(root, "bun.zip"))).digest("hex");
    write("release.json", {
      tag_name: "canary", body: `This release corresponds to the commit: ${REVISION}`,
      assets: [{ name: `${platform}.zip`, browser_download_url: scenario === "wrong download host" ? `https://example.com/${platform}.zip` : `https://github.com/oven-sh/bun/releases/download/canary/${platform}.zip`,
        digest: scenario === "missing digest" ? undefined : `sha256:${scenario === "checksum mismatch" ? "0".repeat(64) : digest}` }],
    });
    write("bin/curl", `#!/bin/sh\n[ "$1" = '-fsSL' ] || exit 1\nshift\nif [ "$1" = '--retry' ]; then\n [ "$2" = '3' ] && [ "$3" = '--retry-all-errors' ] && [ "$4" = '--retry-delay' ] && [ "$5" = '2' ] || exit 1\n shift 5\nfi\n[ "$1" = '-o' ] || exit 1\ncase "$3" in\n https://api.github.com/repos/oven-sh/bun/releases/tags/canary) cp "$ROLLING_FIXTURE/release.json" "$2";;\n https://github.com/oven-sh/bun/releases/download/canary/${platform}.zip) cp "$ROLLING_FIXTURE/bun.zip" "$2";;\n *) exit 1;;\nesac\n`, 0o755);
    write("installed/bun", "previous binary", 0o755);
    const result = spawnSync("bash", [INSTALLER, "./installed"], {
      cwd: root, env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, ROLLING_FIXTURE: root }, encoding: "utf8",
    });
    if (scenario.startsWith("valid")) {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const receipt = JSON.parse(readFileSync(join(root, "installed/bun.install.json"), "utf8"));
      assert.equal(receipt.revision, REVISION);
      assert.equal(receipt.digest, `sha256:${digest}`);
      assert.equal(installedMatchesPin("canary", join(root, "installed/bun"), { version: "1.4.3", revision: REVISION }).ok, true);
    } else {
      assert.notEqual(result.status, 0, "invalid source material must stop installation");
      assert.equal(readFileSync(join(root, "installed/bun"), "utf8"), "previous binary", "failed validation must preserve the previous installation");
      assert.equal(existsSync(join(root, "installed/bun.install.json")), false);
    }
  });
}
