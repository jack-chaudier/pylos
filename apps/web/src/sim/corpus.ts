/**
 * The deterministic synthetic stream the aperture runs over.
 *
 * Mirrors `pylos bench million` (docs/KERNEL.md §10): a seeded, naturalistic
 * thread with planted structure — a rule at turn 1, its revision at turn
 * 483,112, and scattered facts, quotes, numbers and dates in between.
 *
 * Same seed ⇒ same million turns, in the browser and in Bun.
 */

import type { Episode } from "./kernel";

export const SEED = 0x50594c4f; // "PYLO"
export const TOTAL_TURNS = 1_000_000;
export const BUDGET = 8192;

export const RULE_SEQ = 1;
export const RULE_TEXT = "Never send a production migration before the dry-run database is verified.";

export const REVISION_SEQ = 483_112;
export const REVISION_TEXT =
  "Correction to the migration rule: it does not apply when the change is additive-only and the dry-run was skipped by the on-call lead.";

export const TRAP_QUESTION =
  "The change is additive-only and the on-call lead skipped the dry-run — can I send the production migration?";

/** mulberry32 — small, fast, deterministic, identical in every engine. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLACES = [
  "Boston",
  "Lisbon",
  "Reykjavik",
  "Kyoto",
  "Trondheim",
  "Marseille",
  "Wellington",
  "Valparaiso",
  "Ljubljana",
  "Halifax",
  "Salzburg",
  "Bergen",
];
const PEOPLE = [
  "Ines Marchetti",
  "Karel Novak",
  "Amara Diallo",
  "Tomas Lindqvist",
  "Priya Raghavan",
  "Jonas Vestergaard",
  "Mireille Bonnet",
  "Nadia Farouk",
];
const PROJECTS = [
  "Harbour",
  "Kestrel",
  "Tessera",
  "Basalt",
  "Verdigris",
  "Palimpsest",
  "Anvil",
  "Sable",
  "Lantern",
  "Quarry",
];
const KEYS = [
  "db.migration_rule",
  "deploy.window",
  "api.rate_limit",
  "cache.ttl_seconds",
  "index.rebuild_policy",
  "auth.session_ttl",
  "queue.max_retries",
  "billing.grace_period",
  "search.shard_count",
  "log.retention_days",
];
const UNITS = ["ms", "s", "GB", "MB", "%", "x"];
const QUOTES = [
  "ship it when the graph is flat",
  "the dry-run is the contract",
  "no migration without a witness",
  "budgets are promises, not hopes",
  "read the ledger before you answer",
];

function pick<T>(arr: readonly T[], r: number): T {
  return arr[Math.floor(r * arr.length) % arr.length] as T;
}

function fmtDate(r: number): string {
  const y = 2024 + Math.floor(r * 3);
  const m = 1 + (Math.floor(r * 997) % 12);
  const d = 1 + (Math.floor(r * 8191) % 28);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Build one episode. Pure function of (seq, prng draw) so the stream is
 * reproducible and can be generated in chunks without keeping history.
 */
export function makeEpisode(seq: number, next: () => number): Episode {
  const role: Episode["role"] = seq % 2 === 1 ? "user" : "assistant";

  if (seq === RULE_SEQ) {
    return ep(seq, "user", `${RULE_TEXT} That is the rule for ${pick(PROJECTS, 0.42)}.`);
  }
  if (seq === REVISION_SEQ) {
    return ep(seq, "user", REVISION_TEXT);
  }

  const a = next();
  const b = next();
  const c = next();
  const kind = Math.floor(a * 10);

  let text: string;
  switch (kind) {
    case 0:
      text = `I moved to ${pick(PLACES, b)} on ${fmtDate(c)}. Update the address you have for me.`;
      break;
    case 1:
      text = `We decided to set ${pick(KEYS, b)} = ${1 + Math.floor(c * 900)}${pick(UNITS, a)} for ${pick(PROJECTS, b)}.`;
      break;
    case 2:
      text = `${pick(PEOPLE, b)} asked whether the ${pick(PROJECTS, c)} rollout can start before ${fmtDate(b)}.`;
      break;
    case 3:
      text = `Remember that "${pick(QUOTES, b)}" — ${pick(PEOPLE, c)} said it during the ${pick(PROJECTS, a)} review.`;
      break;
    case 4:
      text = `The ${pick(PROJECTS, b)} job took ${10 + Math.floor(c * 4000)}${pick(UNITS, b)} at p99, down ${1 + Math.floor(c * 40)}% from ${fmtDate(c)}.`;
      break;
    case 5:
      text = `Actually, ${pick(KEYS, b)} should be ${1 + Math.floor(c * 900)}${pick(UNITS, c)} — not what we said earlier.`;
      break;
    case 6:
      text = `Noted. ${pick(PROJECTS, b)} now reads ${pick(KEYS, c)} from the shared config; ${pick(PEOPLE, a)} owns it.`;
      break;
    case 7:
      text = `From now on, always run the dry-run against a copy of ${pick(PLACES, b)} production before ${fmtDate(a)}.`;
      break;
    case 8:
      text = `That is fine. The ${pick(PROJECTS, c)} numbers held at ${1 + Math.floor(b * 99)}% through the ${pick(PLACES, a)} window.`;
      break;
    default:
      text = `Let's go with ${pick(PROJECTS, b)} for the ${pick(PLACES, c)} launch and keep ${pick(KEYS, a)} where it is.`;
      break;
  }
  return ep(seq, role, text);
}

function ep(seq: number, role: Episode["role"], content: string): Episode {
  // countTokens inlined: chars/3.6 with a 10% margin (kernel §4)
  return { seq, role, content, tokens: Math.ceil((content.length / 3.6) * 1.1) };
}

/** Certificate lines for the resident frontier (`key = value ⟨#seq⟩`). */
export function frontierLines(atSeq: number): string[] {
  const r = rng(SEED ^ 0x9e37);
  const out = [
    `db.migration_rule = "dry-run verified, unless additive-only" ⟨#${REVISION_SEQ}⟩`,
    `identity.name = Jack ⟨#7⟩`,
    `user.location = ${pick(PLACES, r())} ⟨#${Math.max(1, atSeq - 12_004)}⟩`,
  ];
  for (let i = 0; i < 150; i++) {
    out.push(
      `${pick(KEYS, r())} = ${1 + Math.floor(r() * 900)}${pick(UNITS, r())} ⟨#${Math.max(1, atSeq - Math.floor(r() * 400_000))}⟩`,
    );
  }
  return out;
}
