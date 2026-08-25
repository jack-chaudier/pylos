/**
 * The thin Tauri seam. Every call degrades to a browser equivalent so the UI
 * runs under plain `vite dev` as well as inside the shell.
 */
export const inTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object);

export const isMac: boolean = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/**
 * The browser compatibility path deliberately has a finite ceiling.  The
 * desktop path below sends bytes between the sidecar and a selected file, so
 * it is the only path intended for a vault larger than this limit.
 */
export const MAX_WEB_BUNDLE_BYTES = 64 * 1024 * 1024;

export interface BundleTransfer<T> {
  /** Resolves only after the native sidecar has committed the destination. */
  done: Promise<T>;
  /** Cancels at the next bounded I/O boundary and removes any partial file. */
  abort: () => void;
}

/** The port the shell started the server on. Undefined outside Tauri. */
export async function shellPort(): Promise<string | undefined> {
  if (!inTauri) return undefined;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string>("pylos_port");
  } catch {
    return undefined;
  }
}

export async function openExternal(url: string): Promise<void> {
  if (inTauri) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return;
    } catch {
      // fall through to the browser
    }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function transferId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Starts an export whose body is written by the Rust shell directly to the
 * selected path.  The returned promise is intentionally separate from the
 * abort handle so callers can stop a large transfer without materialising a
 * response in the webview.
 */
export function streamBundleToFile(
  url: string,
  path: string,
  passphrase: string,
  authorization: string | null,
): BundleTransfer<string> {
  if (!inTauri) throw new Error("Native bundle streaming is available only in the desktop shell.");
  const id = transferId();
  let cancelled = false;
  const done = import("@tauri-apps/api/core").then(({ invoke }) => {
    if (cancelled) throw new Error("bundle transfer cancelled");
    return invoke<string>("export_bundle_to_file", {
      transferId: id,
      url,
      path,
      passphrase,
      authorization,
    });
  });
  return {
    done,
    abort: () => {
      if (cancelled) return;
      cancelled = true;
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("cancel_bundle_transfer", { transferId: id }))
        .catch(() => undefined);
    },
  };
}

/** Starts a multipart import streamed from the selected path by the shell. */
export function streamBundleFromFile(
  url: string,
  path: string,
  passphrase: string,
  authorization: string | null,
): BundleTransfer<string> {
  if (!inTauri) throw new Error("Native bundle streaming is available only in the desktop shell.");
  const id = transferId();
  let cancelled = false;
  const done = import("@tauri-apps/api/core").then(({ invoke }) => {
    if (cancelled) throw new Error("bundle transfer cancelled");
    return invoke<string>("import_bundle_from_file", {
      transferId: id,
      url,
      path,
      passphrase,
      authorization,
    });
  });
  return {
    done,
    abort: () => {
      if (cancelled) return;
      cancelled = true;
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("cancel_bundle_transfer", { transferId: id }))
        .catch(() => undefined);
    },
  };
}

/** Opens the native save dialog without reading or writing bundle bytes. */
export async function chooseBundleSavePath(suggestedName: string): Promise<string | undefined> {
  if (!inTauri) return undefined;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: "Pylos bundle", extensions: ["pylos"] }],
  });
  return path ?? undefined;
}

/** Opens the native file picker without reading the selected bundle. */
export async function chooseBundleOpenPath(): Promise<string | undefined> {
  if (!inTauri) return undefined;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({
    multiple: false,
    filters: [{ name: "Pylos bundle", extensions: ["pylos"] }],
  });
  return typeof path === "string" ? path : undefined;
}

/** Returns the chosen path, or undefined when the user cancelled. */
export async function saveBytes(suggestedName: string, bytes: Uint8Array): Promise<string | undefined> {
  if (bytes.byteLength > MAX_WEB_BUNDLE_BYTES) {
    throw new Error("This browser export is capped at 64 MiB; use the desktop shell for a full vault.");
  }
  if (inTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: suggestedName,
      filters: [{ name: "Pylos bundle", extensions: ["pylos"] }],
    });
    if (path === null) return undefined;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("write_file", { path, contents: [...bytes] });
    return path;
  }
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.click();
  URL.revokeObjectURL(url);
  return suggestedName;
}

export async function pickBundle(): Promise<{ name: string; bytes: Uint8Array } | undefined> {
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      multiple: false,
      filters: [{ name: "Pylos bundle", extensions: ["pylos"] }],
    });
    if (typeof path !== "string") return undefined;
    const { invoke } = await import("@tauri-apps/api/core");
    const contents = await invoke<number[]>("read_file", { path });
    if (contents.length > MAX_WEB_BUNDLE_BYTES) {
      throw new Error("This browser-compatible import is capped at 64 MiB; use the desktop shell.");
    }
    return {
      name: path.split(/[\\/]/).pop() ?? "thread.pylos",
      bytes: Uint8Array.from(contents),
    };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".pylos";
    input.onchange = () => {
      const file = input.files?.[0];
      if (file === undefined) {
        resolve(undefined);
        return;
      }
      if (file.size > MAX_WEB_BUNDLE_BYTES) {
        resolve(undefined);
        return;
      }
      void file.arrayBuffer().then((buffer) => {
        resolve({ name: file.name, bytes: new Uint8Array(buffer) });
      });
    };
    input.click();
  });
}

/** Called once the first paint is up so the shell can reveal the window. */
export async function showWindow(): Promise<void> {
  if (!inTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const current = getCurrentWindow();
    await current.show();
    await current.setFocus();
  } catch {
    // The shell may already have shown it.
  }
}
