#!/usr/bin/env bash
# install-bun.sh <dir> — install the bun that package.json's packageManager
# names into <dir>/bun, from npm, verified three ways. Prints nothing but the
# one summary line on success; every failure names its cause.
#
# ONE INSTALLER FOR BOTH PLACES THIS REPO BOOTSTRAPS A BUN: the setup-bun
# action (every workflow) and .github/deploy-wrangler.sh (Workers Builds, the
# path that publishes production). They carried two copies of this logic
# until 2026-09-15, which is how the CI copy grew canary support the deploy
# copy never saw. The deploy side matters MORE, because Cloudflare's build
# image cannot resolve a canary `packageManager` itself (measured 2026-09-15
# with two reversal probes: a canary pin fails the image's own bootstrap
# before any command of ours runs). With SKIP_DEPENDENCY_INSTALL set in the
# build settings, the image stops bootstrapping and this script owns the
# toolchain on both sides.
#
# WHY NPM RATHER THAN A GITHUB RELEASE. A pin may be a release (`1.4.2`) or a
# DATED CANARY WITH ITS BUILD SHA (`1.4.2-canary.20260913.1+09bb546`), and
# only the registry carries both: bun publishes every canary build there under
# an immutable dated version with `@oven/bun-<platform>` tarballs beside it,
# while the GitHub `canary` tag rolls daily. The registry document carries the
# tarball's sha512, so the bytes are verified, which the release zip never
# allowed.
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
want=$(node -e "process.stdout.write(require('./package.json').packageManager)")
case "$want" in
  bun@*) pin="${want#bun@}" ;;
  *) echo "install-bun.sh: packageManager is not bun: package.json says '$want'" >&2; exit 1 ;;
esac
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
