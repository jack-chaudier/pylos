import { homedir } from "node:os";
import { join } from "node:path";

/** `PYLOS_HOME` overrides the profile directory (KERNEL.md §1). */
export function pylosHome(env: Record<string, string | undefined> = process.env): string {
  const override = env.PYLOS_HOME?.trim();
  return override !== undefined && override.length > 0 ? override : join(homedir(), ".pylos");
}

/**
 * The credential file. `PYLOS_AUTH_PATH` wins; otherwise it belongs to the
 * profile in use, so `--home DIR` spends only the credentials in `DIR`.
 */
export function authPath(env: Record<string, string | undefined> = process.env, home?: string): string {
  const override = env.PYLOS_AUTH_PATH?.trim();
  if (override !== undefined && override.length > 0) return override;
  return join(home ?? pylosHome(env), "auth.json");
}

export function grokCliAuthPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.GROK_AUTH_PATH?.trim();
  return override !== undefined && override.length > 0 ? override : join(homedir(), ".grok", "auth.json");
}
