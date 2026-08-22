/**
 * Forgetting (KERNEL §8, A5, A10.6).
 *
 * Pylos forgets only on command, and records that it did. `forget` writes a
 * tombstone, marks the atoms REVOKED, resolves the ledger rows that pointed into
 * the removed material, deletes the FTS rows and replaces the inline content
 * with `⟦removed by user · <tombstone>⟧`.
 *
 * Removing the episode is not enough: the sentence also lives in capsule text,
 * in the `messages` of the packets that carried it, and — for an attachment — in
 * `objects/`. All three are cleared here. What is *not* touched is an assistant
 * turn that restated the material: that is an episode of its own, and the
 * tombstone only names it as a candidate so the interface can ask.
 *
 * The hash chain stays valid because it is computed over the stored
 * `content_hash`, not over the stored text: the archive can prove that something
 * was there and that it was removed on request, without keeping it. Removal is
 * itself appended to the chain as a `system` episode, so `verify` can insist
 * that every removed episode has one — a `removed` flag set by hand in the
 * database fails verification instead of skipping the content check.
 */

import type { AtomPhase, LossEntry, PageRecord, ResidentItem, Seq } from "@pylos/protocol";
import { sourceNamesForRange } from "./compact.ts";
import { canonicalHash } from "./hash.ts";
import { containsName } from "./page.ts";
import { deriveLedger, type SourceName } from "./pure/ledger.ts";
import { type NameHit, names } from "./pure/names.ts";
import { approxTokens } from "./pure/tokens.ts";
import { COUNTERS } from "./schema.ts";
import { lossExists, phaseCounter, type StoredCapsule, type Vault, VaultError } from "./vault.ts";

export interface ForgetTarget {
  seqs?: Seq[];
  range?: [Seq, Seq];
  atomIds?: string[];
  reason?: string;
}

export interface ForgetResult {
  tombstoneId: string;
  episodes: Seq[];
  atoms: number;
  lossRows: number;
  /** Capsules whose text was re-derived without the removed episodes. */
  capsules: number;
  /** Packets whose `messages` were cleared; their receipts are kept. */
  packets: number;
  /** Attachment hashes whose bytes were deleted (nothing else referenced them). */
  blobs: string[];
  /** Assistant episodes that carry a routing name of the removed text (A10.6). */
  echoes: Seq[];
  /** Seq of the `system` episode that records this removal; 0 if nothing was removed. */
  removalSeq: Seq;
}

/** Routing names taken from each removed episode, by the kind priority of A1. */
const NAMES_PER_EPISODE = 8;
/** Cap on the distinct names carried into the echo search, over the whole target. */
const ECHO_NAMES = 24;
/** Cap on the assistant episodes reported as echoes. */
const ECHO_LIMIT = 16;

export function forget(vault: Vault, threadId: string, target: ForgetTarget): ForgetResult {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw new VaultError(`unknown thread ${threadId}`);

  return vault.tx(() => {
    const seqs = new Set<Seq>(target.seqs ?? []);
    if (target.range) {
      for (let seq = target.range[0]; seq <= target.range[1]; seq += 1) seqs.add(seq);
    }
    for (const atomId of target.atomIds ?? []) {
      const atom = vault.atoms.get(atomId);
      if (atom !== null) seqs.add(atom.sourceSeq);
    }
    const tombstoneId = vault.tombstones.create(
      threadId,
      canonicalTarget(target, seqs),
      target.reason ?? "user request",
    );

    const removed: Seq[] = [];
    const byName = new Map<string, NameHit>();
    const blobs = new Set<string>();
    let bytes = 0;
    for (const seq of [...seqs].sort((a, b) => a - b)) {
      const episode = vault.episodes.get(threadId, seq);
      if (episode === null || episode.meta.removed === true) continue;
      bytes += Buffer.byteLength(episode.content);
      for (const hit of names(episode.content, { max: NAMES_PER_EPISODE })) {
        if (byName.size >= ECHO_NAMES) break;
        if (!byName.has(hit.name)) byName.set(hit.name, hit);
      }
      if (typeof episode.meta.blob === "string") blobs.add(episode.meta.blob);
      vault.redactContent(threadId, seq, `⟦removed by user · ${tombstoneId}⟧`, {
        ...episode.meta,
        removed: true,
        tombstone: tombstoneId,
      });
      removed.push(seq);
    }
    if (bytes > 0) vault.bump(threadId, { [COUNTERS.bytes]: -bytes });

    let atoms = 0;
    for (const seq of removed) {
      const affected = vault.db
        .query("SELECT id, phase FROM atom WHERE thread_id = ? AND source_seq = ?")
        .all(threadId, seq) as Array<{ id: string; phase: string }>;
      for (const row of affected) {
        vault.atoms.revoke(threadId, row.id);
        vault.bump(threadId, { [phaseCounter(row.phase as AtomPhase)]: -1 });
        atoms += 1;
      }
    }
    for (const atomId of target.atomIds ?? []) {
      const atom = vault.atoms.get(atomId);
      if (atom === null || atom.phase === "REVOKED") continue;
      vault.atoms.revoke(threadId, atomId);
      atoms += 1;
    }

    let lossRows = 0;
    for (const seq of removed) lossRows += vault.losses.resolve(threadId, seq, seq, tombstoneId);

    const removedSet = new Set(removed);
    const hits = [...byName.values()];
    const capsules = rederiveCapsules(vault, threadId, removedSet, hits);
    const packets = clearPacketMessages(vault, threadId, removedSet, capsules, hits);
    const deleted: string[] = [];
    for (const hash of blobs) {
      if (vault.blobs.referenced(hash)) continue;
      vault.blobs.delete(hash);
      deleted.push(hash);
    }
    const echoes = findEchoes(vault, threadId, hits, removedSet);

    // The chain records the removal itself: a later `system` episode naming what
    // was removed and under which tombstone. `verify` requires it.
    let removalSeq = 0;
    if (removed.length > 0) {
      const removal = vault.episodes.append(threadId, {
        role: "system",
        content: removalText(removed, tombstoneId),
      });
      removalSeq = removal.seq;
      // A tombstone that removed nothing keeps `removal_seq` NULL: only the
      // migration may mark a tombstone legacy, so 0 cannot be borrowed.
      vault.tombstones.record(tombstoneId, removalSeq, echoes);
    }

    return {
      tombstoneId,
      episodes: removed,
      atoms,
      lossRows,
      capsules: capsules.length,
      packets,
      blobs: deleted,
      echoes,
      removalSeq,
    };
  });
}

/** The chain-bound removal record: `⟦removed #12, #13 · tb_…⟧`. */
function removalText(seqs: readonly Seq[], tombstoneId: string): string {
  return `⟦removed ${seqs.map((seq) => `#${seq}`).join(", ")} · ${tombstoneId}⟧`;
}

const REMOVAL = /^⟦removed ((?:#\d+, )*#\d+) · (\S+)⟧$/;

/** The seqs a removal episode names, if it names this tombstone (KERNEL A10.6). */
export function removalRecord(content: string, tombstoneId: string): Set<Seq> {
  const match = REMOVAL.exec(content);
  if (match === null || match[2] !== tombstoneId) return new Set();
  return new Set((match[1] as string).split(", ").map((token) => Number(token.slice(1))));
}

const LOCATOR = /⟨#(\d+)⟩$/;

/**
 * Re-derive the text of every capsule that quotes a removed episode.
 *
 * A capsule's text is a set of located lines, so the extractive writer's output
 * over the surviving source is the same text minus the lines a removed episode
 * produced. Names that leave the text this way are re-accounted against the
 * surviving source vocabulary and the ledger gains the rows it did not have;
 * `capsule.dropped` and existing `loss` rows are left exactly as they are.
 */
function rederiveCapsules(
  vault: Vault,
  threadId: string,
  removed: Set<Seq>,
  hits: readonly NameHit[],
): string[] {
  const seqs = [...removed];
  if (seqs.length === 0) return [];
  const affected = vault.db
    .query("SELECT id FROM capsule WHERE thread_id = ? AND from_seq <= ? AND to_seq >= ?")
    .all(threadId, Math.max(...seqs), Math.min(...seqs)) as Array<{ id: string }>;

  const changed: string[] = [];
  // Ascending level: a parent's surviving vocabulary is read from children that
  // have already been re-derived. A capsule that only straddles the range and
  // quotes nothing removed falls out below, having cost one string split.
  const ordered = affected
    .map((row) => vault.capsules.get(row.id))
    .filter((capsule): capsule is StoredCapsule => capsule !== null)
    .sort((a, b) => a.level - b.level);
  for (const capsule of ordered) {
    const lines = capsule.text.split("\n");
    const surviving = lines.filter((line) => {
      const match = LOCATOR.exec(line);
      const seq = match === null ? 0 : Number(match[1]);
      // A model writer's lines carry no usable locator (KERNEL §3 truncates its
      // output as one unit), so they are judged by what they say instead.
      if (seq > 0) return !removed.has(seq);
      return !hits.some((hit) => containsName(line, hit));
    });
    if (surviving.length === lines.length) continue;

    const text = surviving.join("\n");
    const source = survivingSource(vault, threadId, capsule, removed);
    const { dropped, kept } = deriveLedger(source, text);
    const fresh = dropped.filter(
      (entry) => !removed.has(entry.seq) && !lossExists(vault, threadId, entry.name, entry.seq),
    );
    vault.capsules.replace({
      ...capsule,
      text,
      tokens: approxTokens(text),
      kept,
      hash: canonicalHash({ level: capsule.level, from: capsule.fromSeq, to: capsule.toSeq, text }),
    });
    vault.losses.add(threadId, capsule.id, capsule.level, fresh);
    changed.push(capsule.id);
  }
  return changed;
}

/** The vocabulary a capsule is still responsible for after a removal. */
function survivingSource(
  vault: Vault,
  threadId: string,
  capsule: StoredCapsule,
  removed: Set<Seq>,
): SourceName[] {
  if (capsule.level === 0) return sourceNamesForRange(vault, threadId, capsule.fromSeq, capsule.toSeq);
  const children = vault.capsules.children(threadId, capsule.level, capsule.fromSeq, capsule.toSeq);
  // The rolling root has no children of its own level (KERNEL A3): it absorbed
  // them one at a time, so what it kept is the vocabulary it answers for.
  const entries = children.length > 0 ? children.flatMap((child) => child.kept) : capsule.kept;
  return entries.filter((entry) => !removed.has(entry.seq)).map(toSourceName);
}

function toSourceName(entry: LossEntry): SourceName {
  return {
    name: entry.name,
    kind: entry.kind,
    seq: entry.seq,
    ...(entry.span ? { span: entry.span } : {}),
  };
}

/**
 * Drop `messages` from every packet that could still be carrying the removed
 * material: it answered that turn, it had the episode resident or paged, it was
 * built on a capsule that quoted it, or its rendered text still names it — a
 * frontier certificate read from the removed sentence leaves no structural
 * trace, so the text is the last check. The receipt — digest, resident set,
 * ledger digest, pages — stays, and the X-ray labels the packet reconstructed
 * (KERNEL A7, A10.6).
 */
function clearPacketMessages(
  vault: Vault,
  threadId: string,
  removed: Set<Seq>,
  capsules: readonly string[],
  hits: readonly NameHit[],
): number {
  const rows = vault.db
    .query(
      "SELECT id, turn_seq, resident, pages, messages FROM packet WHERE thread_id = ? AND messages IS NOT NULL",
    )
    .all(threadId) as Array<{
    id: string;
    turn_seq: number;
    resident: string;
    pages: string;
    messages: string;
  }>;
  const quoted = new Set(capsules);
  let count = 0;
  for (const row of rows) {
    const resident = JSON.parse(row.resident) as ResidentItem[];
    const pages = JSON.parse(row.pages) as PageRecord[];
    const carries =
      removed.has(row.turn_seq) ||
      resident.some(
        (item) =>
          (item.seq !== undefined && removed.has(item.seq)) ||
          (item.ref !== undefined && quoted.has(item.ref)),
      ) ||
      pages.some((page) => page.seqs.some((seq) => removed.has(seq))) ||
      namesRemoved(row.messages, hits);
    if (!carries) continue;
    vault.db.query("UPDATE packet SET messages = NULL WHERE id = ?").run(row.id);
    count += 1;
  }
  return count;
}

/** The cheap half of `containsName`, over text that may be tens of kilobytes. */
function namesRemoved(text: string, hits: readonly NameHit[]): boolean {
  const normalized = text.replace(/\s+/g, " ").toLowerCase();
  return hits.some((hit) => text.includes(hit.raw) || normalized.includes(hit.name));
}

/**
 * Assistant episodes that carry a routing name of the removed text. Reported,
 * never removed: guessing which replies quoted the user is the kernel deciding
 * what to forget, and it only forgets on command.
 */
function findEchoes(vault: Vault, threadId: string, hits: readonly NameHit[], removed: Set<Seq>): Seq[] {
  const found = new Set<Seq>();
  for (const hit of hits) {
    if (found.size >= ECHO_LIMIT) break;
    for (const episode of vault.episodes.search(threadId, hit.raw, 8)) {
      if (episode.role !== "assistant" || episode.meta.removed === true) continue;
      if (removed.has(episode.seq) || found.has(episode.seq)) continue;
      if (!containsName(episode.content, hit)) continue;
      found.add(episode.seq);
      if (found.size >= ECHO_LIMIT) break;
    }
  }
  return [...found].sort((a, b) => a - b);
}

function canonicalTarget(target: ForgetTarget, seqs: Set<Seq>): string {
  if (target.range) return `range:${target.range[0]}-${target.range[1]}`;
  if (seqs.size > 0) return `seqs:${[...seqs].sort((a, b) => a - b).join(",")}`;
  return `atoms:${(target.atomIds ?? []).join(",")}`;
}
