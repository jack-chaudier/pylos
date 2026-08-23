import type { Me } from "@pylos/protocol";
import { Fragment, useCallback, useState } from "react";
import { api, type LoginStart } from "../api.ts";
import { useDeviceFlow } from "../poll.ts";
import { openExternal } from "../tauri.ts";
import { DeviceCode, Gate } from "./Gate.tsx";

const PROOFS = "https://github.com/jack-chaudier/pylos/tree/main/bench/results";
/** Each is a measured result in `bench/results`, which is where the link goes. */
const CLAIMS = ["1,000,000 turns", "view ≤ 8,192 tokens", "ledger conserved", "chain verified"];
const REPO = "https://github.com/jack-chaudier/pylos";

export interface SignInProps {
  onSignedIn: (session: string, me: Me) => void;
}

/** Hosted Pylos begins here: one account, one vault, one thread. */
export function SignIn(props: SignInProps): React.JSX.Element {
  const [start, setStart] = useState<LoginStart | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const begin = useCallback((): void => {
    setBusy(true);
    setError(undefined);
    void api
      .loginStart()
      .then((started) => {
        setStart(started);
        void openExternal(started.verificationUrlComplete ?? started.verificationUrl);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setBusy(false));
  }, []);

  return (
    <Gate
      label="Sign in to Pylos"
      foot={
        <p className="gate-foot-line">
          Open source · Apache-2.0 ·{" "}
          <a href={REPO} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </p>
      }
    >
      {start === undefined ? (
        <>
          <button type="button" className="pill gate-cta" disabled={busy} onClick={begin}>
            {busy ? "Starting…" : "Sign in with xAI"}
          </button>
          {error === undefined ? null : <p className="gate-error">{error}</p>}
        </>
      ) : (
        <Waiting start={start} onSignedIn={props.onSignedIn} />
      )}

      <p className="gate-proof">
        <a href={PROOFS} target="_blank" rel="noopener noreferrer">
          {CLAIMS.map((claim, index) => (
            <Fragment key={claim}>
              {index === 0 ? null : " "}
              <span>
                {claim}
                {index === CLAIMS.length - 1 ? "" : " ·"}
              </span>
            </Fragment>
          ))}
        </a>
      </p>
    </Gate>
  );
}

function Waiting({
  start,
  onSignedIn,
}: {
  start: LoginStart;
  onSignedIn: (session: string, me: Me) => void;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | undefined>(undefined);
  const url = start.verificationUrlComplete ?? start.verificationUrl;
  const { error } = useDeviceFlow({
    handle: start.handle,
    expiresIn: start.expiresIn,
    interval: start.interval,
    poll: api.loginPoll,
    onDone: (result) => onSignedIn(result.session, result.me),
  });

  return (
    <DeviceCode
      code={start.userCode}
      url={url}
      note="Waiting for the browser…"
      error={error ?? copyError}
      copied={copied}
      onOpen={(target) => void openExternal(target)}
      onCopy={() => {
        void navigator.clipboard
          ?.writeText(start.userCode)
          .then(() => {
            setCopied(true);
            setCopyError(undefined);
            setTimeout(() => setCopied(false), 1800);
          })
          .catch(() => setCopyError("Copying was blocked — read the code aloud instead."));
      }}
    />
  );
}
