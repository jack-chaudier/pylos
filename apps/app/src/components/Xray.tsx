import type {
  AnswerReceipt,
  AtomView,
  ByteLocator,
  ChatMessage,
  ClaimClassificationReceipt,
  CoverageReceipt,
  Epistemic,
  Packet,
  ReachabilitySpan,
  RequestRound,
  ResidentItem,
  ResidentType,
  SemanticReceipt,
  ThreadStats,
} from "@pylos/protocol";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { groupedNumber, pageLabel, shortHash, tokenCount } from "../format.ts";

export interface XrayProps {
  threadId: string;
  stats: ThreadStats | undefined;
  turnSeq: number | undefined;
  onClose: () => void;
  /** A successful verify moves `verifiedTo`; the evidence bar should hear about it. */
  onVerified: () => void;
}

/** One accent: the slots are told apart by how much kiln is in them. */
const RESIDENT_COLOR: Record<ResidentType, string> = {
  header: "color-mix(in srgb, var(--ash) 55%, transparent)",
  frontier: "var(--kiln)",
  capsule: "var(--kiln-deep)",
  paged: "color-mix(in srgb, var(--kiln) 50%, var(--bone))",
  recent: "var(--ink)",
  query: "var(--oxblood)",
};

const RESIDENT_LABEL: Record<ResidentType, string> = {
  header: "header",
  frontier: "frontier",
  capsule: "capsules",
  paged: "paged",
  recent: "recent",
  query: "query",
};

/** KERNEL A10.1: presence is not support. Packets written before 1.2 say nothing. */
const EPISTEMIC_LABEL: Record<Epistemic, string> = {
  SUPPORTED: "supported",
  PROPOSED: "proposed",
  HISTORICAL: "historical",
  NON_AUTHORITATIVE: "—",
};

export function Xray(props: XrayProps): React.JSX.Element {
  const [packet, setPacket] = useState<Packet | undefined>(undefined);
  const [atoms, setAtoms] = useState<AtomView[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);
  const [verified, setVerified] = useState<{ ok: boolean; headHash: string; checkedTo: number } | undefined>(
    undefined,
  );
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    const seq = props.turnSeq;
    if (seq === undefined) {
      setError("No packet yet — send a turn and the view will be recorded here.");
      return;
    }
    let cancelled = false;
    setError(undefined);
    void api
      .packet(props.threadId, seq)
      .then((value) => {
        if (!cancelled) setPacket(value);
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [props.threadId, props.turnSeq]);

  useEffect(() => {
    let cancelled = false;
    void api
      .atomsPage(props.threadId, { limit: 32 })
      .then((page) => {
        if (!cancelled) setAtoms(page.atoms);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.threadId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  const residentTotals = useMemo(() => {
    const totals = new Map<ResidentType, number>();
    for (const item of packet?.resident ?? []) {
      totals.set(item.type, (totals.get(item.type) ?? 0) + item.tokens);
    }
    return totals;
  }, [packet]);

  const reconstructed =
    packet !== undefined && (packet.reconstructed === true || packet.messages.length === 0);
  const rounds = packet?.rounds ?? [];

  return (
    <>
      <div className="drawer-backdrop" onClick={props.onClose} role="presentation" aria-hidden="true" />
      <aside className="drawer" aria-label="X-ray">
        <div className="drawer-head">
          <h2>What the model saw{rounds.length > 1 ? ` — ${rounds.length} rounds` : ""}</h2>
          {packet?.status === "pending" ? (
            <span className="badge" data-tone="oxblood">
              pending
            </span>
          ) : null}
          {reconstructed ? (
            <span className="badge" data-tone="kiln">
              reconstructed
            </span>
          ) : null}
          <span className="drawer-flex" />
          <button type="button" className="ghost" onClick={props.onClose}>
            Close
          </button>
        </div>

        <div className="drawer-body">
          {error !== undefined ? <div className="empty">{error}</div> : null}

          {packet !== undefined ? (
            <>
              <Section
                title="Packet"
                count={`${tokenCount(packet.tokens)} / ${tokenCount(packet.budget)}`}
                defaultOpen
              >
                <div className="resident-bar">
                  {[...residentTotals.entries()].map(([type, tokens]) => (
                    <i
                      key={type}
                      style={{
                        width: `${(tokens / Math.max(1, packet.tokens)) * 100}%`,
                        background: RESIDENT_COLOR[type],
                      }}
                      title={`${RESIDENT_LABEL[type]} · ${tokens} tokens`}
                    />
                  ))}
                </div>
                <div className="resident-legend">
                  {[...residentTotals.entries()].map(([type, tokens]) => (
                    <span key={type}>
                      <i className="dot" style={{ background: RESIDENT_COLOR[type] }} />
                      {RESIDENT_LABEL[type]} <b>{groupedNumber(tokens)}</b>
                    </span>
                  ))}
                </div>
                <dl className="kv">
                  <dt>model</dt>
                  <dd>{packet.model}</dd>
                  <dt>turn</dt>
                  <dd>{groupedNumber(packet.turnSeq)}</dd>
                  <dt>packet digest</dt>
                  <dd className="hash">{packet.digest}</dd>
                  {packet.compilerVersion !== undefined ? (
                    <>
                      <dt>compiler</dt>
                      <dd>{packet.compilerVersion}</dd>
                    </>
                  ) : null}
                </dl>
              </Section>

              <ClosureReceipt spans={packet.reachability} pages={packet.pages} />
              <CollectionReceipt coverage={packet.coverage} />
              <GateReceipt receipt={packet.answerReceipt} />
              <SemanticStatus receipt={packet.semantic} />

              {rounds.length > 0 ? (
                <Section title="Rounds" count={String(rounds.length)} defaultOpen>
                  <RoundList rounds={rounds} />
                </Section>
              ) : null}

              <Section title="Messages sent" count={String(packet.messages.length)} defaultOpen={false}>
                {reconstructed ? (
                  <div className="empty">
                    This packet is older than the retained window. It is re-rendered from resident[]; the
                    digest above is the authority.
                  </div>
                ) : null}
                {packet.messages.map((message, index) => {
                  // biome-ignore lint/suspicious/noArrayIndexKey: position in the packet is the identity
                  return <MessageBlock key={`${message.role}-${index}`} message={message} />;
                })}
                {packet.messages.length === 0 && !reconstructed ? (
                  <div className="empty">No messages recorded.</div>
                ) : null}
              </Section>

              <Section title="Resident items" count={String(packet.resident.length)} defaultOpen={false}>
                <ResidentList items={packet.resident} />
              </Section>

              <Section title="Loss ledger" count={groupedNumber(packet.ledger.count)} defaultOpen>
                <dl className="kv">
                  <dt>unresolved</dt>
                  <dd>{groupedNumber(packet.ledger.count)}</dd>
                  <dt>resident names</dt>
                  <dd>
                    {packet.ledger.residentNames.length === 0 ? "—" : packet.ledger.residentNames.join(", ")}
                  </dd>
                </dl>
                {packet.ledger.historical.length > 0 ? (
                  <div style={{ marginTop: 8 }}>
                    {packet.ledger.historical.map((entry) => (
                      <div key={entry.key} className="page-row">
                        <span className="trigger">changed</span>
                        <span>
                          {entry.key}: {entry.previous} → {entry.current}
                        </span>
                        <span className="latency">#{groupedNumber(entry.changedAtSeq)}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Section>

              <Section title="Pages served" count={String(packet.pages.length)} defaultOpen>
                {packet.pages.length === 0 ? (
                  <div className="empty">Nothing had to be recovered for this turn.</div>
                ) : (
                  packet.pages.map((page, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: order of service is the identity
                    <div key={`${page.trigger}-${index}`} className="page-row">
                      {/* KERNEL A11.1: a fault is not an UNKNOWN locator — it is the receipt
                          that no locator was found, and it says which question found none. */}
                      <span className="trigger" data-resolved={page.resolved} data-trigger={page.trigger}>
                        {page.resolved || page.trigger === "fault"
                          ? pageTriggerLabel(page.trigger)
                          : "unknown"}
                      </span>
                      <span>
                        {page.trigger === "path" ? pageLabel(page) : (page.name ?? page.query ?? "—")}
                        {page.seqs.length > 0
                          ? ` · #${page.seqs.slice(0, 6).map(groupedNumber).join(", #")}`
                          : ""}
                        {page.source !== undefined && page.byteRange !== undefined
                          ? ` · bytes ${page.byteRange[0]}–${page.byteRange[1]}`
                          : ""}
                      </span>
                      <span className="latency">
                        {page.trigger === "fault" ? "no route" : `${page.tokens}t · ${page.latencyMs}ms`}
                      </span>
                    </div>
                  ))
                )}
              </Section>
            </>
          ) : null}

          <Memory atoms={atoms} />

          <Section title="Archive" count={groupedNumber(props.stats?.turns ?? 0)} defaultOpen>
            <dl className="kv">
              <dt>head hash</dt>
              <dd className="hash">{props.stats?.headHash ?? "—"}</dd>
              <dt>episodes</dt>
              <dd>
                {groupedNumber(props.stats?.episodes.user ?? 0)} user ·{" "}
                {groupedNumber(props.stats?.episodes.assistant ?? 0)} assistant
              </dd>
              <dt>capsules</dt>
              <dd>{groupedNumber(props.stats?.capsules ?? 0)}</dd>
              <dt>losses</dt>
              <dd>{groupedNumber(props.stats?.losses ?? 0)}</dd>
              <dt>atoms</dt>
              <dd>
                {groupedNumber(props.stats?.atoms.supported ?? 0)} supported ·{" "}
                {groupedNumber(props.stats?.atoms.historical ?? 0)} historical ·{" "}
                {groupedNumber(props.stats?.atoms.proposed ?? 0)} proposed
              </dd>
              <dt>models</dt>
              <dd>{props.stats?.models.join(", ") || "—"}</dd>
            </dl>
            <div className="sheet-actions">
              {verified !== undefined ? (
                <span className="badge" data-tone={verified.ok ? "kiln" : "oxblood"}>
                  {verified.ok
                    ? `chain verified to #${groupedNumber(verified.checkedTo)} · ${shortHash(verified.headHash)}`
                    : "chain mismatch"}
                </span>
              ) : null}
              <button
                type="button"
                className="pill"
                disabled={verifying}
                onClick={() => {
                  setVerifying(true);
                  void api
                    .verify(props.threadId)
                    .then((result) => {
                      setVerified(result);
                      if (result.ok) props.onVerified();
                    })
                    .finally(() => setVerifying(false));
                }}
              >
                {verifying ? "Verifying…" : "Verify"}
              </button>
            </div>
          </Section>
        </div>
      </aside>
    </>
  );
}

/**
 * A12's closure receipt is deliberately shown as four states. An absent
 * receipt is treated as a legacy packet, never as an implicit fifth state.
 */
function ClosureReceipt({
  spans,
  pages,
}: {
  spans: ReachabilitySpan[] | undefined;
  pages: Packet["pages"];
}): React.JSX.Element {
  if (spans === undefined) {
    return (
      <Section title="Byte closure" count="legacy" defaultOpen>
        <div className="receipt-empty">
          This packet predates the four-state closure receipt. No reachability state is inferred here.
        </div>
      </Section>
    );
  }

  const counts: Record<ReachabilitySpan["state"], number> = {
    resident: 0,
    capsule: 0,
    pageable: 0,
    opaque: 0,
  };
  for (const span of spans) counts[span.state] += 1;
  const exactFromReceipt = spans.filter(hasExactLocator).length;
  const exactFromPages = pages.filter(
    (page) => page.source !== undefined && page.byteRange !== undefined && page.sourceHash !== undefined,
  ).length;
  const exact = exactFromReceipt + exactFromPages;
  return (
    <Section title="Byte closure" count={`${groupedNumber(spans.length)} spans`} defaultOpen>
      <div className="receipt-card closure-card">
        <p className="receipt-lede">
          Every retained byte is resident, carried by a capsule, pageable, or covered by an opaque receipt.
        </p>
        <div className="receipt-metrics">
          {(["resident", "capsule", "pageable", "opaque"] as const).map((state) => (
            <div className="receipt-metric" key={state}>
              <b>{groupedNumber(counts[state])}</b>
              <span>{state}</span>
            </div>
          ))}
        </div>
        <div className="receipt-foot">
          <span>exact locators</span>
          <b>{groupedNumber(exact)}</b>
          <span className="receipt-muted">hash-bound byte ranges in this receipt and its pages</span>
        </div>
      </div>
    </Section>
  );
}

function hasExactLocator(span: ReachabilitySpan): boolean {
  if (span.kind === "episode" || span.kind === "attachment") return true;
  return "locator" in span && span.locator !== undefined;
}

/** A13 is a route receipt and a lower bound, never a claim that the set is complete. */
function CollectionReceipt({ coverage }: { coverage: CoverageReceipt | undefined }): React.JSX.Element {
  if (coverage === undefined) {
    return (
      <Section title="Collection coverage" count="none" defaultOpen={false}>
        <div className="receipt-empty">No collection cue was recorded for this question.</div>
      </Section>
    );
  }

  return (
    <Section title="Collection coverage" count={coverage.completeness} defaultOpen>
      <div className="receipt-card">
        <p className="receipt-lede">
          Cue <b>{coverage.cue}</b> · routes ran against the archive as of turn #
          {groupedNumber(coverage.asOfSeq)}.
        </p>
        <div className="receipt-metrics receipt-metrics-five">
          <div className="receipt-metric">
            <b>{groupedNumber(coverage.located)}</b>
            <span>located</span>
          </div>
          <div className="receipt-metric">
            <b>{groupedNumber(coverage.supported)}</b>
            <span>supported</span>
          </div>
          <div className="receipt-metric">
            <b>{groupedNumber(coverage.historical)}</b>
            <span>historical</span>
          </div>
          <div className="receipt-metric">
            <b>{coverage.required === undefined ? "unknown" : groupedNumber(coverage.required)}</b>
            <span>required</span>
          </div>
          <div className="receipt-metric">
            <b>{groupedNumber(coverage.unresolved ?? 0)}</b>
            <span>unknown</span>
          </div>
        </div>
        <div className="receipt-foot">
          <span>completeness</span>
          <b data-status={coverage.completeness}>{coverage.completeness}</b>
          <span className="receipt-muted">a route lower bound; cardinality is not inferred</span>
        </div>
        {coverage.routes.length > 0 ? (
          <div className="receipt-locators">
            {coverage.routes.slice(0, 24).map((route) => (
              <div className="receipt-locator" key={route.digest}>
                <span className="trigger">{route.status}</span>
                <span>
                  {route.source} · bytes {route.byteRange[0]}–{route.byteRange[1]}
                </span>
                <span className="latency">{shortHash(route.revision)}</span>
              </div>
            ))}
            {coverage.routes.length > 24 ? (
              <div className="receipt-muted">+{groupedNumber(coverage.routes.length - 24)} more locators</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/** A14's release receipt: per-claim classes and exact witnesses, when any. */
function GateReceipt({ receipt }: { receipt: AnswerReceipt | undefined }): React.JSX.Element {
  if (receipt === undefined) {
    return (
      <Section title="Memory gate" count="none" defaultOpen={false}>
        <div className="receipt-empty">No answer receipt was stored with this packet.</div>
      </Section>
    );
  }
  const witnessed = receipt.classifications.filter((claim) => claim.witness !== undefined).length;
  const coverageBases = receipt.classifications.filter(
    (claim) => claim.witness === undefined && claim.basis !== undefined,
  ).length;
  const currentEvidence = receipt.classifications.filter(hasCurrentEvidence).length;
  return (
    <Section title="Memory gate" count={receipt.status} defaultOpen>
      <div className="receipt-card">
        <p className="receipt-lede">
          Kernel release: <b data-status={receipt.status}>{receipt.status}</b> · {currentEvidence} of{" "}
          {receipt.classifications.length} remembered claims have current evidence.
          {witnessed > 0 || coverageBases > 0 ? (
            <span className="receipt-muted">
              {" "}
              ({witnessed} exact source {witnessed === 1 ? "witness" : "witnesses"} · {coverageBases} coverage{" "}
              {coverageBases === 1 ? "base" : "bases"})
            </span>
          ) : null}
        </p>
        <div className="receipt-claims">
          {receipt.classifications.length === 0 ? (
            <div className="receipt-empty">No remembered claims were classified.</div>
          ) : (
            receipt.classifications.map((claim) => {
              const candidate = receipt.candidates.find((item) => sameSpan(item.span, claim.span));
              const evidenceKey = claim.witness?.hash ?? claim.basis?.digest ?? "none";
              return (
                <div
                  className="receipt-claim"
                  key={`${claim.span[0]}-${claim.span[1]}-${claim.kind}-${claim.classification}-${evidenceKey}`}
                >
                  <div className="receipt-claim-head">
                    <span className="trigger">{claim.kind}</span>
                    <b data-classification={claim.classification}>{claim.classification}</b>
                  </div>
                  <div className="receipt-claim-text">
                    {candidate?.text ?? `answer span ${claim.span.join("–")}`}
                  </div>
                  <div className="receipt-witness">{formatClaimEvidence(claim)}</div>
                </div>
              );
            })
          )}
        </div>
        {receipt.qualifications.length > 0 ? (
          <div className="receipt-qualifications">
            {receipt.qualifications.map((qualification) => (
              <div key={qualification}>{qualification}</div>
            ))}
          </div>
        ) : null}
        <p className="receipt-muted receipt-note">
          The gate controls remembered claims only; it does not certify reasoning, entailment, or creative
          prose.
        </p>
      </div>
    </Section>
  );
}

function sameSpan(left: [number, number], right: [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function hasCurrentEvidence(claim: ClaimClassificationReceipt): boolean {
  return claim.witness !== undefined || claim.basis !== undefined;
}

export function formatClaimEvidence(claim: ClaimClassificationReceipt): string {
  if (claim.witness !== undefined) return `current witness · ${formatWitness(claim.witness)}`;
  if (claim.basis !== undefined) {
    return `coverage · ${claim.basis.metric} ${groupedNumber(claim.basis.value)} · ${shortHash(claim.basis.digest)}`;
  }
  return "no current witness";
}

function formatWitness(witness: ByteLocator): string {
  return `${witness.source} · bytes ${witness.from}–${witness.to} · ${shortHash(witness.hash)}`;
}

/** A15.2 is address-only. The UI must not imply semantic retrieval efficacy. */
function SemanticStatus({ receipt }: { receipt: SemanticReceipt | undefined }): React.JSX.Element {
  if (receipt === undefined) {
    return (
      <Section title="Semantic route" count="none" defaultOpen={false}>
        <div className="receipt-empty">No semantic route receipt was recorded for this packet.</div>
      </Section>
    );
  }
  const count = receipt.status === "ready" ? `${receipt.indexed ?? 0} indexed` : receipt.status;
  return (
    <Section title="Semantic route" count={count} defaultOpen={receipt.status !== "ready"}>
      <div className="receipt-card" data-semantic-status={receipt.status}>
        <p className="receipt-lede">
          Address route: <b data-status={receipt.status}>{receipt.status}</b>
        </p>
        {receipt.status === "ready" ? (
          <p className="receipt-copy">
            {groupedNumber(receipt.indexed ?? 0)} indexed · {groupedNumber(receipt.eligible ?? 0)} eligible.
            Hits still require exact byte paging and a receipt before they can be read.
          </p>
        ) : (
          <p className="receipt-copy">
            {receipt.reason ?? "The semantic route did not produce a usable index."}
          </p>
        )}
        <p className="receipt-muted receipt-note">
          Semantic addresses are not authority and do not become facts.
        </p>
      </div>
    </Section>
  );
}

function pageTriggerLabel(trigger: Packet["pages"][number]["trigger"]): string {
  switch (trigger) {
    case "address":
      return "address route";
    case "invalidation":
      return "address invalidation";
    case "semantic":
      return "semantic address";
    case "semantic-unavailable":
      return "semantic unavailable";
    case "attachment-tail":
      return "attachment tail";
    case "recent-overflow":
      return "recent overflow";
    case "fault":
      return "page fault";
    default:
      return trigger;
  }
}

/**
 * What the thread believes, and on whose word. PROPOSED atoms were asserted by
 * a model rather than the user (KERNEL A9.1): they are shown, marked, and never
 * dressed up as certificates.
 */
function Memory({ atoms }: { atoms: AtomView[] }): React.JSX.Element {
  const held = atoms.filter((atom) => atom.phase === "SUPPORTED");
  const proposed = atoms.filter((atom) => atom.phase === "PROPOSED");
  return (
    <>
      <Section title="Memory" count={groupedNumber(held.length)} defaultOpen={false}>
        {held.length === 0 ? (
          <div className="empty">Nothing has been asserted yet.</div>
        ) : (
          held.slice(0, 60).map((atom) => <AtomRow key={atom.id} atom={atom} />)
        )}
      </Section>
      {proposed.length > 0 ? (
        <Section title="Proposed" count={groupedNumber(proposed.length)} defaultOpen>
          <div className="empty">
            Asserted by a model, not by you. Unconfirmed: never used as a certificate.
          </div>
          {proposed.slice(0, 60).map((atom) => (
            <AtomRow key={atom.id} atom={atom} />
          ))}
        </Section>
      ) : null}
    </>
  );
}

function AtomRow({ atom }: { atom: AtomView }): React.JSX.Element {
  const unconfirmed = atom.phase === "PROPOSED";
  return (
    <div className="page-row atom-row" data-proposed={unconfirmed}>
      <span className="trigger">{unconfirmed ? "≈" : atom.kind}</span>
      <span>
        {atom.key} = {atom.value}
        {unconfirmed ? " · unconfirmed" : ""}
      </span>
      <span className="latency">
        {atom.authority} · #{groupedNumber(atom.sourceSeq)}
      </span>
    </div>
  );
}

interface ResidentGroup {
  type: ResidentType;
  epistemic: Epistemic | undefined;
  list: ResidentItem[];
}

/**
 * Grouped by slot *and* by what the slot is allowed to support: one `recent`
 * window holds the user's word and a previous model's, and only the first is
 * evidence (KERNEL A10.1).
 */
function ResidentList({ items }: { items: ResidentItem[] }): React.JSX.Element {
  const groups = new Map<string, ResidentGroup>();
  for (const item of items) {
    const key = `${item.type}|${item.epistemic ?? ""}`;
    const group = groups.get(key) ?? { type: item.type, epistemic: item.epistemic, list: [] };
    group.list.push(item);
    groups.set(key, group);
  }
  return (
    <>
      <div className="empty">Only supported spans count as evidence.</div>
      {[...groups.entries()].map(([key, group]) => (
        <div key={key} className="page-row">
          <span className="trigger" style={{ color: RESIDENT_COLOR[group.type] }}>
            {RESIDENT_LABEL[group.type]}
          </span>
          <span>
            <b className="epistemic" data-supported={group.epistemic === "SUPPORTED"}>
              {group.epistemic === undefined ? "—" : EPISTEMIC_LABEL[group.epistemic]}
            </b>
            {group.list
              .slice(0, 8)
              .map((item) => item.ref ?? (item.seq === undefined ? "—" : `#${item.seq}`))
              .join(", ")}
            {group.list.length > 8 ? ` … +${group.list.length - 8}` : ""}
          </span>
          <span className="latency">
            {groupedNumber(group.list.reduce((sum, item) => sum + item.tokens, 0))}t
          </span>
        </div>
      ))}
    </>
  );
}

/** One row per provider request of the turn, ordinal 0 being the compiled packet (KERNEL A10.3). */
function RoundList({ rounds }: { rounds: RequestRound[] }): React.JSX.Element {
  return (
    <>
      {rounds.map((round) => (
        <div key={round.ordinal} className="page-row">
          <span className="trigger" data-resolved={round.status === "done"}>
            {round.ordinal === 0 ? "packet" : `round ${round.ordinal}`}
          </span>
          <span>
            {tokenCount(round.tokens)} / {tokenCount(round.budget)}
            {round.pages.length > 0 ? ` · ${round.pages.length} paged` : ""} ·{" "}
            <span className="hash">{shortHash(round.messagesDigest)}</span>
          </span>
          <span className="latency">{round.status}</span>
        </div>
      ))}
    </>
  );
}

function MessageBlock({ message }: { message: ChatMessage }): React.JSX.Element {
  return (
    <div className="message-block">
      <div className="message-role">
        {message.role}
        {message.toolCalls !== undefined ? (
          <span>{message.toolCalls.map((call) => call.name).join(", ")}</span>
        ) : null}
        {message.toolCallId !== undefined ? <span>{message.toolCallId}</span> : null}
      </div>
      <div className="message-text">{message.content}</div>
    </div>
  );
}

function Section({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="xray-section">
      <button type="button" className="xray-head" onClick={() => setOpen((value) => !value)}>
        <span className="xray-caret" data-open={open}>
          ▸
        </span>
        <h3>{title}</h3>
        <span className="count">{count}</span>
      </button>
      {open ? children : null}
    </section>
  );
}
