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

import {
  BUDGET,
  frontierLines,
  makeEpisode,
  REVISION_SEQ,
  REVISION_TEXT,
  RULE_SEQ,
  RULE_TEXT,
  rng,
  SEED,
  TOTAL_TURNS,
  TRAP_QUESTION,
} from "../sim/corpus";
import type { Capsule, CapsuleAtomLine, Episode, LossEntry, Packet, PageRecord } from "./kernel";
import { K } from "./kernel";

const RECENT_WINDOW = 140;
const RECOMPILE_EVERY = 16; // leaf seals — one recompile per 512 turns
const STRIP_MAX = 16;

export interface Recovered {
  seq: number;
  text: string;
  trigger: string;
  quote: string;
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
  /** True once the trap question has been put to the ledger. */
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

  private next = rng(SEED);
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
  private routed = false;
  private revisionText = "";

  constructor() {
    this.watched = K.names(TRAP_QUESTION);
    // the rule and its revision are what the trap turns on; watch their names too
    for (const n of K.names(REVISION_TEXT)) this.watched.add(n);
    this.packet = this.compile();
  }

  reset(): void {
    this.next = rng(SEED);
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
    this.routed = false;
    this.revisionText = "";
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
    if (this.seq >= this.total && !this.routed) this.trap();
    return appended;
  }

  /** Run to completion with no pacing — used for reduced motion and for the build-time snapshot. */
  runToEnd(): RunState {
    while (this.seq < this.total) this.append();
    if (!this.routed) this.trap();
    return this.state();
  }

  // ------------------------------------------------------------------ stream

  private append(): void {
    const ep = makeEpisode(this.seq + 1, this.next);
    this.seq = ep.seq;
    this.archiveBytes += ep.content.length + 96; // content + hash-chain record
    if (ep.seq === REVISION_SEQ) this.revisionText = ep.content;

    // fixed-size ring: the resident window never grows with the archive
    this.recent[this.recentAt] = ep.content;
    this.recentAt = (this.recentAt + 1) % RECENT_WINDOW;

    this.leafBuf.push(ep);
    if (this.leafBuf.length === K.LEAF_SIZE) this.sealLeaf();
  }

  private sealLeaf(): void {
    const eps = this.leafBuf;
    this.leafBuf = [];
    const atoms = this.atomLinesFor(eps);
    const capsule = K.sealLeaf(eps, atoms);
    this.record(capsule);
    this.push(0, capsule);

    this.sealsSinceCompile++;
    if (this.sealsSinceCompile >= RECOMPILE_EVERY) {
      this.sealsSinceCompile = 0;
      this.packet = this.compile();
    }
  }

  /**
   * The rules stage of the atomizer (§2), reduced to what the extractive writer
   * consumes: certificate lines for decisions, corrections and rules.
   */
  private atomLinesFor(eps: readonly Episode[]): CapsuleAtomLine[] {
    const out: CapsuleAtomLine[] = [];
    for (const ep of eps) {
      const m = /([a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+)\s*(?:=|should be)\s*([^\s.,;]+)/i.exec(ep.content);
      if (m?.[1] && m[2]) out.push({ key: m[1], value: m[2], seq: ep.seq });
    }
    return out;
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

  // -------------------------------------------------------------------- trap

  /**
   * Turn 1,000,000. The question names things the capsules no longer contain,
   * so ledger routing (§5.1) pages the exact span back before the model answers.
   *
   * A recovery is only ever shown when the ledger actually routed to the
   * revision *and* that turn really went through this run. Anything else is a
   * run that did not recover, and the page says so — a page about not
   * inventing recall does not get to invent a recall.
   */
  private trap(): void {
    this.routed = true;
    const records: PageRecord[] = K.routeByLedger({
      query: TRAP_QUESTION,
      index: this.pageIndex,
    });
    const hit = records.find((r) => r.seq === REVISION_SEQ);
    if (hit && this.revisionText) {
      const text = this.revisionText;
      const span = hit.span;
      const quote = span ? text.slice(span[0], Math.min(text.length, span[1])) : hit.name;
      this.recovered = {
        seq: hit.seq,
        text,
        trigger: `ledger · "${hit.name}"`,
        quote: quote || hit.name,
      };
    } else {
      this.recovered = null;
    }
    this.packet = this.compile();
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
      routed: this.routed,
      done: this.seq >= this.total,
    };
  }
}

function header(seq: number, bytes: number): string {
  return [
    `You are continuing one long conversation. Archive: ${seq.toLocaleString("en-US")} turns, ${(bytes / 1e9).toFixed(2)} GB, exact and hash-chained.`,
    `Rule in force: ${RULE_TEXT} ⟨#${RULE_SEQ}⟩`,
    "You see a bounded view of that archive. Lines marked ⟨lost: …⟩ name things the view no longer contains.",
    "If your answer depends on one of them, call recall first or say that you would need to check.",
    "Never state a lost value from memory. Things marked ⟨historical⟩ were true earlier and have changed.",
  ].join("\n");
}
