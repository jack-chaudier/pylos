import type { ThreadStats } from "@pylos/protocol";
import { useEffect, useRef, useState } from "react";
import { bytesLabel, groupedNumber, tokenCount } from "../format.ts";

/** The aperture: a gate between a bounded view and an unbounded archive. */
export function SealMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9.2" fill="none" stroke="var(--verdigris)" strokeWidth="1.4" />
      <path d="M12 2.8 A9.2 9.2 0 0 1 12 21.2" fill="none" stroke="var(--verdigris)" strokeWidth="1.4" />
      <circle cx="12" cy="12" r="3.1" fill="none" stroke="var(--verdigris)" strokeWidth="1.4" />
      <path d="M12 8.9 V2.8 M12 15.1 V21.2" stroke="var(--verdigris)" strokeWidth="1.4" />
    </svg>
  );
}

export interface EvidenceBarProps {
  stats: ThreadStats | undefined;
  /** 0–1 while the packet is being built; undefined when settled. */
  building: number | undefined;
  recovered: number;
  viewTokens: number | undefined;
  budget: number;
  open: boolean;
  onOpen: () => void;
}

/**
 * The seal, expanded. Every figure the machinery can honestly report, in one
 * mono strip; clicking it opens the X-ray that proves each one. Narrow windows
 * keep archive, view and recovered — the three that change while you talk.
 */
export function EvidenceBar(props: EvidenceBarProps): React.JSX.Element {
  const { stats, building, recovered, viewTokens, budget } = props;
  const turns = stats?.turns ?? 0;
  const meter =
    building !== undefined
      ? building
      : viewTokens === undefined
        ? 0
        : Math.min(1, viewTokens / Math.max(budget, 1));
  const verifiedTo = stats?.verifiedTo ?? 0;
  const verified = turns > 0 && verifiedTo >= turns;

  return (
    <button
      type="button"
      className="evidence"
      data-open={props.open}
      onClick={props.onOpen}
      aria-label="Open the X-ray"
    >
      <SealMark className="seal-mark" />
      <span className="evidence-strip">
        <Figure
          label="archive"
          value={groupedNumber(turns)}
          unit="turns"
          hint="Turns held verbatim in the hash-chained vault. Compaction never touches them."
        />
        <Figure
          label=""
          wide
          value={bytesLabel(stats?.archiveBytes ?? 0)}
          hint="Bytes of exact archive on disk, including the chain records."
        />
        <Figure
          label="view"
          value={`${viewTokens === undefined ? "—" : tokenCount(viewTokens)} / ${tokenCount(budget)}`}
          hint="Tokens in the packet the model last saw, against the budget it may never exceed."
        />
        <Figure
          label="ledger"
          wide
          value={groupedNumber(stats?.losses ?? 0)}
          hint="Unresolved loss-ledger entries: things a capsule no longer contains, each with an exact locator."
        />
        <Figure
          label="recovered"
          value={groupedNumber(recovered)}
          tone={recovered > 0 ? "ember" : undefined}
          hint="Spans paged back from the archive before the last answer."
        />
        <Figure
          label=""
          wide
          value={`${groupedNumber(stats?.models.length ?? 0)} models`}
          hint="Distinct models that have spoken in this thread."
        />
        <Figure
          label="chain"
          wide
          value={verified ? "✓" : "—"}
          tone={verified ? "verdigris" : undefined}
          hint={
            turns === 0
              ? "Nothing has been written to this thread yet."
              : `Hash chain verified to #${groupedNumber(verifiedTo)} of #${groupedNumber(turns)}.${
                  verified ? "" : " Open the X-ray to verify the rest."
                }`
          }
        />
      </span>
      <span className="evidence-meter">
        <i style={{ width: `${Math.round(meter * 100)}%` }} />
      </span>
    </button>
  );
}

function Figure({
  label,
  value,
  unit,
  hint,
  tone,
  wide,
}: {
  label: string;
  value: string;
  /** Dropped on narrow screens, where the label already says what the number counts. */
  unit?: string;
  hint: string;
  tone?: "ember" | "verdigris";
  wide?: boolean;
}): React.JSX.Element {
  const changed = useChanged(value);
  return (
    <span className="figure" data-wide={wide === true} title={hint}>
      {label === "" ? null : <span className="figure-label">{label}</span>}
      <em data-tone={tone} data-changed={changed}>
        {value}
        {unit === undefined ? null : <i className="figure-unit"> {unit}</i>}
      </em>
    </span>
  );
}

/** True for one beat after `value` changes, so the figure can settle rather than jump. */
function useChanged(value: string): boolean {
  const previous = useRef(value);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setChanged(true);
    const timer = setTimeout(() => setChanged(false), 220);
    return () => clearTimeout(timer);
  }, [value]);
  return changed;
}
