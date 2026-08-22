import { homedir } from "node:os";
import { join } from "node:path";

/** `PYLOS_HOME` overrides the profile directory (KERNEL.md §1). */
export function pylosHome(env: Record<string, string | undefined> = process.env): string {
  const override = env.PYLOS_HOME?.trim();
  return override !== undefined && override.length > 0 ? override : join(homedir(), ".pylos");
}

export function authPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.PYLOS_AUTH_PATH?.trim();
  return override !== undefined && override.length > 0 ? override : join(pylosHome(env), "auth.json");
}

export function grokCliAuthPath(env: Record<string, string | undefined> = process.env): string {
  const override = env.GROK_AUTH_PATH?.trim();
  return override !== undefined && override.length > 0 ? override : join(homedir(), ".grok", "auth.json");
}
