import type { ThreadStats } from "@pylos/protocol";
import { useEffect, useRef, useState } from "react";
import { bytesLabel, groupedNumber, tokenCount } from "../format.ts";

export interface EvidenceProps {
  stats: ThreadStats | undefined;
  /** Turns the ring is showing: a new one counts when its arrival settles. */
  turns: number;
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
  const { stats, turns, recovered, viewTokens, viewRounds, budget } = props;
  const verifiedTo = stats?.verifiedTo ?? 0;
  const verified = turns > 0 && verifiedTo >= turns;
  const hints = figureHints({
    turns,
    recovered,
    viewTokens,
    viewRounds,
    budget,
    verifiedTo,
    archiveBytes: stats?.archiveBytes ?? 0,
  });

  return (
    <>
      <Figure
        place="archive"
        label="archive"
        value={groupedNumber(turns)}
        unit="turns"
        hint={hints.archive}
        onOpen={props.onOpen}
      />
      <Figure
        place="view"
        label="view"
        value={`${viewTokens === undefined ? "—" : tokenCount(viewTokens)} / ${tokenCount(budget)}`}
        {...(viewRounds !== undefined && viewRounds > 1 ? { unit: `· ${viewRounds} rounds` } : {})}
        hint={hints.view}
        onOpen={props.onOpen}
      />
      <Figure
        place="recovered"
        label="paged"
        value={groupedNumber(recovered)}
        lit={recovered > 0}
        hint={hints.paged}
        onOpen={props.onOpen}
      />
      <Figure
        place="chain"
        label="chain"
        value={verified ? "✓" : "—"}
        lit={verified}
        hint={hints.chain}
        onOpen={props.onOpen}
      />
    </>
  );
}

/** Where every figure leads, said the way the drawer titles itself. */
const XRAY = "Click to open what the model saw.";

export interface FigureHints {
  archive: string;
  view: string;
  paged: string;
  chain: string;
}

/**
 * A figure with no sentence behind it is a dial with no dial face. Each hint
 * says in plain speech what the number measures — including the states before
 * a first turn, where `—` on its own reads as a fault rather than an empty
 * thread — and then where clicking goes.
 */
export function figureHints(input: {
  turns: number;
  recovered: number;
  viewTokens: number | undefined;
  viewRounds: number | undefined;
  budget: number;
  verifiedTo: number;
  archiveBytes: number;
}): FigureHints {
  const { turns, recovered, viewTokens, viewRounds, budget, verifiedTo, archiveBytes } = input;
  const rounds =
    viewRounds !== undefined && viewRounds > 1
      ? ` The last answer took ${viewRounds} requests, each held to that same budget.`
      : "";

  return {
    archive:
      turns === 0
        ? `Every turn is kept exactly, word for word, and hashed into one chain; nothing has been said in this thread yet. ${XRAY}`
        : `Every turn kept exactly, word for word, and hashed into one chain — ${bytesLabel(archiveBytes)} on disk, never rewritten. ${XRAY}`,
    view:
      viewTokens === undefined
        ? `The bounded text the model reads, over its budget of ${tokenCount(budget)} tokens — nothing has been compiled for a model yet, so your first question fills this. ${XRAY}`
        : `The bounded text the model reads, over its budget: ${tokenCount(viewTokens)} of ${tokenCount(budget)} tokens, a limit it may never exceed.${rounds} ${XRAY}`,
    paged:
      recovered > 0
        ? `Earlier turns brought back exactly, word for word, for the last answer — ${groupedNumber(recovered)} of them. ${XRAY}`
        : `Earlier turns are brought back exactly, word for word, when an answer needs them; ${
            turns === 0 ? "nothing has been asked yet" : "none were needed for the last one"
          }. ${XRAY}`,
    chain:
      turns === 0
        ? `Whether the archive's hash chain verified — nothing has been written to this thread yet, so there is nothing to verify. ${XRAY}`
        : verifiedTo >= turns
          ? `Whether the archive's hash chain verified: it holds through all ${groupedNumber(turns)} turns so far. ${XRAY}`
          : `Whether the archive's hash chain verified: checked through turn ${groupedNumber(verifiedTo)} of ${groupedNumber(turns)} so far. ${XRAY}`,
  };
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
    <button
      type="button"
      className="figure"
      data-place={place}
      title={hint}
      aria-label={`${label} ${value}${unit === undefined ? "" : ` ${unit}`} — ${hint}`}
      onClick={onOpen}
    >
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
