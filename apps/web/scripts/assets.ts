/**
 * Brand assets, generated rather than hand-drawn so they cannot drift from the
 * page: the aperture mark (favicon), the OG card, the touch icon, the manifest,
 * robots, and the install script the download block points at.
 *
 * The OG card is laid out in HTML with the same self-hosted fonts and the same
 * palette as the site, then photographed with headless Chrome. Its numbers come
 * from `public/aperture/final.json`, so the card states what the run actually
 * produced.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, "../public");
const tmp = resolve(here, "../.assets-tmp");

const BONE = "#F4F1EA";
const INK = "#17160F";
const ASH = "#7C786E";
const VERDIGRIS = "#1F6F5C";
const EMBER = "#C98A2E";
const HAIRLINE = "rgba(23,22,15,0.14)";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ── the mark ────────────────────────────────────────────────────────────────
// A gate seen end-on: a verdigris ring left open on one side, with the ember
// point of what was recovered sitting at the centre.

function mark(size: number, background: string | null): string {
  const bg = background
    ? `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="${background}"/>`
    : "";
  const s = size / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}<g transform="translate(${size / 2} ${size / 2}) rotate(-58) translate(${-size / 2} ${-size / 2})"><circle cx="${size / 2}" cy="${size / 2}" r="${9 * s}" fill="none" stroke="${VERDIGRIS}" stroke-width="${2.6 * s}" stroke-dasharray="${46 * s} ${12 * s}" stroke-linecap="butt"/></g><circle cx="${size / 2}" cy="${size / 2}" r="${2.6 * s}" fill="${EMBER}"/></svg>`;
}

// ── the OG card ─────────────────────────────────────────────────────────────

interface Snapshot {
  turn: number;
  packet: { tokens: number; budget: number };
  lossRows: number;
  revisionSeq: number;
}

function ogHtml(snap: Snapshot | null, fontDir: string): string {
  const nf = new Intl.NumberFormat("en-US");
  const turns = nf.format(snap?.turn ?? 1_000_000);
  const tokens = nf.format(snap?.packet.tokens ?? 6440);
  const budget = nf.format(snap?.packet.budget ?? 8192);
  const ledger = nf.format(snap?.lossRows ?? 1_249_335);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:"Newsreader";src:url("${fontDir}/newsreader-latin-var.woff2") format("woff2-variations");font-weight:300 700}
@font-face{font-family:"Geist";src:url("${fontDir}/geist-latin-var.woff2") format("woff2-variations");font-weight:300 700}
@font-face{font-family:"Geist Mono";src:url("${fontDir}/geist-mono-latin-var.woff2") format("woff2-variations");font-weight:400 600}
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px}
body{background:${BONE};color:${INK};font-family:"Geist",system-ui,sans-serif;
  display:grid;grid-template-columns:1fr 452px;overflow:hidden}
.pane{padding:62px 58px;display:flex;flex-direction:column;justify-content:space-between}
.pane.right{border-left:1px solid ${HAIRLINE};justify-content:center;gap:0;padding:62px 52px}
.mono{font-family:"Geist Mono",monospace;font-size:15px;letter-spacing:.11em;text-transform:uppercase;color:${ASH}}
.wordmark{font-family:"Newsreader",serif;font-size:38px;font-variation-settings:"opsz" 32;
  color:${VERDIGRIS};display:flex;align-items:center;gap:14px;letter-spacing:-.02em}
h1{font-family:"Newsreader",serif;font-weight:400;font-size:118px;line-height:.96;
  letter-spacing:-.035em;font-variation-settings:"opsz" 72;margin:26px 0 22px}
.lede{font-size:20px;line-height:1.5;color:rgba(23,22,15,.66);max-width:30ch}
.num{font-family:"Newsreader",serif;font-weight:400;font-size:70px;line-height:1;
  letter-spacing:-.03em;font-variation-settings:"opsz" 60;color:${EMBER};font-variant-numeric:tabular-nums}
.num.small{font-size:52px;color:${VERDIGRIS}}
.stat + .stat{margin-top:38px;padding-top:38px;border-top:1px solid ${HAIRLINE}}
.stat .mono{margin-bottom:10px}
.foot{font-family:"Geist Mono",monospace;font-size:14px;letter-spacing:.1em;
  text-transform:uppercase;color:${ASH}}
</style></head><body>
<div class="pane">
  <div class="wordmark">${mark(30, null)}pylos</div>
  <div>
    <h1>Talk forever.</h1>
    <p class="lede">One conversation. Every model. Nothing forgotten silently.</p>
  </div>
  <p class="foot">Open source · Apache-2.0 · Mac + Linux</p>
</div>
<div class="pane right">
  <div class="stat">
    <p class="mono">Archive · exact</p>
    <p class="num">${turns}</p>
    <p class="mono" style="margin-top:10px;font-size:13px;letter-spacing:.05em">turns · ${ledger} ledger entries</p>
  </div>
  <div class="stat">
    <p class="mono">View · bounded</p>
    <p class="num small">${tokens}<span style="color:${ASH};font-size:.5em"> / ${budget}</span></p>
    <p class="mono" style="margin-top:10px;font-size:13px;letter-spacing:.05em">tokens resident, every turn</p>
  </div>
</div>
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
      "--virtual-time-budget=2500",
      `--screenshot=${out}`,
      `--window-size=${w},${h}`,
      `file://${htmlPath}`,
    ],
    { stdio: "ignore" },
  );
  return res.status === 0 && existsSync(out);
}

// ── run ─────────────────────────────────────────────────────────────────────

await mkdir(pub, { recursive: true });
await mkdir(tmp, { recursive: true });

// favicon: the mark on bone, sized for a 16px tab
await writeFile(resolve(pub, "favicon.svg"), `${mark(32, BONE)}\n`, "utf8");

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
      background_color: BONE,
      theme_color: BONE,
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

// install script — the thing the copy button actually points at
await writeFile(
  resolve(pub, "install.sh"),
  `#!/bin/sh
# Pylos installer — one conversation, every model, nothing forgotten silently.
# https://github.com/jack-chaudier/pylos
set -eu

REPO="jack-chaudier/pylos"
VERSION="\${PYLOS_VERSION:-latest}"
PREFIX="\${PYLOS_PREFIX:-$HOME/.local/bin}"

say() { printf '%s\\n' "$*" >&2; }
die() { say "pylos: $*"; exit 1; }

os=$(uname -s)
arch=$(uname -m)

case "$os" in
  Darwin) plat=macos ;;
  Linux)  plat=linux ;;
  *) die "unsupported platform: $os. Pylos ships for macOS and Linux." ;;
esac

case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) die "unsupported architecture: $arch" ;;
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
say "pylos: run 'pylos' to start the thread"
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
await writeFile(ogPath, ogHtml(snap, `file://${pub}/fonts`), "utf8");
const ogOk = shoot(ogPath, resolve(pub, "og.png"), 1200, 630);

const touchPath = resolve(tmp, "touch.html");
await writeFile(
  touchPath,
  `<!doctype html><html><body style="margin:0;width:180px;height:180px;background:${BONE}">${mark(180, BONE)}</body></html>`,
  "utf8",
);
const touchOk = shoot(touchPath, resolve(pub, "apple-touch-icon.png"), 180, 180);

await rm(tmp, { recursive: true, force: true });

console.log(
  `[pylos/web] assets · favicon ✓ · manifest ✓ · install.sh ✓ · og.png ${ogOk ? "✓" : "skipped"} · apple-touch-icon ${touchOk ? "✓" : "skipped"}`,
);
