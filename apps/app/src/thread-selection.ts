import { DEFAULT_BUDGET, type ThreadStats } from "@pylos/protocol";

/** The app's startup fallback when a legacy thread has no durable selection. */
export const FALLBACK_MODEL = "grok-4.6";

/**
 * Reopen the model the thread actually selected. The capped first-seen
 * history is diagnostic evidence, not an authority for the next turn.
 */
export function selectedModelForThread(thread: ThreadStats): string {
  return thread.selectedModel ?? FALLBACK_MODEL;
}

/** Reopen the durable settings budget even when no turn followed the change. */
export function selectedBudgetForThread(thread: ThreadStats): number {
  return thread.selectedBudget ?? thread.lastPacket?.budget ?? DEFAULT_BUDGET;
}
