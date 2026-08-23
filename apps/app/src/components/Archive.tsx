import type { Capsule, Episode } from "@pylos/protocol";
import { useEffect } from "react";
import { groupedNumber } from "../format.ts";
import { TimelineRail } from "./TimelineRail.tsx";
import { type StreamingTurn, Transcript } from "./Transcript.tsx";

export interface ArchiveProps {
  threadId: string;
  turns: number;
  episodes: Episode[];
  capsules: Capsule[];
  handoffs: Episode[];
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  streaming: StreamingTurn | undefined;
  jumpTo: number | undefined;
  view: { firstSeq: number; lastSeq: number };
  dateFor: (seq: number) => number | undefined;
  onNearTop: () => void;
  onViewportChange: (view: { firstSeq: number; lastSeq: number }) => void;
  onForget: (episode: Episode) => void;
  onJump: (seq: number) => void;
  onNow: () => void;
  onClose: () => void;
}

/** A place you visit, not where you live: the whole thread, from the right. */
export function Archive(props: ArchiveProps): React.JSX.Element {
  const { onClose } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} role="presentation" aria-hidden="true" />
      <aside className="drawer drawer-archive" aria-label="The archive">
        <div className="drawer-head">
          <h2>The archive</h2>
          <span className="mono">{groupedNumber(props.turns)} turns</span>
          <span className="drawer-flex" />
          {props.hasNewer ? (
            <button type="button" className="ghost" onClick={props.onNow}>
              Now
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="archive-body">
          <Transcript
            threadId={props.threadId}
            episodes={props.episodes}
            capsules={props.capsules}
            hasOlder={props.hasOlder}
            loadingOlder={props.loadingOlder}
            streaming={props.streaming}
            jumpTo={props.jumpTo}
            onNearTop={props.onNearTop}
            onViewportChange={(next) =>
              props.onViewportChange({ firstSeq: next.firstSeq, lastSeq: next.lastSeq })
            }
            onForget={props.onForget}
          />
          <TimelineRail
            turns={props.turns}
            capsules={props.capsules}
            handoffs={props.handoffs}
            view={props.view}
            onJump={props.onJump}
            dateFor={props.dateFor}
          />
        </div>
      </aside>
    </>
  );
}
