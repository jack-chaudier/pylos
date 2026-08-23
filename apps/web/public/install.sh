#!/bin/sh
# Pylos installer — one conversation, every model, nothing forgotten silently.
# https://github.com/jack-chaudier/pylos
set -eu

REPO="jack-chaudier/pylos"
VERSION="${PYLOS_VERSION:-latest}"
PREFIX="${PYLOS_PREFIX:-$HOME/.local/bin}"
SOURCE="https://github.com/$REPO"

say() { printf '%s\n' "$*" >&2; }
die() { say "pylos: $*"; exit 1; }

os=$(uname -s)
arch=$(uname -m)

case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
esac

case "$os/$arch" in
  Darwin/arm64) plat=macos ;;
  Linux/x64)    plat=linux ;;
  Darwin/x64)
    die "no release build for Intel macOS. Pylos ships macOS on Apple silicon and Linux on x64; build from source: $SOURCE" ;;
  Linux/arm64)
    die "no release build for arm64 Linux. Pylos ships macOS on Apple silicon and Linux on x64; build from source: $SOURCE" ;;
  *)
    die "unsupported platform: $os $arch. Pylos ships macOS on Apple silicon and Linux on x64; build from source: $SOURCE" ;;
esac

asset="pylos-${plat}-${arch}.tar.gz"
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

command -v curl >/dev/null 2>&1 || die "curl is required"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

say "pylos: downloading $asset"
curl -fsSL "$url" -o "$tmp/$asset" || die "no release asset at $url — see https://github.com/$REPO/releases"

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$PREFIX"
install -m 0755 "$tmp/pylos" "$PREFIX/pylos"

say "pylos: installed to $PREFIX/pylos"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) say "pylos: add $PREFIX to your PATH" ;;
esac
say "pylos: run 'pylos serve' and open http://127.0.0.1:7334/app/"
