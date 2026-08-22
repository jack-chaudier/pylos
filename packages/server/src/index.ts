#!/usr/bin/env bun
/**
 * `@pylos/server` — the Pylos API.
 *
 *   bun run packages/server/src/index.ts [serve] [--port 7334] [--home ~/.pylos]
 *   bun run packages/server/src/index.ts serve --hosted --web ./app --origin https://pylos.example
 */
import { PYLOS_VERSION } from "@pylos/protocol";
import { pylosHome } from "./home.ts";
import { type ServeOptions, serve, splitOrigins } from "./serve.ts";

export { AuthService } from "./auth/xai.ts";
export type { ContextOptions, ServerContext } from "./context.ts";
export { createContext } from "./context.ts";
export { HostedRegistry } from "./hosted.ts";
export type { Kernel } from "./kernel.ts";
export { openKernel, registerCore } from "./kernel.ts";
export { DEFAULT_MODEL, ProviderRegistry } from "./providers/registry.ts";
export type { Provider, ProviderEvent, ProviderFn } from "./providers/types.ts";
export type { Handler, PylosServer, ServeOptions } from "./serve.ts";
export { createFetch, createHostedFetch, serve } from "./serve.ts";
export { staticSite } from "./static.ts";

interface Args extends ServeOptions {
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const options: Args = { help: false, version: false };
  const origins: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "serve") continue;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--hosted") options.hosted = true;
    else if (arg === "--port" || arg === "-p") {
      const value = Number(argv[++i]);
      if (Number.isFinite(value)) options.port = value;
    } else if (arg === "--home") {
      const value = argv[++i];
      if (value !== undefined) options.home = value;
    } else if (arg === "--host") {
      const value = argv[++i];
      if (value !== undefined) options.host = value;
    } else if (arg === "--web") {
      const value = argv[++i];
      if (value !== undefined) options.web = value;
    } else if (arg === "--origin") {
      origins.push(...splitOrigins(argv[++i]));
    }
  }
  if (origins.length > 0) options.origins = origins;
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
        `pylos ${PYLOS_VERSION} — the forever chat, API server`,
        "",
        "  pylos serve [--port 7334] [--home ~/.pylos]",
        "              [--hosted] [--host 0.0.0.0] [--web DIR] [--origin https://…]",
        "",
        "  --hosted    one vault per signed-in xAI account; binds 0.0.0.0 unless --host says otherwise",
        "  --web DIR   serve a built app at /app/ (default: ./app beside the binary, or apps/app/dist)",
        "  --origin    browser origin allowed to make state-changing requests (repeatable)",
        "",
        "Environment: PYLOS_PORT, PYLOS_HOME, PYLOS_AUTH_PATH, PYLOS_HOSTED, PYLOS_HOST,",
        "             PYLOS_WEB, PYLOS_ORIGIN (comma-separated), OLLAMA_HOST",
        "",
      ].join("\n"),
    );
    return;
  }

  const server = await serve(args);
  const home = args.home ?? pylosHome();
  const mode = server.hosted ? "hosted" : "local";
  const kernel = server.context === undefined ? "per user" : server.context.kernel.backend;
  process.stdout.write(
    `pylos ${PYLOS_VERSION} listening on ${server.url} · ${mode} · home ${home} · kernel ${kernel}\n`,
  );
  if (server.web !== undefined) {
    process.stdout.write(`  app ${server.web} → ${server.url}/app/\n`);
  }
  if (server.hosted) {
    const origins = args.origins ?? splitOrigins(process.env.PYLOS_ORIGIN);
    process.stdout.write(
      `  origins ${origins.length > 0 ? origins.join(", ") : "(none — bearer clients only)"}\n`,
    );
  }

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
