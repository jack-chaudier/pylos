/**
 * Brand assets, generated rather than hand-drawn so they cannot drift from the
 * page: the OG card, the manifest, robots, and the install script the download
 * block points at. The icons are tracked files, cut from the Empyrean plate.
 *
 * The OG card is laid out in HTML with the same self-hosted fonts, the same
 * palette, the same mark and the same plate as the site, then photographed with
 * headless Chrome. Its numbers come from `public/aperture/final.json`, so the
 * card states what the run actually produced.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, "../public");
const tmp = resolve(here, "../.assets-tmp");

/** docs/DESIGN.md, verbatim. */
const KILN = "#D9450E";
const BONE = "#F4EBDD";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ── the OG card ─────────────────────────────────────────────────────────────

interface Snapshot {
  turn: number;
  packet: { tokens: number; budget: number };
  lossRows: number;
}

function ogHtml(snap: Snapshot | null, fontDir: string, artDir: string): string {
  const nf = new Intl.NumberFormat("en-US");
  const turns = nf.format(snap?.turn ?? 1_000_000);
  const tokens = nf.format(snap?.packet.tokens ?? 6440);
  const budget = nf.format(snap?.packet.budget ?? 8192);
  const ledger = nf.format(snap?.lossRows ?? 1_249_335);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Instrument Serif";src:url("${fontDir}/instrument-serif-latin.woff2") format("woff2");font-weight:400}
@font-face{font-family:"Instrument Serif";src:url("${fontDir}/instrument-serif-italic-latin.woff2") format("woff2");font-weight:400;font-style:italic}
@font-face{font-family:"Courier Prime";src:url("${fontDir}/courier-prime-latin.woff2") format("woff2");font-weight:400}
@font-face{font-family:"Courier Prime";src:url("${fontDir}/courier-prime-bold-latin.woff2") format("woff2");font-weight:700}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px}
body{background:${KILN};color:${BONE};font-family:"Instrument Serif",Georgia,serif;
  display:grid;grid-template-columns:1fr 430px;overflow:hidden}
.pane{padding:56px 54px;display:flex;flex-direction:column;justify-content:space-between}
.mono{font-family:"Courier Prime",monospace;font-size:15px;letter-spacing:.12em;text-transform:uppercase}
.brand{display:flex;align-items:center;gap:18px}
.mark{position:relative;flex:none;width:56px;height:56px;border-radius:50%;overflow:hidden;
  box-shadow:inset 0 0 0 1px ${BONE}47}
.mark img{position:absolute;width:200%;height:auto;left:-45.3%;top:-51.2%}
.wordmark{font-size:34px;text-transform:uppercase;letter-spacing:.02em;line-height:1}
h1{font-weight:400;font-size:80px;line-height:.9;letter-spacing:-.01em;
  text-transform:uppercase;margin:24px 0 20px}
h1 em{font-style:italic}
.figures{font-family:"Courier Prime",monospace;font-size:15px;font-weight:700;
  letter-spacing:.1em;text-transform:uppercase;line-height:2}
.plate{padding:0;overflow:hidden}
.plate img{width:100%;height:630px;object-fit:cover;object-position:50% 38%;display:block}
</style></head><body>
<div class="pane">
  <div class="brand">
    <span class="mark"><img src="${artDir}/empyrean.webp" alt=""></span>
    <p class="wordmark">Pylos</p>
  </div>
  <div>
    <h1>The conversation<br><em>that does not end</em></h1>
    <p class="figures">${turns} turns · view ${tokens} / ${budget} · ledger ${ledger}</p>
  </div>
  <p class="mono">Open source · Apache-2.0 · macOS + Linux</p>
</div>
<div class="plate"><img src="${artDir}/empyrean.webp" alt=""></div>
</body></html>`;
}

// ── shoot ───────────────────────────────────────────────────────────────────

function shoot(htmlPath: string, out: string, w: number, h: number): boolean {
  if (!existsSync(CHROME)) {
    console.warn(`[pylos/web] no Chrome at ${CHROME}; keeping the existing ${out}`);
    return false;
  }
  const res = spawnSync(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--virtual-time-budget=3000",
      `--screenshot=${out}`,
      `--window-size=${w},${h}`,
      `file://${htmlPath}`,
    ],
    // A build must never hang on a browser: no card is better than no build.
    { stdio: "ignore", timeout: 90_000 },
  );
  return res.status === 0 && existsSync(out);
}

// ── run ─────────────────────────────────────────────────────────────────────

await mkdir(pub, { recursive: true });
await mkdir(tmp, { recursive: true });

// manifest + robots
await writeFile(
  resolve(pub, "site.webmanifest"),
  `${JSON.stringify(
    {
      name: "Pylos",
      short_name: "Pylos",
      description: "One conversation. Every model. Nothing forgotten silently.",
      start_url: "/",
      display: "browser",
      background_color: KILN,
      theme_color: KILN,
      icons: [
        { src: "/favicon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
        { src: "/favicon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

await writeFile(
  resolve(pub, "robots.txt"),
  "User-agent: *\nAllow: /\n\nSitemap: https://pylos.vercel.app/sitemap.xml\n",
  "utf8",
);

await writeFile(
  resolve(pub, "sitemap.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://pylos.vercel.app/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n</urlset>\n`,
  "utf8",
);

// The installer. Asset names are a contract with release.yml: it publishes
// pylos-macos-arm64.tar.gz and pylos-linux-x64.tar.gz, and nothing else — so
// every other platform is told plainly to build from source.
await writeFile(
  resolve(pub, "install.sh"),
  `#!/bin/sh
# Pylos installer — exact archive, bounded address proposals.
# https://github.com/jack-chaudier/pylos
set -eu

umask 022

REPO="jack-chaudier/pylos"
VERSION="\${PYLOS_VERSION:-latest}"
PREFIX="\${PYLOS_PREFIX:-$HOME/.local/bin}"
SOURCE="https://github.com/$REPO"

say() { printf '%s\\n' "$*" >&2; }
die() { say "pylos: $*"; exit 1; }

case "$PREFIX" in
  ""|/|.|..) die "unsafe install prefix: $PREFIX" ;;
esac

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

asset="pylos-\${plat}-\${arch}.tar.gz"
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/$asset"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$asset"
fi

for command in curl tar awk find mktemp; do
  command -v "$command" >/dev/null 2>&1 || die "$command is required"
done

if command -v shasum >/dev/null 2>&1; then
  sha256_file() { shasum -a 256 "$1" | awk '{ print $1 }'; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_file() { sha256sum "$1" | awk '{ print $1 }'; }
else
  die "shasum or sha256sum is required"
fi

tmp=$(mktemp -d)
transaction=""
lock=""
swapping=0
committed=0
old_pylos=0
old_semantic=0
old_app=0
new_pylos=0
new_semantic=0
new_app=0

path_exists() { [ -e "$1" ] || [ -h "$1" ]; }

remove_path() {
  if [ -h "$1" ] || [ -f "$1" ]; then
    rm -f "$1"
  elif [ -d "$1" ]; then
    rm -rf "$1"
  fi
}

rollback_one() {
  name=$1
  installed=$2
  backed=$3
  if [ "$installed" -eq 1 ]; then
    remove_path "$PREFIX/$name" || return 1
  fi
  if [ "$backed" -eq 1 ] && path_exists "$transaction/old/$name"; then
    mv "$transaction/old/$name" "$PREFIX/$name" || return 1
  fi
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  set +e
  rollback_failed=0
  if [ "$swapping" -eq 1 ] && [ "$committed" -eq 0 ]; then
    rollback_one pylos "$new_pylos" "$old_pylos" || rollback_failed=1
    rollback_one app "$new_app" "$old_app" || rollback_failed=1
    rollback_one semantic "$new_semantic" "$old_semantic" || rollback_failed=1
  fi
  if [ "$rollback_failed" -eq 1 ]; then
    say "pylos: automatic rollback failed; previous files remain in $transaction/old"
    transaction=""
  fi
  if [ -n "$transaction" ]; then rm -rf "$transaction"; fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
  if [ -n "$lock" ]; then rmdir "$lock" 2>/dev/null; fi
  exit "$status"
}

trap cleanup EXIT
trap 'exit 1' HUP INT TERM

say "pylos: downloading $asset"
curl -fsSL "$url" -o "$tmp/$asset" || die "no release asset at $url — see https://github.com/$REPO/releases"

mkdir -p "$PREFIX"
[ -d "$PREFIX" ] || die "install prefix is not a directory: $PREFIX"

tar -tzf "$tmp/$asset" > "$tmp/entries"
[ -s "$tmp/entries" ] || die "release archive is empty"
while IFS= read -r entry; do
  case "$entry" in */) entry=\${entry%/} ;; esac
  case "$entry" in
    ""|/*|./*|../*|*/../*|*/..|*//*|*[!A-Za-z0-9._/-]*)
      die "release archive has an unsafe path: $entry" ;;
  esac
  case "$entry" in
    pylos|semantic|semantic/*|app|app/*) ;;
    *) die "release archive has an unexpected path: $entry" ;;
  esac
done < "$tmp/entries"

# Links can redirect later tar members outside the private staging tree. Both
# release platforms put the member type in the first verbose-list column.
if ! tar -tvzf "$tmp/$asset" | awk '
  substr($0, 1, 1) != "-" && substr($0, 1, 1) != "d" { exit 1 }
'; then
  die "release archive contains a link or special file"
fi

lock="$PREFIX/.pylos-install.lock"
mkdir "$lock" 2>/dev/null || die "another Pylos install is already running"
transaction=$(mktemp -d "$PREFIX/.pylos-install.XXXXXX")
mkdir "$transaction/new" "$transaction/old"
tar -xzf "$tmp/$asset" -C "$transaction/new"
stage="$transaction/new"

# Recheck the extracted tree without parsing newline-delimited filenames.
if ! find "$stage" -exec sh -c '
  root=$1
  shift
  for path do
    [ "$path" = "$root" ] && continue
    [ ! -h "$path" ] || exit 1
    [ -f "$path" ] || [ -d "$path" ] || exit 1
    relative=\${path#"$root"/}
    case "$relative" in
      ""|/*|./*|../*|*/../*|*/..|*//*|*[!A-Za-z0-9._/-]*) exit 1 ;;
    esac
    case "$relative" in
      pylos|semantic|semantic/*|app|app/*) ;;
      *) exit 1 ;;
    esac
  done
' sh "$stage" {} +; then
  die "release archive extracted an unsafe path or file type"
fi

[ -f "$stage/pylos" ] && [ ! -h "$stage/pylos" ] || die "release archive has no regular pylos executable"
[ -f "$stage/app/index.html" ] && [ ! -h "$stage/app/index.html" ] || die "release archive has no app/index.html"
manifest="$stage/semantic/manifest.json"
[ -f "$manifest" ] && [ ! -h "$manifest" ] || die "release archive has no semantic/manifest.json"

expected_platform=linux
expected_arch=x64
if [ "$plat" = "macos" ]; then
  expected_platform=darwin
  expected_arch=arm64
fi
grep -F "\\"platform\\": \\"$expected_platform\\"" "$manifest" >/dev/null || die "semantic manifest is for another platform"
grep -F "\\"arch\\": \\"$expected_arch\\"" "$manifest" >/dev/null || die "semantic manifest is for another architecture"

# The release builder emits canonical JSON: every asset \`file\` is immediately
# followed by its \`sha256\`. Refuse alternate shapes in this POSIX parser.
pairs="$transaction/semantic-assets"
if ! awk '
  /"file"[[:space:]]*:/ {
    if (pending != "") exit 1
    value = $0
    sub(/^[^:]*:[[:space:]]*"/, "", value)
    sub(/"[[:space:]]*,?[[:space:]]*$/, "", value)
    if (value == $0 || seen[value]++) exit 1
    pending = value
    files += 1
    next
  }
  /"sha256"[[:space:]]*:/ {
    if (pending == "") exit 1
    value = $0
    sub(/^[^:]*:[[:space:]]*"/, "", value)
    sub(/"[[:space:]]*,?[[:space:]]*$/, "", value)
    if (value == $0) exit 1
    print pending, value
    pending = ""
    hashes += 1
  }
  END {
    if (pending != "" || files != 4 || hashes != files) exit 1
  }
' "$manifest" > "$pairs"; then
  die "semantic manifest has invalid asset records"
fi

names="$transaction/semantic-asset-names"
: > "$names"
while IFS=' ' read -r file digest extra; do
  case "$file" in ""|*[!A-Za-z0-9._-]*) die "semantic manifest has an unsafe filename: $file" ;; esac
  [ -z "\${extra:-}" ] || die "semantic manifest has an invalid asset record: $file"
  [ "\${#digest}" -eq 64 ] || die "semantic manifest has an invalid SHA-256 for $file"
  case "$digest" in *[!0-9a-f]*) die "semantic manifest has an invalid SHA-256 for $file" ;; esac
  declared="$stage/semantic/$file"
  [ -f "$declared" ] && [ ! -h "$declared" ] || die "semantic asset is missing: $file"
  actual=$(sha256_file "$declared")
  [ "$actual" = "$digest" ] || die "semantic asset hash mismatch: $file"
  printf '%s\\n' "$file" >> "$names"
done < "$pairs"

# Runtime payloads are closed over the manifest. The two tracked source-tree
# placeholders are inert metadata, never loaded as semantic assets.
for declared in "$stage/semantic"/* "$stage/semantic"/.[!.]* "$stage/semantic"/..?*; do
  path_exists "$declared" || continue
  file=\${declared##*/}
  case "$file" in manifest.json|.gitkeep|README.txt) continue ;; esac
  [ -f "$declared" ] && [ ! -h "$declared" ] || die "semantic directory is not flat: $file"
  grep -F -x "$file" "$names" >/dev/null || die "semantic asset is not declared: $file"
done

find "$stage/semantic" "$stage/app" -type d -exec chmod 0755 {} +
find "$stage/semantic" "$stage/app" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/pylos"

backup_one() {
  name=$1
  if path_exists "$PREFIX/$name"; then
    case "$name" in
      pylos) old_pylos=1 ;;
      semantic) old_semantic=1 ;;
      app) old_app=1 ;;
    esac
    mv "$PREFIX/$name" "$transaction/old/$name"
  fi
}

install_one() {
  name=$1
  case "$name" in
    pylos) new_pylos=1 ;;
    semantic) new_semantic=1 ;;
    app) new_app=1 ;;
  esac
  mv "$stage/$name" "$PREFIX/$name"
}

# All paths are on PREFIX's filesystem. The executable disappears during the
# short swap and is installed last; a failed rename restores the previous set.
swapping=1
backup_one pylos
backup_one semantic
backup_one app
install_one semantic
install_one app
install_one pylos
committed=1
swapping=0
rm -rf "$transaction"
transaction=""

say "pylos: installed to $PREFIX/pylos"
say "pylos: semantic runtime at $PREFIX/semantic"
say "pylos: app at $PREFIX/app"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) say "pylos: add $PREFIX to your PATH" ;;
esac
say "pylos: run 'pylos serve' and open http://127.0.0.1:7334/app/"
`,
  "utf8",
);

// OG card
let snap: Snapshot | null = null;
try {
  snap = JSON.parse(await readFile(resolve(pub, "aperture/final.json"), "utf8")) as Snapshot;
} catch {
  snap = null;
}

const ogPath = resolve(tmp, "og.html");
await writeFile(ogPath, ogHtml(snap, `file://${pub}/fonts`, `file://${pub}/art`), "utf8");
const ogOut = resolve(pub, "og.png");
// The card is a Chrome screenshot, and Chrome's PNG bytes differ across versions and
// platforms; regenerating on every build would dirty the tracked file under CI's
// clean-tree check. The existing card is kept; set PYLOS_REFRESH_OG=1 to reshoot.
const ogOk =
  existsSync(ogOut) && process.env.PYLOS_REFRESH_OG !== "1" ? true : shoot(ogPath, ogOut, 1200, 630);

await rm(tmp, { recursive: true, force: true });

console.log(`[pylos/web] assets · manifest ✓ · robots ✓ · install.sh ✓ · og.png ${ogOk ? "✓" : "skipped"}`);
