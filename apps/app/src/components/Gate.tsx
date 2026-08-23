/**
 * The one screen that stands between you and the thread — hosted sign-in and
 * local connect are the same picture with different buttons.
 */
export interface GateProps {
  /** Over a thread that already exists, rather than the whole window. */
  overlay?: boolean;
  label: string;
  children: React.ReactNode;
  foot?: React.ReactNode;
}

export function Gate(props: GateProps): React.JSX.Element {
  const overlay = props.overlay === true;
  return (
    <section
      className="gate"
      data-overlay={overlay}
      aria-label={props.label}
      // Over a thread it is modal; on its own it is simply the screen.
      role={overlay ? "dialog" : undefined}
    >
      <img className="gate-plate" src={`${import.meta.env.BASE_URL}art/empyrean.webp`} alt="" />
      <div className="gate-card">
        <h1 className="wordmark">Pylos</h1>
        <p className="gate-line">One conversation. Every model. Nothing forgotten silently.</p>
        {props.children}
      </div>
      {props.foot === undefined ? null : <div className="gate-foot">{props.foot}</div>}
    </section>
  );
}

/** The device code, as the browser on the other side will ask for it. */
export function DeviceCode({
  code,
  url,
  note,
  error,
  onOpen,
  onCopy,
  copied,
  onBack,
}: {
  code: string;
  url: string;
  note: string;
  error: string | undefined;
  onOpen: (url: string) => void;
  onCopy?: () => void;
  copied?: boolean;
  onBack?: () => void;
}): React.JSX.Element {
  return (
    <>
      <p className="gate-note">Enter this code on x.ai. It is one-time and expires.</p>
      <div className="gate-code">{code}</div>
      <div className="gate-actions">
        {onBack === undefined ? null : (
          <button type="button" className="ghost" onClick={onBack}>
            Back
          </button>
        )}
        {onCopy === undefined ? null : (
          <button type="button" className="ghost" onClick={onCopy}>
            {copied === true ? "Copied" : "Copy code"}
          </button>
        )}
        <button type="button" className="pill" onClick={() => onOpen(url)}>
          Open x.ai
        </button>
      </div>
      <p className="gate-note">{note}</p>
      {error === undefined ? null : <p className="gate-error">{error}</p>}
    </>
  );
}
