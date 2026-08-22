/**
 * The aperture's engine driver.
 *
 * Streams the synthetic thread through the compiler in chunks: append episodes,
 * seal a level-0 capsule every 32, roll up a parent every 8 children, keep the
 * loss ledger, and recompile the bounded packet as it goes. Nothing is
 * materialised that does not have to be — the run holds O(log n) capsules and a
 * fixed-size window of recent turns, which is exactly the claim it is
 * illustrating.
 */

import type { Capsule, Episode, LossEntry, Packet, PageRecord } from "./kernel";
import { K } from "./kernel";
import {
  BUDGET,
  certificatesIn,
  episodeAt,
  frontierLines,
  QUOTE_PROBE,
  REVISION_TEXT,
  ruleAtom,
  ruleCertificate,
  TOTAL_TURNS,
  TRAP_QUESTION,
} from "./thread";

const RECENT_WINDOW = 140;
const RECOMPILE_EVERY = 16; // leaf seals — one recompile per 512 turns
const STRIP_MAX = 16;

export interface Recovered {
  /** The question that routed. */
  query: string;
  seq: number;
  text: string;
  trigger: string;
  quote: string;
}

/**
 * A certificate that was already in the view, and so needed no page. The trap
 * ends here: the standing rule is a `preference` atom, kind priority keeps it
 * resident whatever its age, and the superseded version is labelled rather than
 * dropped (KERNEL A4). It is the receipt `bench/results` records for the trap.
 */
export interface Resident {
  query: string;
  seq: number;
  line: string;
  historical: string | null;
}

export interface RunState {
  turn: number;
  total: number;
  /** Bytes of exact, hash-chained archive on disk. */
  archiveBytes: number;
  /** Rows in the `loss` table — every one of them pageable. */
  lossRows: number;
  capsules: number;
  levelCounts: number[];
  packet: Packet;
  /** Names pushed into the ledger by the most recent seals, newest first. */
  strip: StripEntry[];
  /** Null once `routed` is true means: nothing in the ledger matched the question. */
  recovered: Recovered | null;
  /** The trap's answer: the current rule certificate, already resident. */
  resident: Resident | null;
  /** True once the closing questions have been put to the view. */
  routed: boolean;
  done: boolean;
}

export interface StripEntry {
  name: string;
  kind: string;
  seq: number;
  id: number;
}

export class ApertureRun {
  readonly total = TOTAL_TURNS;
  readonly budget = BUDGET;

  private seq = 0;
  private archiveBytes = 0;
  private lossRows = 0;
  private capsuleTotal = 0;
  private levelCounts: number[] = [];
  private leafBuf: Episode[] = [];
  private pending: Capsule[][] = [];
  private spine: Capsule[] = [];
  private recent: string[] = new Array(RECENT_WINDOW).fill("");
  private recentAt = 0;
  private strip: StripEntry[] = [];
  private stripId = 0;
  private sealsSinceCompile = 0;
  private packet: Packet;
  private pageIndex = new Map<string, LossEntry>();
  private watched: Set<string>;
  private recovered: Recovered | null = null;
  private resident: Resident | null = null;
  private routed = false;

  constructor() {
    // Only the names the closing questions can ask about are indexed: the run
    // keeps a bounded page index, exactly as the vault keeps a bounded working
    // set over an unbounded loss table.
    this.watched = K.names(TRAP_QUESTION);
    for (const n of K.names(REVISION_TEXT)) this.watched.add(n);
    for (const n of K.names(QUOTE_PROBE.query)) this.watched.add(n);
    this.packet = this.compile();
  }

  reset(): void {
    this.seq = 0;
    this.archiveBytes = 0;
    this.lossRows = 0;
    this.capsuleTotal = 0;
    this.levelCounts = [];
    this.leafBuf = [];
    this.pending = [];
    this.spine = [];
    this.recent = new Array(RECENT_WINDOW).fill("");
    this.recentAt = 0;
    this.strip = [];
    this.stripId = 0;
    this.sealsSinceCompile = 0;
    this.pageIndex = new Map();
    this.recovered = null;
    this.resident = null;
    this.routed = false;
    this.frontierCache = null;
    this.packet = this.compile();
  }

  get turn(): number {
    return this.seq;
  }

  get finished(): boolean {
    return this.seq >= this.total;
  }

  /**
   * Advance the stream toward `target`, spending at most `msBudget`
   * milliseconds. Returns the number of turns actually appended so the caller
   * can pace itself.
   */
  advanceTo(target: number, msBudget: number): number {
    const start = performance.now();
    const limit = Math.min(target, this.total);
    let appended = 0;
    while (this.seq < limit) {
      // work in slices so the clock is only read once per slice
      const sliceEnd = Math.min(limit, this.seq + 4096);
      while (this.seq < sliceEnd) {
        this.append();
        appended++;
      }
      if (performance.now() - start >= msBudget) break;
    }
    if (this.seq >= this.total && !this.routed) this.close();
    return appended;
  }

  /** Run to completion with no pacing — used for reduced motion and for the build-time snapshot. */
  runToEnd(): RunState {
    while (this.seq < this.total) this.append();
    if (!this.routed) this.close();
    return this.state();
  }

  // ------------------------------------------------------------------ stream

  private append(): void {
    const ep = episodeAt(this.seq + 1);
    this.seq = ep.seq;
    this.archiveBytes += ep.content.length + 96; // content + hash-chain record

    // fixed-size ring: the resident window never grows with the archive
    this.recent[this.recentAt] = ep.content;
    this.recentAt = (this.recentAt + 1) % RECENT_WINDOW;

    this.leafBuf.push(ep);
    if (this.leafBuf.length === K.LEAF_SIZE) this.sealLeaf();
  }

  private sealLeaf(): void {
    const eps = this.leafBuf;
    this.leafBuf = [];
    const atoms = certificatesIn(eps);
    const capsule = K.sealLeaf(eps, atoms);
    this.record(capsule);
    this.push(0, capsule);

    this.sealsSinceCompile++;
    if (this.sealsSinceCompile >= RECOMPILE_EVERY) {
      this.sealsSinceCompile = 0;
      this.packet = this.compile();
    }
  }

  private push(level: number, capsule: Capsule): void {
    let bucket = this.pending[level];
    if (!bucket) {
      bucket = [];
      this.pending[level] = bucket;
    }
    bucket.push(capsule);
    this.spine[level] = capsule;
    if (bucket.length === K.FAN_OUT) {
      this.pending[level] = [];
      const parent = K.sealParent(bucket);
      this.record(parent);
      this.push(level + 1, parent);
    }
  }

  private record(c: Capsule): void {
    this.capsuleTotal++;
    this.levelCounts[c.level] = (this.levelCounts[c.level] ?? 0) + 1;
    this.lossRows += c.dropped.length;

    for (const d of c.dropped) {
      if (this.watched.has(d.name)) this.pageIndex.set(d.name, d);
      if (this.strip.length < STRIP_MAX + 8 && c.level === 0) {
        this.strip.push({ name: d.name, kind: d.kind, seq: d.seq, id: this.stripId++ });
      }
    }
    while (this.strip.length > STRIP_MAX) this.strip.shift();
  }

  // ----------------------------------------------------------------- compile

  private frontierCache: { at: number; lines: string[] } | null = null;

  private compile(): Packet {
    const atSeq = Math.max(1, this.seq);
    // coarse → fine: the O(log n) capsules that cover everything before the window
    const capsules: Capsule[] = [];
    for (let lvl = this.spine.length - 1; lvl >= 0; lvl--) {
      const c = this.spine[lvl];
      if (c) capsules.push(c);
    }
    const paged = this.recovered
      ? [`⟦recovered #${this.recovered.seq} · ledger⟧ ${this.recovered.text}`]
      : [];
    return K.compile({
      budget: this.budget,
      header: header(atSeq, this.archiveBytes),
      frontier: this.frontier(atSeq),
      capsules,
      paged,
      recent: this.recentNewestFirst(),
      ledgerCount: this.lossRows,
    });
  }

  /** Certificate lines change slowly; rebuilding them every turn is waste. */
  private frontier(atSeq: number): string[] {
    const bucket = Math.floor(atSeq / 8192);
    if (!this.frontierCache || this.frontierCache.at !== bucket) {
      this.frontierCache = { at: bucket, lines: frontierLines(atSeq) };
    }
    return this.frontierCache.lines;
  }

  /** The resident window, newest first — the order `recent` is filled in. */
  private recentNewestFirst(): string[] {
    const out: string[] = [];
    for (let i = 0; i < RECENT_WINDOW; i++) {
      const t = this.recent[(this.recentAt - 1 - i + RECENT_WINDOW * 2) % RECENT_WINDOW];
      if (t) out.push(t);
    }
    return out;
  }

  // ----------------------------------------------------------------- closing

  /**
   * The closing questions, answered the way the kernel answers them.
   *
   * The trap — "the dry-run was skipped, can I send it?" — needs no page: the
   * standing rule is a certificate in the frontier, and the revision at turn
   * 483,112 replaced its value there, so the current rule is in the view and the
   * turn-1 version is labelled historical. That is the receipt the live bench
   * records (`public/bench/trap.json`), and it is the receipt shown here.
   *
   * Recovery by paging is a different question, and the exhibit asks one: an
   * exact quote from a turn hundreds of thousands of episodes back, whose name
   * the capsules no longer contain. That one routes through the loss ledger.
   *
   * Nothing is shown that did not happen: if the route resolves nothing, the
   * page says so.
   */
  private close(): void {
    this.routed = true;
    const rule = ruleCertificate(this.seq);
    this.resident = { query: TRAP_QUESTION, ...rule };
    this.recovered = this.route(QUOTE_PROBE.query);
    this.packet = this.compile();
  }

  /**
   * KERNEL §5.1: route a question through the ledger, skipping every name the
   * view already contains — what is resident is never paged again.
   */
  private route(query: string): Recovered | null {
    const residentNames = K.names(this.residentText());
    const records: PageRecord[] = K.routeByLedger({ query, index: this.pageIndex });
    const hit = records.find((r) => !residentNames.has(r.name));
    if (!hit) return null;
    const text = episodeAt(hit.seq).content;
    const span = hit.span;
    const quote = span ? text.slice(span[0], Math.min(text.length, span[1])) : hit.name;
    // The locator has to resolve to text that really carries the name, or it is
    // not a page (KERNEL §5.2). A near miss is a miss.
    if (!text.toLowerCase().includes(hit.name)) return null;
    return { query, seq: hit.seq, text, trigger: `ledger · "${hit.name}"`, quote: quote || hit.name };
  }

  /** Everything the model can already see: frontier, capsules, recent turns. */
  private residentText(): string {
    const parts = this.frontier(Math.max(1, this.seq));
    for (let lvl = this.spine.length - 1; lvl >= 0; lvl--) {
      const c = this.spine[lvl];
      if (c) parts.push(c.text);
    }
    return [...parts, ...this.recentNewestFirst()].join("\n");
  }

  // ------------------------------------------------------------------- state

  state(): RunState {
    return {
      turn: this.seq,
      total: this.total,
      archiveBytes: this.archiveBytes,
      lossRows: this.lossRows,
      capsules: this.capsuleTotal,
      levelCounts: this.levelCounts.slice(),
      packet: this.packet,
      strip: this.strip.slice().reverse(),
      recovered: this.recovered,
      resident: this.resident,
      routed: this.routed,
      done: this.seq >= this.total,
    };
  }
}

function header(seq: number, bytes: number): string {
  const rule = ruleAtom(seq);
  return [
    `You are continuing one long conversation. Archive: ${seq.toLocaleString("en-US")} turns, ${(bytes / 1e9).toFixed(2)} GB, exact and hash-chained.`,
    `Rule in force: ${rule.value} ⟨#${rule.seq}⟩`,
    "You see a bounded view of that archive. Lines marked ⟨lost: …⟩ name things the view no longer contains.",
    "If your answer depends on one of them, call recall first or say that you would need to check.",
    "Never state a lost value from memory. Things marked ⟨historical⟩ were true earlier and have changed.",
  ].join("\n");
}
