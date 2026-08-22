#!/usr/bin/env bun
/**
 * The dev orchestrator Tauri's `beforeDevCommand` runs: start the Pylos server
 * if nothing is already listening, then hand over to Vite — running in
 * `apps/app`, the shared UI this shell wraps — in the foreground. Both die with
 * this process.
 */
const PORT = Number(process.env.PYLOS_PORT ?? 7334);
const UI_PORT = Number(process.env.PYLOS_UI_PORT ?? 1420);
const SERVER_ENTRY = new URL("../../../packages/server/src/index.ts", import.meta.url).pathname;
const APP_DIR = new URL("../../app", import.meta.url).pathname;

async function listening(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(600),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const children: Array<{ kill: () => void }> = [];

if (await listening()) {
  process.stdout.write(`pylos: reusing the server already on :${PORT}\n`);
} else {
  const server = Bun.spawn(["bun", "run", SERVER_ENTRY, "serve"], {
    env: { ...process.env, PYLOS_PORT: String(PORT) },
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(server);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await listening()) break;
    await Bun.sleep(150);
  }
  process.stdout.write(`pylos: server up on :${PORT}\n`);
}

const vite = Bun.spawn(["bunx", "vite", "--port", String(UI_PORT), "--strictPort"], {
  cwd: APP_DIR,
  env: { ...process.env },
  stdout: "inherit",
  stderr: "inherit",
});
children.push(vite);

const stop = (): void => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await vite.exited;
stop();
