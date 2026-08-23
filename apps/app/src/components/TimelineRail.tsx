import type { Capsule, Episode } from "@pylos/protocol";
import { useMemo, useRef, useState } from "react";
import { groupedNumber, shortDate } from "../format.ts";

export interface RailProps {
  turns: number;
  capsules: Capsule[];
  handoffs: Episode[];
  /** The seq range currently on screen. */
  view: { firstSeq: number; lastSeq: number };
  onJump: (seq: number) => void;
  /** Rough seq → date, from whatever episodes are loaded. */
  dateFor: (seq: number) => number | undefined;
}

/**
 * The scrollbar, replaced. Hairline ticks at capsule boundaries (denser marks =
 * more compacted), kiln ticks at handoffs, a kiln thumb for the viewport.
 */
export function TimelineRail(props: RailProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ y: number; seq: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);
  const turns = Math.max(1, props.turns);

  const ticks = useMemo(() => {
    const marks: Array<{ seq: number; kind: "capsule" | "handoff" }> = [];
    // Thin out to something a 700px rail can actually resolve.
    const stride = Math.max(1, Math.ceil(props.capsules.length / 260));
    props.capsules.forEach((capsule, index) => {
      if (capsule.level !== 0 || index % stride !== 0) return;
      marks.push({ seq: capsule.toSeq, kind: "capsule" });
    });
    for (const handoff of props.handoffs) marks.push({ seq: handoff.seq, kind: "handoff" });
    return marks;
  }, [props.capsules, props.handoffs]);

  const positionFor = (seq: number): number => Math.min(1, Math.max(0, seq / turns));

  const seqAt = (clientY: number): number => {
    const box = ref.current?.getBoundingClientRect();
    if (box === undefined) return 1;
    const fraction = Math.min(1, Math.max(0, (clientY - box.top - 16) / Math.max(1, box.height - 32)));
    return Math.max(1, Math.round(fraction * turns));
  };

  const thumbTop = positionFor(props.view.firstSeq) * 100;
  const thumbHeight = Math.max(3, (positionFor(props.view.lastSeq) - positionFor(props.view.firstSeq)) * 100);

  return (
    <div
      className="rail"
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Timeline"
      aria-valuemin={1}
      aria-valuemax={turns}
      aria-valuenow={props.view.firstSeq}
      onMouseMove={(event) => {
        const seq = seqAt(event.clientY);
        setHover({ y: event.clientY - (ref.current?.getBoundingClientRect().top ?? 0), seq });
        if (dragging) props.onJump(seq);
      }}
      onMouseLeave={() => {
        setHover(undefined);
        setDragging(false);
      }}
      onMouseDown={(event) => {
        setDragging(true);
        props.onJump(seqAt(event.clientY));
      }}
      onMouseUp={() => setDragging(false)}
      onKeyDown={(event) => {
        const step = Math.max(1, Math.round(turns / 50));
        if (event.key === "ArrowUp") props.onJump(Math.max(1, props.view.firstSeq - step));
        if (event.key === "ArrowDown") props.onJump(Math.min(turns, props.view.firstSeq + step));
        if (event.key === "Home") props.onJump(1);
        if (event.key === "End") props.onJump(turns);
      }}
    >
      <div className="rail-line" />
      {ticks.map((tick) => (
        <div
          key={`${tick.kind}-${tick.seq}`}
          className="rail-tick"
          data-kind={tick.kind}
          style={{ top: `calc(16px + ${positionFor(tick.seq) * 100}% - ${positionFor(tick.seq) * 32}px)` }}
        />
      ))}
      <div
        className="rail-thumb"
        style={{
          top: `calc(16px + ${thumbTop}% - ${(thumbTop / 100) * 32}px)`,
          height: `${thumbHeight}%`,
        }}
      />
      {hover !== undefined ? (
        <div className="rail-tip" style={{ top: hover.y }}>
          turn {groupedNumber(hover.seq)}
          {(() => {
            const ts = props.dateFor(hover.seq);
            return ts === undefined ? "" : ` · ${shortDate(ts)}`;
          })()}
        </div>
      ) : null}
    </div>
  );
}
