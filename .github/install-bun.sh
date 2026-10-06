#!/usr/bin/env bash
# install-bun.sh <dir> — install the bun that config/bun-pin.json names into
# <dir>/bun, from the declared source with checksum and identity checks. Prints nothing but the
# one summary line on success; every failure names its cause.
#
# ONE INSTALLER FOR BOTH PLACES THIS REPO BOOTSTRAPS A BUN: the setup-bun
# action (every workflow) and .github/deploy-wrangler.sh (Workers Builds, the
# path that publishes production). They carried two copies of this logic
# until 2026-09-15, which is how the CI copy grew canary support the deploy
# copy never saw. The deploy side matters MORE, because Cloudflare's build
# image cannot resolve a canary `packageManager` (measured 2026-09-15 with
# three probes: a canary pin fails the image's own bootstrap before any
# command of ours runs, sha or no sha, and only removing the field builds).
# With SKIP_DEPENDENCY_INSTALL set in the build settings the image stops
# bootstrapping, the pin lives in a file it never reads, and this script owns
# the toolchain on both sides.
#
# FIXED PINS USE NPM. A pin may be a release (`1.4.2`) or a
# DATED CANARY WITH ITS BUILD SHA (`1.4.2-canary.20260913.1+09bb546`), and
# only the registry carries both: bun publishes every canary build there under
# an immutable dated version with `@oven/bun-<platform>` tarballs beside it,
# while the GitHub `canary` tag rolls daily. The registry document carries the
# tarball's sha512. The explicitly rolling canary instead uses GitHub's
# release asset SHA-256 and the commit named by that release.
#
# THREE WITNESSES, because a canary binary reports the NEXT release as its
# version (`bun --version` on the 1.4.2-canary.20260913.1 tarball prints
# `1.4.3`, measured 2026-09-14): the registry's sha512 on the tarball, the
# tarball's own package.json (which names a canary WITH its build sha, so it
# equals the whole pin), and the binary's `--revision`, which carries the sha.
#
# Needs node (for JSON) and openssl, both present on the GitHub runner and in
# the Workers Builds image. `openssl base64 -A` rather than `base64 -w0`, so
# it also runs on a Mac.
set -euo pipefail

dir="${1:?usage: install-bun.sh <dir>}"
# config/bun-pin.json is THE declaration, and it is deliberately not
# package.json's packageManager: the build image reads that field and cannot
# resolve a canary in it (measured 2026-09-15), while nothing but this
# repository's own tools read the file.
pin=$(node -e "process.stdout.write(String(require('./config/bun-pin.json').bun || ''))")
if [ -z "$pin" ]; then
  echo "install-bun.sh: config/bun-pin.json names no bun" >&2; exit 1
fi
version="${pin%%+*}"
sha=""
case "$pin" in *+*) sha="${pin#*+}" ;; esac

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  platform=bun-linux-x64 ;;
  Linux-aarch64) platform=bun-linux-aarch64 ;;
  Darwin-arm64)  platform=bun-darwin-aarch64 ;;
  Darwin-x86_64) platform=bun-darwin-x64 ;;
  *) echo "install-bun.sh: no bun platform package known for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

# The owner selected the rolling GitHub canary to adopt bun check before npm's
# daily publication. Resolve one metadata snapshot, verify its bytes and full
# commit, and keep that identity beside the binary for runtime comparisons.
if [ "$pin" = "canary" ]; then
  mkdir -p "$dir"
  work=$(mktemp -d "$dir/.install.XXXXXX")
  trap 'rm -rf "$work"' EXIT
  curl -fsSL -o "$work/release.json" "https://api.github.com/repos/oven-sh/bun/releases/tags/canary"
  node - "$work/release.json" "$platform" "$work/resolved.json" <<'NODE'
const fs = require("node:fs");
const [file, platform, out] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(file, "utf8"));
const asset = release.assets?.find((entry) => entry.name === `${platform}.zip`);
const revision = /commit:\s*([0-9a-f]{40})\b/.exec(release.body ?? "")?.[1];
const expectedUrl = `https://github.com/oven-sh/bun/releases/download/canary/${platform}.zip`;
if (release.tag_name !== "canary" || !revision || asset?.browser_download_url !== expectedUrl || !/^sha256:[0-9a-f]{64}$/.test(asset?.digest ?? "")) {
  throw new Error("install-bun.sh: canary metadata lacks a supported URL, full commit, or SHA-256 digest");
}
fs.writeFileSync(out, JSON.stringify({ source: "canary", url: expectedUrl, revision, digest: asset.digest }));
NODE
  download=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).url)' "$work/resolved.json")
  digest=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).digest)' "$work/resolved.json")
  commit=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).revision)' "$work/resolved.json")
  curl -fsSL -o "$work/bun.zip" "$download"
  got="sha256:$(openssl dgst -sha256 "$work/bun.zip" | awk '{print $NF}')"
  if [ "$got" != "$digest" ]; then
    echo "install-bun.sh: canary checksum mismatch; the rolling release may have moved during download" >&2
    exit 1
  fi
  unzip -qo "$work/bun.zip" -d "$work"
  candidate="$work/$platform/bun"
  actual=$("$candidate" -p 'Bun.revision')
  if [ "$actual" != "$commit" ]; then
    echo "install-bun.sh: canary names commit $commit, binary reports $actual" >&2
    exit 1
  fi
  "$candidate" check --help >/dev/null
  install -m 0755 "$candidate" "$dir/bun"
  install -m 0644 "$work/resolved.json" "$dir/bun.install.json"
  echo "install-bun.sh: bun $("$dir/bun" --version) ($("$dir/bun" --revision)), GitHub canary, SHA-256 verified, at $dir/bun"
  exit 0
fi

# The registry's record of this exact version: where the bytes are and what
# they hash to. A version the registry does not carry fails HERE, with the
# version named, rather than as a 404 from curl.
doc=$(curl -fsSL "https://registry.npmjs.org/@oven/${platform}/${version}") \
  || { echo "install-bun.sh: @oven/${platform}@${version} is not on the registry" >&2; exit 1; }
tarball=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).dist.tarball)" "$doc")
integrity=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).dist.integrity)" "$doc")

work="$dir/.install"
rm -rf "$work" && mkdir -p "$work"
curl -fsSL -o "$work/bun.tgz" "$tarball"
got="sha512-$(openssl dgst -sha512 -binary "$work/bun.tgz" | openssl base64 -A)"
if [ "$got" != "$integrity" ]; then
  echo "install-bun.sh: tarball integrity mismatch: registry says $integrity, downloaded $got" >&2
  exit 1
fi
tar -xzf "$work/bun.tgz" -C "$work"

packaged=$(node -e "process.stdout.write(require(process.argv[1]).version)" "$work/package/package.json")
if [ "$packaged" != "$pin" ]; then
  echo "install-bun.sh: asked for $pin, the tarball's package.json says $packaged" >&2
  exit 1
fi

install -m 0755 "$work/package/bin/bun" "$dir/bun"
rm -rf "$work"

revision=$("$dir/bun" --revision)
if [ -n "$sha" ]; then
  case "$revision" in
    *"+$sha"*) ;;
    *) echo "install-bun.sh: pin names build $sha, the binary reports $revision" >&2; exit 1 ;;
  esac
elif [ "$("$dir/bun" --version)" != "$version" ]; then
  echo "install-bun.sh: asked for $version, the binary reports $("$dir/bun" --version)" >&2
  exit 1
fi
echo "install-bun.sh: bun $("$dir/bun" --version) ($revision), npm @oven/${platform}@${version}, sha512 verified, at $dir/bun"
