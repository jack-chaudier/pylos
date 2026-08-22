import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Thread } from "@pylos/protocol";
import { openVault, type Vault } from "../src/index.ts";

const homes: string[] = [];

/** A throwaway vault in a temp directory. Removed by `cleanup()`. */
export function tempVault(settings: Record<string, unknown> = {}): { vault: Vault; thread: Thread } {
  const home = mkdtempSync(join(tmpdir(), "pylos-test-"));
  homes.push(home);
  const vault = openVault({ home, fast: true });
  const thread = vault.threads.create("Test thread", { budget: 8192, ...settings });
  return { vault, thread };
}

export function cleanup(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
}

/** A deterministic PRNG so property tests fail the same way twice. */
export function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

const WORDS =
  "ledger harbor scheduler ingest billing runtime migration rollout latency throughput backlog cohort".split(
    " ",
  );
const PLACES = "Lisbon Tallinn Oaxaca Kyoto Porto Ghent Bergen Valletta Tartu Salta".split(" ");
const PEOPLE = "Ada Okafor|Amir Haddad|Bea Moreau|Cai Tanaka|Dara Novak|Eli Ferreira".split("|");

/** Naturalistic filler with entities, numbers and dates — enough to exercise names(). */
export function syntheticTurn(next: () => number, index: number): string {
  const word = WORDS[Math.floor(next() * WORDS.length)] as string;
  const place = PLACES[Math.floor(next() * PLACES.length)] as string;
  const person = PEOPLE[Math.floor(next() * PEOPLE.length)] as string;
  const number = (1000 + Math.floor(next() * 89000)) / 100;
  switch (index % 5) {
    case 0:
      return `Status on quiet-${word}: the ingest worker is degraded; p99 latency at ${number} ms.`;
    case 1:
      return `${person} lives in ${place}.`;
    case 2:
      return `We decided to use ${word}-store for the ${word} pipeline on 2026-0${1 + (index % 9)}-1${index % 9}.`;
    case 3:
      return `${person} wrote this and I want it kept exactly: “the ${word} palimpsest of ${place} ${Math.floor(number)}”`;
    default:
      return `Quick aside about ${place} and the ${word} rollout, nothing important.`;
  }
}
