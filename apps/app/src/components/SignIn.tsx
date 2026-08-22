import type { Me } from "@pylos/protocol";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { api, type LoginStart } from "../api.ts";
import { openExternal } from "../tauri.ts";
import { SealMark } from "./Seal.tsx";

const POLL_MS = 2500;
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
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const { onSignedIn } = props;

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

  const done = useRef(false);
  useEffect(() => {
    if (start === undefined) return;
    done.current = false;
    const deadline = Date.now() + Math.max(1, start.expiresIn) * 1000;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async (): Promise<void> => {
      if (done.current) return;
      if (Date.now() > deadline) {
        done.current = true;
        setStart(undefined);
        setError("That code expired. Start again.");
        return;
      }
      try {
        const result = await api.loginPoll(start.handle);
        if ("pending" in result) {
          timer = setTimeout(() => void poll(), POLL_MS);
          return;
        }
        done.current = true;
        onSignedIn(result.session, result.me);
      } catch (cause) {
        done.current = true;
        setStart(undefined);
        setError((cause as Error).message);
      }
    };

    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      done.current = true;
      clearTimeout(timer);
    };
  }, [start, onSignedIn]);

  return (
    <div className="signin">
      <div className="signin-card">
        <SealMark className="seal-emblem" />
        <h1>pylos</h1>
        <p className="signin-line">One conversation. Every model. Nothing forgotten silently.</p>

        {start === undefined ? (
          <button type="button" className="pill signin-cta" disabled={busy} onClick={begin}>
            {busy ? "Starting…" : "Sign in with xAI"}
          </button>
        ) : (
          <>
            <p className="signin-note">Enter this code on x.ai. It is one-time and expires.</p>
            <div className="signin-code">{start.userCode}</div>
            <div className="signin-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(start.userCode)
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1800);
                    })
                    .catch(() => setError("Copying was blocked — read the code aloud instead."));
                }}
              >
                {copied ? "Copied" : "Copy code"}
              </button>
              <button
                type="button"
                className="pill"
                onClick={() => void openExternal(start.verificationUrlComplete ?? start.verificationUrl)}
              >
                Open x.ai
              </button>
            </div>
            <p className="signin-note">Waiting for the browser…</p>
          </>
        )}

        {error !== undefined ? <p className="signin-error">{error}</p> : null}

        <p className="signin-proof">
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
      </div>

      <p className="signin-foot">
        Open source · Apache-2.0 ·{" "}
        <a href={REPO} target="_blank" rel="noopener noreferrer">
          GitHub
        </a>
      </p>
    </div>
  );
}
