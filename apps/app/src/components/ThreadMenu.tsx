import type { ThreadStats } from "@pylos/protocol";
import { useState } from "react";
import { groupedNumber } from "../format.ts";
import { useDismiss } from "./Composer.tsx";

export interface ThreadMenuProps {
  stats: ThreadStats | undefined;
  threads: ThreadStats[];
  hasMore: boolean;
  hasNewer: boolean;
  loadingMore: boolean;
  onNew: () => void;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  onOpen: (threadId: string) => void;
  onExport: () => void;
  onExportPartial: () => void;
  onImport: () => void;
  onClose: () => void;
}

export function ThreadMenu(props: ThreadMenuProps): React.JSX.Element {
  useDismiss(props.onClose);
  const others = props.threads.filter((thread) => thread.threadId !== props.stats?.threadId);
  const fragment = props.stats?.fragment;
  return (
    <div className="menu menu-down" role="menu">
      <button type="button" className="menu-item" onClick={props.onNew}>
        New thread
      </button>
      {fragment === undefined ? (
        <button type="button" className="menu-item" onClick={props.onExport}>
          Export…
          <small>.pylos</small>
        </button>
      ) : (
        <>
          <button
            type="button"
            className="menu-item"
            disabled
            title="Full-vault export is unavailable for an authenticated fragment."
          >
            Full export unavailable
            <small>read-only</small>
          </button>
          <button type="button" className="menu-item" onClick={props.onExportPartial}>
            Export this range…
            <small>{`#${fragment.fromSeq}–#${fragment.toSeq}`}</small>
          </button>
        </>
      )}
      <button type="button" className="menu-item" onClick={props.onImport}>
        Import…
      </button>
      {others.length > 0 ? (
        <>
          <div className="menu-sep" />
          <div className="menu-group">Other threads</div>
          {others.map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              className="menu-item"
              onClick={() => props.onOpen(thread.threadId)}
            >
              <span className="menu-item-title">{thread.title}</span>
              <small>{groupedNumber(thread.turns)}</small>
            </button>
          ))}
          {props.hasMore ? (
            <button
              type="button"
              className="menu-item"
              onClick={props.onLoadOlder}
              disabled={props.loadingMore}
            >
              {props.loadingMore ? "Loading older threads…" : "Load older threads"}
            </button>
          ) : null}
          {props.hasNewer ? (
            <button
              type="button"
              className="menu-item"
              onClick={props.onLoadNewer}
              disabled={props.loadingMore}
            >
              {props.loadingMore ? "Loading newer threads…" : "Load newer threads"}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export interface PassphraseProps {
  title: string;
  note: string;
  confirm: string;
  busy: boolean;
  error: string | undefined;
  onSubmit: (passphrase: string) => void;
  onCancel: () => void;
}

export function PassphraseSheet(props: PassphraseProps): React.JSX.Element {
  const [value, setValue] = useState("");
  const ready = value.length >= 8;
  return (
    <div className="sheet-backdrop">
      <button type="button" className="scrim" aria-label="Cancel" onClick={props.onCancel} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title}>
        <h3>{props.title}</h3>
        <p>{props.note}</p>
        <div className="field">
          <input
            type="password"
            value={value}
            // biome-ignore lint/a11y/noAutofocus: a modal that asks for exactly one value
            autoFocus
            placeholder="passphrase · at least 8 characters"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready) props.onSubmit(value);
            }}
          />
        </div>
        {props.error !== undefined ? <p className="sheet-error">{props.error}</p> : null}
        <div className="sheet-actions">
          <button type="button" className="ghost" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="pill"
            disabled={!ready || props.busy}
            onClick={() => props.onSubmit(value)}
          >
            {props.busy ? "Working…" : props.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface ConfirmProps {
  title: string;
  note: string;
  confirm: string;
  /** What declining means here; "Keep it" when the sheet is about one turn. */
  cancel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmSheet(props: ConfirmProps): React.JSX.Element {
  return (
    <div className="sheet-backdrop">
      <button type="button" className="scrim" aria-label="Cancel" onClick={props.onCancel} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title}>
        <h3>{props.title}</h3>
        <p>{props.note}</p>
        <div className="sheet-actions">
          <button type="button" className="ghost" onClick={props.onCancel}>
            {props.cancel ?? "Keep it"}
          </button>
          <button type="button" className="pill" onClick={props.onConfirm}>
            {props.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
