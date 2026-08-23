import type { ThreadStats } from "@pylos/protocol";
import { useEffect, useRef, useState } from "react";
import { bytesLabel, groupedNumber, tokenCount } from "../format.ts";

export interface EvidenceProps {
  stats: ThreadStats | undefined;
  recovered: number;
  viewTokens: number | undefined;
  /** KERNEL A10.3: provider requests the last turn spent, packet included. */
  viewRounds: number | undefined;
  budget: number;
  onOpen: () => void;
}

/**
 * The four figures that ring the presence at rest: how much is kept, how much
 * the model saw, what came back for the last answer, and whether the chain
 * still holds. Each opens the X-ray that proves it.
 */
export function EvidenceFigures(props: EvidenceProps): React.JSX.Element {
  const { stats, recovered, viewTokens, viewRounds, budget } = props;
  const turns = stats?.turns ?? 0;
  const verifiedTo = stats?.verifiedTo ?? 0;
  const verified = turns > 0 && verifiedTo >= turns;

  return (
    <>
      <Figure
        place="archive"
        label="archive"
        value={groupedNumber(turns)}
        unit="turns"
        hint={
          `Turns held verbatim in the hash-chained vault — ${bytesLabel(stats?.archiveBytes ?? 0)} on disk. ` +
          "Compaction never touches them."
        }
        onOpen={props.onOpen}
      />
      <Figure
        place="view"
        label="view"
        value={`${viewTokens === undefined ? "—" : tokenCount(viewTokens)} / ${tokenCount(budget)}`}
        {...(viewRounds !== undefined && viewRounds > 1 ? { unit: `· ${viewRounds} rounds` } : {})}
        hint={
          "Tokens in the packet the model last saw, against the budget it may never exceed. " +
          "A turn that recalled, or was checked, costs more than one request — each held to that same budget."
        }
        onOpen={props.onOpen}
      />
      <Figure
        place="recovered"
        label="recovered"
        value={groupedNumber(recovered)}
        lit={recovered > 0}
        hint="Spans paged back from the archive before the last answer."
        onOpen={props.onOpen}
      />
      <Figure
        place="chain"
        label="chain"
        value={verified ? "✓" : "—"}
        lit={verified}
        hint={
          turns === 0
            ? "Nothing has been written to this thread yet."
            : `Hash chain verified to #${groupedNumber(verifiedTo)} of #${groupedNumber(turns)}.${
                verified ? "" : " Open the X-ray to verify the rest."
              }`
        }
        onOpen={props.onOpen}
      />
    </>
  );
}

function Figure({
  place,
  label,
  value,
  unit,
  hint,
  lit,
  onOpen,
}: {
  /** Where it sits around the ring. */
  place: string;
  label: string;
  value: string;
  /** Trailing detail — the unit, or what the figure cost. Dropped on narrow screens. */
  unit?: string;
  hint: string;
  lit?: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const changed = useChanged(value);
  return (
    <button type="button" className="figure" data-place={place} title={hint} onClick={onOpen}>
      <span className="figure-label">{label}</span>
      <em data-lit={lit === true} data-changed={changed}>
        {value}
        {unit === undefined ? null : <i className="figure-unit"> {unit}</i>}
      </em>
    </button>
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
