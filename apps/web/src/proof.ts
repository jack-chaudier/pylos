/**
 * The proof — the deterministic million-turn bench, drawn.
 *
 * Two panels over the run's 100 checkpoints. The top one is the bound: the
 * archive climbing to a gigabyte while the view stays under its cap — which a
 * rolling summary also manages, and the caption says so. The bottom one is the
 * claim: what can still be brought back, exactly, at each checkpoint.
 *
 * Everything is read from `/bench/series.json`, which `scripts/series.ts`
 * derives from `bench/results/million-5.json` at build time. Nothing here holds
 * a number of its own, and every figure in the receipt row links to the
 * artifact it came from.
 *
 * The SVG is built with DOM calls and presentation attributes: the page's CSP
 * has no `style-src 'unsafe-inline'`, so a `style=""` attribute would be
 * dropped.
 */

const ARTIFACT = "https://github.com/jack-chaudier/pylos/blob/main/bench/results/million-5.md";
const SVG_NS = "http://www.w3.org/2000/svg";

interface Point {
  seq: number;
  archiveBytes: number;
  viewP50: number;
  viewMax: number;
  ledger: number;
  rolling: number;
  bm25: number;
  pylos: number;
}

interface Tally {
  checked: number;
  passed: number;
}

interface Series {
  source: string;
  seed: string;
  turns: number;
  budget: number;
  points: Point[];
  final: {
    archiveBytes: number;
    lossEntries: number;
    capsules: number;
    facts: Tally;
    quotes: Tally;
    numbers: Tally;
    memories: Tally;
    sequence: Tally;
    faults: { asked: number; receipted: number };
    verifyOk: boolean;
    headHash: string;
  };
}

const nf = new Intl.NumberFormat("en-US");

export async function mountProof(): Promise<void> {
  const host = document.querySelector<HTMLElement>("[data-proof]");
  if (!host) return;

  const series = await load();
  if (series === null || series.points.length === 0) {
    host.replaceChildren(
      text("p", "mono", "The bench series could not be loaded. It lives at /bench/series.json."),
    );
    return;
  }

  const chart = document.createElement("figure");
  chart.className = "chart";
  chart.append(residencyPanel(series), survivalPanel(series));
  host.replaceChildren(chart, receipt(series));
}

async function load(): Promise<Series | null> {
  try {
    const res = await fetch("/bench/series.json", { cache: "no-cache" });
    return res.ok ? ((await res.json()) as Series) : null;
  } catch {
    return null;
  }
}

// ── the bound ───────────────────────────────────────────────────────────────

const W = 1000;
const PAD_X = 8;
const TICK_STEP = 250_000;

/** Headroom above the cap, so the dashed cap line is not the top edge. */
const TOKEN_CEILING = 9600;
/** The archive area stops short of the view line: two scales, one frame. */
const AREA_SHARE = 0.6;

function residencyPanel(s: Series): HTMLElement {
  const y0 = 26;
  const y1 = 268;
  const maxBytes = Math.max(...s.points.map((p) => p.archiveBytes));
  const svg = root(
    W,
    320,
    `The archive grows to ${mib(maxBytes)} while the view the model reads stays flat under its cap of ${nf.format(s.budget)} tokens.`,
  );
  const x = (seq: number): number => PAD_X + (seq / s.turns) * (W - 2 * PAD_X);
  const yTok = (v: number): number => y1 - (v / TOKEN_CEILING) * (y1 - y0);
  const yByte = (v: number): number => y1 - (v / maxBytes) * (y1 - y0) * AREA_SHARE;

  axes(svg, s, x, y1);

  // The archive, from an empty vault at turn 0 to the last checkpoint.
  const area = [`M ${x(0)} ${y1}`];
  for (const p of s.points) area.push(`L ${round(x(p.seq))} ${round(yByte(p.archiveBytes))}`);
  const lastPoint = s.points[s.points.length - 1] as Point;
  area.push(`L ${round(x(lastPoint.seq))} ${y1}`, "Z");
  svg.append(
    path(area.join(" "), { fill: "#F4EBDD", "fill-opacity": "0.2", stroke: "none" }),
    path(area.slice(0, -2).join(" "), {
      fill: "none",
      stroke: "#F4EBDD",
      "stroke-opacity": "0.85",
      "stroke-width": "2",
    }),
  );

  // The cap, and the view that never reached it.
  svg.append(
    path(`M ${PAD_X} ${round(yTok(s.budget))} L ${W - PAD_X} ${round(yTok(s.budget))}`, {
      fill: "none",
      stroke: "#F4EBDD",
      "stroke-opacity": "0.45",
      "stroke-width": "1",
      "stroke-dasharray": "6 6",
    }),
    path(
      polyline(s.points, x, (p) => yTok(p.viewP50)),
      {
        fill: "none",
        stroke: "#F4EBDD",
        "stroke-width": "2.5",
        "stroke-linejoin": "round",
      },
    ),
  );

  const first = s.points[0] as Point;
  svg.append(
    label(`cap ${nf.format(s.budget)}`, PAD_X + 10, yTok(s.budget) - 9, "start"),
    label(`view · p50 ${nf.format(first.viewP50)}`, PAD_X + 10, yTok(first.viewP50) + 20, "start"),
    label(`archive ${mib(maxBytes)}`, W - PAD_X - 4, yByte(maxBytes) - 10, "end"),
  );

  const p50Low = Math.min(...s.points.map((p) => p.viewP50));
  const p50High = Math.max(...s.points.map((p) => p.viewP50));
  const widest = Math.max(...s.points.map((p) => p.viewMax));
  return panel(
    svg,
    null,
    "Left to right, the bench's 100 checkpoints. The archive climbs to " +
      `${mib(maxBytes)} of exact, hash-chained text; the view the model reads stays between ` +
      `${nf.format(p50Low)} and ${nf.format(p50High)} tokens at the median, and its largest single ` +
      `packet across the whole run was ${nf.format(widest)} — under the hard cap of ${nf.format(s.budget)}. ` +
      "A rolling summary is flat too: flatness is the table stakes, not the claim. The claim is below.",
  );
}

// ── the claim ───────────────────────────────────────────────────────────────

function survivalPanel(s: Series): HTMLElement {
  const H = 280;
  const y0 = 26;
  const y1 = 228;
  const end = s.points[s.points.length - 1] as Point;
  const svg = root(
    W,
    H,
    "What can still be brought back exactly at each checkpoint: Pylos flat at " +
      `${pct(end.pylos)}, the rolling summary falling to ${pct(end.rolling)}, BM25 to ${pct(end.bm25)}.`,
  );

  const x = (seq: number): number => PAD_X + (seq / s.turns) * (W - 2 * PAD_X);
  const y = (frac: number): number => y1 - frac * (y1 - y0);

  for (const grid of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(
      path(`M ${PAD_X} ${round(y(grid))} L ${W - PAD_X} ${round(y(grid))}`, {
        fill: "none",
        stroke: "#F4EBDD",
        "stroke-opacity": grid === 0 ? "0.4" : "0.16",
        "stroke-width": "1",
      }),
      label(`${grid * 100}%`, PAD_X + 4, y(grid) - 7, "start"),
    );
  }
  axes(svg, s, x, y1 + 12, false);

  svg.append(
    path(
      polyline(s.points, x, (p) => y(p.bm25)),
      {
        fill: "none",
        stroke: "#F4EBDD",
        "stroke-opacity": "0.7",
        "stroke-width": "1.5",
        "stroke-dasharray": "1.5 5",
        "stroke-linecap": "round",
      },
    ),
    path(
      polyline(s.points, x, (p) => y(p.rolling)),
      {
        fill: "none",
        stroke: "#F4EBDD",
        "stroke-opacity": "0.7",
        "stroke-width": "1.5",
        "stroke-dasharray": "8 5",
      },
    ),
    path(
      polyline(s.points, x, (p) => y(p.pylos)),
      {
        fill: "none",
        stroke: "#F4EBDD",
        "stroke-width": "3.5",
      },
    ),
  );

  // The two baselines fluctuate turn to turn; a label on the line would sit in
  // the noise, so the closing value is stated once, in the legend.
  svg.append(label(`pylos ${pct(end.pylos)}`, W - PAD_X - 4, y(end.pylos) - 12, "end"));

  return panel(
    svg,
    legend(end, s.turns),
    "What can still be brought back, exactly, at each checkpoint — across every planted family: " +
      "revised facts, exact quotes, numbers with their units, turns addressed by number, name-free " +
      "memories, the authority law, and a fault receipted rather than answered. Pylos holds every " +
      "family at every checkpoint; the two baselines are measured on the same archive and the same probes.",
  );
}

function legend(last: Point, turns: number): HTMLElement {
  const list = document.createElement("ul");
  list.className = "mono chart__legend";
  const entries: Array<[string, number, Record<string, string>]> = [
    ["Pylos", last.pylos, { "stroke-width": "3.5" }],
    [
      "Rolling summary",
      last.rolling,
      { "stroke-width": "1.5", "stroke-dasharray": "8 5", "stroke-opacity": "0.7" },
    ],
    [
      "BM25 retrieval",
      last.bm25,
      { "stroke-width": "1.5", "stroke-dasharray": "1.5 5", "stroke-opacity": "0.7" },
    ],
  ];
  for (const [name, value, attrs] of entries) {
    const item = document.createElement("li");
    const swatch = document.createElementNS(SVG_NS, "svg");
    swatch.setAttribute("class", "chart__swatch");
    swatch.setAttribute("viewBox", "0 0 34 10");
    swatch.setAttribute("aria-hidden", "true");
    swatch.append(path("M 0 5 L 34 5", { fill: "none", stroke: "#F4EBDD", ...attrs }));
    item.append(swatch, document.createTextNode(`${name} — ${pct(value)} at ${nf.format(turns)}`));
    list.append(item);
  }
  return list;
}

// ── the receipt ─────────────────────────────────────────────────────────────

function receipt(s: Series): HTMLElement {
  const f = s.final;
  const list = document.createElement("ul");
  list.className = "mono proof__receipt";
  const figures: string[] = [
    `${nf.format(f.facts.passed)}/${nf.format(f.facts.checked)} facts`,
    `${nf.format(f.quotes.passed)}/${nf.format(f.quotes.checked)} quotes exact`,
    `${nf.format(f.numbers.passed)}/${nf.format(f.numbers.checked)} numbers with their units`,
    `${nf.format(f.sequence.passed)}/${nf.format(f.sequence.checked)} turn numbers`,
    `${nf.format(f.memories.passed)}/${nf.format(f.memories.checked)} name-free memories`,
    `${nf.format(f.faults.receipted)}/${nf.format(f.faults.asked)} faults receipted`,
    `${nf.format(f.lossEntries)} ledger entries`,
    `${nf.format(f.capsules)} capsules`,
    `${mib(f.archiveBytes)} archive`,
    `chain ${f.verifyOk ? "✓" : "✕"} to #${nf.format(s.turns)}`,
  ];
  for (const figure of figures) {
    const item = document.createElement("li");
    const anchor = document.createElement("a");
    anchor.href = ARTIFACT;
    anchor.textContent = figure;
    anchor.title = `${s.source} · seed ${s.seed} · head ${f.headHash.slice(0, 12)}`;
    item.append(anchor);
    list.append(item);
  }
  return list;
}

// ── drawing ─────────────────────────────────────────────────────────────────

function panel(svg: SVGSVGElement, above: HTMLElement | null, caption: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "chart__panel";
  if (above) box.append(above);
  box.append(svg, text("figcaption", "mono chart__caption", caption));
  return box;
}

function root(w: number, h: number, title: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("class", "chart__svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", title);
  return svg;
}

function path(d: string, attrs: Record<string, string>): SVGPathElement {
  const node = document.createElementNS(SVG_NS, "path");
  node.setAttribute("d", d);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function label(value: string, x: number, y: number, anchor: "start" | "end"): SVGTextElement {
  const node = document.createElementNS(SVG_NS, "text");
  node.setAttribute("class", "lab");
  node.setAttribute("x", round(x));
  node.setAttribute("y", round(y));
  node.setAttribute("text-anchor", anchor);
  node.textContent = value.toUpperCase();
  return node;
}

/** The x axis: a rule, a tick every 250,000 turns, and the turn count under it. */
function axes(
  svg: SVGSVGElement,
  s: Series,
  x: (seq: number) => number,
  baseline: number,
  rule = true,
): void {
  if (rule) {
    svg.append(
      path(`M ${PAD_X} ${baseline} L ${W - PAD_X} ${baseline}`, {
        fill: "none",
        stroke: "#F4EBDD",
        "stroke-opacity": "0.4",
        "stroke-width": "1",
      }),
    );
  }
  for (let seq = 0; seq <= s.turns; seq += TICK_STEP) {
    const at = x(seq);
    svg.append(
      path(`M ${round(at)} ${baseline} L ${round(at)} ${baseline + 6}`, {
        fill: "none",
        stroke: "#F4EBDD",
        "stroke-opacity": "0.5",
        "stroke-width": "1",
      }),
    );
    const tick = document.createElementNS(SVG_NS, "text");
    tick.setAttribute("class", "tick");
    tick.setAttribute("x", round(at));
    tick.setAttribute("y", round(baseline + 24));
    tick.setAttribute("text-anchor", seq === 0 ? "start" : seq === s.turns ? "end" : "middle");
    tick.textContent = seq === 0 ? "0" : `${seq / 1000}K`;
    svg.append(tick);
  }
}

function polyline(points: Point[], x: (seq: number) => number, y: (p: Point) => number): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"} ${round(x(p.seq))} ${round(y(p))}`).join(" ");
}

// ── helpers ─────────────────────────────────────────────────────────────────

function text(tag: string, cls: string, value: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = value;
  return node;
}

function round(n: number): string {
  return n.toFixed(1);
}

function mib(bytes: number): string {
  return `${nf.format(Math.round(bytes / 2 ** 20))} MiB`;
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
