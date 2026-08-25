import type {
  ThreadCompactionStatus,
  ThreadFragmentStatus,
  ThreadSourceReadiness,
  ThreadStats,
} from "@pylos/protocol";
import { groupedNumber, shortHash } from "../format.ts";

/** The persisted marker, rather than an import toast, controls the UI mode. */
export function isReadOnlyFragment(stats: ThreadStats | undefined): boolean {
  return stats?.fragment?.readOnly === true;
}

export function isReadOnlySource(stats: ThreadStats | undefined): boolean {
  return stats?.sourceReadiness?.status === "noncompactable" && stats.sourceReadiness.readOnly === true;
}

export function fragmentRangeLabel(fragment: ThreadFragmentStatus): string {
  return `#${groupedNumber(fragment.fromSeq)}–#${groupedNumber(fragment.toSeq)}`;
}

export function fragmentOriginLabel(fragment: ThreadFragmentStatus): string {
  return `original thread ${fragment.originalThreadId}`;
}

/** Durable provenance for an authenticated partial import. */
export function FragmentBanner({ fragment }: { fragment: ThreadFragmentStatus }): React.JSX.Element {
  return (
    <aside className="fragment-banner" data-fragment-read-only="true" aria-label="Read-only fragment">
      <div className="fragment-banner-head">
        <span className="badge" data-tone="kiln">
          read-only fragment
        </span>
        <span className="fragment-banner-label">authenticated archive range</span>
      </div>
      <p className="fragment-banner-copy">
        Turns <b>{fragmentRangeLabel(fragment)}</b> from{" "}
        <code title={fragment.originalThreadId}>{fragmentOriginLabel(fragment)}</code>. This range is
        authenticated, readable, and cannot accept new turns or edits.
      </p>
      <dl className="fragment-details">
        <dt>boundary</dt>
        <dd className="hash" title={`${fragment.prevHash} → ${fragment.headHash}`}>
          {shortHash(fragment.prevHash)} → {shortHash(fragment.headHash)}
        </dd>
        <dt>fragment id</dt>
        <dd className="hash" title={fragment.threadId}>
          {fragment.threadId}
        </dd>
      </dl>
    </aside>
  );
}

/** Durable quarantine for a legacy source that cannot safely be compacted. */
export function SourceReadinessBanner({
  readiness,
}: {
  readiness: ThreadSourceReadiness;
}): React.JSX.Element {
  return (
    <aside
      className="fragment-banner source-readiness-banner"
      data-source-readiness="noncompactable"
      aria-label="Legacy source quarantine"
    >
      <div className="fragment-banner-head">
        <span className="badge" data-tone="kiln">
          read-only quarantine
        </span>
        <span className="fragment-banner-label">legacy source needs remediation</span>
      </div>
      <p className="fragment-banner-copy">
        New turns are paused at <b>episode #{groupedNumber(readiness.seq ?? 0)}</b> because this source cannot
        be compacted safely: <code>{readiness.reason}</code>.
      </p>
      <p className="source-readiness-next">
        Next action: use <b>Forget this</b> on the offending episode in the archive. The exact chain and full
        export remain available while remediation is recorded.
      </p>
    </aside>
  );
}

/** Progress is durable and read-only while the bounded derived index catches up. */
export function CompactionBanner({ status }: { status: ThreadCompactionStatus }): React.JSX.Element | null {
  if (!status.pending) return null;
  return (
    <aside
      className="fragment-banner compaction-banner"
      data-compaction-pending="true"
      aria-label="Rebuilding archive index"
    >
      <div className="fragment-banner-head">
        <span className="badge" data-tone="kiln">
          rebuilding bounded index
        </span>
        <span className="fragment-banner-label">the archive remains readable</span>
      </div>
      <p className="fragment-banner-copy">
        Sealed through <b>episode #{groupedNumber(status.sealedThrough)}</b> of{" "}
        <b>#{groupedNumber(status.headSeq)}</b>. The next bounded pass will run automatically; new turns wait
        until the index is ready.
      </p>
    </aside>
  );
}
