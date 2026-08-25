import { budgetSharesFailure } from "@pylos/core";
import { type BudgetShares, MAX_THREAD_BUDGET, MAX_THREAD_MODEL_BYTES } from "@pylos/protocol";
import { HttpError } from "./http.ts";

/** Validate a model identifier before provider lookup or any thread mutation. */
export function requiredModel(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "invalid_model", "`model` must be a non-empty string.");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_THREAD_MODEL_BYTES) {
    throw new HttpError(413, "model_too_large", "The model identifier exceeds its UTF-8 byte limit.");
  }
  return value;
}

/** Validate an optional model field without turning absence into a default. */
export function optionalModel(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredModel(value);
}

/** Validate the positive, bounded packet budget accepted at an HTTP boundary. */
export function requiredBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, "invalid_budget", "`budget` must be a positive safe integer.");
  }
  if (value > MAX_THREAD_BUDGET) {
    throw new HttpError(413, "budget_too_large", "The budget exceeds the thread budget limit.");
  }
  return value;
}

/** Validate an optional budget field without turning absence into a default. */
export function optionalBudget(value: unknown): number | undefined {
  return value === undefined ? undefined : requiredBudget(value);
}

/** Validate an optional exact packet-share map before the kernel is mutated. */
export function optionalShares(value: unknown): BudgetShares | undefined {
  if (value === undefined) return undefined;
  const failure = budgetSharesFailure(value);
  if (failure !== null) throw new HttpError(400, "invalid_shares", failure);
  const shares = value as BudgetShares;
  return {
    header: shares.header,
    frontier: shares.frontier,
    capsules: shares.capsules,
    paged: shares.paged,
  };
}

/** Validate an inclusive export range against the already-read thread head. */
export function optionalExportRange(value: unknown, head: number): [number, number] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new HttpError(400, "invalid_range", "`range` must contain exactly [from, to].");
  }
  const from = value[0];
  const to = value[1];
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
    throw new HttpError(400, "invalid_range", "Export range endpoints must be safe integers.");
  }
  if (from < 1 || from > to || to > head) {
    throw new HttpError(416, "range_out_of_bounds", "Export range must fit within the thread head.");
  }
  return [from, to];
}
