#!/usr/bin/env bun
/**
 * `@pylos/server` — the local API. Loopback only.
 *
 *   bun run packages/server/src/index.ts [serve] [--port 7334] [--home ~/.pylos]
 */
import { PYLOS_VERSION } from "@pylos/protocol";
import { pylosHome } from "./home.ts";
import { type ServeOptions, serve } from "./serve.ts";

export { AuthService } from "./auth/xai.ts";
export type { Kernel } from "./kernel.ts";
export { openKernel, registerCore } from "./kernel.ts";
export { DEFAULT_MODEL, ProviderRegistry } from "./providers/registry.ts";
export type { Provider, ProviderEvent, ProviderFn } from "./providers/types.ts";
export type { PylosServer, ServeOptions, ServerContext } from "./serve.ts";
export { createContext, createFetch, serve } from "./serve.ts";

function parseArgs(argv: string[]): ServeOptions & { help: boolean; version: boolean } {
  const options: ServeOptions & { help: boolean; version: boolean } = {
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "serve") continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--port" || arg === "-p") {
      const value = Number(argv[++i]);
      if (Number.isFinite(value)) options.port = value;
    } else if (arg === "--home") {
      const value = argv[++i];
      if (value !== undefined) options.home = value;
    }
  }
  return options;
}

/** The CLI entry, exported so the compiled sidecar can call it directly. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.version) {
    process.stdout.write(`pylos ${PYLOS_VERSION}\n`);
    return;
  }
  if (args.help) {
    process.stdout.write(
      [
        `pylos ${PYLOS_VERSION} — the forever chat, local API`,
        "",
        "  pylos serve [--port 7334] [--home ~/.pylos]",
        "",
        "Environment: PYLOS_PORT, PYLOS_HOME, PYLOS_AUTH_PATH, OLLAMA_HOST",
        "",
      ].join("\n"),
    );
    return;
  }

  const server = await serve(args);
  const home = args.home ?? pylosHome();
  process.stdout.write(
    `pylos ${PYLOS_VERSION} listening on ${server.url} · home ${home} · kernel ${server.kernel.backend}\n`,
  );

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    void server.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`pylos: ${(error as Error).message ?? String(error)}\n`);
    process.exit(1);
  });
}
