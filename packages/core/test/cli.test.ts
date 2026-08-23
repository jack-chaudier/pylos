import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

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
  const server = Bun.spawn(["bun", CLI, "serve", "--port", "0", "--home", home], {
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    const url = await listeningUrl(server.stdout, 10_000);
    const health = await fetch(`${url}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, home, backend: "core" });
    // Still serving: the command did not return the moment the port was bound.
    expect(server.killed).toBe(false);
  } finally {
    server.kill("SIGTERM");
  }
  expect(await server.exited).toBe(0);
}, 20_000);
