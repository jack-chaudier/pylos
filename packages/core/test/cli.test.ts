import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/** A nonzero candidate avoids Bun 1.3's unsupported port-0 server bind. */
function candidatePort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

/** The candidate bind is itself the probe; retry if another process wins it. */
async function startServer(home: string): Promise<{ server: Bun.Subprocess; url: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = candidatePort();
    const server = Bun.spawn(["bun", CLI, "serve", "--port", String(port), "--home", home], {
      stdout: "pipe",
      stderr: "inherit",
    });
    try {
      const url = await listeningUrl(server.stdout, 5_000);
      return { server, url };
    } catch (error) {
      lastError = error;
      server.kill("SIGTERM");
      await server.exited;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("server did not bind a probed port");
}

/** The line the server prints once it is bound, or a failure with what it did print. */
async function listeningUrl(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const deadline = Bun.sleep(timeoutMs).then(() => undefined);
  let seen = "";
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === undefined || chunk.done) throw new Error(`server never bound: ${seen}`);
      seen += decoder.decode(chunk.value, { stream: true });
      const match = /listening on (http:\/\/\S+)/.exec(seen);
      if (match?.[1] !== undefined) return match[1];
    }
  } finally {
    reader.releaseLock();
  }
}

test("`pylos serve` stays up until it is signalled, and answers on its own profile", async () => {
  const home = mkdtempSync(join(tmpdir(), "pylos-cli-"));
  homes.push(home);
  const { server, url } = await startServer(home);
  try {
    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, home, backend: "core" });
    // Still serving: the command did not return the moment the port was bound.
    expect(server.killed).toBe(false);
  } finally {
    server.kill("SIGTERM");
  }
  expect(await server.exited).toBe(0);
}, 30_000);
