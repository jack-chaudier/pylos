import type { Capsule, Episode, PageRecord } from "@pylos/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.ts";
import { bytesLabel, fullStamp, groupedNumber, shortTime, spelled } from "../format.ts";

export interface StreamingTurn {
  text: string;
  model: string;
  pages: PageRecord[];
  error?: string;
}

export interface TranscriptProps {
  threadId: string;
  episodes: Episode[];
  capsules: Capsule[];
  hasOlder: boolean;
  loadingOlder: boolean;
  streaming: StreamingTurn | undefined;
  /** Seq the rail asked us to jump to; cleared by the parent once honoured. */
  jumpTo: number | undefined;
  onNearTop: () => void;
  onViewportChange: (view: { firstSeq: number; lastSeq: number; ratio: number }) => void;
  onForget: (episode: Episode) => void;
  onScrolledChange: (scrolled: boolean) => void;
}

const ESTIMATED_ROW = 96;
const OVERSCAN = 8;
const MAX_DOM_ROWS = 200;

export function Transcript(props: TranscriptProps): React.JSX.Element {
  const { episodes, capsules, streaming } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<number, number>());
  const [, forceMeasure] = useState(0);
  const [range, setRange] = useState({ start: 0, end: 30 });
  const pinnedToBottom = useRef(true);
  const previousFirstSeq = useRef<number | undefined>(undefined);
  const previousHeight = useRef(0);

  /** Capsule boundaries, keyed by the last sealed seq. */
  const sealedAt = useMemo(() => {
    const map = new Map<number, { from: number; to: number; losses: number }>();
    for (const capsule of capsules) {
      if (capsule.level !== 0) continue;
      map.set(capsule.toSeq, {
        from: capsule.fromSeq,
        to: capsule.toSeq,
        losses: capsule.dropped.length + capsule.carriedCount,
      });
    }
    return map;
  }, [capsules]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: measuring must re-derive offsets
  const offsets = useMemo(() => {
    const out = new Float64Array(episodes.length + 1);
    for (let i = 0; i < episodes.length; i += 1) {
      const seq = episodes[i]?.seq ?? 0;
      out[i + 1] = (out[i] ?? 0) + (heights.current.get(seq) ?? ESTIMATED_ROW);
    }
    return out;
    // `forceMeasure` intentionally participates: measuring changes the offsets.
  }, [episodes, forceMeasure]);

  const totalHeight = offsets[episodes.length] ?? 0;

  const recompute = useCallback((): void => {
    const element = scrollRef.current;
    if (element === null) return;
    const top = element.scrollTop;
    const bottom = top + element.clientHeight;
    let start = binarySearch(offsets, top);
    let end = binarySearch(offsets, bottom) + 1;
    start = Math.max(0, start - OVERSCAN);
    end = Math.min(episodes.length, end + OVERSCAN);
    if (end - start > MAX_DOM_ROWS) end = start + MAX_DOM_ROWS;
    setRange((current) => (current.start === start && current.end === end ? current : { start, end }));

    const first = episodes[start];
    const last = episodes[Math.max(start, end - 1)];
    if (first !== undefined && last !== undefined) {
      const scrollable = Math.max(1, element.scrollHeight - element.clientHeight);
      props.onViewportChange({
        firstSeq: first.seq,
        lastSeq: last.seq,
        ratio: Math.min(1, Math.max(0, top / scrollable)),
      });
    }
    props.onScrolledChange(top > 4);

    pinnedToBottom.current = element.scrollHeight - bottom < 80;
    if (top < 900 && props.hasOlder && !props.loadingOlder) props.onNearTop();
  }, [episodes, offsets, props]);

  // Measure rendered rows; a changed height re-derives the offsets.
  const measure = useCallback((seq: number, node: HTMLDivElement | null): void => {
    if (node === null) return;
    const height = node.getBoundingClientRect().height;
    if (height <= 0) return;
    const known = heights.current.get(seq);
    if (known !== undefined && Math.abs(known - height) < 0.5) return;
    heights.current.set(seq, height);
    forceMeasure((n) => n + 1);
  }, []);

  useEffect(() => {
    recompute();
  }, [recompute]);

  // Keep the reading position stable when older pages are prepended.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const firstSeq = episodes[0]?.seq;
    if (
      previousFirstSeq.current !== undefined &&
      firstSeq !== undefined &&
      firstSeq < previousFirstSeq.current
    ) {
      const added = element.scrollHeight - previousHeight.current;
      if (added > 0) element.scrollTop += added;
    }
    previousFirstSeq.current = firstSeq;
    previousHeight.current = element.scrollHeight;
  }, [episodes]);

  // Follow the stream unless the reader has scrolled away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: growth is the trigger, not a read
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null || !pinnedToBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [streaming?.text, episodes]);

  useEffect(() => {
    const seq = props.jumpTo;
    const element = scrollRef.current;
    if (seq === undefined || element === null) return;
    const index = episodes.findIndex((episode) => episode.seq >= seq);
    if (index < 0) return;
    element.scrollTop = Math.max(0, (offsets[index] ?? 0) - 40);
    recompute();
  }, [props.jumpTo, episodes, offsets, recompute]);

  const visible = episodes.slice(range.start, range.end);
  const padTop = offsets[range.start] ?? 0;
  const padBottom = Math.max(0, totalHeight - (offsets[range.end] ?? totalHeight));

  return (
    <div className="transcript" ref={scrollRef} onScroll={recompute}>
      {props.hasOlder ? (
        <div className="measure loading-older mono">
          {props.loadingOlder ? "recovering earlier turns…" : "scroll up for the earlier archive"}
        </div>
      ) : null}
      <div style={{ height: padTop }} />
      {visible.map((episode) => (
        <Row
          key={episode.seq}
          episode={episode}
          sealed={sealedAt.get(episode.seq)}
          threadId={props.threadId}
          measure={measure}
          onForget={props.onForget}
        />
      ))}
      <div style={{ height: padBottom }} />
      {streaming !== undefined ? (
        <div className="measure">
          {streaming.pages.length > 0 ? (
            <RecoveryLine threadId={props.threadId} pages={streaming.pages} />
          ) : null}
          <div className="row row-assistant">
            <div className="row-text">
              {streaming.text}
              <span className="cursor" />
            </div>
          </div>
          {streaming.error !== undefined ? <div className="turn-error">{streaming.error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function binarySearch(offsets: Float64Array, target: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid + 1] ?? 0) <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

interface RowProps {
  episode: Episode;
  sealed: { from: number; to: number; losses: number } | undefined;
  threadId: string;
  measure: (seq: number, node: HTMLDivElement | null) => void;
  onForget: (episode: Episode) => void;
}

function Row({ episode, sealed, threadId, measure, onForget }: RowProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    measure(episode.seq, ref.current);
  });

  const pages = Array.isArray(episode.meta.pages) ? (episode.meta.pages as PageRecord[]) : [];
  const removed = episode.meta.removed === true;

  return (
    <div ref={ref} className="measure">
      {episode.role === "handoff" ? (
        <div className="handoff">
          <span>{episode.content}</span>
        </div>
      ) : episode.role === "attachment" ? (
        <div className="row">
          <RowMeta episode={episode} />
          <span className="row-attachment">
            <PaperclipIcon />
            <b>{String(episode.meta.name ?? "attachment")}</b>
            {typeof episode.meta.size === "number" ? bytesLabel(episode.meta.size) : null}
          </span>
        </div>
      ) : (
        <>
          {pages.length > 0 ? <RecoveryLine threadId={threadId} pages={pages} /> : null}
          <div className={`row row-${episode.role}${removed ? " row-removed" : ""}`}>
            <RowMeta episode={episode} />
            <div className="row-text">{episode.content}</div>
            {!removed ? (
              <div className="row-actions">
                <button type="button" className="row-action" onClick={() => onForget(episode)}>
                  Forget this
                </button>
              </div>
            ) : null}
          </div>
        </>
      )}
      {sealed !== undefined ? (
        <div className="sealed">
          <span>
            sealed · turns {groupedNumber(sealed.from)}–{groupedNumber(sealed.to)}
            {sealed.losses > 0 ? ` · ${sealed.losses} losses carried` : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function RowMeta({ episode }: { episode: Episode }): React.JSX.Element {
  return (
    <div className="row-meta" title={fullStamp(episode.ts)}>
      #{episode.seq} · {shortTime(episode.ts)}
      {episode.model !== undefined ? (
        <>
          <br />
          {episode.model}
        </>
      ) : null}
    </div>
  );
}

function RecoveryLine({
  threadId,
  pages,
}: {
  threadId: string;
  pages: PageRecord[];
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [spans, setSpans] = useState<Array<{ seq: number; text: string; ts: number }>>([]);
  const seqs = useMemo(() => {
    const all = pages.flatMap((page) => page.seqs);
    return [...new Set(all)].sort((a, b) => a - b);
  }, [pages]);

  useEffect(() => {
    if (!open || spans.length > 0) return;
    let cancelled = false;
    void (async () => {
      const loaded = await Promise.all(
        seqs.slice(0, 12).map(async (seq) => {
          try {
            const episode = await api.episode(threadId, seq);
            return { seq, text: episode.content, ts: episode.ts };
          } catch {
            return { seq, text: "UNKNOWN — the locator did not resolve.", ts: 0 };
          }
        }),
      );
      if (!cancelled) setSpans(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, seqs, threadId, spans.length]);

  const resolved = pages.filter((page) => page.resolved).length;
  const unresolved = pages.length - resolved;
  if (seqs.length === 0 && unresolved === 0) return null;

  return (
    <>
      <button type="button" className="recovery" onClick={() => setOpen((value) => !value)}>
        ↺ recovered {spelled(seqs.length)} earlier {seqs.length === 1 ? "moment" : "moments"}
        {unresolved > 0 ? ` · ${unresolved} unknown` : ""}
      </button>
      {open ? (
        <div className="recovery-spans">
          {spans.map((span) => (
            <div key={span.seq} className="recovery-span">
              <b>
                #{span.seq}
                {span.ts > 0 ? ` · ${fullStamp(span.ts)}` : ""}
              </b>
              {span.text}
            </div>
          ))}
          {spans.length === 0 ? <div className="recovery-span">recovering…</div> : null}
        </div>
      ) : null}
    </>
  );
}

function PaperclipIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 10.5 11.5 19a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 1 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
