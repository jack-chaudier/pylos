import type {
  AnswerReceipt,
  CapsuleView,
  CoverageReceipt,
  Episode,
  EpisodeView,
  PageRecord,
  ReachabilitySpan,
  SemanticReceipt,
} from "@pylos/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bytesLabel, fullStamp, groupedNumber, shortTime } from "../format.ts";
import { splitReceipts } from "../receipts.ts";
import { CheckLine, GateLine, RecoveryLine } from "./EvidenceLines.tsx";

export interface StreamingTurn {
  text: string;
  model: string;
  pages: PageRecord[];
  /** Kernel packet receipts collected before the committed answer arrives. */
  coverage?: CoverageReceipt;
  reachability?: ReachabilitySpan[];
  semantic?: SemanticReceipt;
  /** A gate is the release point. Deltas before it are never rendered. */
  gate?: AnswerReceipt;
  /** KERNEL A9.5: the draft named lost values, so the text so far is provisional. */
  check?: { names: string[] };
  error?: string;
}

export interface TranscriptProps {
  readOnly?: boolean;
  threadId: string;
  episodes: Episode[];
  capsules: CapsuleView[];
  hasOlder: boolean;
  loadingOlder: boolean;
  streaming: StreamingTurn | undefined;
  /** Seq the rail asked us to jump to; cleared by the parent once honoured. */
  jumpTo: number | undefined;
  onNearTop: () => void;
  onViewportChange: (view: { firstSeq: number; lastSeq: number; ratio: number }) => void;
  onForget: (episode: Episode) => void;
}

const ESTIMATED_ROW = 96;
const OVERSCAN = 8;
const MAX_DOM_ROWS = 200;

export function Transcript(props: TranscriptProps): React.JSX.Element {
  const { episodes, capsules, streaming } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const heights = useRef(new Map<number, number>());
  const [measured, forceMeasure] = useState(0);
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
        losses: Math.max(0, capsule.droppedCount) + capsule.carriedCount,
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
    // `measured` intentionally participates: measuring changes the offsets.
  }, [episodes, measured]);

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
    // Measuring shrinks estimated rows, so the foot moves: follow it.
  }, [streaming?.text, episodes, measured]);

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
          readOnly={props.readOnly}
          onForget={props.onForget}
        />
      ))}
      <div style={{ height: padBottom }} />
      {streaming !== undefined ? (
        <div className="measure">
          {streaming.pages.length > 0 ? (
            <RecoveryLine threadId={props.threadId} pages={streaming.pages} />
          ) : null}
          {/* Mid-turn the outcome is not settled, but the draft is already gone. */}
          {streaming.check !== undefined ? (
            <CheckLine meta={{ names: streaming.check.names, status: "revised" }} />
          ) : null}
          <GateLine receipt={streaming.gate} />
          <div className="row row-assistant">
            <AnswerText text={streaming.text} cursor />
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
  readOnly?: boolean;
  episode: Episode;
  sealed: { from: number; to: number; losses: number } | undefined;
  threadId: string;
  measure: (seq: number, node: HTMLDivElement | null) => void;
  onForget: (episode: Episode) => void;
}

function Row({
  episode,
  sealed,
  threadId,
  measure,
  readOnly = false,
  onForget,
}: RowProps): React.JSX.Element {
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
          <ProjectionReceipt episode={episode} />
        </div>
      ) : (
        <>
          {pages.length > 0 ? <RecoveryLine threadId={threadId} pages={pages} /> : null}
          <CheckLine meta={episode.meta.check} />
          <div className={`row row-${episode.role}${removed ? " row-removed" : ""}`}>
            <RowMeta episode={episode} />
            {episode.role === "assistant" ? (
              <AnswerText text={episode.content} />
            ) : (
              <div className="row-text">{episode.content}</div>
            )}
            <ProjectionReceipt episode={episode} />
            {!readOnly && !removed ? (
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

/**
 * An assistant turn as the archive stored it, with the gate's qualification
 * lines lifted out of the prose into the engraved register. Only the styling
 * moves; the lines stay in the episode's bytes and in every export.
 */
function AnswerText({ text, cursor = false }: { text: string; cursor?: boolean }): React.JSX.Element {
  const { body, receipts } = splitReceipts(text);
  return (
    <>
      <div className="row-text">
        {body}
        {cursor && receipts.length === 0 ? <span className="cursor" /> : null}
      </div>
      {receipts.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the last line grows as it streams
        <p key={index} className="receipt-line">
          {line}
          {cursor && index === receipts.length - 1 ? <span className="cursor" /> : null}
        </p>
      ))}
    </>
  );
}

/** A bounded transcript row stays honest about omitted bytes and its source. */
function ProjectionReceipt({ episode }: { episode: Episode }): React.JSX.Element | null {
  const projected = episode as Episode &
    Partial<
      Pick<
        EpisodeView,
        "contentBytes" | "contentTruncated" | "locator" | "continuation" | "locatorOmittedReason"
      >
    >;
  if (projected.contentTruncated !== true || projected.contentBytes === undefined) return null;
  const retained = new TextEncoder().encode(episode.content).byteLength;
  const locator = projected.locator;
  const source = locator?.source ?? `locator withheld · ${projected.locatorOmittedReason ?? "unknown"}`;
  return (
    <div className="row-projection mono" title={locator?.revision}>
      bounded · {bytesLabel(retained)} of {bytesLabel(projected.contentBytes)} · {source}
      {projected.continuation === undefined ? "" : ` · continue at byte ${projected.continuation.from}`}
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
