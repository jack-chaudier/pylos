import type { ChatMessage, Packet, ResidentItem, ResidentType, ThreadStats } from "@pylos/protocol";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { groupedNumber, shortHash, tokenCount } from "../format.ts";

export interface XrayProps {
  threadId: string;
  stats: ThreadStats | undefined;
  turnSeq: number | undefined;
  onClose: () => void;
}

const RESIDENT_COLOR: Record<ResidentType, string> = {
  header: "var(--ash)",
  frontier: "var(--verdigris)",
  capsule: "var(--verdigris-deep)",
  paged: "var(--ember)",
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

export function Xray(props: XrayProps): React.JSX.Element {
  const [packet, setPacket] = useState<Packet | undefined>(undefined);
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

  return (
    <>
      <div className="drawer-backdrop" onClick={props.onClose} role="presentation" aria-hidden="true" />
      <aside className="drawer" aria-label="X-ray">
        <div className="drawer-head">
          <h2>What the model saw</h2>
          {packet?.status === "pending" ? (
            <span className="badge" data-tone="oxblood">
              pending
            </span>
          ) : null}
          {reconstructed ? (
            <span className="badge" data-tone="ember">
              reconstructed
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
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
                      <span className="trigger" data-resolved={page.resolved}>
                        {page.resolved ? page.trigger : "unknown"}
                      </span>
                      <span>
                        {page.name ?? page.query ?? "—"}
                        {page.seqs.length > 0
                          ? ` · #${page.seqs.slice(0, 6).map(groupedNumber).join(", #")}`
                          : ""}
                      </span>
                      <span className="latency">
                        {page.tokens}t · {page.latencyMs}ms
                      </span>
                    </div>
                  ))
                )}
              </Section>
            </>
          ) : null}

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
              <dt>models</dt>
              <dd>{props.stats?.models.join(", ") || "—"}</dd>
            </dl>
            <div className="sheet-actions">
              {verified !== undefined ? (
                <span className="badge" data-tone={verified.ok ? "verdigris" : "oxblood"}>
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
                    .then(setVerified)
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

function ResidentList({ items }: { items: ResidentItem[] }): React.JSX.Element {
  const groups = new Map<ResidentType, ResidentItem[]>();
  for (const item of items) {
    const list = groups.get(item.type) ?? [];
    list.push(item);
    groups.set(item.type, list);
  }
  return (
    <>
      {[...groups.entries()].map(([type, list]) => (
        <div key={type} className="page-row">
          <span className="trigger" style={{ color: RESIDENT_COLOR[type] }}>
            {RESIDENT_LABEL[type]}
          </span>
          <span>
            {list
              .slice(0, 8)
              .map((item) => item.ref ?? (item.seq === undefined ? "—" : `#${item.seq}`))
              .join(", ")}
            {list.length > 8 ? ` … +${list.length - 8}` : ""}
          </span>
          <span className="latency">{groupedNumber(list.reduce((sum, item) => sum + item.tokens, 0))}t</span>
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
