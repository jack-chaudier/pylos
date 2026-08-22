import type { Episode, ModelInfo } from "@pylos/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bytesLabel, providerLabel } from "../format.ts";

export interface ComposerProps {
  models: ModelInfo[];
  model: string;
  budget: number;
  busy: boolean;
  attachments: Episode[];
  onSend: (text: string) => void;
  onStop: () => void;
  onPickModel: (model: string) => void;
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (seq: number) => void;
  onBudget: (budget: number) => void;
  onRefreshModels: () => void;
}

export function Composer(props: ComposerProps): React.JSX.Element {
  const { onAttach } = props;
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const [drop, setDrop] = useState(false);
  const [menu, setMenu] = useState<"model" | "settings" | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dropDepth = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is the trigger, not a read
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (element === null) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Evidence can be dropped anywhere in the window, not just on the composer.
  useEffect(() => {
    const onEnter = (event: DragEvent): void => {
      event.preventDefault();
      dropDepth.current += 1;
      setDrop(true);
    };
    const onOver = (event: DragEvent): void => event.preventDefault();
    const onLeave = (): void => {
      dropDepth.current -= 1;
      if (dropDepth.current <= 0) setDrop(false);
    };
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      dropDepth.current = 0;
      setDrop(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length > 0) onAttach(files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [onAttach]);

  const send = (): void => {
    const value = text.trim();
    if (value.length === 0 || props.busy) return;
    setText("");
    props.onSend(value);
  };

  const current = props.models.find((model) => model.id === props.model);

  return (
    <div className="composer-dock">
      <div className="composer" data-focus={focus} data-drop={drop}>
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder="Say anything. The thread remembers."
          spellCheck
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onChange={(event) => setText(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length > 0) {
              event.preventDefault();
              props.onAttach(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send();
            }
          }}
        />

        {props.attachments.length > 0 ? (
          <div className="chips">
            {props.attachments.map((attachment) => (
              <span key={attachment.seq} className="chip">
                <b>{String(attachment.meta.name ?? "file")}</b>
                {typeof attachment.meta.size === "number" ? bytesLabel(attachment.meta.size) : null}
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => props.onRemoveAttachment(attachment.seq)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="composer-bar">
          <button
            type="button"
            className="icon-button"
            title="Attach evidence"
            aria-label="Attach a file"
            onClick={() => fileRef.current?.click()}
          >
            <Paperclip />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              if (files.length > 0) props.onAttach(files);
              event.target.value = "";
            }}
          />

          <span className="menu-anchor">
            <button
              type="button"
              className="model-chip"
              data-open={menu === "model"}
              onClick={() => {
                setMenu((value) => (value === "model" ? undefined : "model"));
                props.onRefreshModels();
              }}
            >
              {current?.label ?? props.model}
              {current !== undefined && !current.supportsTools ? (
                <span className="no-tools" title="This model cannot call the recall tool">
                  no recall tool
                </span>
              ) : null}
              <Caret />
            </button>
            {menu === "model" ? (
              <ModelMenu
                models={props.models}
                current={props.model}
                onPick={(model) => {
                  setMenu(undefined);
                  props.onPickModel(model);
                }}
                onClose={() => setMenu(undefined)}
              />
            ) : null}
          </span>

          <span className="composer-flex" />

          <span className="menu-anchor">
            <button
              type="button"
              className="icon-button"
              title="View budget"
              aria-label="Settings"
              onClick={() => setMenu((value) => (value === "settings" ? undefined : "settings"))}
            >
              <Gauge />
            </button>
            {menu === "settings" ? (
              <BudgetPopover
                budget={props.budget}
                onPick={(budget) => {
                  props.onBudget(budget);
                  setMenu(undefined);
                }}
                onClose={() => setMenu(undefined)}
              />
            ) : null}
          </span>

          {props.busy ? (
            <button type="button" className="send" data-stop="true" onClick={props.onStop}>
              Stop
            </button>
          ) : (
            <button type="button" className="send" disabled={text.trim().length === 0} onClick={send}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ModelMenu({
  models,
  current,
  onPick,
  onClose,
}: {
  models: ModelInfo[];
  current: string;
  onPick: (model: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  useDismiss(onClose);
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const list = groups.get(model.provider) ?? [];
    list.push(model);
    groups.set(model.provider, list);
  }
  return (
    <div className="menu menu-up" role="menu">
      {[...groups.entries()].map(([provider, list]) => (
        <div key={provider}>
          <div className="menu-group">{providerLabel(provider)}</div>
          {list.map((model) => (
            <button
              key={`${provider}/${model.id}`}
              type="button"
              className="menu-item"
              role="menuitem"
              data-active={model.id === current}
              data-disabled={!model.available}
              onClick={() => onPick(model.id)}
            >
              {model.label}
              {!model.available ? (
                <small>connect</small>
              ) : !model.supportsTools ? (
                <small className="warn">no recall</small>
              ) : null}
            </button>
          ))}
        </div>
      ))}
      {models.length === 0 ? <div className="empty">No models available.</div> : null}
    </div>
  );
}

function BudgetPopover({
  budget,
  onPick,
  onClose,
}: {
  budget: number;
  onPick: (budget: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  useDismiss(onClose);
  return (
    <div className="popover">
      <h4>View budget</h4>
      <p>How much the model may see each turn. The archive is never affected.</p>
      <div className="segmented">
        <button type="button" data-active={budget === 8192} onClick={() => onPick(8192)}>
          8k demo
        </button>
        <button type="button" data-active={budget === 32768} onClick={() => onPick(32768)}>
          32k
        </button>
        <button type="button" data-active={budget === 131072} onClick={() => onPick(131072)}>
          128k
        </button>
      </div>
    </div>
  );
}

export function useDismiss(onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".menu, .popover, .model-chip, .icon-button, .thread-title, .account") === null) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);
}

function Paperclip(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M20 10.5 11.5 19a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 1 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Gauge(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 16a8 8 0 1 1 16 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M12 16 16 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Caret(): React.JSX.Element {
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 4 5 7 8 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
