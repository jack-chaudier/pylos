import type { PageRecord } from "@pylos/protocol";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { fullStamp, pageLabel, spelled, turnList } from "../format.ts";

/**
 * The two lines that sit between a question and its answer, in the exchange and
 * in the archive drawer alike: what came back, and what had to be re-read.
 */

/**
 * What the check round did (KERNEL A9.5, A10.4). Episodes written before 1.2
 * carry `{names, revised}` instead of a status; a check that ran and changed
 * nothing reads the same under either shape. `none` carries no names and says
 * nothing: there was nothing to reopen.
 */
export function CheckLine({ meta }: { meta: unknown }): React.JSX.Element | null {
  if (meta === null || typeof meta !== "object") return null;
  const receipt = meta as { names?: unknown; status?: unknown; revised?: unknown };
  const names = Array.isArray(receipt.names) ? receipt.names.filter((name) => typeof name === "string") : [];
  if (names.length === 0) return null;
  const status =
    typeof receipt.status === "string" ? receipt.status : receipt.revised === true ? "revised" : "confirmed";
  if (status === "check-failed") {
    return (
      <div className="checked" data-failed="true">
        archive could not be re-read · {names.join(", ")} — unverified
      </div>
    );
  }
  return (
    <div className="checked">
      ↺ reopened the archive · {names.join(", ")}
      {status === "confirmed" ? " · answer stood" : ""}
    </div>
  );
}

export function RecoveryLine({
  threadId,
  pages,
}: {
  threadId: string;
  pages: PageRecord[];
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [spans, setSpans] = useState<Array<{ seq: number; text: string; ts: number }>>([]);
  const seqs = useMemo(() => {
    const all = pages.flatMap((page) => page.seqs);
    return [...new Set(all)].sort((a, b) => a - b);
  }, [pages]);

  useEffect(() => {
    if (!open || spans.length > 0) return;
    let cancelled = false;
    void (async () => {
      const loaded = await Promise.all(
        seqs.slice(0, 12).map(async (seq) => {
          try {
            const episode = await api.episode(threadId, seq);
            return { seq, text: episode.content, ts: episode.ts };
          } catch {
            return { seq, text: "UNKNOWN — the locator did not resolve.", ts: 0 };
          }
        }),
      );
      if (!cancelled) setSpans(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, seqs, threadId, spans.length]);

  // KERNEL A11.1: a fault is a routing receipt, not a loss — it is neither an
  // `unknown` locator nor, on its own, a reason to draw a line at all.
  const unresolved = pages.filter((page) => !page.resolved && page.trigger !== "fault").length;
  const handledFault =
    pages.some((page) => page.trigger === "fault") &&
    pages.some((page) => page.resolved && page.trigger === "model");
  // The turns are named below; only the reasons the turn list cannot carry — how
  // the model asked, and whose receipt led there — are worth a word of their own.
  const why = useMemo(
    () =>
      [...new Set(pages.filter((page) => page.trigger === "model" || page.trigger === "path").map(pageLabel))]
        .slice(0, 3)
        .join(" · "),
    [pages],
  );
  if (seqs.length === 0 && unresolved === 0) return null;

  return (
    <>
      <button type="button" className="recovery" onClick={() => setOpen((value) => !value)}>
        ↺ {handledFault ? "page fault · " : ""}recovered {spelled(seqs.length)} earlier{" "}
        {seqs.length === 1 ? "moment" : "moments"}
        {seqs.length > 0 ? ` · ${turnList(seqs)}` : ""}
        {why.length > 0 ? ` · ${why}` : ""}
        {unresolved > 0 ? ` · ${unresolved} unknown` : ""}
      </button>
      {open ? (
        <div className="recovery-spans">
          {spans.map((span) => (
            <div key={span.seq} className="recovery-span">
              <b>
                #{span.seq}
                {span.ts > 0 ? ` · ${fullStamp(span.ts)}` : ""}
              </b>
              {span.text}
            </div>
          ))}
          {spans.length === 0 ? <div className="recovery-span">recovering…</div> : null}
        </div>
      ) : null}
    </>
  );
}
