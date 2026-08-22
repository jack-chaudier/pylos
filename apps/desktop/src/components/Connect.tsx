import type { AuthStatus, ProviderId } from "@pylos/protocol";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { providerLabel } from "../format.ts";
import { openExternal } from "../tauri.ts";

export interface ConnectProps {
  statuses: AuthStatus[];
  grokCliAvailable: boolean;
  onDone: () => void;
  onClose: () => void;
}

type View =
  | { kind: "root" }
  | { kind: "key"; provider: ProviderId }
  | { kind: "device"; userCode: string; url: string; handle: string };

/** Not a wizard. One small sheet, opened by the first send. */
export function Connect(props: ConnectProps): React.JSX.Element {
  const [view, setView] = useState<View>({ kind: "root" });
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const statusOf = (provider: ProviderId): AuthStatus | undefined =>
    props.statuses.find((status) => status.provider === provider);

  const run = async (task: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await task();
      props.onDone();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-backdrop">
      <button type="button" className="scrim" aria-label="Close" onClick={props.onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Connect a model">
        {view.kind === "root" ? (
          <>
            <h3>Connect a model</h3>
            <p>
              Pylos keeps the archive. A model is only borrowed cognition — connect one and it can continue
              the thread.
            </p>

            {props.grokCliAvailable ? (
              <button
                type="button"
                className="option"
                disabled={busy}
                onClick={() => void run(() => api.importGrokCli())}
              >
                <Mark />
                <span className="option-body">
                  <span className="option-title">Import your Grok CLI login</span>
                  <span className="option-sub">reads ~/.grok/auth.json · nothing is printed</span>
                </span>
              </button>
            ) : null}

            <button
              type="button"
              className="option"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    const started = await api.deviceStart();
                    setView({
                      kind: "device",
                      userCode: started.userCode,
                      url: started.verificationUrl,
                      handle: started.handle,
                    });
                    void openExternal(started.verificationUrl);
                  } catch (cause) {
                    setError((cause as Error).message);
                  } finally {
                    setBusy(false);
                  }
                })()
              }
            >
              <Mark />
              <span className="option-body">
                <span className="option-title">Sign in with xAI</span>
                <span className="option-sub">a one-time code in your browser</span>
              </span>
            </button>

            {(["xai", "anthropic", "openai", "openai-compatible"] as ProviderId[]).map((provider) => {
              const status = statusOf(provider);
              const connected = status?.ok === true;
              return (
                <button
                  key={provider}
                  type="button"
                  className="option"
                  disabled={busy}
                  onClick={() => setView({ kind: "key", provider })}
                >
                  <Mark dim={!connected} />
                  <span className="option-body">
                    <span className="option-title">
                      {providerLabel(provider)}
                      {provider === "openai-compatible" ? "" : " API key"}
                    </span>
                    <span className={`option-sub${connected ? " ok" : ""}`}>
                      {connected ? `connected · ${status?.identity ?? ""}` : "not connected"}
                    </span>
                  </span>
                </button>
              );
            })}

            <p className="sheet-note">
              Credentials live in ~/.pylos/auth.json (0600). They never enter the vault, an export, or an API
              response.
            </p>
            {error !== undefined ? <p className="sheet-error">{error}</p> : null}
            <div className="sheet-actions">
              <button type="button" className="ghost" onClick={props.onClose}>
                Later
              </button>
            </div>
          </>
        ) : null}

        {view.kind === "key" ? (
          <KeyForm
            provider={view.provider}
            busy={busy}
            error={error}
            connected={statusOf(view.provider)?.ok === true}
            onBack={() => {
              setView({ kind: "root" });
              setError(undefined);
            }}
            onLogout={() => void run(() => api.logout(view.provider))}
            onSubmit={(key, baseUrl) => void run(() => api.setApiKey(view.provider, key, baseUrl))}
          />
        ) : null}

        {view.kind === "device" ? (
          <DevicePoll
            userCode={view.userCode}
            url={view.url}
            handle={view.handle}
            onDone={props.onDone}
            onBack={() => setView({ kind: "root" })}
          />
        ) : null}
      </div>
    </div>
  );
}

function KeyForm({
  provider,
  busy,
  error,
  connected,
  onBack,
  onSubmit,
  onLogout,
}: {
  provider: ProviderId;
  busy: boolean;
  error: string | undefined;
  connected: boolean;
  onBack: () => void;
  onSubmit: (key: string, baseUrl?: string) => void;
  onLogout: () => void;
}): React.JSX.Element {
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const compatible = provider === "openai-compatible";
  return (
    <>
      <h3>{providerLabel(provider)}</h3>
      <p>
        {provider === "xai"
          ? "An xAI API key starts with xai-."
          : compatible
            ? "Any endpoint that speaks /v1/chat/completions."
            : "The key is stored locally and sent only to this provider."}
      </p>
      {compatible ? (
        <div className="field">
          <input
            value={baseUrl}
            placeholder="https://host/v1"
            spellCheck={false}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </div>
      ) : null}
      <div className="field">
        <input
          type="password"
          value={key}
          placeholder={provider === "xai" ? "xai-…" : "sk-…"}
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: a modal that asks for exactly one value
          autoFocus
          onChange={(event) => setKey(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && key.trim().length > 0) {
              onSubmit(key.trim(), compatible ? baseUrl.trim() : undefined);
            }
          }}
        />
      </div>
      {error !== undefined ? <p className="sheet-error">{error}</p> : null}
      <div className="sheet-actions">
        {connected ? (
          <button type="button" className="ghost" onClick={onLogout}>
            Disconnect
          </button>
        ) : null}
        <span style={{ flex: 1 }} />
        <button type="button" className="ghost" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="pill"
          disabled={busy || key.trim().length === 0}
          onClick={() => onSubmit(key.trim(), compatible ? baseUrl.trim() : undefined)}
        >
          Connect
        </button>
      </div>
    </>
  );
}

function DevicePoll({
  userCode,
  url,
  handle,
  onDone,
  onBack,
}: {
  userCode: string;
  url: string;
  handle: string;
  onDone: () => void;
  onBack: () => void;
}): React.JSX.Element {
  const [message, setMessage] = useState("Waiting for the browser…");
  const [failed, setFailed] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      if (done.current) return;
      try {
        const result = await api.devicePoll(handle);
        if ("pending" in result) {
          timer = setTimeout(() => void poll(), 2500);
          return;
        }
        done.current = true;
        setMessage(`Connected as ${result.identity ?? "your xAI account"}.`);
        setTimeout(onDone, 550);
      } catch (cause) {
        done.current = true;
        setFailed(true);
        setMessage((cause as Error).message);
      }
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => {
      done.current = true;
      clearTimeout(timer);
    };
  }, [handle, onDone]);

  return (
    <>
      <h3>Sign in with xAI</h3>
      <p>Enter this code on x.ai. The code is one-time and expires.</p>
      <div className="device-code">{userCode}</div>
      <p className="sheet-note" style={{ textAlign: "center" }}>
        {message}
      </p>
      <div className="sheet-actions">
        <button type="button" className="ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="pill" onClick={() => void openExternal(url)}>
          {failed ? "Retry in browser" : "Open browser"}
        </button>
      </div>
    </>
  );
}

function Mark({ dim }: { dim?: boolean }): React.JSX.Element {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ opacity: dim === true ? 0.35 : 0.9, flex: "none" }}
    >
      <circle cx="12" cy="12" r="9" stroke="var(--verdigris)" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="3" stroke="var(--verdigris)" strokeWidth="1.5" />
    </svg>
  );
}
