/**
 * The thin Tauri seam. Every call degrades to a browser equivalent so the UI
 * runs under plain `vite dev` as well as inside the shell.
 */
export const inTauri: boolean = typeof window !== "undefined" && "__TAURI_INTERNALS__" in (window as object);

export const isMac: boolean = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

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

/** Returns the chosen path, or undefined when the user cancelled. */
export async function saveBytes(suggestedName: string, bytes: Uint8Array): Promise<string | undefined> {
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
