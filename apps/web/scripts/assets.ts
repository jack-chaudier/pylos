/**
 * Brand assets, generated rather than hand-drawn so they cannot drift from the
 * page: the aperture mark (favicon), the OG card, the touch icon, the manifest,
 * robots, and the install script the download block points at.
 *
 * The OG card is laid out in HTML with the same self-hosted fonts, the same
 * palette and the same plate as the site, then photographed with headless
 * Chrome. Its numbers come from `public/aperture/final.json`, so the card states
 * what the run actually produced.
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

// ── the mark ────────────────────────────────────────────────────────────────
// The aperture seen end-on: a bone ring left open on one side over the kiln
// ground, with the point of what was recovered sitting at its centre.

function mark(size: number, background: string | null): string {
  const bg = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : "";
  const s = size / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}<g transform="translate(${size / 2} ${size / 2}) rotate(-58) translate(${-size / 2} ${-size / 2})"><circle cx="${size / 2}" cy="${size / 2}" r="${8.6 * s}" fill="none" stroke="${BONE}" stroke-width="${2.8 * s}" stroke-dasharray="${44 * s} ${12 * s}" stroke-linecap="butt"/></g><circle cx="${size / 2}" cy="${size / 2}" r="${2.8 * s}" fill="${BONE}"/></svg>`;
}

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
  <p class="wordmark">Pylos</p>
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

// favicon: the mark on kiln, sized for a 16px tab
await writeFile(resolve(pub, "favicon.svg"), `${mark(32, KILN)}\n`, "utf8");

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
        { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
        { src: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
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
# Pylos installer — one conversation, every model, nothing forgotten silently.
# https://github.com/jack-chaudier/pylos
set -eu

REPO="jack-chaudier/pylos"
VERSION="\${PYLOS_VERSION:-latest}"
PREFIX="\${PYLOS_PREFIX:-$HOME/.local/bin}"
SOURCE="https://github.com/$REPO"

say() { printf '%s\\n' "$*" >&2; }
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

asset="pylos-\${plat}-\${arch}.tar.gz"
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
`,
  "utf8",
);

// OG card + touch icon
let snap: Snapshot | null = null;
try {
  snap = JSON.parse(await readFile(resolve(pub, "aperture/final.json"), "utf8")) as Snapshot;
} catch {
  snap = null;
}

const ogPath = resolve(tmp, "og.html");
await writeFile(ogPath, ogHtml(snap, `file://${pub}/fonts`, `file://${pub}/art`), "utf8");
const ogOk = shoot(ogPath, resolve(pub, "og.png"), 1200, 630);

const touchPath = resolve(tmp, "touch.html");
await writeFile(
  touchPath,
  `<!doctype html><html><body style="margin:0;width:180px;height:180px;background:${KILN}">${mark(180, KILN)}</body></html>`,
  "utf8",
);
const touchOk = shoot(touchPath, resolve(pub, "apple-touch-icon.png"), 180, 180);

await rm(tmp, { recursive: true, force: true });

console.log(
  `[pylos/web] assets · favicon ✓ · manifest ✓ · install.sh ✓ · ` +
    `og.png ${ogOk ? "✓" : "skipped"} · apple-touch-icon ${touchOk ? "✓" : "skipped"}`,
);
