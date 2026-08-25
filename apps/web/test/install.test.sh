#!/bin/sh
set -eu

root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT HUP INT TERM

repo=$(CDPATH= cd "$(dirname "$0")/../../.." && pwd)
installer="$repo/apps/web/public/install.sh"
fakebin="$root/bin"
mkdir -p "$fakebin"

cat > "$fakebin/uname" <<'EOF'
#!/bin/sh
case "$1" in
  -s) printf '%s\n' "${PYLOS_TEST_OS:-Darwin}" ;;
  -m) printf '%s\n' "${PYLOS_TEST_ARCH:-arm64}" ;;
  *) exit 1 ;;
esac
EOF

cat > "$fakebin/curl" <<'EOF'
#!/bin/sh
destination=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then
    destination=$2
    shift 2
  else
    shift
  fi
done
[ -n "$destination" ]
/bin/cp "$PYLOS_TEST_ARCHIVE" "$destination"
EOF

cat > "$fakebin/mv" <<'EOF'
#!/bin/sh
case "${PYLOS_TEST_FAIL_NEW_APP:-0}:$1" in
  1:*/new/app) exit 73 ;;
esac
exec /bin/mv "$@"
EOF
chmod 0755 "$fakebin/uname" "$fakebin/curl" "$fakebin/mv"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    sha256sum "$1" | awk '{ print $1 }'
  fi
}

make_release() {
  name=$1
  mode=${2:-valid}
  platform=${3:-darwin}
  manifest_arch=${4:-arm64}
  target=aarch64-apple-darwin
  sqlite_file=libsqlite3.dylib
  vec_file=vec0.dylib
  lembed_file=lembed0.dylib
  if [ "$platform/$manifest_arch" = "linux/x64" ]; then
    target=x86_64-unknown-linux-gnu
    sqlite_file=libsqlite3.so
    vec_file=vec0.so
    lembed_file=lembed0.so
  fi
  stage="$root/$name-stage"
  archive="$root/$name.tar.gz"
  mkdir -p "$stage/semantic" "$stage/app/assets"
  printf '#!/bin/sh\nprintf new-pylos\\n\n' > "$stage/pylos"
  chmod 0755 "$stage/pylos"
  printf '<!doctype html><title>Pylos</title>\n' > "$stage/app/index.html"
  printf 'app-asset\n' > "$stage/app/assets/app.js"
  printf 'sqlite\n' > "$stage/semantic/$sqlite_file"
  printf 'vec\n' > "$stage/semantic/$vec_file"
  printf 'lembed\n' > "$stage/semantic/$lembed_file"
  printf 'model\n' > "$stage/semantic/model.gguf"
  : > "$stage/semantic/.gitkeep"
  printf 'Build-time semantic assets.\n' > "$stage/semantic/README.txt"
  sqlite=$(sha256_file "$stage/semantic/$sqlite_file")
  vec=$(sha256_file "$stage/semantic/$vec_file")
  lembed=$(sha256_file "$stage/semantic/$lembed_file")
  model=$(sha256_file "$stage/semantic/model.gguf")
  model_file=model.gguf
  if [ "$mode" = "bad-name" ]; then model_file=../model.gguf; fi
  cat > "$stage/semantic/manifest.json" <<EOF
{
  "schema": 1,
  "target": "$target",
  "platform": "$platform",
  "arch": "$manifest_arch",
  "dimension": 384,
  "sqlite": {
    "file": "$sqlite_file",
    "sha256": "$sqlite"
  },
  "extensions": {
    "vec0": {
      "file": "$vec_file",
      "sha256": "$vec",
      "version": "0.1.8"
    },
    "lembed0": {
      "file": "$lembed_file",
      "sha256": "$lembed",
      "version": "0.0.1-alpha.8"
    }
  },
  "model": {
    "file": "$model_file",
    "sha256": "$model",
    "name": "all-MiniLM-L6-v2"
  }
}
EOF
  if [ "$mode" = "bad-hash" ]; then printf 'tampered\n' > "$stage/semantic/model.gguf"; fi
  if [ "$mode" = "symlink" ]; then ln -s /tmp "$stage/app/escape"; fi
  if [ "$mode" = "extra-runtime" ]; then printf 'undeclared\n' > "$stage/semantic/rogue.so"; fi
  tar -C "$stage" -czf "$archive" pylos semantic app
  printf '%s\n' "$archive"
}

seed_old() {
  prefix=$1
  mkdir -p "$prefix/semantic" "$prefix/app"
  printf 'old-pylos\n' > "$prefix/pylos"
  printf 'old-semantic\n' > "$prefix/semantic/old"
  printf 'old-app\n' > "$prefix/app/index.html"
}

assert_old() {
  prefix=$1
  [ "$(cat "$prefix/pylos")" = "old-pylos" ]
  [ "$(cat "$prefix/semantic/old")" = "old-semantic" ]
  [ "$(cat "$prefix/app/index.html")" = "old-app" ]
}

run_install() {
  archive=$1
  prefix=$2
  shift 2
  env PATH="$fakebin:$PATH" PYLOS_TEST_ARCHIVE="$archive" PYLOS_PREFIX="$prefix" "$@" sh "$installer"
}

valid=$(make_release valid)
prefix="$root/success-prefix"
run_install "$valid" "$prefix" >/dev/null
[ -x "$prefix/pylos" ]
[ -f "$prefix/semantic/manifest.json" ]
[ -f "$prefix/semantic/model.gguf" ]
[ -f "$prefix/semantic/.gitkeep" ]
[ -f "$prefix/semantic/README.txt" ]
[ -f "$prefix/app/index.html" ]

linux=$(make_release linux valid linux x64)
prefix="$root/linux-prefix"
run_install "$linux" "$prefix" PYLOS_TEST_OS=Linux PYLOS_TEST_ARCH=x86_64 >/dev/null
[ -x "$prefix/pylos" ]
[ -f "$prefix/semantic/vec0.so" ]
[ -f "$prefix/app/index.html" ]

for mode in bad-hash bad-name symlink extra-runtime; do
  archive=$(make_release "$mode" "$mode")
  prefix="$root/$mode-prefix"
  seed_old "$prefix"
  if run_install "$archive" "$prefix" >/dev/null 2>&1; then
    printf 'installer unexpectedly accepted %s fixture\n' "$mode" >&2
    exit 1
  fi
  assert_old "$prefix"
done

prefix="$root/rollback-prefix"
seed_old "$prefix"
if run_install "$valid" "$prefix" PYLOS_TEST_FAIL_NEW_APP=1 >/dev/null 2>&1; then
  printf 'installer unexpectedly completed an injected mid-swap failure\n' >&2
  exit 1
fi
assert_old "$prefix"

printf 'installer tests passed\n'
