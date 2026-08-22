import type { ThreadStats } from "@pylos/protocol";
import { useState } from "react";
import { groupedNumber } from "../format.ts";
import { useDismiss } from "./Composer.tsx";

export interface ThreadMenuProps {
  stats: ThreadStats | undefined;
  threads: ThreadStats[];
  onNew: () => void;
  onOpen: (threadId: string) => void;
  onExport: () => void;
  onImport: () => void;
  onClose: () => void;
}

export function ThreadMenu(props: ThreadMenuProps): React.JSX.Element {
  useDismiss(props.onClose);
  const others = props.threads.filter((thread) => thread.threadId !== props.stats?.threadId);
  return (
    <div className="menu menu-down" role="menu">
      <button type="button" className="menu-item" onClick={props.onNew}>
        New thread
      </button>
      <button type="button" className="menu-item" onClick={props.onExport}>
        Export…
        <small>.pylos</small>
      </button>
      <button type="button" className="menu-item" onClick={props.onImport}>
        Import…
      </button>
      {others.length > 0 ? (
        <>
          <div className="menu-sep" />
          <div className="menu-group">Other threads</div>
          {others.slice(0, 12).map((thread) => (
            <button
              key={thread.threadId}
              type="button"
              className="menu-item"
              onClick={() => props.onOpen(thread.threadId)}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "22ch",
                }}
              >
                {thread.title}
              </span>
              <small>{groupedNumber(thread.turns)}</small>
            </button>
          ))}
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
            Keep it
          </button>
          <button type="button" className="pill" onClick={props.onConfirm}>
            {props.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
