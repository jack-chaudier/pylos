/**
 * Hashing primitives for the chain, capsules and packet digests.
 * Kept out of `pure/` because it reaches for a platform crypto implementation.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "./pure/canonical.ts";

/** Lowercase hex sha256 of a string or byte buffer. */
export function sha256(value: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value))
    .digest("hex");
}

/** sha256 of the canonical JSON encoding of a value. */
export function canonicalHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** The chain link: `sha256(prevHash ‖ canonical(record))`. */
export function chainHash(prevHash: string, record: unknown): string {
  return sha256(`${prevHash}${canonicalJson(record)}`);
}

/** Genesis hash of a thread: `sha256("pylos:" + threadId)`. */
export function genesisHash(threadId: string): string {
  return sha256(`pylos:${threadId}`);
}

/** Time-ordered, collision-resistant id. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let random = "";
  for (const byte of bytes) random += byte.toString(16).padStart(2, "0");
  return `${prefix}_${Date.now().toString(36)}${random}`;
}
