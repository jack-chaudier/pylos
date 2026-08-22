/**
 * The trap exhibit.
 *
 * Two columns, one model, one question, turn 1,000,000. Everything rendered
 * here comes from `public/bench/trap.json` — the artifact `pylos bench million
 * --live` writes. Nothing about the exhibit is written into the page, so when
 * the bench replaces the file the page tells the truth without being touched.
 *
 * Until then the file carries `"placeholder": true` and the section says so.
 */

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

const nf = new Intl.NumberFormat("en-US");

export async function mountTrap(): Promise<void> {
  const body = document.querySelector<HTMLElement>("[data-trap-body]");
  if (!body) return;

  let data: TrapArtifact;
  try {
    const res = await fetch("/bench/trap.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(String(res.status));
    data = (await res.json()) as TrapArtifact;
  } catch {
    body.innerHTML = `<p class="mono">The bench artifact could not be loaded. It lives at <a class="link" href="/bench/trap.json">/bench/trap.json</a>.</p>`;
    return;
  }

  if (data.placeholder) {
    const tag = document.querySelector<HTMLElement>("[data-trap-tag]");
    if (tag) tag.hidden = false;
  }

  body.replaceChildren(render(data));
}

function render(d: TrapArtifact): DocumentFragment {
  const frag = document.createDocumentFragment();

  const q = el("div", "trap__q");
  q.append(
    el("p", "mono", `${d.model} · budget ${nf.format(d.budget)} tokens · turn ${nf.format(d.turns)}`),
    el("p", "trap__qtext", d.question),
  );
  frag.append(q);

  const cols = el("div", "trap__cols");
  cols.append(column(d, "baseline"), column(d, "pylos"));
  frag.append(cols);

  const hashes = el("p", "trap__hashes");
  hashes.append(
    el("span", "", `seed ${d.seed}`),
    el("span", "", `rule #${nf.format(d.rule.seq)} · revised #${nf.format(d.revision.seq)}`),
    el("span", "", `archive head ${short(d.hashes.archiveHead)}`),
    el("span", "", `packet ${short(d.hashes.packet)}`),
  );
  frag.append(hashes);

  const pp = d.pylos.probes;
  const bp = d.baseline.probes;
  if (pp && bp) {
    frag.append(
      el(
        "p",
        "trap__probes mono",
        `${nf.format(pp.n)} probes per arm · Pylos current ${pp.current}/${pp.n}, silent-false ${pp.silentFalse} · ` +
          `rolling summary current ${bp.current}/${bp.n}, abstained ${bp.abstained}, silent-false ${bp.silentFalse}`,
      ),
    );
  }
  if (!d.placeholder && d.note) frag.append(el("p", "dl__note", d.note));

  if (d.placeholder) {
    const note = el(
      "p",
      "dl__note",
      d.note ?? "Preliminary. These columns are illustrative until the bench artifact replaces this file.",
    );
    frag.append(note);
  }

  return frag;
}

function column(d: TrapArtifact, which: "baseline" | "pylos"): HTMLElement {
  const side = d[which];
  const col = el("article", `col${which === "pylos" ? " col--pylos" : ""}`);

  const head = el("div", "col__head");
  head.append(
    el("h3", "col__name", side.label ?? (which === "pylos" ? "Pylos" : "Rolling summary")),
    el("span", "mono", which === "pylos" ? "exact archive" : "lossy compaction"),
  );
  col.append(head, el("p", "col__answer", side.answer));

  if (side.note) col.append(el("p", "col__note", side.note));

  const receipt = el("div", "receipt");
  if (which === "baseline") {
    receipt.append(
      el("span", "", "pages: none — nothing recorded what the summary dropped"),
      el(
        "span",
        side.usedStale ? "bad" : "good",
        side.usedStale
          ? `✕ answered from the superseded rule (#${nf.format(d.rule.seq)})`
          : "✓ answered from the current rule",
      ),
    );
  } else {
    const pages = d.pylos.pages ?? [];
    for (const p of pages) {
      receipt.append(
        el(
          "span",
          "page",
          p.trigger.startsWith("resident")
            ? `● resident #${nf.format(p.seq)} · ${p.trigger.replace(/^resident · /, "")}`
            : `↺ recovered #${nf.format(p.seq)} · ${p.trigger}`,
        ),
      );
    }
    if (pages.length === 0) receipt.append(el("span", "", "pages: none needed"));
    receipt.append(
      el(
        "span",
        side.usedStale ? "bad" : "good",
        side.usedStale
          ? `✕ answered from the superseded rule (#${nf.format(d.rule.seq)})`
          : `✓ answered from the current rule (#${nf.format(d.revision.seq)})`,
      ),
    );
  }
  col.append(receipt);
  return col;
}

function el(tag: string, cls = "", text = ""): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function short(hash: string): string {
  return hash && hash.length > 16 ? `${hash.slice(0, 12)}…${hash.slice(-4)}` : hash || "—";
}
