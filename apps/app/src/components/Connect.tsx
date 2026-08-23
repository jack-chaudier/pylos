import type { AuthStatus, ProviderId } from "@pylos/protocol";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { providerLabel } from "../format.ts";
import { useDeviceFlow } from "../poll.ts";
import { openExternal } from "../tauri.ts";
import { DeviceCode, Gate } from "./Gate.tsx";

const KEYED: ProviderId[] = ["xai", "anthropic", "openai", "openai-compatible"];

export interface ConnectProps {
  statuses: AuthStatus[];
  grokCliAvailable: boolean;
  /** The provider a not-connected model asked for; the sheet opens on it. */
  focus: ProviderId | undefined;
  onDone: () => void;
  onClose: () => void;
}

type View =
  | { kind: "root" }
  | { kind: "key"; provider: ProviderId }
  | { kind: "device"; userCode: string; url: string; handle: string; expiresIn: number; interval: number };

/** Local Pylos: the same screen as hosted sign-in, over the thread you already have. */
export function Connect(props: ConnectProps): React.JSX.Element {
  const [view, setView] = useState<View>(
    props.focus === undefined || props.focus === "ollama"
      ? { kind: "root" }
      : { kind: "key", provider: props.focus },
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const statusOf = (provider: ProviderId): AuthStatus | undefined =>
    props.statuses.find((status) => status.provider === provider);

  const { onClose } = props;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const startDevice = (): void => {
    setBusy(true);
    setError(undefined);
    void api
      .deviceStart()
      .then((started) => {
        setView({
          kind: "device",
          userCode: started.userCode,
          url: started.verificationUrl,
          handle: started.handle,
          expiresIn: started.expiresIn,
          interval: started.interval,
        });
        void openExternal(started.verificationUrl);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  };

  return (
    <Gate overlay label="Connect a model">
      {view.kind === "root" ? (
        <>
          <button type="button" className="pill gate-cta" disabled={busy} onClick={startDevice}>
            Sign in with xAI
          </button>
          <button
            type="button"
            className="ghost gate-choice"
            disabled={busy}
            onClick={() => setView({ kind: "key", provider: "xai" })}
          >
            Use an API key
          </button>
          {props.grokCliAvailable ? (
            <button
              type="button"
              className="ghost gate-choice"
              disabled={busy}
              onClick={() => void run(() => api.importGrokCli())}
            >
              Import Grok CLI login
            </button>
          ) : null}
          <p className="gate-note">
            Credentials live in ~/.pylos/auth.json (0600). They never enter the vault, an export, or an API
            response.
          </p>
          {error === undefined ? null : <p className="gate-error">{error}</p>}
          <button type="button" className="gate-later" onClick={onClose}>
            later
          </button>
        </>
      ) : null}

      {view.kind === "key" ? (
        <KeyForm
          provider={view.provider}
          statuses={props.statuses}
          busy={busy}
          error={error}
          connected={statusOf(view.provider)?.ok === true}
          onProvider={(provider) => {
            setView({ kind: "key", provider });
            setError(undefined);
          }}
          onBack={() => {
            setView({ kind: "root" });
            setError(undefined);
          }}
          onLogout={() => void run(() => api.logout(view.provider))}
          onSubmit={(key, baseUrl) => void run(() => api.setApiKey(view.provider, key, baseUrl))}
        />
      ) : null}

      {view.kind === "device" ? (
        <Waiting
          userCode={view.userCode}
          url={view.url}
          handle={view.handle}
          expiresIn={view.expiresIn}
          interval={view.interval}
          onDone={props.onDone}
          onBack={() => setView({ kind: "root" })}
        />
      ) : null}
    </Gate>
  );
}

function KeyForm({
  provider,
  statuses,
  busy,
  error,
  connected,
  onProvider,
  onBack,
  onSubmit,
  onLogout,
}: {
  provider: ProviderId;
  statuses: AuthStatus[];
  busy: boolean;
  error: string | undefined;
  connected: boolean;
  onProvider: (provider: ProviderId) => void;
  onBack: () => void;
  onSubmit: (key: string, baseUrl?: string) => void;
  onLogout: () => void;
}): React.JSX.Element {
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const compatible = provider === "openai-compatible";
  return (
    <>
      <div className="gate-providers">
        {KEYED.map((id) => (
          <button
            key={id}
            type="button"
            className="gate-provider"
            data-active={id === provider}
            data-connected={statuses.find((status) => status.provider === id)?.ok === true}
            onClick={() => onProvider(id)}
          >
            {providerLabel(id)}
          </button>
        ))}
      </div>
      <p className="gate-note">
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
      {error === undefined ? null : <p className="gate-error">{error}</p>}
      <div className="gate-actions">
        {connected ? (
          <button type="button" className="ghost" onClick={onLogout}>
            Disconnect
          </button>
        ) : null}
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

function Waiting({
  userCode,
  url,
  handle,
  expiresIn,
  interval,
  onDone,
  onBack,
}: {
  userCode: string;
  url: string;
  handle: string;
  expiresIn: number;
  interval: number;
  onDone: () => void;
  onBack: () => void;
}): React.JSX.Element {
  const [connected, setConnected] = useState<string | undefined>(undefined);
  const { error } = useDeviceFlow({
    handle,
    expiresIn,
    interval,
    poll: api.devicePoll,
    onDone: (status) => {
      setConnected(status.identity ?? "your xAI account");
      setTimeout(onDone, 550);
    },
  });

  return (
    <DeviceCode
      code={userCode}
      url={url}
      note={connected === undefined ? "Waiting for the browser…" : `Connected as ${connected}.`}
      error={error}
      onOpen={(target) => void openExternal(target)}
      onBack={onBack}
    />
  );
}
