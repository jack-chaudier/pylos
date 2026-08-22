/**
 * Budget allocation for the context compiler (KERNEL §4).
 *
 * The shares are caps, not reservations: whatever a slot does not use flows to
 * the recent window, which is the slot that can always absorb more. The total is
 * a hard ceiling — the packet must never exceed `B` by the kernel's own count.
 */

/** Fractional caps per slot. `recent` is whatever remains. */
export interface BudgetShares {
  header: number;
  frontier: number;
  capsules: number;
  paged: number;
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
  const header = Math.floor(budget * shares.header);
  const frontier = Math.floor(budget * shares.frontier);
  const capsules = Math.floor(budget * shares.capsules);
  const paged = Math.floor(budget * shares.paged);
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
