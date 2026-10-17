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

// A stand-in for curl that plays api.github.com and github.com by URL. It
// answers the API with the 403 Workers Builds saw (build 8358ea90) when
// ROLLING_API=ratelimit and the request carries no token, and logs each
// request so a scenario can assert which source was read and who was sent
// the token. It retries the way real curl does (measured against a local
// server): --retry-all-errors repeats a 4xx --retry more times, while plain
// --retry leaves a 403 alone.
const CURL = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let out, headers, format, auth = false, fail = false, retries = 0, retryAll = false, url;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-o") out = args[++i];
  else if (arg === "-D") headers = args[++i];
  else if (arg === "-w") format = args[++i];
  else if (arg === "-H") { const h = args[++i]; auth ||= /^Authorization: Bearer /m.test(h.startsWith("@") ? fs.readFileSync(h.slice(1), "utf8") : h); }
  else if (arg === "--retry") retries = Number(args[++i]);
  else if (arg === "--retry-delay") i++;
  else if (arg === "--retry-all-errors") retryAll = true;
  else if (/^-[a-zA-Z]+$/.test(arg)) fail ||= arg.includes("f");
  else if (arg.startsWith("https://")) url = arg;
  else process.exit(2);
}
const fixture = process.env.ROLLING_FIXTURE;
const files = {
  "https://api.github.com/repos/oven-sh/bun/releases/tags/canary": "release.json",
  "https://github.com/oven-sh/bun/releases/tag/canary": "release.html",
  "https://github.com/oven-sh/bun/releases/expanded_assets/canary": "assets.html",
  [\`https://github.com/oven-sh/bun/releases/download/canary/\${process.env.ROLLING_PLATFORM}.zip\`]: "bun.zip",
};
let status = files[url] ? 200 : 404;
let body = files[url] ? fs.readFileSync(fixture + "/" + files[url]) : "";
let head = "";
if (url.startsWith("https://api.github.com/") && process.env.ROLLING_API === "ratelimit" && !auth) {
  status = 403;
  body = JSON.stringify({ message: "API rate limit exceeded" });
  head = "x-ratelimit-remaining: 0\\r\\nx-ratelimit-reset: 1791475530\\r\\n";
}
const attempts = status >= 400 && retryAll ? retries + 1 : 1;
fs.appendFileSync(fixture + "/requests.log", ((auth ? "auth " : "anon ") + url + "\\n").repeat(attempts));
if (headers) fs.writeFileSync(headers, "HTTP/2 " + status + "\\r\\n" + head + "\\r\\n");
if (fail && status >= 400) { process.stderr.write("curl: (22) The requested URL returned error: " + status + "\\n"); process.exit(22); }
if (out) fs.writeFileSync(out, body);
if (format) process.stdout.write(String(status));
`;

const API_SCENARIOS = ["valid", "valid Linux", "checksum mismatch", "revision mismatch", "no checker", "wrong download host", "missing digest"];
const PAGE_SCENARIOS = ["rate limited", "rate limited with a token", "forced to pages", "rate limited, page digest mismatch", "rate limited, page markup drifted"];

for (const scenario of [...API_SCENARIOS, ...PAGE_SCENARIOS]) {
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
    // The same release as github.com renders it, trimmed from the 2026-10-08
    // pages: the body's commit link, and a copy button per asset whose label
    // names the file. The decoy asset proves the digest is chosen by name.
    const pageDigest = scenario === "rate limited, page digest mismatch" ? "0".repeat(64) : digest;
    write("release.html", scenario === "rate limited, page markup drifted"
      ? `<p>Built from <a href="https://github.com/oven-sh/bun/commit/${REVISION}">${REVISION.slice(0, 7)}</a></p>`
      : `<p>This release of Bun corresponds to the commit: <a class="commit-link" data-hovercard-type="commit" data-hovercard-url="https://github.com/oven-sh/bun/commit/${REVISION}/hovercard" href="https://github.com/oven-sh/bun/commit/${REVISION}"><tt>${REVISION.slice(0, 7)}</tt></a></p>`);
    write("assets.html", ["bun-windows-x64", platform].map((name) => {
      const value = `sha256:${name === platform ? pageDigest : "e".repeat(64)}`;
      return `<a href="/oven-sh/bun/releases/download/canary/${name}.zip" rel="nofollow" data-turbo="false" class="wb-break-all"><span class="text-bold">${name}.zip</span></a>
<span class="Truncate-text">${value}</span><clipboard-copy id="clipboard-button-${value}" aria-label="Copy to clipboard digest for ${name}.zip" type="button" value="${value}" class="Button--invisible"></clipboard-copy>`;
    }).join("\n"));
    write("bin/curl", CURL, 0o755);
    write("installed/bun", "previous binary", 0o755);
    const { GITHUB_TOKEN: _github, GH_TOKEN: _gh, ...inherited } = process.env;
    /** @type {Record<string, string | undefined>} */
    const env = { ...inherited, PATH: `${join(root, "bin")}:${process.env.PATH}`, ROLLING_FIXTURE: root, ROLLING_PLATFORM: platform };
    if (scenario.startsWith("rate limited")) env.ROLLING_API = "ratelimit";
    if (scenario === "rate limited with a token") env.GITHUB_TOKEN = "test-token";
    if (scenario === "forced to pages") env.INSTALL_BUN_METADATA = "pages";
    const result = spawnSync("bash", [INSTALLER, "./installed"], { cwd: root, encoding: "utf8", env });
    const requests = existsSync(join(root, "requests.log")) ? readFileSync(join(root, "requests.log"), "utf8").trim().split("\n") : [];
    const zip = `anon https://github.com/oven-sh/bun/releases/download/canary/${platform}.zip`;
    const api = "https://api.github.com/repos/oven-sh/bun/releases/tags/canary";
    const pages = ["anon https://github.com/oven-sh/bun/releases/tag/canary", "anon https://github.com/oven-sh/bun/releases/expanded_assets/canary"];
    const expected = {
      "rate limited": { metadata: "pages", requests: [`anon ${api}`, ...pages, zip] },
      "rate limited with a token": { metadata: "api", requests: [`auth ${api}`, zip] },
      "forced to pages": { metadata: "pages", requests: [...pages, zip] },
    }[scenario] ?? (scenario.startsWith("valid") ? { metadata: "api", requests: [`anon ${api}`, zip] } : undefined);
    if (expected) {
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const receipt = JSON.parse(readFileSync(join(root, "installed/bun.install.json"), "utf8"));
      assert.equal(receipt.revision, REVISION);
      assert.equal(receipt.digest, `sha256:${digest}`);
      assert.equal(receipt.metadata, expected.metadata);
      // One API request on a 403, never the four that burned build 8358ea90,
      // and the token goes to the API alone, never to the download host.
      assert.deepEqual(requests, expected.requests);
      assert.equal(installedMatchesPin("canary", join(root, "installed/bun"), { version: "1.4.3", revision: REVISION }).ok, true);
    } else {
      assert.notEqual(result.status, 0, "invalid source material must stop installation");
      assert.equal(readFileSync(join(root, "installed/bun"), "utf8"), "previous binary", "failed validation must preserve the previous installation");
      assert.equal(existsSync(join(root, "installed/bun.install.json")), false);
    }
  });
}
