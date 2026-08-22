import type { ThreadStats } from "@pylos/protocol";
import { compactNumber, groupedNumber, tokenCount } from "../format.ts";

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

export interface SealProps {
  stats: ThreadStats | undefined;
  /** 0–1 while the packet is being built; undefined when settled. */
  building: number | undefined;
  recovered: number;
  viewTokens: number | undefined;
  budget: number;
  open: boolean;
  onOpen: () => void;
}

export function Seal(props: SealProps): React.JSX.Element {
  const { stats, building, recovered, viewTokens, budget } = props;
  const archive = stats?.turns ?? 0;
  const meter =
    building !== undefined
      ? building
      : viewTokens === undefined
        ? 0
        : Math.min(1, viewTokens / Math.max(budget, 1));

  return (
    <button
      type="button"
      className="seal"
      data-open={props.open}
      onClick={props.onOpen}
      title="The exact packet the model saw"
      aria-label="Open the X-ray"
    >
      <SealMark className="seal-mark" />
      <span className="seal-text">
        archive <em>{groupedNumber(archive)}</em>
        {" · view "}
        <em>{viewTokens === undefined ? "—" : tokenCount(viewTokens)}</em>
        {` / ${tokenCount(budget)}`}
        {recovered > 0 ? (
          <>
            {" · "}
            <em className="recovered">{compactNumber(recovered)} recovered</em>
          </>
        ) : null}
      </span>
      <span className="seal-meter">
        <i style={{ width: `${Math.round(meter * 100)}%` }} />
      </span>
    </button>
  );
}
