#!/usr/bin/env bun

/**
 * `pylos` — the kernel's command line.
 *
 * ```
 * pylos serve [--port 7334]
 * pylos verify [--thread ID] [--full]
 * pylos export --out FILE [--thread ID] [--passphrase P] [--range A:B]
 * pylos import FILE [--passphrase P]
 * pylos stats [--thread ID] [--json]
 * pylos bench million [--turns N] [--seed S] [--budget B] [--out PATH]
 * pylos bench live --model M [--turns N]
 * ```
 */

import { join } from "node:path";
import { exportBundle, importBundle } from "./bundle.ts";
import { stats } from "./stats.ts";
import { openVault } from "./vault.ts";
import { verify } from "./verify.ts";

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function str(args: Args, key: string): string | undefined {
  const value = args.flags[key];
  return typeof value === "string" ? value : undefined;
}

function num(args: Args, key: string): number | undefined {
  const value = str(args, key);
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(/[_,]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

const USAGE = `pylos — the forever chat

  pylos serve [--port 7334]            start the local API (needs @pylos/server)
  pylos verify [--thread ID] [--full]  replay the hash chain
  pylos stats  [--thread ID] [--json]  archive size, ledger, atoms, head hash
  pylos export --out FILE              write an encrypted .pylos bundle
  pylos import FILE                    restore a bundle into this profile
  pylos bench million [--turns N] [--seed S] [--budget B] [--out PATH]
  pylos bench live --model M [--turns N]

  --home DIR   profile directory (default $PYLOS_HOME or ~/.pylos)
`;

async function readPassphrase(args: Args): Promise<string> {
  const given = str(args, "passphrase") ?? process.env.PYLOS_PASSPHRASE;
  if (given !== undefined && given.length > 0) return given;
  process.stdout.write("passphrase: ");
  for await (const line of console) return line.trim();
  return "";
}

interface ServerModule {
  main(argv: string[]): Promise<void>;
}

/**
 * The kernel does not depend on the API layer, so `@pylos/server` is only
 * resolvable from here when something else installed it. In a checkout it is
 * the sibling workspace, found by path; anywhere else `serve` says so plainly.
 */
async function loadServer(): Promise<ServerModule | undefined> {
  const candidates = ["@pylos/server", join(import.meta.dir, "..", "..", "server", "src", "index.ts")];
  for (const specifier of candidates) {
    try {
      const module = (await import(specifier)) as Partial<ServerModule>;
      if (typeof module.main === "function") return module as ServerModule;
    } catch {
      // Not resolvable from here; try the next candidate.
    }
  }
  return undefined;
}

/** Resolves to the process exit code, or to `null` when the command owns the process. */
async function main(argv: string[]): Promise<number | null> {
  const args = parseArgs(argv);
  const command = args.positional[0];
  if (command === undefined || args.flags.help === true) {
    process.stdout.write(USAGE);
    return command === undefined ? 1 : 0;
  }
  const home = str(args, "home");
  const vaultOptions = home === undefined ? {} : { home };

  switch (command) {
    case "serve": {
      const server = await loadServer();
      if (server === undefined) {
        process.stderr.write(
          "pylos serve needs @pylos/server, which is not available here.\n" +
            "Run `bun install` in a Pylos checkout, then `bun packages/core/src/cli.ts serve`.\n",
        );
        return 1;
      }
      try {
        // The server owns the process from here: it binds the port and stops on
        // SIGINT/SIGTERM. Returning would exit before the first request.
        await server.main(argv);
      } catch (error) {
        process.stderr.write(`pylos: ${(error as Error).message}\n`);
        return 1;
      }
      return null;
    }

    case "verify": {
      const vault = openVault(vaultOptions);
      const thread = str(args, "thread") ?? vault.threads.primary().id;
      const result = verify(vault, thread, { full: args.flags.full === true });
      process.stdout.write(
        `${result.ok ? "ok" : "FAILED"} · thread ${thread} · checked #${result.checkedFrom}→#${result.checkedTo} · head ${result.headHash.slice(0, 16)}…\n`,
      );
      if (!result.ok) process.stdout.write(`  ${result.reason} at #${result.failedAt}\n`);
      vault.close();
      return result.ok ? 0 : 2;
    }

    case "stats": {
      const vault = openVault(vaultOptions);
      const thread = str(args, "thread") ?? vault.threads.primary().id;
      const summary = stats(vault, thread, { verify: true });
      if (args.flags.json === true) {
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        process.stdout.write(
          [
            `thread    ${summary.threadId} · ${summary.title}`,
            `archive   ${summary.turns} turns · ${(summary.archiveBytes / 1048576).toFixed(1)} MiB`,
            `episodes  ${summary.episodes.user} user · ${summary.episodes.assistant} assistant · ${summary.episodes.other} other`,
            `memory    ${summary.atoms.supported} current atoms · ${summary.atoms.historical} historical`,
            `ledger    ${summary.losses} recorded omissions · ${summary.capsules} capsules`,
            `view      ${summary.lastPacket ? `${summary.lastPacket.tokens}/${summary.lastPacket.budget} tokens · ${summary.lastPacket.pages} pages` : "no packet yet"}`,
            `head      ${summary.headHash}`,
            `verified  to #${summary.verifiedTo ?? 0}`,
            `models    ${summary.models.join(", ") || "none"}`,
            "",
          ].join("\n"),
        );
      }
      vault.close();
      return 0;
    }

    case "export": {
      const vault = openVault(vaultOptions);
      const thread = str(args, "thread") ?? vault.threads.primary().id;
      const range = str(args, "range");
      const parsed = range?.split(":").map(Number);
      const bytes = await exportBundle(vault, thread, {
        passphrase: await readPassphrase(args),
        ...(parsed && parsed.length === 2 && parsed.every(Number.isFinite)
          ? { range: [parsed[0] as number, parsed[1] as number] as [number, number] }
          : {}),
      });
      const out = str(args, "out") ?? `pylos-${thread}-${vault.threads.get(thread)?.headSeq ?? 0}.pylos`;
      await Bun.write(out, bytes);
      process.stdout.write(`wrote ${out} · ${(bytes.length / 1048576).toFixed(2)} MiB\n`);
      vault.close();
      return 0;
    }

    case "import": {
      const file = args.positional[1];
      if (file === undefined) {
        process.stderr.write("usage: pylos import FILE\n");
        return 1;
      }
      const vault = openVault(vaultOptions);
      const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
      const result = await importBundle(vault, bytes, { passphrase: await readPassphrase(args) });
      process.stdout.write(
        `imported ${result.episodes} episodes into ${result.threadId} · head ${result.headHash.slice(0, 16)}… · chain ${result.verified ? "verified" : "UNVERIFIED"}\n`,
      );
      vault.close();
      return result.verified ? 0 : 2;
    }

    case "bench": {
      const which = args.positional[1] ?? "million";
      if (which === "million") {
        const { runMillion } = await import("../../../bench/million.ts" as string);
        const result = await runMillion({
          turns: num(args, "turns") ?? 1_000_000,
          seed: str(args, "seed") ?? "1",
          budget: num(args, "budget") ?? 8192,
          ...(str(args, "out") === undefined ? {} : { out: str(args, "out") as string }),
          ...(home === undefined ? {} : { home }),
        });
        return result.final.ok ? 0 : 2;
      }
      if (which === "live") {
        const { runLive } = await import("../../../bench/live.ts" as string);
        const result = await runLive({
          model: str(args, "model") ?? "grok-4.3",
          turns: num(args, "turns") ?? 2000,
          seed: str(args, "seed") ?? "live-1",
          budget: num(args, "budget") ?? 8192,
        });
        return result.ok ? 0 : 2;
      }
      process.stderr.write(`unknown bench "${which}"\n`);
      return 1;
    }

    default:
      process.stderr.write(`unknown command "${command}"\n${USAGE}`);
      return 1;
  }
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}

export { main };
