import type { Episode, ModelInfo, ProviderId } from "@pylos/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { bytesLabel, providerLabel } from "../format.ts";
import { createDictation, type Dictation, dictationSupported } from "../speech.ts";

export interface ComposerProps {
  readOnly?: boolean;
  readOnlyMessage?: string;
  models: ModelInfo[];
  model: string;
  budget: number;
  busy: boolean;
  attachments: Episode[];
  onSend: (text: string) => void;
  onStop: () => void;
  /** Something the composer could not do — dictation refused, mostly. */
  onError: (message: string) => void;
  onPickModel: (model: string) => void;
  /** A model whose provider is not connected: connect it, then switch. */
  onConnectModel: (provider: ProviderId, model: string) => void;
  /** `↑` on an empty composer opens the archive. */
  onEarlier: () => void;
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (seq: number) => void;
  onBudget: (budget: number) => void;
  onRefreshModels: () => void;
}

export function Composer(props: ComposerProps): React.JSX.Element {
  const { onAttach, readOnly = false } = props;
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const [drop, setDrop] = useState(false);
  const [menu, setMenu] = useState<"model" | undefined>(undefined);
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const dropDepth = useRef(0);
  const dictation = useRef<Dictation | undefined>(undefined);
  /** What was in the box when the microphone opened; the speech is added to it. */
  const spokenOnto = useRef("");
  const notify = useRef(props.onError);
  notify.current = props.onError;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `text` is the trigger, not a read
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (element === null) return;
    element.style.height = "0px";
    element.style.height = `${element.scrollHeight}px`;
  }, [text]);

  useEffect(() => {
    if (!readOnly) inputRef.current?.focus();
  }, [readOnly]);

  // Built once, and only where the browser has a recognizer of its own.
  useEffect(() => {
    const handle = createDictation({
      onHeard: (heard) => setText(spokenOnto.current + heard),
      onError: (message) => {
        setListening(false);
        notify.current(message);
      },
      onEnd: () => setListening(false),
    });
    dictation.current = handle;
    return () => {
      handle?.stop();
      dictation.current = undefined;
    };
  }, []);

  const listen = useCallback((): void => {
    const handle = dictation.current;
    if (handle === undefined) return;
    if (listening) {
      handle.stop();
      setListening(false);
      return;
    }
    setText((current) => {
      spokenOnto.current = current.length === 0 || current.endsWith(" ") ? current : `${current} `;
      return spokenOnto.current;
    });
    try {
      handle.start();
      setListening(true);
    } catch (error) {
      notify.current(error instanceof Error ? error.message : String(error));
    }
  }, [listening]);

  // Evidence can be dropped anywhere in the window, not just on the composer.
  useEffect(() => {
    if (readOnly) return;
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
  }, [onAttach, readOnly]);

  const send = (): void => {
    const value = text.trim();
    if (readOnly || value.length === 0 || props.busy) return;
    if (listening) {
      dictation.current?.stop();
      setListening(false);
    }
    setText("");
    props.onSend(value);
  };

  if (readOnly) {
    return (
      <div className="composer-dock">
        <div className="composer composer-readonly" data-read-only="true">
          <div className="composer-readonly-copy">
            <span className="badge">read-only</span>
            <span>
              {props.readOnlyMessage ??
                "Questions, attachments, model handoffs, and settings are disabled for this fragment."}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const current = props.models.find((model) => model.id === props.model);
  const chip = modelChipState(current);

  return (
    <div className="composer-dock">
      <div className="composer" data-focus={focus} data-drop={drop}>
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder="Ask it, or tell it something."
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
            if (event.key === "ArrowUp" && text.length === 0) {
              event.preventDefault();
              props.onEarlier();
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
              title={chip.title}
              aria-label={chip.connected ? undefined : chip.title}
              onClick={() => {
                setMenu((value) => (value === "model" ? undefined : "model"));
                props.onRefreshModels();
              }}
            >
              {current?.label ?? props.model}
              {chip.connected ? null : <span className="not-connected">· not connected</span>}
              {current !== undefined && !current.supportsTools ? (
                <span className="no-tools" title="This model cannot call the recall tool">
                  no recall
                </span>
              ) : null}
              <span aria-hidden="true">▾</span>
            </button>
            {menu === "model" ? (
              <ModelMenu
                models={props.models}
                current={props.model}
                budget={props.budget}
                onPick={(model) => {
                  setMenu(undefined);
                  props.onPickModel(model);
                }}
                onConnect={(provider, model) => {
                  setMenu(undefined);
                  props.onConnectModel(provider, model);
                }}
                onBudget={props.onBudget}
                onClose={() => setMenu(undefined)}
              />
            ) : null}
          </span>

          <span className="composer-flex" />

          {dictationSupported() ? (
            <button
              type="button"
              className="icon-button record"
              data-listening={listening}
              title={listening ? "Stop dictating" : "Dictate"}
              aria-label={listening ? "Stop dictating" : "Dictate"}
              aria-pressed={listening}
              onClick={listen}
            >
              <Microphone />
            </button>
          ) : null}

          {props.busy ? (
            <button
              type="button"
              className="send"
              data-stop="true"
              aria-label="Stop"
              title="Stop"
              onClick={props.onStop}
            >
              <StopGlyph />
            </button>
          ) : (
            <button
              type="button"
              className="send"
              disabled={text.trim().length === 0}
              aria-label="Send"
              title="Send"
              onClick={send}
            >
              <SendGlyph />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The chip is the only place the chosen model is named at rest, so it must not
 * read as ready when its provider holds no credentials — the send that fails is
 * too late to learn it. An unknown id (the list has not arrived) claims nothing.
 */
export function modelChipState(current: ModelInfo | undefined): { connected: boolean; title: string } {
  if (current === undefined || current.available) {
    return {
      connected: true,
      title: "The model this thread will use next. Tap to switch model or set the view budget.",
    };
  }
  return {
    connected: false,
    title: `${current.label} is not connected — tap to connect it, or to pick a model that is.`,
  };
}

/**
 * Connected providers first and selectable; the rest sit under a rule and open
 * the Connect sheet instead of switching (docs/DESIGN.md, the composer). The
 * view budget is the foot of the same menu: it is a property of the next turn,
 * not a control of its own.
 */
function ModelMenu({
  models,
  current,
  budget,
  onPick,
  onConnect,
  onBudget,
  onClose,
}: {
  models: ModelInfo[];
  current: string;
  budget: number;
  onPick: (model: string) => void;
  onConnect: (provider: ProviderId, model: string) => void;
  onBudget: (budget: number) => void;
  onClose: () => void;
}): React.JSX.Element {
  useDismiss(onClose);
  const ready = models.filter((model) => model.available);
  const waiting = models.filter((model) => !model.available);

  return (
    <div className="menu menu-up" role="menu">
      {byProvider(ready).map(([provider, list]) => (
        <div key={provider}>
          <div className="menu-group">{providerLabel(provider)}</div>
          {list.map((model) => (
            <button
              key={model.id}
              type="button"
              className="menu-item"
              role="menuitem"
              data-active={model.id === current}
              onClick={() => onPick(model.id)}
            >
              {model.label}
              {model.supportsTools ? null : <small className="warn">no recall</small>}
            </button>
          ))}
        </div>
      ))}
      {waiting.length > 0 ? (
        <>
          <div className="menu-rule">connect ▸</div>
          {waiting.map((model) => (
            <button
              key={model.id}
              type="button"
              className="menu-item"
              role="menuitem"
              data-disabled="true"
              onClick={() => onConnect(model.provider, model.id)}
            >
              {model.label}
              <small>{providerLabel(model.provider)}</small>
            </button>
          ))}
        </>
      ) : null}
      {models.length === 0 ? <div className="empty">No models available.</div> : null}
      <div className="menu-foot">
        <div className="menu-group">view budget</div>
        <div className="segmented">
          {BUDGETS.map(([value, label]) => (
            <button key={value} type="button" data-active={budget === value} onClick={() => onBudget(value)}>
              {label}
            </button>
          ))}
        </div>
        <p className="menu-foot-note">How much the model may see each turn. The archive is never affected.</p>
      </div>
    </div>
  );
}

/** The three budgets the app offers, smallest first. */
const BUDGETS: ReadonlyArray<readonly [number, string]> = [
  [8192, "8k demo"],
  [32768, "32k"],
  [131072, "128k"],
];

function byProvider(models: ModelInfo[]): Array<[ProviderId, ModelInfo[]]> {
  const groups = new Map<ProviderId, ModelInfo[]>();
  for (const model of models) {
    const list = groups.get(model.provider) ?? [];
    list.push(model);
    groups.set(model.provider, list);
  }
  return [...groups.entries()];
}

export function useDismiss(onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".menu, .model-chip, .icon-button, .thread-title, .account") === null) {
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

function Microphone(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect
        x="9"
        y="3"
        width="6"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SendGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V5M12 5 6 11M12 5l6 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopGlyph(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  );
}
