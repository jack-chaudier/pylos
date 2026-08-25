import type { Episode, PageRecord } from "@pylos/protocol";
import { splitReceipts } from "../receipts.ts";
import { CheckLine, GateLine, RecoveryLine } from "./EvidenceLines.tsx";
import type { StreamingTurn } from "./Transcript.tsx";

export interface ExchangeProps {
  threadId: string;
  /** The last thing you said. */
  question: Episode | undefined;
  /** The answer to it, once it has committed. */
  answer: Episode | undefined;
  streaming: StreamingTurn | undefined;
  /** KERNEL A6: a user turn with nothing after it. */
  awaitingReply: boolean;
  hasEarlier: boolean;
  onEarlier: () => void;
}

const pagesOf = (episode: Episode | undefined): PageRecord[] =>
  Array.isArray(episode?.meta.pages) ? (episode.meta.pages as PageRecord[]) : [];

/**
 * One exchange, and only one: what you asked, what had to be recovered to
 * answer it, and the answer. Everything before it is in the archive drawer.
 */
export function Exchange(props: ExchangeProps): React.JSX.Element {
  const { streaming, answer } = props;
  const pages = streaming === undefined ? pagesOf(answer) : streaming.pages;
  // Mid-turn the outcome is not settled, but the draft is already gone.
  const check =
    streaming === undefined
      ? answer?.meta.check
      : streaming.check === undefined
        ? undefined
        : { names: streaming.check.names, status: "revised" };
  // The gate's qualifications are receipts appended to the answer's bytes; the
  // archive keeps them there, the presence sets them in the engraved register.
  const { body, receipts } = splitReceipts(streaming?.text ?? answer?.content ?? "");
  const receiptLines = receipts.map((line, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the last line grows as it streams
    <p key={index} className="receipt-line">
      {line}
      {streaming !== undefined && index === receipts.length - 1 ? <span className="cursor" /> : null}
    </p>
  ));

  return (
    <div className="exchange">
      {props.hasEarlier ? (
        <button type="button" className="earlier" onClick={props.onEarlier}>
          earlier
        </button>
      ) : null}

      {props.question === undefined ? null : <p className="question">{props.question.content}</p>}

      {pages.length > 0 ? <RecoveryLine threadId={props.threadId} pages={pages} /> : null}
      <CheckLine meta={check} />
      {streaming !== undefined ? <GateLine receipt={streaming.gate} /> : null}

      {streaming !== undefined ? (
        <>
          <p className="answer">
            {body}
            {receipts.length === 0 ? <span className="cursor" /> : null}
          </p>
          {receiptLines}
        </>
      ) : answer !== undefined ? (
        <>
          <p className="answer" data-removed={answer.meta.removed === true}>
            {body}
          </p>
          {receiptLines}
        </>
      ) : null}

      {props.awaitingReply ? <div className="no-reply">no reply · send again to retry this turn</div> : null}
    </div>
  );
}
