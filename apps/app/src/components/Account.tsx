import type { Me } from "@pylos/protocol";
import { useState } from "react";
import { useDismiss } from "./Composer.tsx";

export interface AccountProps {
  me: Me;
  onSignOut: () => void;
}

/** Hosted mode only: who this vault belongs to, and the way out. */
export function Account(props: AccountProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const name = props.me.name ?? props.me.email ?? "your xAI account";
  const initial = name.trim().slice(0, 1).toUpperCase();

  return (
    <span className="menu-anchor">
      <button
        type="button"
        className="account"
        data-open={open}
        title={name}
        aria-label="Account"
        onClick={() => setOpen((value) => !value)}
      >
        {initial}
      </button>
      {open ? <AccountMenu me={props.me} onSignOut={props.onSignOut} onClose={() => setOpen(false)} /> : null}
    </span>
  );
}

function AccountMenu({
  me,
  onSignOut,
  onClose,
}: {
  me: Me;
  onSignOut: () => void;
  onClose: () => void;
}): React.JSX.Element {
  useDismiss(onClose);
  return (
    <div className="menu menu-down" role="menu">
      <div className="account-who">
        <b>{me.name ?? "Signed in"}</b>
        {me.email === undefined ? null : <span>{me.email}</span>}
      </div>
      <div className="menu-sep" />
      <button type="button" className="menu-item" role="menuitem" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}
