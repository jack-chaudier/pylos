import type {
  DemoAnswerReceipt,
  DemoApiLinks,
  DemoPacketCoverage,
  DemoSummary,
  PageRecord,
  ThreadStats,
} from "@pylos/protocol";
import { useCallback, useRef, useState } from "react";
import type { EvidenceResource } from "../api.ts";
import { api, MAX_EVIDENCE_TAIL_BYTES } from "../api.ts";
import { groupedNumber, shortHash } from "../format.ts";

export interface ProofDemoPromptProps {
  busy: boolean;
  error: string | undefined;
  onOpen: () => void;
}

export interface ColdStartPromptProps extends ProofDemoPromptProps {
  /** Set only on a local first run with no provider connected: opens the Connect sheet. */
  onConnect: (() => void) | undefined;
}

/**
 * The empty-thread invitation: the line, and one quiet way into the tour. The
 * tour explains itself once it is open, so nothing explains it here. Until a
 * provider is connected the line is an offer nothing can answer, so the way to
 * a model is named here rather than hidden behind a failed send.
 */
export function ProofDemoPrompt(props: ColdStartPromptProps): React.JSX.Element {
  return (
    <section className="proof-prompt" aria-labelledby="proof-prompt-title">
      <p className="coldstart-line" id="proof-prompt-title">
        Say anything. It will be kept.
      </p>
      {props.onConnect === undefined ? null : (
        <button type="button" className="ghost coldstart-connect" onClick={props.onConnect}>
          Connect a model →
        </button>
      )}
      <button type="button" className="quiet-link" onClick={props.onOpen} disabled={props.busy}>
        {props.busy ? "opening the proof thread…" : "or open the proof thread →"}
      </button>
      {props.error === undefined ? null : <p className="proof-prompt-error">{props.error}</p>}
    </section>
  );
}

/** A durable proof thread keeps an explicit way back into its guided receipts. */
export function ProofDemoReentry(props: ProofDemoPromptProps): React.JSX.Element {
  return (
    <section className="proof-reentry" aria-label="Proof tour">
      <button type="button" className="quiet-link" onClick={props.onOpen} disabled={props.busy}>
        {props.busy ? "opening the proof tour…" : "open the proof tour →"}
      </button>
      {props.error === undefined ? null : <p className="proof-prompt-error">{props.error}</p>}
    </section>
  );
}

/** The server marks the scripted proof with a provider id ordinary threads never receive. */
export function isProofDemoThread(stats: ThreadStats | undefined): boolean {
  return stats?.models.includes("pylos-proof-demo") === true;
}

export interface ProofTourProps {
  summary: DemoSummary;
  onClose: () => void;
}

export interface ProofCollectionReceiptView {
  verified: boolean;
  required: number;
  located: number;
  supported: number;
  unresolved: number;
  completeness: string;
  sources: DemoSummary["proof"]["collection"]["sources"];
  answer: string;
}

/**
 * Keep the two collection cards on one receipt-derived view. A malformed or
 * stale proof summary must not turn filler into a confirmed source or render
 * an UNKNOWN answer beside complete counts.
 */
export function proofCollectionReceipt(summary: DemoSummary): ProofCollectionReceiptView {
  const collection = summary.proof.collection;
  const coverage = collection.coverage;
  const sources = collection.sources;
  const required = coverage?.required ?? collection.required;
  const located = coverage?.located ?? collection.located;
  const supported = coverage?.supported ?? collection.supported;
  const unresolved = coverage?.unresolved ?? Math.max(0, required - supported);
  const completeness = coverage?.completeness ?? collection.completeness;
  const sourceTexts = sources.map((source) => source.text);
  const validSourceSet =
    sources.length === 10 &&
    new Set(sourceTexts).size === 10 &&
    sources.every((source) => source.text.startsWith("Launch note:"));
  const verified =
    coverage !== undefined &&
    required === 11 &&
    located === 10 &&
    supported === 10 &&
    unresolved === 1 &&
    completeness === "incomplete" &&
    validSourceSet &&
    summary.final.answerReceipt?.status === "released" &&
    !summary.final.answer.includes("UNKNOWN");
  return {
    verified,
    required,
    located,
    supported,
    unresolved,
    completeness,
    sources: verified ? sources : [],
    answer: verified
      ? summary.final.answer
      : "The proof answer is withheld because its receipt is inconsistent.",
  };
}

export interface ArchivePullSource {
  seq: number;
  text: string;
  href: string;
  distanceFromQuestion: number;
  position: number;
  lane: number;
}

export interface ArchivePullModel {
  totalTurns: number;
  questionSeq: number;
  newestSourceSeq: number | undefined;
  distanceFromNewestSource: number | undefined;
  requested: number;
  exactSources: number;
  unresolved: number;
  viewTokens: number | undefined;
  viewBudget: number | undefined;
  packetPages: number;
  sources: ArchivePullSource[];
}

/** Geometry constants shared by the projection oracle and the responsive map. */
export const ARCHIVE_PULL_TRACK_MIN_WIDTH = 640;
export const ARCHIVE_PULL_SOURCE_HIT_SIZE = 22;
export const ARCHIVE_PULL_LANE_COUNT = 4;
export const ARCHIVE_PULL_LANE_STEP = 26;

/**
 * Project the verified collection receipt into the archive-map coordinates.
 * The projection is intentionally fail-closed: an inconsistent receipt gets
 * no source dots, so the map cannot invent the missing eleventh note.
 */
export function archivePullModel(summary: DemoSummary): ArchivePullModel {
  const receipt = proofCollectionReceipt(summary);
  const totalTurns =
    Number.isSafeInteger(summary.thread.turns) && summary.thread.turns > 0 ? summary.thread.turns : 0;
  const questionSeq =
    Number.isSafeInteger(summary.final.questionSeq) && summary.final.questionSeq > 0
      ? summary.final.questionSeq
      : summary.proof.collection.questionSeq;
  const sourceSeqs = new Set<number>();
  const sourceHrefs = new Set<string>();
  const sourceBindings =
    receipt.verified &&
    receipt.sources.every(
      (source) =>
        Number.isSafeInteger(source.seq) &&
        source.seq > 0 &&
        source.href.length > 0 &&
        !sourceSeqs.has(source.seq) &&
        sourceSeqs.add(source.seq) &&
        !sourceHrefs.has(source.href) &&
        sourceHrefs.add(source.href),
    )
      ? receipt.sources
      : [];
  const trackWidth = 96;
  const laneCount = Math.min(
    ARCHIVE_PULL_LANE_COUNT,
    Math.max(1, Math.ceil(Math.sqrt(sourceBindings.length))),
  );
  const sources = sourceBindings.map((source, index) => ({
    seq: source.seq,
    text: source.text,
    href: source.href,
    distanceFromQuestion: questionSeq - source.seq,
    position: totalTurns === 0 ? 0 : Math.min(98, Math.max(2, 2 + (source.seq / totalTurns) * trackWidth)),
    lane: index % laneCount,
  }));
  const newestSourceSeq = sources.reduce<number | undefined>(
    (newest, source) => (newest === undefined || source.seq > newest ? source.seq : newest),
    undefined,
  );
  return {
    totalTurns,
    questionSeq,
    newestSourceSeq,
    distanceFromNewestSource: newestSourceSeq === undefined ? undefined : questionSeq - newestSourceSeq,
    requested: receipt.verified ? receipt.required : 0,
    exactSources: sources.length,
    unresolved: receipt.verified ? receipt.unresolved : 0,
    viewTokens: summary.thread.lastPacket?.tokens,
    viewBudget: summary.thread.lastPacket?.budget,
    packetPages: Array.isArray(summary.final.pages) ? summary.final.pages.length : 0,
    sources,
  };
}

type EvidenceViewerState =
  | { status: "idle" }
  | { status: "loading"; label: string; href: string }
  | { status: "loaded"; label: string; href: string; resource: EvidenceResource }
  | { status: "error"; label: string; href: string; message: string }
  | { status: "exact-loading"; label: string; href: string }
  | { status: "exact-loaded"; label: string; href: string; receipt: ExactTailVerification }
  | { status: "exact-error"; label: string; href: string; message: string };

/**
 * A short guided reading of the durable demo summary. Every value in this
 * component comes from DemoSummary or one of its packet/page receipts; the UI
 * deliberately does not manufacture a success count or a witness.
 */
export function ProofTour({ summary, onClose }: ProofTourProps): React.JSX.Element {
  const { proof } = summary;
  const collection = proof.collection.coverage;
  const invalidation = proof.invalidation.page;
  const tail = proof.attachment.page;
  const collectionReceipt = proofCollectionReceipt(summary);
  const archivePull = archivePullModel(summary);
  const finalStatus = collectionReceipt.verified ? proofFinalStatus(summary) : "missing";
  const locatorCount = collection?.routes.length ?? 0;
  const lastPacket = summary.thread.lastPacket;
  const [chainCheck, setChainCheck] = useState<ChainCheckState>({ status: "idle" });
  const [evidence, setEvidence] = useState<EvidenceViewerState>({ status: "idle" });
  const [archiveTurnInput, setArchiveTurnInput] = useState("");
  const [archiveTurnError, setArchiveTurnError] = useState<string | undefined>();
  const evidenceRequest = useRef(0);
  const checkChain = useCallback((): void => {
    if (chainCheck.status === "checking") return;
    setChainCheck({ status: "checking" });
    void api
      .verify(summary.thread.threadId)
      .then((result) => setChainCheck({ status: "checked", result }))
      .catch((cause: unknown) =>
        setChainCheck({
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        }),
      );
  }, [chainCheck.status, summary.thread.threadId]);
  const openEvidence = useCallback((label: string, href: string): void => {
    const requestId = evidenceRequest.current + 1;
    evidenceRequest.current = requestId;
    setEvidence({ status: "loading", label, href });
    void api
      .demoEvidence(href)
      .then((resource) => {
        if (evidenceRequest.current !== requestId) return;
        setEvidence({ status: "loaded", label, href, resource });
      })
      .catch((cause: unknown) => {
        if (evidenceRequest.current !== requestId) return;
        setEvidence({
          status: "error",
          label,
          href,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
  }, []);
  const openExactTail = useCallback((): void => {
    const label = "Open exact tail receipt";
    const containingSpanHref = proof.attachment.links.span;
    const receiptHref = focusedReceiptHref(proof.attachment.links) ?? containingSpanHref;
    const requestedRange: [number, number] = [proof.attachment.tail.from, proof.attachment.tail.to];
    const expectedHash = proof.attachment.tail.hash;
    const requestId = evidenceRequest.current + 1;
    evidenceRequest.current = requestId;
    if (containingSpanHref === undefined) {
      setEvidence({
        status: "exact-error",
        label,
        href: receiptHref ?? "",
        message: "The containing-span evidence link is unavailable; the exact tail is withheld.",
      });
      return;
    }
    setEvidence({ status: "exact-loading", label, href: receiptHref ?? containingSpanHref });
    void api
      .demoEvidence(containingSpanHref)
      .then((resource) => verifyExactTail(resource, requestedRange, expectedHash))
      .then((receipt) => {
        if (evidenceRequest.current !== requestId) return;
        setEvidence({ status: "exact-loaded", label, href: receiptHref ?? containingSpanHref, receipt });
      })
      .catch((cause: unknown) => {
        if (evidenceRequest.current !== requestId) return;
        setEvidence({
          status: "exact-error",
          label,
          href: receiptHref ?? containingSpanHref,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
  }, [
    proof.attachment.links.span,
    proof.attachment.tail.from,
    proof.attachment.tail.hash,
    proof.attachment.tail.to,
    proof.attachment.links,
  ]);
  const closeEvidence = useCallback((): void => {
    evidenceRequest.current += 1;
    setEvidence({ status: "idle" });
  }, []);

  return (
    <section className="proof-tour" aria-labelledby="proof-tour-title">
      <div className="proof-tour-head">
        <div>
          <p className="mono">one-minute archive proof</p>
          <h2 id="proof-tour-title">The proof thread</h2>
          <p>
            Five moments from one scripted proof thread: what changed, what was found, what was deleted, the
            exact tail of a stored file, and what the archive could still support. Its receipts are read from
            stored kernel state; it is not a model-quality claim.
          </p>
          <p className="proof-evidence-orientation">
            The useful surprise is custody, not eloquence: each card ties a human sentence to a durable row,
            byte range, or hash. Select any linked receipt, linked source, route, or attachment span to see
            the bounded evidence without leaving this tour; a deleted source opens its removal receipt instead
            of a dead link. Once a receipt is open, use “Inspect bounded JSON” in this panel.
          </p>
        </div>
        <button type="button" className="ghost" onClick={onClose}>
          Close tour
        </button>
      </div>

      <EvidenceViewer state={evidence} onClose={closeEvidence} />

      <section className="proof-overview" aria-labelledby="proof-overview-title">
        <div className="proof-overview-head">
          <p className="mono" id="proof-overview-title">
            what this thread actually did
          </p>
          <span className="proof-scripted-label">scripted zero-model fixture</span>
        </div>
        <div className="proof-scale-grid">
          <ScaleMetric label="turns in this thread" value={groupedNumber(summary.thread.turns)} />
          <ScaleMetric
            label="last view / limit"
            value={
              lastPacket === undefined
                ? "not recorded"
                : `${groupedNumber(lastPacket.tokens)} / ${groupedNumber(lastPacket.budget)} tokens`
            }
          />
          <ScaleMetric
            label="archive checked through"
            value={
              summary.thread.verifiedTo === undefined
                ? "not verified"
                : `#${groupedNumber(summary.thread.verifiedTo)}`
            }
          />
          <ScaleMetric label="bytes kept" value={groupedNumber(summary.thread.archiveBytes)} />
          <ScaleMetric label="compressed summaries" value={groupedNumber(summary.thread.capsules)} />
          <ScaleMetric label="archive omissions · loss ledger" value={groupedNumber(summary.thread.losses)} />
        </div>
        <p className="proof-scale-note">
          These numbers belong to this proof thread. Separately, a locally retained million-turn export and
          restore proof writes <span className="num">1,000,000</span> synthetic turns out to a file, reads
          them back, and verifies the hash chain end to end; that finite benchmark is separate evidence, not
          this thread or a current hosted-release claim.
        </p>
        <p className="proof-scale-note">
          <strong>Archive omissions</strong> is the durable loss-ledger count recorded across this thread’s
          compaction history. It is not a count of unresolved proof cards: the collection card has its own
          receipt (<span className="num">11</span> requested, <span className="num">10</span> located,{" "}
          <span className="num">1</span> unresolved), and the five cards remain independently inspectable.
        </p>
        <p className="proof-scale-note">
          In plain terms, this finite fixture keeps{" "}
          <span className="num">{(summary.thread.archiveBytes / (1024 * 1024)).toFixed(1)} MB</span> across{" "}
          <span className="num">{groupedNumber(summary.thread.turns)}</span> turns while the last bounded view
          used{" "}
          {lastPacket === undefined ? (
            "an unrecorded token budget"
          ) : (
            <span className="num">
              {groupedNumber(lastPacket.tokens)} of {groupedNumber(lastPacket.budget)} tokens
            </span>
          )}
          . That is a small, receipt-backed view over a larger archive—not a universal recall claim.
        </p>
        <ChainCheck
          check={checkChain}
          state={chainCheck}
          turns={summary.thread.turns}
          recordedTo={summary.thread.verifiedTo}
          recordedHeadHash={summary.thread.headHash}
        />
        <ArchiveTurnChooser
          threadId={summary.thread.threadId}
          maxSeq={summary.thread.turns}
          input={archiveTurnInput}
          error={archiveTurnError}
          onInput={setArchiveTurnInput}
          onError={setArchiveTurnError}
          onOpen={openEvidence}
        />
        <InspectEvidence>
          <ReceiptLine label="thread id" value={summary.thread.threadId} />
          <ReceiptLine label="head hash" value={summary.thread.headHash} />
          <ReceiptLine label="last packet digest" value={lastPacket?.digest ?? "not recorded"} />
          <ReceiptLine
            label="archive omissions scope"
            value="loss-ledger rows across this thread; separate from proof-card coverage"
          />
        </InspectEvidence>
      </section>

      <div className="proof-steps">
        <ProofStep number="01" title="I changed my place, and the answer changed" tone="good">
          <p>The archive keeps both statements. The current answer uses the newer one.</p>
          <div className="proof-quote-pair">
            <blockquote>
              <span className="proof-quote-label">Original</span>
              {proof.correctedFact.originalText}
            </blockquote>
            <span className="proof-quote-arrow" aria-hidden="true">
              →
            </span>
            <blockquote>
              <span className="proof-quote-label">Current</span>
              {proof.correctedFact.currentText}
            </blockquote>
          </div>
          <ReceiptLine label="answer shown" value={proof.correctedFact.grounded.answer} />
          <ReceiptLinks
            links={[
              {
                label: "Open historical statement",
                href: proofEpisodeHref(summary.thread.threadId, proof.correctedFact.originalSeq),
              },
              { label: "Open current statement", href: proof.correctedFact.currentWitness.href },
              {
                label: "Open focused receipt",
                href: focusedReceiptHref(proof.correctedFact.grounded.links),
              },
              { label: "Open how it was found", href: proof.correctedFact.grounded.links.route },
            ]}
            onOpen={openEvidence}
          />
          <InspectEvidence>
            <ReceiptLine
              label="historical source"
              value={`episode #${groupedNumber(proof.correctedFact.originalSeq)}`}
            />
            <ReceiptLine
              label="current source"
              value={`episode #${groupedNumber(proof.correctedFact.correctionSeq)}`}
            />
            <ReceiptLine label="address route" value={shortHash(proof.correctedFact.routeId)} />
            <ReceiptLine label="current witness" value={formatWitness(proof.correctedFact.currentWitness)} />
            <ReceiptLine
              label="grounded answer episode"
              value={proof.correctedFact.grounded.links.answerEpisode}
            />
            <ReceiptLinks
              links={[{ label: "Open raw packet", href: proof.correctedFact.grounded.links.packet }]}
              onOpen={openEvidence}
            />
          </InspectEvidence>
        </ProofStep>

        <ProofStep number="02" title="I asked for 11 notes; 10 were found" tone="warn">
          {collectionReceipt.verified ? (
            <p>
              Asked for <span className="proof-value">{groupedNumber(collectionReceipt.required)}</span>{" "}
              launch notes, the archive found{" "}
              <span className="proof-value">{groupedNumber(collectionReceipt.located)}</span>. One is still
              missing, so this answer does not say all 11 exist.
            </p>
          ) : (
            <p className="proof-prompt-error" role="alert">
              The proof receipt is inconsistent; counts and source claims are withheld.
            </p>
          )}
          <ReceiptLine
            label="confirmed sources"
            value={collectionReceipt.verified ? groupedNumber(collectionReceipt.supported) : "withheld"}
          />
          <ReceiptLine
            label="older sources"
            value={collectionReceipt.verified ? groupedNumber(collection?.historical ?? 0) : "withheld"}
          />
          <ReceiptLine
            label="source pointers"
            value={collectionReceipt.verified ? groupedNumber(locatorCount) : "withheld"}
          />
          <ReceiptLine
            label="all 11 confirmed?"
            value={collectionReceipt.verified ? collectionReceipt.completeness : "withheld"}
          />
          <ReceiptLine label="what it says" value={collectionReceipt.answer} />
          <ReceiptLinks
            links={[
              { label: "Open focused receipt", href: focusedReceiptHref(proof.collection.links) },
              { label: "Open collection question", href: proof.collection.links.questionEpisode },
            ]}
            onOpen={openEvidence}
          />
          {collectionReceipt.verified ? (
            <>
              <p className="proof-source-intro">
                {groupedNumber(collectionReceipt.sources.length)} recovered source texts, shown exactly as
                retained:
              </p>
              <ol className="proof-source-list">
                {collectionReceipt.sources.map((source, index) => (
                  <li key={source.href}>
                    <span className="proof-source-label">Launch note {index + 1}</span>
                    <span>{source.text}</span>
                    <EvidenceLink
                      label={`Open note ${index + 1} · #${groupedNumber(source.seq)}`}
                      ariaLabel={`Open launch note ${index + 1}, episode #${groupedNumber(source.seq)}`}
                      href={source.href}
                      onOpen={openEvidence}
                    />
                  </li>
                ))}
              </ol>
              <ArchivePullMap model={archivePull} onOpen={openEvidence} />
            </>
          ) : null}
          <InspectEvidence>
            <ReceiptLine label="collection query" value={proof.collection.query} />
            <ReceiptLine
              label="question sequence"
              value={`#${groupedNumber(proof.collection.questionSeq)}`}
            />
            <ReceiptLine
              label="coverage digest"
              value={collectionReceipt.verified ? (collection?.digest ?? "not recorded") : "withheld"}
            />
            {collectionReceipt.verified
              ? collection?.routes.map((route, index) => (
                  <ReceiptLine
                    key={route.digest}
                    label={`locator ${index + 1}`}
                    value={formatCoverageRoute(route)}
                  />
                ))
              : null}
            <ReceiptLinks
              links={[{ label: "Open raw packet", href: proof.collection.links.packet }]}
              onOpen={openEvidence}
            />
          </InspectEvidence>
        </ProofStep>

        <ProofStep number="03" title="After deletion, the answer says it cannot verify" tone="warn">
          <p>
            Before deletion, the archive could answer this question. After deletion, it says what it can no
            longer check instead of keeping a stale answer.
          </p>
          <p className="proof-sub-label">Before deletion · released answer (assistant history)</p>
          <blockquote className="proof-quote-single">{proof.invalidation.grounded.answer}</blockquote>
          <p className="proof-sub-label">After deletion · user source now</p>
          <p className="proof-tombstone">
            Source bytes are gone by user request; the archive keeps an explicit tombstone.
          </p>
          <p className="proof-sub-label">After deletion · same question</p>
          <blockquote className="proof-quote-single">{proof.invalidation.repeated.answer}</blockquote>
          <ReceiptLine label="answer status" value="cannot verify after deletion" />
          <ReceiptLinks
            links={[
              { label: "Open tombstone receipt", href: proof.invalidation.sourceHref },
              {
                label: "Open focused receipt before deletion",
                href: focusedReceiptHref(proof.invalidation.grounded.links),
              },
              {
                label: "Open focused receipt after deletion",
                href: focusedReceiptHref(proof.invalidation.repeated.links),
              },
              { label: "Open the changed route", href: proof.invalidation.repeated.links.route },
            ]}
            onOpen={openEvidence}
          />
          <InspectEvidence>
            <ReceiptLine label="query" value={proof.invalidation.grounded.query} />
            <ReceiptLine label="source tombstone" value={proof.invalidation.sourceText} />
            <ReceiptLine
              label="removal receipt"
              value={`${proof.invalidation.sourceReceipt.status} · source bytes unavailable`}
            />
            <ReceiptLine
              label="tombstone id"
              value={proof.invalidation.sourceReceipt.tombstoneId ?? "recorded · id withheld"}
            />
            <ReceiptLine
              label="original content hash"
              value={proof.invalidation.sourceReceipt.originalContentHash}
            />
            <ReceiptLine
              label="forgotten source"
              value={`episode #${groupedNumber(proof.invalidation.sourceSeq)}`}
            />
            <ReceiptLine label="route" value={shortHash(proof.invalidation.routeId)} />
            <ReceiptLine label="page" value={formatPage(invalidation)} />
            <ReceiptLinks
              links={[
                { label: "Open raw packet before deletion", href: proof.invalidation.grounded.links.packet },
                { label: "Open raw packet after deletion", href: proof.invalidation.repeated.links.packet },
              ]}
              onOpen={openEvidence}
            />
          </InspectEvidence>
        </ProofStep>

        <ProofStep number="04" title="A large file still gives back its tail" tone="good">
          <p>
            The end of <span className="proof-value">{proof.attachment.name}</span> comes back from the stored
            file, even though the file was split into pieces.
          </p>
          <p className="proof-tail-marker">
            <span className="proof-tail-marker-label">requested tail marker · </span>
            {proof.attachment.tail.marker}
          </p>
          <p className="proof-scale-note">
            The requested tail is a smaller, exact byte range inside the final manifest span. The tail hash
            covers only the requested bytes; the hash of the containing manifest span covers the full chunk.
            The marker above is the requested-tail exhibit. The viewer separately shows a bounded tail window
            from the containing span, which is not the requested range unless the receipt says the ranges
            match; no full file is exposed.
          </p>
          <ReceiptLine label="stored pieces" value={groupedNumber(proof.attachment.spans)} />
          <ReceiptLinks
            links={[
              { label: "Open stored file", href: proof.attachment.links.attachment },
              { label: "Open containing-span tail", href: proof.attachment.links.span },
              {
                label: "Open exact tail receipt",
                href: focusedReceiptHref(proof.attachment.links) ?? proof.attachment.links.span,
                onClick: openExactTail,
              },
            ]}
            onOpen={openEvidence}
          />
          <InspectEvidence>
            <ReceiptLine label="manifest" value={shortHash(proof.attachment.manifestId)} />
            <ReceiptLine
              label="requested tail range"
              value={`${String(proof.attachment.tail.from)}–${String(proof.attachment.tail.to)}`}
            />
            <ReceiptLine label="requested tail hash" value={proof.attachment.tail.hash} />
            <ReceiptLine label="tail page" value={formatPage(tail)} />
            <ReceiptLine label="attachment packet" value={proof.attachment.links.packet} />
          </InspectEvidence>
        </ProofStep>

        <ProofStep
          number="05"
          title="The answer is released only with evidence"
          tone={finalStatus === "released" ? "good" : "warn"}
        >
          <p>
            The archive checked the answer before releasing it. Its status is{" "}
            <span className="proof-value">{finalStatus}</span>; the note count is still incomplete.
          </p>
          <p>
            Released means the exact partial sentence below is supported by its receipt. It does not mean all
            11 launch notes exist.
          </p>
          <blockquote className="proof-quote-single">{collectionReceipt.answer}</blockquote>
          <ReceiptLine label="answer status" value={finalStatus} />
          <ReceiptLinks
            links={[
              { label: "Open focused receipt", href: focusedReceiptHref(summary.final.links) },
              { label: "Open final answer episode", href: summary.final.links.answerEpisode },
            ]}
            onOpen={openEvidence}
          />
          <InspectEvidence>
            <ReceiptLine label="answer receipt" value={formatAnswerReceipt(summary)} />
            <ReceiptLine label="final packet id" value={summary.final.packetId} />
            <ReceiptLine label="final answer episode" value={`#${groupedNumber(summary.final.answerSeq)}`} />
            <ReceiptLinks
              links={[{ label: "Open raw packet", href: summary.final.links.packet }]}
              onOpen={openEvidence}
            />
          </InspectEvidence>
        </ProofStep>
      </div>

      <div className="proof-tour-foot">
        <span className="receipt-muted">
          The notes question is exchange #{groupedNumber(proof.collection.questionSeq)} · this thread contains{" "}
          {groupedNumber(summary.thread.turns)} turns.
        </span>
        <button type="button" className="pill" onClick={onClose}>
          Continue in the thread
        </button>
      </div>
    </section>
  );
}

type ChainCheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "checked"; result: ChainCheckResult }
  | { status: "error"; message: string };

interface ChainCheckResult {
  ok: boolean;
  headHash: string;
  checkedTo: number;
}

function ChainCheck({
  check,
  state,
  turns,
  recordedTo,
  recordedHeadHash,
}: {
  check: () => void;
  state: ChainCheckState;
  turns: number;
  recordedTo: number | undefined;
  recordedHeadHash: string;
}): React.JSX.Element {
  const label = recordedTo === undefined ? "Check" : "Re-check";
  const result = state.status === "checked" ? state.result : undefined;
  const matchesRecordedHead = result !== undefined && result.headHash === recordedHeadHash;
  return (
    <div className="proof-chain-check">
      <div className="proof-chain-copy">
        <p className="proof-chain-title">Live hash-chain check</p>
        <p>
          {recordedTo === undefined
            ? "Run the archive check across this thread."
            : `The summary already checked through #${groupedNumber(recordedTo)}. Run it again against the live archive.`}{" "}
          This checks the hash chain only; it does not verify meaning or model answers.
        </p>
      </div>
      <button
        type="button"
        className="pill proof-chain-button"
        onClick={check}
        disabled={state.status === "checking"}
        aria-busy={state.status === "checking"}
      >
        {state.status === "checking" ? "Checking…" : `${label} all ${groupedNumber(turns)} archived turns`}
      </button>
      {result !== undefined ? (
        <p
          className="proof-chain-status"
          data-status={result.ok && matchesRecordedHead ? "verified" : "mismatch"}
        >
          {result.ok && matchesRecordedHead
            ? `Chain checked through #${groupedNumber(result.checkedTo)} · head hash matches · ${shortHash(result.headHash)}`
            : `Hash-chain check reported a mismatch through #${groupedNumber(result.checkedTo)} · head ${shortHash(result.headHash)}`}
        </p>
      ) : state.status === "idle" ? (
        <p className="proof-chain-status" data-status="idle">
          Not rechecked this session
          {recordedTo === undefined
            ? " · no recorded summary check"
            : ` · summary records a check through #${groupedNumber(recordedTo)}`}
        </p>
      ) : null}
      {state.status === "error" ? (
        <p className="proof-chain-status" data-status="error" role="alert">
          Live check failed: {state.message}
        </p>
      ) : null}
    </div>
  );
}

export type ArchiveTurnAddressResult =
  | { ok: true; seq: number; href: string }
  | { ok: false; message: string };

/** Validate a direct sequence address without implying semantic retrieval. */
export function archiveTurnAddress(
  threadId: string,
  rawSeq: string,
  maxSeq: number,
): ArchiveTurnAddressResult {
  const max = Number.isSafeInteger(maxSeq) && maxSeq > 0 ? maxSeq : 0;
  const trimmed = rawSeq.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return { ok: false, message: `Enter a whole turn from 1 to ${groupedNumber(max)}.` };
  }
  const seq = Number(trimmed);
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > max) {
    return { ok: false, message: `Turn must be between 1 and ${groupedNumber(max)}.` };
  }
  return { ok: true, seq, href: proofEpisodeHref(threadId, seq) };
}

function ArchiveTurnChooser({
  threadId,
  maxSeq,
  input,
  error,
  onInput,
  onError,
  onOpen,
}: {
  threadId: string;
  maxSeq: number;
  input: string;
  error: string | undefined;
  onInput: (value: string) => void;
  onError: (value: string | undefined) => void;
  onOpen: (label: string, href: string) => void;
}): React.JSX.Element {
  const inputId = "proof-archive-turn";
  const helpId = "proof-archive-turn-help";
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const address = archiveTurnAddress(threadId, input, maxSeq);
    if (!address.ok) {
      onError(address.message);
      return;
    }
    onError(undefined);
    onOpen(`Open archived turn #${groupedNumber(address.seq)}`, address.href);
  };
  return (
    <section className="proof-archive-turn" aria-labelledby="proof-archive-turn-title">
      <div>
        <p className="mono" id="proof-archive-turn-title">
          direct sequence address
        </p>
        <p className="proof-archive-turn-copy">
          Choose any archived turn 1–{groupedNumber(maxSeq)}. This addresses a recorded sequence in this
          scripted fixture; it is not semantic recall and does not infer meaning.
        </p>
      </div>
      <form className="proof-archive-turn-form" onSubmit={submit}>
        <label htmlFor={inputId}>Choose any archived turn 1–{groupedNumber(maxSeq)}</label>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min="1"
          max={maxSeq}
          step="1"
          value={input}
          aria-describedby={helpId}
          onChange={(event) => onInput(event.currentTarget.value)}
        />
        <button type="submit" className="proof-link-button">
          Open exact turn
        </button>
      </form>
      <p className="proof-archive-turn-help" id={helpId}>
        Turn #7 is a removed-source example; opening it shows its tombstone receipt instead of source bytes.
      </p>
      {error === undefined ? null : (
        <p className="proof-evidence-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function ArchivePullMap({
  model,
  onOpen,
}: {
  model: ArchivePullModel;
  onOpen: (label: string, href: string) => void;
}): React.JSX.Element {
  const questionPosition =
    model.totalTurns === 0 ? 98 : Math.min(98, Math.max(2, 2 + (model.questionSeq / model.totalTurns) * 96));
  const newestLabel =
    model.newestSourceSeq === undefined ? "no retained source" : `#${groupedNumber(model.newestSourceSeq)}`;
  const distanceLabel =
    model.distanceFromNewestSource === undefined
      ? "distance unavailable"
      : `${groupedNumber(model.distanceFromNewestSource)} turns before question`;
  return (
    <section className="archive-pull-map" aria-labelledby="archive-pull-title">
      <div className="archive-pull-head">
        <div>
          <p className="mono">collection routes / source bindings</p>
          <h4 id="archive-pull-title">{distanceLabel.replace(" turns before question", "-turn pull")}</h4>
        </div>
        <span className="archive-pull-status">receipt-derived</span>
      </div>
      <p className="archive-pull-copy">
        <span className="num">{groupedNumber(model.exactSources)}</span> exact source bindings sit in the{" "}
        <span className="num">{groupedNumber(model.totalTurns)}</span>-turn archive. The open gap is{" "}
        <span className="num">{groupedNumber(model.unresolved)}</span> unresolved request(s); no unbound
        source is shown, and every dot opens its bounded source in the viewer.
      </p>
      <p className="archive-pull-receipt-summary">
        {groupedNumber(model.requested)} requested / {groupedNumber(model.exactSources)} exact sources /{" "}
        {groupedNumber(model.unresolved)} unresolved ·{" "}
        {model.viewTokens === undefined || model.viewBudget === undefined
          ? "bounded-view context not recorded"
          : `${groupedNumber(model.viewTokens)} / ${groupedNumber(model.viewBudget)} bounded-view context`}
      </p>
      <p className="archive-pull-lane-note">
        Dense source bindings use staggered lanes; their horizontal positions still follow the recorded turn
        sequence.
      </p>
      <div className="archive-pull-metrics">
        <div>
          <span>requested</span>
          <strong>{groupedNumber(model.requested)}</strong>
        </div>
        <div>
          <span>exact sources</span>
          <strong>{groupedNumber(model.exactSources)}</strong>
        </div>
        <div>
          <span>unresolved</span>
          <strong>{groupedNumber(model.unresolved)}</strong>
        </div>
        <div>
          <span>bounded-view context</span>
          <strong>
            {model.viewTokens === undefined || model.viewBudget === undefined
              ? "not recorded"
              : `${groupedNumber(model.viewTokens)} / ${groupedNumber(model.viewBudget)}`}
          </strong>
        </div>
        <div>
          <span>final packet pages</span>
          <strong>{groupedNumber(model.packetPages)}</strong>
        </div>
      </div>
      {model.sources.length === 0 ? (
        <p className="archive-pull-empty" role="alert">
          No exact source bindings are shown because the collection receipt was not verified.
        </p>
      ) : (
        <>
          <div className="archive-pull-track-shell">
            <div className="archive-pull-track">
              <span className="archive-pull-track-line" aria-hidden="true" />
              {model.sources.map((source) => (
                <button
                  key={source.href}
                  type="button"
                  className="archive-pull-source"
                  data-archive-pull-source={source.seq}
                  data-archive-pull-source-href={source.href}
                  data-archive-pull-lane={source.lane}
                  style={{
                    left: `${source.position}%`,
                    top: `${29 + source.lane * ARCHIVE_PULL_LANE_STEP}px`,
                  }}
                  aria-label={`Launch note #${groupedNumber(source.seq)} · exact source binding · ${groupedNumber(source.distanceFromQuestion)} turns before question`}
                  title={`Launch note #${groupedNumber(source.seq)} · ${source.text}`}
                  onClick={() => onOpen(`Open launch note #${groupedNumber(source.seq)}`, source.href)}
                >
                  <span aria-hidden="true" />
                </button>
              ))}
              {model.unresolved > 0 ? (
                <span
                  className="archive-pull-unresolved"
                  data-archive-pull-unresolved="true"
                  style={{ left: `${Math.max(2, questionPosition - 2)}%` }}
                  role="img"
                  aria-label={`${groupedNumber(model.unresolved)} unresolved source request; no source bytes retained`}
                >
                  ?
                </span>
              ) : null}
              <span
                className="archive-pull-question"
                data-archive-pull-question={model.questionSeq}
                style={{ left: `${questionPosition}%` }}
                role="img"
                aria-label={`Final collection question #${groupedNumber(model.questionSeq)}`}
              >
                <span aria-hidden="true">Q</span>
              </span>
            </div>
            <div className="archive-pull-axis" aria-hidden="true">
              <span>oldest retained source</span>
              <span>question #{groupedNumber(model.questionSeq)}</span>
            </div>
          </div>
          <p className="archive-pull-distance">
            Newest exact source <strong>{newestLabel}</strong> → question{" "}
            <span className="num">#{groupedNumber(model.questionSeq)}</span> ·{" "}
            <strong>{groupedNumber(model.distanceFromNewestSource ?? 0)} turns</strong> ·{" "}
            <strong>{groupedNumber(model.totalTurns)} total turns</strong>.
          </p>
        </>
      )}
    </section>
  );
}

function ProofStep({
  number,
  title,
  tone,
  children,
}: {
  number: string;
  title: string;
  tone: "good" | "warn";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <article className="proof-step" data-tone={tone}>
      <div className="proof-step-number" aria-hidden="true">
        {number}
      </div>
      <div className="proof-step-body">
        <h3>{title}</h3>
        {children}
      </div>
    </article>
  );
}

function ReceiptLine({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="proof-receipt-line">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function ScaleMetric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="proof-scale-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReceiptLinks({
  links,
  onOpen,
}: {
  links: Array<{
    label: string;
    href: string | undefined;
    ariaLabel?: string;
    onClick?: () => void;
  }>;
  onOpen?: (label: string, href: string) => void;
}): React.JSX.Element | null {
  const available = links.filter(
    (link): link is { label: string; href: string; ariaLabel?: string; onClick?: () => void } =>
      link.href !== undefined,
  );
  if (available.length === 0) return null;
  return (
    <nav className="proof-links" aria-label="Inspectable receipts">
      {available.map((link) => (
        <EvidenceLink key={link.label + link.href} {...link} onOpen={onOpen} />
      ))}
    </nav>
  );
}

function EvidenceLink({
  label,
  ariaLabel,
  href,
  onOpen,
  onClick,
}: {
  label: string;
  ariaLabel?: string;
  href: string;
  onOpen?: (label: string, href: string) => void;
  onClick?: () => void;
}): React.JSX.Element {
  const action = onClick ?? (onOpen === undefined ? undefined : () => onOpen(label, href));
  if (action === undefined) {
    return (
      <a href={href} aria-label={ariaLabel} data-evidence-href={href}>
        {label} ↗
      </a>
    );
  }
  return (
    <button
      type="button"
      className="proof-link-button"
      aria-label={ariaLabel}
      data-evidence-href={href}
      onClick={action}
    >
      {label} ↗
    </button>
  );
}

export interface EvidencePresentation {
  eyebrow: string;
  title: string;
  summary: string;
  rows: Array<{ label: string; value: string }>;
  body?: { label: string; text: string; kind: "text" | "code" };
  note?: string;
  rawHref: string;
}

export interface ExactTailVerification {
  status: "MATCH" | "MISMATCH";
  requestedRange: [number, number];
  containingSpanRange: [number, number];
  containingSpanHash: string;
  retainedTailRange: [number, number];
  exactByteCount: number;
  expectedHash: string;
  recomputedHash: string;
  exactBytes: Uint8Array;
  displayEncoding: "utf-8" | "base64";
  displayText: string;
  reason?: string;
}

function exactTailFailure(
  requestedRange: [number, number],
  expectedHash: string,
  reason: string,
  containingSpanRange: [number, number] = [0, 0],
  retainedTailRange: [number, number] = [0, 0],
): ExactTailVerification {
  return {
    status: "MISMATCH",
    requestedRange,
    containingSpanRange,
    containingSpanHash: "not available",
    retainedTailRange,
    exactByteCount: 0,
    expectedHash,
    recomputedHash: "not computed",
    exactBytes: new Uint8Array(),
    displayEncoding: "base64",
    displayText: "",
    reason,
  };
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

function exactTailDisplay(
  bytes: Uint8Array,
  encoding: string | undefined,
): { displayEncoding: "utf-8" | "base64"; displayText: string } {
  if (encoding === "utf-8") {
    try {
      return {
        displayEncoding: "utf-8",
        displayText: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      // Fall through to bounded base64 for an invalid UTF-8 span.
    }
  }
  return { displayEncoding: "base64", displayText: bytesToBase64(bytes) };
}

/**
 * Verify the requested tail from the already-bounded containing-span response.
 * The normalizer retains only the final 2048 bytes, so this helper cannot read
 * or accidentally expose the rest of a large attachment.
 */
export async function verifyExactTail(
  resource: EvidenceResource,
  requestedRange: [number, number],
  expectedHash: string,
): Promise<ExactTailVerification> {
  if (
    !Number.isSafeInteger(requestedRange[0]) ||
    !Number.isSafeInteger(requestedRange[1]) ||
    requestedRange[0] < 0 ||
    requestedRange[1] <= requestedRange[0]
  ) {
    return exactTailFailure(requestedRange, expectedHash, "The requested byte range is invalid.");
  }
  if (requestedRange[1] - requestedRange[0] > MAX_EVIDENCE_TAIL_BYTES) {
    return exactTailFailure(
      requestedRange,
      expectedHash,
      `The requested range exceeds the ${groupedNumber(MAX_EVIDENCE_TAIL_BYTES)}-byte exact-tail bound.`,
    );
  }
  if (resource.kind !== "attachment-span") {
    return exactTailFailure(
      requestedRange,
      expectedHash,
      "The containing attachment span response is unavailable.",
    );
  }
  const spanRange: [number, number] = [resource.span.from, resource.span.to];
  const containingSpanHash = resource.span.hash;
  const retainedRange: [number, number] = [resource.tailBytesFrom, resource.tailBytesTo];
  if (requestedRange[0] < spanRange[0] || requestedRange[1] > spanRange[1]) {
    return exactTailFailure(
      requestedRange,
      expectedHash,
      "The requested range is not contained by the manifest span.",
      spanRange,
      retainedRange,
    );
  }
  if (
    resource.tailBytes.byteLength === 0 ||
    retainedRange[1] - retainedRange[0] !== resource.tailBytes.byteLength ||
    retainedRange[0] < spanRange[0] ||
    retainedRange[1] > spanRange[1]
  ) {
    return exactTailFailure(
      requestedRange,
      expectedHash,
      "The bounded containing-span bytes are missing or malformed.",
      spanRange,
      retainedRange,
    );
  }
  if (requestedRange[0] < retainedRange[0] || requestedRange[1] > retainedRange[1]) {
    return exactTailFailure(
      requestedRange,
      expectedHash,
      "The requested range is outside the retained containing-span tail window.",
      spanRange,
      retainedRange,
    );
  }
  const from = requestedRange[0] - retainedRange[0];
  const to = requestedRange[1] - retainedRange[0];
  const exactBytes = resource.tailBytes.slice(from, to);
  if (exactBytes.byteLength !== requestedRange[1] - requestedRange[0]) {
    return exactTailFailure(
      requestedRange,
      expectedHash,
      "The bounded response did not contain every requested byte.",
      spanRange,
      retainedRange,
    );
  }
  const recomputedHash = await sha256Bytes(exactBytes);
  if (recomputedHash !== expectedHash) {
    return {
      status: "MISMATCH",
      requestedRange,
      containingSpanRange: spanRange,
      containingSpanHash,
      retainedTailRange: retainedRange,
      exactByteCount: exactBytes.byteLength,
      expectedHash,
      recomputedHash,
      exactBytes: new Uint8Array(),
      displayEncoding: "base64",
      displayText: "",
      reason: "The recomputed SHA-256 does not match the receipt hash; exact bytes are withheld.",
    };
  }
  const display = exactTailDisplay(exactBytes, resource.span.encoding);
  return {
    status: "MATCH",
    requestedRange,
    containingSpanRange: spanRange,
    containingSpanHash,
    retainedTailRange: retainedRange,
    exactByteCount: exactBytes.byteLength,
    expectedHash,
    recomputedHash,
    exactBytes,
    ...display,
  };
}

export interface ExactTailPresentation {
  status: "MATCH" | "MISMATCH";
  summary: string;
  rows: Array<{ label: string; value: string }>;
  body: { label: string; text: string; kind: "text" | "code" };
  note: string;
}

export function formatExactTailReceipt(receipt: ExactTailVerification): ExactTailPresentation {
  const exactBytes =
    receipt.status === "MATCH"
      ? receipt.displayText
      : "Exact requested bytes withheld until the bounded response and receipt hash agree.";
  return {
    status: receipt.status,
    summary:
      receipt.status === "MATCH"
        ? "The requested bytes were sliced from the bounded span window and matched the receipt."
        : "The exact tail is withheld because the bounded evidence did not pass every containment and hash check.",
    rows: [
      { label: "requested byte range", value: formatByteRange(receipt.requestedRange) },
      { label: "exact byte count", value: groupedNumber(receipt.exactByteCount) },
      { label: "expected SHA-256", value: receipt.expectedHash },
      { label: "recomputed SHA-256", value: receipt.recomputedHash },
      { label: "verification", value: receipt.status },
      { label: "containing manifest span", value: formatByteRange(receipt.containingSpanRange) },
      { label: "containing span SHA-256", value: receipt.containingSpanHash },
      { label: "retained tail window", value: formatByteRange(receipt.retainedTailRange) },
    ],
    body: {
      label:
        receipt.status === "MATCH"
          ? `exact requested bytes · ${receipt.displayEncoding}`
          : "exact requested bytes",
      text: exactBytes,
      kind: receipt.displayEncoding === "utf-8" ? "text" : "code",
    },
    note:
      receipt.status === "MATCH"
        ? "MATCH is a browser recomputation over exactly the requested range, not over the containing manifest span."
        : `MISMATCH · ${receipt.reason ?? "The exact requested bytes are not available."}`,
  };
}

export function ExactTailReceipt({ receipt }: { receipt: ExactTailVerification }): React.JSX.Element {
  const presentation = formatExactTailReceipt(receipt);
  return (
    <div className="proof-tail-verification" data-exact-tail-status={receipt.status}>
      <p className="proof-tail-verification-status">{receipt.status}</p>
      <p className="proof-evidence-summary">{presentation.summary}</p>
      <dl className="proof-evidence-rows">
        {presentation.rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="proof-evidence-body">
        <p className="mono">{presentation.body.label}</p>
        <pre data-kind={presentation.body.kind}>{presentation.body.text}</pre>
      </div>
      <p className="proof-evidence-note">{presentation.note}</p>
    </div>
  );
}

/** Pure, bounded presentation logic shared by the viewer and its oracle tests. */
export function formatEvidenceResource(resource: EvidenceResource): EvidencePresentation {
  switch (resource.kind) {
    case "episode": {
      if (resource.removed) {
        const receipt = resource.removalReceipt;
        return {
          eyebrow: "bounded removal receipt",
          title: `Episode #${groupedNumber(resource.seq)} tombstone`,
          summary: "tombstoned · source bytes unavailable",
          rows: [
            { label: "episode", value: `#${groupedNumber(resource.seq)}` },
            { label: "role", value: resource.role },
            { label: "removal status", value: receipt?.status ?? "tombstoned" },
            { label: "tombstone", value: receipt?.tombstoneId ?? "recorded · id withheld" },
            {
              label: "original content hash",
              value: receipt?.originalContentHash ?? "recorded · hash withheld",
            },
            { label: "source bytes", value: "unavailable by user request" },
            { label: "chain entry hash", value: resource.chainHash },
            { label: "removed", value: "yes · source is unavailable" },
          ],
          body: {
            label: "tombstone statement",
            text: "No source bytes remain. This bounded receipt proves the removal state without recreating the deleted witness.",
            kind: "text",
          },
          note: "This is a bounded removal receipt, not a broken evidence link: the chain row and original content hash remain, while the deleted source bytes do not.",
          rawHref: resource.href,
        };
      }
      const excerpt = compactEpisodeExcerpt(resource);
      return {
        eyebrow: "exact stored source",
        title: `Episode #${groupedNumber(resource.seq)}`,
        summary: `${resource.role}${resource.removed ? " · removed by request" : " · retained"}`,
        rows: [
          { label: "episode", value: `#${groupedNumber(resource.seq)}` },
          { label: "role", value: resource.role },
          { label: "stored bytes", value: groupedNumber(resource.byteLength) },
          ...(resource.locator === undefined
            ? []
            : [
                {
                  label: "source locator",
                  value: `${resource.locator.source} · bytes ${resource.locator.byteRange[0]}–${resource.locator.byteRange[1]} · revision ${shortHash(resource.locator.revision)}`,
                },
              ]),
          { label: "chain entry hash", value: resource.chainHash },
          { label: "removed", value: resource.removed ? "yes · source is unavailable" : "no" },
        ],
        body: { label: excerpt.label, text: excerpt.text, kind: "text" },
        note: excerpt.note,
        rawHref: resource.href,
      };
    }
    case "packet-receipt": {
      const receipt = resource.receipt;
      const coverage = receipt.coverage;
      const answerReceipt = receipt.answerReceipt;
      const attachmentPage = receipt.pages.find((page) => page.trigger === "attachment-tail");
      return {
        eyebrow: "focused packet receipt",
        title: `Exchange #${groupedNumber(receipt.turnSeq)}`,
        summary: `${receipt.status} · ${shortHash(receipt.digest)}`,
        rows: [
          { label: "question", value: `#${groupedNumber(receipt.question.seq)} · ${receipt.question.text}` },
          { label: "answer", value: `#${groupedNumber(receipt.answer.seq)} · ${receipt.answer.text}` },
          {
            label: "pages",
            value: `${groupedNumber(receipt.pageCount)}${receipt.pagesTruncated ? " · truncated" : ""}`,
          },
          { label: "packet locator", value: receipt.rawPacket },
          { label: "coverage", value: formatCoverage(coverage) },
          { label: "answer gate", value: formatAnswerGate(answerReceipt) },
          { label: "classifications", value: formatClassifications(answerReceipt) },
          ...(attachmentPage === undefined
            ? []
            : [
                { label: "attachment page trigger", value: attachmentPage.trigger },
                { label: "requested byte range", value: formatByteRange(attachmentPage.byteRange) },
                {
                  label: "requested tail hash",
                  value: attachmentPage.spanHash ?? "not recorded",
                },
              ]),
        ],
        body: {
          label: "answer text",
          text: receipt.answer.text,
          kind: "text",
        },
        note:
          coverage === undefined
            ? "This packet has no collection obligation. A missing coverage block is not evidence that a collection was complete."
            : "Coverage counts are the routes this packet actually ran; they do not establish an unknown total.",
        rawHref: resource.href,
      };
    }
    case "route": {
      const route = resource.route;
      const witnessLines =
        route.witnesses.length === 0
          ? "No current witness."
          : route.witnesses
              .map(
                (witness) =>
                  `${witness.authority} · ${witness.source} · bytes ${witness.byteRange[0]}–${witness.byteRange[1]} · ${shortHash(witness.contentHash)}`,
              )
              .join("\n");
      return {
        eyebrow: "address route",
        title: "Question → evidence address",
        summary: `${route.effectiveStatus} now · stored row ${route.storedStatus}`,
        rows: [
          { label: "route id", value: route.id },
          { label: "effective status", value: route.effectiveStatus },
          { label: "stored status", value: route.storedStatus },
          { label: "route digest", value: route.routeDigest },
          { label: "question", value: `#${groupedNumber(route.questionSeq)} · ${route.normalizedQuery}` },
          { label: "as of", value: `#${groupedNumber(route.asOfSeq)}` },
          {
            label: "lineage",
            value:
              route.closesRouteId === undefined
                ? route.closedByRouteId === undefined
                  ? "no later closure event recorded"
                  : `closed by event ${route.closedByRouteId}`
                : `closure event closes ${route.closesRouteId}`,
          },
        ],
        body: { label: "witnesses · authority matters", text: witnessLines, kind: "code" },
        note:
          route.effectiveStatus === "active"
            ? "The route is currently active; its witness is an address, not authority to invent facts."
            : "This route is no longer effective. The immutable stored row remains visible, with its closing lineage.",
        rawHref: resource.href,
      };
    }
    case "attachment-span":
      return {
        eyebrow: "byte-exact attachment span",
        title: `${resource.manifest.name} · span ${groupedNumber(resource.ordinal)}`,
        summary: `${resource.span.state} · ${resource.excerptTruncated ? "bounded containing-span tail window" : "containing-span window"}`,
        rows: [
          { label: "manifest", value: resource.manifestId },
          { label: "containing manifest span range", value: `${resource.span.from}–${resource.span.to}` },
          { label: "declared bytes", value: groupedNumber(resource.byteLength) },
          { label: "excerpt bytes", value: groupedNumber(resource.excerptBytes) },
          { label: "containing manifest span hash", value: resource.span.hash },
          { label: "containing-span tail window", value: resource.excerpt },
          { label: "span content digest", value: resource.digest },
          { label: "span state", value: resource.span.state },
          { label: "encoding", value: resource.span.encoding ?? "binary / unspecified" },
        ],
        body: { label: "containing-span tail window", text: resource.excerpt, kind: "text" },
        note: `The containing manifest span is ${resource.span.from}–${resource.span.to}. This viewer decodes only its final ${groupedNumber(Math.min(resource.byteLength, resource.excerptBytes))} bytes. That containing-span window is not the requested tail range; the proof card and receipt bind the requested range and hash separately.`,
        rawHref: resource.href,
      };
    case "packet":
      return {
        eyebrow: "raw packet · bounded preview",
        title: `Packet ${shortHash(resource.id)}`,
        summary: `${resource.status} · exchange #${groupedNumber(resource.turnSeq)}`,
        rows: [
          { label: "packet digest", value: resource.digest },
          { label: "pages", value: groupedNumber(resource.pageCount) },
          { label: "coverage", value: formatCoverage(resource.coverage) },
          { label: "answer gate", value: formatAnswerGate(resource.answerReceipt) },
          { label: "classifications", value: formatClassifications(resource.answerReceipt) },
        ],
        body: { label: "bounded packet preview", text: resource.preview, kind: "code" },
        note: "The raw packet is intentionally summarized here; the proof tour keeps large provider views out of the narrative.",
        rawHref: resource.href,
      };
    case "json":
      return {
        eyebrow: "evidence response",
        title: "Bounded API preview",
        summary:
          resource.fields.length === 0 ? "non-object response" : `${resource.fields.length} fields shown`,
        rows: [{ label: "fields", value: resource.fields.join(", ") || "none" }],
        body: { label: "bounded JSON", text: resource.preview, kind: "code" },
        note: "This fallback is capped. The response may contain more fields than the viewer renders.",
        rawHref: resource.href,
      };
  }
}

function formatCoverage(coverage: DemoPacketCoverage | undefined): string {
  if (coverage === undefined) return "no collection block";
  const unresolved = coverage.unresolved === undefined ? "?" : String(coverage.unresolved);
  const required = coverage.required === undefined ? "unknown" : String(coverage.required);
  return `located ${coverage.located} · supported ${coverage.supported} · historical ${coverage.historical} · unresolved ${unresolved} · required ${required} · ${coverage.completeness}`;
}

function formatAnswerGate(answerReceipt: Pick<DemoAnswerReceipt, "status" | "digest"> | undefined): string {
  if (answerReceipt === undefined) return "no answer receipt";
  return `${answerReceipt.status} · ${shortHash(answerReceipt.digest)}`;
}

function formatClassifications(answerReceipt: DemoAnswerReceipt | undefined): string {
  if (answerReceipt === undefined || answerReceipt.classifications.length === 0) return "none recorded";
  return answerReceipt.classifications
    .map((entry) => {
      const basis =
        entry.basis === undefined
          ? ""
          : ` · basis ${entry.basis.metric} ${entry.basis.value} · ${shortHash(entry.basis.digest)}`;
      const witness =
        entry.witness === undefined
          ? ""
          : ` · witness ${entry.witness.source}:${entry.witness.from}–${entry.witness.to}`;
      return `${entry.classification} ${entry.kind}${basis}${witness}`;
    })
    .join("; ");
}

function EvidenceViewer({
  state,
  onClose,
}: {
  state: EvidenceViewerState;
  onClose: () => void;
}): React.JSX.Element | null {
  if (state.status === "idle") return null;
  if (state.status === "exact-loading") {
    return (
      <aside className="proof-evidence-viewer" aria-live="polite" aria-busy="true" data-kind="exact-tail">
        <div className="proof-evidence-head">
          <div>
            <p className="mono">checking exact tail receipt</p>
            <h3>{state.label}</h3>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="proof-evidence-loading">Slicing the bounded span window and recomputing SHA-256…</p>
      </aside>
    );
  }
  if (state.status === "exact-error") {
    return (
      <aside className="proof-evidence-viewer" aria-live="polite" data-kind="exact-tail" data-status="error">
        <div className="proof-evidence-head">
          <div>
            <p className="mono">exact tail unavailable</p>
            <h3>{state.label}</h3>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="proof-evidence-error" role="alert">
          {state.message}
        </p>
        {state.href.length === 0 ? null : <RawEvidencePanel href={state.href} />}
      </aside>
    );
  }
  if (state.status === "exact-loaded") {
    return (
      <aside className="proof-evidence-viewer" aria-live="polite" data-kind="exact-tail">
        <div className="proof-evidence-head">
          <div>
            <p className="mono">exact tail receipt</p>
            <h3>{state.label}</h3>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Close evidence
          </button>
        </div>
        <ExactTailReceipt receipt={state.receipt} />
        <RawEvidencePanel href={state.href} />
      </aside>
    );
  }
  if (state.status === "loading") {
    return (
      <aside className="proof-evidence-viewer" aria-live="polite" aria-busy="true">
        <div className="proof-evidence-head">
          <div>
            <p className="mono">opening stored evidence</p>
            <h3>{state.label}</h3>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="proof-evidence-loading">Reading the existing receipt…</p>
      </aside>
    );
  }
  const label = state.label;
  const href = state.href;
  if (state.status === "error") {
    return (
      <aside className="proof-evidence-viewer" aria-live="polite" data-status="error">
        <div className="proof-evidence-head">
          <div>
            <p className="mono">evidence could not be opened</p>
            <h3>{label}</h3>
          </div>
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="proof-evidence-error" role="alert">
          {state.message}
        </p>
        <RawEvidencePanel href={href} />
      </aside>
    );
  }
  const presentation = formatEvidenceResource(state.resource);
  return (
    <aside className="proof-evidence-viewer" aria-live="polite" data-kind={state.resource.kind}>
      <div className="proof-evidence-head">
        <div>
          <p className="mono">{presentation.eyebrow}</p>
          <h3>{presentation.title}</h3>
          <p className="proof-evidence-summary">{presentation.summary}</p>
        </div>
        <button type="button" className="ghost" onClick={onClose}>
          Close evidence
        </button>
      </div>
      <dl className="proof-evidence-rows">
        {presentation.rows.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      {presentation.body === undefined ? null : (
        <div className="proof-evidence-body">
          <p className="mono">{presentation.body.label}</p>
          <pre data-kind={presentation.body.kind}>{presentation.body.text}</pre>
        </div>
      )}
      {presentation.note === undefined ? null : <p className="proof-evidence-note">{presentation.note}</p>}
      <RawEvidencePanel href={presentation.rawHref} />
    </aside>
  );
}

type RawJsonState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; text: string }
  | { status: "error"; message: string };

function RawEvidencePanel({ href }: { href: string }): React.JSX.Element {
  const [state, setState] = useState<RawJsonState>({ status: "idle" });
  const inspect = useCallback((): void => {
    if (state.status === "loading") return;
    setState({ status: "loading" });
    void api
      .demoEvidenceJson(href)
      .then((text) => setState({ status: "loaded", text }))
      .catch((cause: unknown) =>
        setState({ status: "error", message: cause instanceof Error ? cause.message : String(cause) }),
      );
  }, [href, state.status]);
  return (
    <div className="proof-evidence-raw">
      <span className="mono">bounded API response</span>
      <code>{href}</code>
      <button
        type="button"
        className="proof-link-button"
        onClick={inspect}
        disabled={state.status === "loading"}
      >
        {state.status === "loading" ? "Reading…" : "Inspect bounded JSON"}
      </button>
      {state.status === "loaded" ? (
        <pre className="proof-raw-json" data-raw-json="true">
          {state.text}
        </pre>
      ) : state.status === "error" ? (
        <p className="proof-evidence-error" role="alert">
          Bounded JSON inspection failed: {state.message}
        </p>
      ) : null}
    </div>
  );
}

/** Prefer the bounded receipt endpoint; keep raw packets behind Inspect evidence. */
export function focusedReceiptHref(links: DemoApiLinks): string | undefined {
  const extended = links as DemoApiLinks & { receipt?: unknown };
  if (typeof extended.receipt === "string") return extended.receipt;
  return links.packetReceipt;
}

function InspectEvidence({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <details className="proof-inspect">
      <summary>Inspect evidence</summary>
      <div className="proof-inspect-body">{children}</div>
    </details>
  );
}

function formatPage(page: PageRecord | undefined): string {
  if (page === undefined) return "no page receipt";
  const locator = page.source ?? page.manifest ?? "no source locator";
  const bytes = page.byteRange === undefined ? "" : ` · bytes ${page.byteRange[0]}–${page.byteRange[1]}`;
  return `${page.trigger} · ${page.resolved ? "resolved" : "unresolved"} · ${locator}${bytes}`;
}

function formatByteRange(byteRange: PageRecord["byteRange"]): string {
  return byteRange === undefined ? "not recorded" : `${byteRange[0]}–${byteRange[1]}`;
}

function proofEpisodeHref(threadId: string, seq: number): string {
  return `/api/threads/${encodeURIComponent(threadId)}/episodes/${seq}`;
}

function compactEpisodeExcerpt(resource: Extract<EvidenceResource, { kind: "episode" }>): {
  label: string;
  text: string;
  note?: string;
} {
  if (!resource.textTruncated) {
    return { label: "exact stored words", text: resource.text };
  }
  const bytes = new TextEncoder().encode(resource.text);
  const window = 384;
  if (bytes.byteLength <= window * 2) {
    return {
      label: "bounded source excerpt",
      text: resource.text,
      note: `The stored source is ${groupedNumber(resource.byteLength)} bytes; the archive retains additional bytes behind its manifest/page spans, while this bounded viewer response returned prefix bytes 0–${groupedNumber(resource.textBytes)} for display.`,
    };
  }
  const tailStart = bytes.byteLength - window;
  const head = new TextDecoder().decode(bytes.subarray(0, window));
  const tail = new TextDecoder().decode(bytes.subarray(tailStart));
  return {
    label: "bounded source head / tail",
    text: `${head}\n… [omitted bounded-prefix bytes ${window}–${tailStart}] …\n${tail}`,
    note: `The stored source is ${groupedNumber(resource.byteLength)} bytes. The archive retains additional bytes behind its manifest/page spans; this bounded viewer response returned prefix bytes 0–${groupedNumber(resource.textBytes)}. The view shows head bytes 0–${window} and tail bytes ${tailStart}–${bytes.byteLength} from that returned prefix.`,
  };
}

function formatWitness(witness: DemoSummary["proof"]["correctedFact"]["currentWitness"]): string {
  const revision = witness.revision === undefined ? "" : ` · revision ${shortHash(witness.revision)}`;
  return `${witness.source} · #${groupedNumber(witness.seq)} · bytes ${witness.byteRange[0]}–${witness.byteRange[1]} · ${witness.authority}${revision}`;
}

function formatCoverageRoute(
  route: NonNullable<DemoSummary["proof"]["collection"]["coverage"]>["routes"][number],
): string {
  return (
    route.status +
    " · " +
    route.route +
    " · " +
    route.source +
    " · bytes " +
    route.byteRange[0] +
    "–" +
    route.byteRange[1] +
    " · " +
    shortHash(route.digest)
  );
}

function proofFinalStatus(summary: DemoSummary): "released" | "qualified" | "missing" {
  return summary.final.answerReceipt?.status ?? "missing";
}

function formatAnswerReceipt(summary: DemoSummary): string {
  const receipt = summary.final.answerReceipt;
  if (receipt === undefined) return "no answer receipt";
  return `${receipt.status} · ${shortHash(receipt.digest)}`;
}
