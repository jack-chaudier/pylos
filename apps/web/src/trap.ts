/**
 * The story — the trap, in four beats and no vocabulary.
 *
 * A rule is set, the rule is revised, a great many turns pass, and the same
 * question is put to the same model twice. Everything rendered here comes from
 * `public/bench/trap.json` — the artifact `pylos bench million --live` writes —
 * so when the bench replaces the file the page tells the truth without being
 * touched.
 *
 * Until then the file carries `"placeholder": true` and the section says so.
 */

import { TOTAL_TURNS } from "./aperture/thread";

export interface TrapArtifact {
  placeholder?: boolean;
  note?: string;
  seed: string | number;
  turns: number;
  budget: number;
  model: string;
  rule: { seq: number; text: string };
  revision: { seq: number; text: string };
  question: string;
  baseline: { label?: string; answer: string; usedStale: boolean; note?: string; probes?: Probes };
  pylos: {
    label?: string;
    answer: string;
    usedStale: boolean;
    pages?: { seq: number; trigger: string }[];
    note?: string;
    probes?: Probes;
  };
  hashes: { archiveHead: string; packet: string };
}

export interface Probes {
  n: number;
  current: number;
  stale: number;
  abstained: number;
  silentFalse: number;
}

const LIVE_RESULT = "https://github.com/jack-chaudier/pylos/blob/main/bench/results/million-live-live-1.md";

const COUNT_MS = 2000;

const nf = new Intl.NumberFormat("en-US");

let pending: Promise<TrapArtifact | null> | null = null;

/** The bench artifact, fetched once and shared: the story and the console both quote it. */
export function loadTrap(): Promise<TrapArtifact | null> {
  pending ??= fetch("/bench/trap.json", { cache: "no-cache" })
    .then((res) => (res.ok ? (res.json() as Promise<TrapArtifact>) : null))
    .catch(() => null);
  return pending;
}

export async function mountTrap(): Promise<void> {
  const body = document.querySelector<HTMLElement>("[data-trap-body]");
  if (!body) return;

  const data = await loadTrap();
  if (data === null) {
    const miss = el("p", "mono");
    miss.append(document.createTextNode("The bench artifact could not be loaded. It lives at "));
    miss.append(link("/bench/trap.json", "/bench/trap.json"));
    miss.append(document.createTextNode("."));
    body.replaceChildren(miss);
    return;
  }

  if (data.placeholder) {
    const tag = document.querySelector<HTMLElement>("[data-trap-tag]");
    if (tag) tag.hidden = false;
  }

  body.replaceChildren(render(data));
  const counter = body.querySelector<HTMLElement>("[data-count]");
  if (counter) countUp(counter, data.revision.seq, data.turns);
}

// ── the four beats ──────────────────────────────────────────────────────────

function render(d: TrapArtifact): DocumentFragment {
  const frag = document.createDocumentFragment();

  const beats = el("ol", "beats");
  beats.append(
    beat(`Turn ${nf.format(d.rule.seq)}`, d.rule.text),
    beat(`Turn ${nf.format(d.revision.seq)}`, d.revision.text),
  );
  frag.append(beats);

  const count = el("div", "count");
  const target = el("span", "", nf.format(d.turns));
  target.dataset.count = "";
  const line = el("p", "count__num");
  line.append(document.createTextNode(`turn ${nf.format(d.revision.seq)} → turn `), target);
  count.append(
    line,
    el(
      "p",
      "mono count__gloss",
      `${nf.format(d.turns - d.revision.seq)} turns later, recorded live · the deterministic run below goes to ${nf.format(TOTAL_TURNS)}`,
    ),
  );
  frag.append(count);

  const question = el("div", "story__q");
  question.append(
    el(
      "p",
      "mono",
      `Turn ${nf.format(d.turns)} · the question · ${d.model} · budget ${nf.format(d.budget)} tokens`,
    ),
    el("p", "story__qtext", d.question),
  );
  frag.append(question);

  const answers = el("div", "answers");
  answers.append(answer(d, "baseline"), answer(d, "pylos"));
  frag.append(answers);

  const hashes = el("p", "mono story__hashes");
  hashes.append(
    receipt(
      `run seed · ${d.seed}`,
      "The seed this run used. The same seed replays the same thread, turn for turn.",
    ),
    receipt(
      `hash of the last turn · ${short(d.hashes.archiveHead)}`,
      "Every turn is hashed into the one after it. This is the end of that chain, so changing any " +
        "earlier turn would change this number.",
    ),
    receipt(
      `hash of what the model read · ${short(d.hashes.packet)}`,
      "The exact text handed to the model for this question, hashed — so the answer above can be " +
        "checked against what was actually asked.",
    ),
    link(LIVE_RESULT, "check them in the artifact"),
  );
  frag.append(hashes);

  const caption = el("p", "story__caption");
  caption.append(
    document.createTextNode(
      `A live sample at turn ${nf.format(d.turns)} — the deterministic proof is below. `,
    ),
    link(LIVE_RESULT, "bench/results/million-live-live-1.md"),
  );
  frag.append(caption);

  return frag;
}

function beat(label: string, text: string): HTMLElement {
  const item = el("li", "beat");
  item.append(el("p", "mono beat__label", label), el("p", "beat__text", `“${text}”`));
  return item;
}

function answer(d: TrapArtifact, which: "baseline" | "pylos"): HTMLElement {
  const side = d[which];
  const card = el("article", "answer");
  card.append(
    el("p", "mono answer__who", side.label ?? (which === "pylos" ? "Pylos" : "An ordinary chat")),
    el("p", "answer__text", side.answer),
  );

  const probes = side.probes;
  if (probes) {
    card.append(
      el(
        "p",
        "answer__probes",
        `${nf.format(probes.current)}/${nf.format(probes.n)} answers used the current rule`,
      ),
    );
  }

  card.append(
    el(
      "p",
      `answer__verdict ${side.usedStale ? "is-wrong" : "is-right"}`,
      side.usedStale
        ? `wrong · the rule changed on turn ${nf.format(d.revision.seq)}`
        : `turn ${nf.format(d.revision.seq)} · brought back exactly`,
    ),
  );
  return card;
}

// ── the counter ─────────────────────────────────────────────────────────────

/** Counts once, when the beat scrolls into view. A reduced-motion visitor gets the number. */
function countUp(node: HTMLElement, from: number, to: number): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.disconnect();
        const t0 = performance.now();
        const step = (now: number): void => {
          const p = Math.min(1, (now - t0) / COUNT_MS);
          // ease-out cubic: the number lands rather than stopping dead
          const eased = 1 - (1 - p) ** 3;
          node.textContent = nf.format(Math.round(from + (to - from) * eased));
          if (p < 1) requestAnimationFrame(step);
        };
        node.textContent = nf.format(from);
        requestAnimationFrame(step);
      }
    },
    { threshold: 0.6 },
  );
  observer.observe(node);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function el(tag: string, cls = "", text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

/** A figure a stranger can hover: what it is in words, then the figure itself. */
function receipt(text: string, title: string): HTMLElement {
  const node = el("span", "", text);
  node.title = title;
  return node;
}

function link(href: string, text: string): HTMLAnchorElement {
  const node = document.createElement("a");
  node.className = "link";
  node.href = href;
  node.textContent = text;
  return node;
}

function short(hash: string): string {
  return hash && hash.length > 16 ? `${hash.slice(0, 12)}…${hash.slice(-4)}` : hash || "—";
}
