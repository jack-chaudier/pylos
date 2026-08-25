/**
 * Budget allocation for the context compiler (KERNEL §4).
 *
 * The shares are caps, not reservations: whatever a slot does not use flows to
 * the recent window, which is the slot that can always absorb more. The total is
 * a hard ceiling — the packet must never exceed `B` by the kernel's own count.
 */

import { type BudgetShares, MAX_THREAD_BUDGET } from "@pylos/protocol";

/** Fractional caps per slot. `recent` is whatever remains. */
export type { BudgetShares } from "@pylos/protocol";

const BUDGET_SHARE_KEYS = ["header", "frontier", "capsules", "paged"] as const;

/**
 * Return a stable failure for an untrusted shares object, or `null` when it is
 * an exact kernel allocation. This checks the whole map: optional/extra keys
 * and non-finite values are not meaningful allocation inputs and must never
 * reach `Math.floor`.
 */
export function budgetSharesFailure(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "shares must be an object";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== BUDGET_SHARE_KEYS.length ||
    keys.some((key) => !BUDGET_SHARE_KEYS.includes(key as (typeof BUDGET_SHARE_KEYS)[number]))
  ) {
    return "shares must contain exactly header, frontier, capsules, and paged";
  }
  let total = 0;
  for (const key of BUDGET_SHARE_KEYS) {
    const entry = record[key];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0 || entry > 1) {
      return `shares.${key} must be a finite number from 0 through 1`;
    }
    total += entry;
  }
  if (!Number.isFinite(total) || total > 1) return "shares total must be at most 1";
  return null;
}

/** Validate and return the exact allocation shape used by the compiler. */
export function checkedBudgetShares(value: unknown): BudgetShares {
  const failure = budgetSharesFailure(value);
  if (failure !== null) throw new Error(`thread ${failure}`);
  const record = value as Record<keyof BudgetShares, number>;
  return {
    header: record.header,
    frontier: record.frontier,
    capsules: record.capsules,
    paged: record.paged,
  };
}

/**
 * Validate the scalar spend recorded for a compiled packet (or request
 * round).  `tokens` is a spend, while `budget` is the hard ceiling selected
 * for that request; bounding them independently is not sufficient because a
 * forged row can otherwise claim a spend larger than its own ceiling.
 */
export function packetTokensFailure(tokens: unknown, budget: unknown): string | null {
  if (
    typeof budget !== "number" ||
    !Number.isSafeInteger(budget) ||
    budget < 1 ||
    budget > MAX_THREAD_BUDGET
  ) {
    return `packet budget must be an integer from 1 through ${MAX_THREAD_BUDGET}`;
  }
  if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) {
    return "packet tokens must be a non-negative safe integer";
  }
  if (tokens > budget) return "packet tokens exceed packet budget";
  return null;
}

/** Validate packet spend and return its safe integer representation. */
export function checkedPacketTokens(tokens: unknown, budget: unknown): number {
  const failure = packetTokensFailure(tokens, budget);
  if (failure !== null) throw new Error(failure);
  return tokens as number;
}

/**
 * Check the scalar budget relation carried by retained request rounds. An empty
 * round list is the only receiptless compatibility shape; every retained round
 * must carry both scalar fields so a missing value cannot evade the hard cap.
 * Receipt verification still owns the rest of the full round shape.
 */
export function packetRoundsFailure(rounds: unknown, packetBudget: unknown): string | null {
  if (!Array.isArray(rounds)) return "packet rounds must be an array";
  for (const [index, rawRound] of rounds.entries()) {
    if (rawRound === null || typeof rawRound !== "object" || Array.isArray(rawRound)) {
      return `packet round ${index} is malformed`;
    }
    const round = rawRound as Record<string, unknown>;
    if (!Object.hasOwn(round, "tokens") || !Object.hasOwn(round, "budget")) {
      return `packet round ${index} budget fields are missing`;
    }
    const failure = packetTokensFailure(round.tokens, round.budget);
    if (failure !== null) return `packet round ${index} ${failure}`;
    if (round.budget !== packetBudget) return `packet round ${index} budget does not match packet budget`;
  }
  return null;
}

/** KERNEL §4 defaults: 4% / 20% / 18% / 18%, leaving ≈ 40% for the recent window. */
export const DEFAULT_SHARES: BudgetShares = {
  header: 0.04,
  frontier: 0.2,
  capsules: 0.18,
  paged: 0.18,
};

export interface Allocation {
  budget: number;
  header: number;
  frontier: number;
  capsules: number;
  paged: number;
  recent: number;
}

/** Turn a budget into per-slot token caps. */
export function allocate(budget: number, shares: BudgetShares = DEFAULT_SHARES): Allocation {
  const checked = checkedBudgetShares(shares);
  const header = Math.floor(budget * checked.header);
  const frontier = Math.floor(budget * checked.frontier);
  const capsules = Math.floor(budget * checked.capsules);
  const paged = Math.floor(budget * checked.paged);
  const recent = Math.max(0, budget - header - frontier - capsules - paged);
  return { budget, header, frontier, capsules, paged, recent };
}

/**
 * After the bounded slots have been filled, hand their leftovers to the recent
 * window. Called once, with the actual spend of each slot.
 */
export function spare(allocation: Allocation, spent: Omit<Allocation, "budget" | "recent">): number {
  const used = spent.header + spent.frontier + spent.capsules + spent.paged;
  return Math.max(0, allocation.budget - used);
}
