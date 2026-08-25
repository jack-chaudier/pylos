/**
 * The deterministic proof thread (KERNEL demo surface).
 *
 * This module is intentionally a very small client of the kernel.  It seeds
 * through `runTurn`, lets the normal gate and compactor write their receipts,
 * uses the public forget/address/attachment APIs, and only then reads those
 * durable rows back into a summary.  The summary is never inserted into SQL
 * and no provider output is treated as a receipt.
 */

import type {
  DemoRemovalReceipt,
  DemoSummary,
  DemoTurnRef,
  DemoWitness,
  Packet,
  PageRecord,
  Seq,
} from "@pylos/protocol";
import { getAddressRoute, listCurrentAddressRoutes } from "./address.ts";
import { ATTACHMENT_CHUNK_SIZE, readAttachmentSpan } from "./attachment.ts";
import { forget } from "./forget.ts";
import { sha256 } from "./hash.ts";
import { stats } from "./stats.ts";
import { type Provider, runTurn, type TurnResult } from "./turn.ts";
import type { EpisodeInput, Vault } from "./vault.ts";

export const DEMO_VERSION = "proof-v1";
export const DEMO_MODEL = "pylos-proof-demo";
export const DEMO_BUDGET = 8192;
export const DEMO_ATTACHMENT_NAME = "proof-tail.txt";
export const DEMO_TAIL_MARKER = "TAIL_MARKER_PYLOS_PROOF_V1";

const ADDRESS_QUERY = "Where do I live?";
const CODE_QUERY = "What is the vault access code?";
const COLLECTION_QUERY = "List all 11 launch notes.";
const ATTACHMENT_QUERY = `What is in the tail of ${DEMO_ATTACHMENT_NAME}?`;

// Keep the proof's collection contract in one place. The requested cardinality
// deliberately exceeds the ten deterministic source episodes so the tour can
// demonstrate an honest lower bound without letting archive filler become a
// false positive.
const DEMO_LAUNCH_NOTES = [
  "Launch note: the kiln test began at 09:10.",
  "Launch note: the blue crate goes to Dock 3.",
  "Launch note: Mina owns the backup key.",
  "Launch note: the relay check passed on Tuesday.",
  "Launch note: the spare battery is in the north cabinet.",
  "Launch note: the release window starts after lunch.",
  "Launch note: the paper map stays with the field kit.",
  "Launch note: the first rehearsal uses the small room.",
  "Launch note: the archive copy is stored off-site.",
  "Launch note: the signal test needs a quiet channel.",
] as const;
const DEMO_COLLECTION_REQUIRED = DEMO_LAUNCH_NOTES.length + 1;
const DEMO_COLLECTION_UNRESOLVED = 1;
const DEMO_COLLECTION_ANSWER = "I found 10 launch-note sources.";

const HISTORICAL_VALUE = "Lisbon";
const CURRENT_VALUE = "Porto";
const FILLER_TURNS = 80;

interface DemoState {
  version: string;
  originalSeq: Seq;
  correctionSeq: Seq;
  groundedFact: DemoTurnState;
  forgottenSourceSeq: Seq;
  grounded: DemoTurnState;
  repeated: DemoTurnState;
  collection: DemoTurnState;
  attachment: {
    seq: Seq;
    turn: DemoTurnState;
    manifestId: string;
    marker: string;
  };
  final: DemoTurnState;
}

interface DemoTurnState {
  query: string;
  questionSeq: Seq;
  answerSeq: Seq;
  packetId: string;
}

/**
 * Read a previously persisted proof thread without seeding or changing it.
 *
 * The marker is deliberately the only admission check here.  A normal thread
 * may have a title or happen to contain similar text, but it is not a proof
 * demo unless the kernel wrote the complete `proof-v1` state after seeding.
 * `buildSummary` then re-reads and verifies the durable receipts, just as the
 * POST/idempotent path does.
 */
export function readDemo(vault: Vault, threadId: string): DemoSummary | null {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw missingThread(threadId);
  const saved = readDemoState(thread.settings);
  return saved === null ? null : buildSummary(vault, threadId, saved, false);
}

/** Seed an empty thread and return a receipt-backed proof summary. */
export async function demo(vault: Vault, threadId: string): Promise<DemoSummary> {
  const thread = vault.threads.get(threadId);
  if (thread === null) throw missingThread(threadId);

  const saved = readDemoState(thread.settings);
  if (saved !== null) return buildSummary(vault, threadId, saved, false);
  if (thread.headSeq !== 0) throw requiresEmptyThread();

  vault.threads.setTitle(threadId, "The proof thread");
  vault.threads.setSettings(threadId, {
    ...thread.settings,
    model: DEMO_MODEL,
    budget: DEMO_BUDGET,
  });

  // A correction that is deliberately grounded before the archive is made
  // large.  This gives the real A15 recorder a current witness to persist.
  const original = await scriptedTurn(vault, threadId, "I live in Lisbon.", "Noted.");
  const correction = await scriptedTurn(vault, threadId, "I live in Porto.", "Noted.");

  const groundedFact = await scriptedTurn(vault, threadId, ADDRESS_QUERY, "I live in Porto.");
  if (groundedFact.packet.answerReceipt?.status !== "released") {
    throw new Error("the proof demo corrected fact was not released by the claim gate");
  }
  const groundedFactState = turnState(ADDRESS_QUERY, groundedFact);
  const factRoute = latestActiveRoute(vault, threadId, ADDRESS_QUERY);
  if (factRoute === null) {
    throw new Error("the proof demo could not persist the corrected fact route");
  }

  // This is a separate grounded fact.  It is the witness deliberately removed
  // below, leaving the corrected Porto fact current and independently visible.
  const codeSource = await scriptedTurn(vault, threadId, "The vault access code is L-2048.", "Noted.");
  const grounded = await scriptedTurn(vault, threadId, CODE_QUERY, "The vault access code is L-2048.");
  if (grounded.packet.answerReceipt?.status !== "released") {
    throw new Error("the proof demo forgotten fact was not released by the claim gate");
  }
  const groundedState = turnState(CODE_QUERY, grounded);
  const addressRoute = latestActiveRoute(vault, threadId, CODE_QUERY);
  if (addressRoute === null) {
    throw new Error("the proof demo could not persist the forgotten fact route");
  }

  // Ten distinct user episodes make the source count honest: the question
  // supplies 11 as a requested cardinality, while the bounded route locates
  // exactly ten authoritative sources and reports one unresolved lower bound.
  for (const note of DEMO_LAUNCH_NOTES) await scriptedTurn(vault, threadId, note, "Filed.");

  // Enough real turns to seal leaves and roll a root at the demo budget.  The
  // filler has no launch/location vocabulary so it cannot accidentally answer
  // either proof query; the kernel still archives and compacts every turn.
  for (let index = 0; index < FILLER_TURNS; index += 1) {
    await scriptedTurn(
      vault,
      threadId,
      `Archive filler ${String(index + 1).padStart(2, "0")}: the kiln ledger line is stable.`,
      "Filed.",
    );
  }

  // Deleting the exact launch-code witness makes the second query prove
  // explicit invalidation instead of silently falling through to a substitute.
  forget(vault, threadId, {
    seqs: [codeSource.userEpisode.seq],
    reason: "proof demo: remove the vault access code witness",
  });
  const repeated = await scriptedTurn(
    vault,
    threadId,
    CODE_QUERY,
    "I can no longer verify the vault access code.",
  );
  const repeatedState = turnState(CODE_QUERY, repeated);
  const invalidation = pageFor(repeated.packet, "invalidation", false);
  const routeAfterForget = getAddressRoute(vault, threadId, addressRoute.id);
  if (invalidation === null || routeAfterForget?.status !== "invalidated") {
    throw new Error("the proof demo could not produce an address invalidation receipt");
  }

  const attachmentBytes = demoAttachmentBytes();
  const attachment = await scriptedTurn(
    vault,
    threadId,
    ATTACHMENT_QUERY,
    "The exact attachment tail is in the page.",
    [
      {
        role: "attachment",
        // Model the real upload path: the kernel can label bytes indexed only
        // when the exact extracted text is what the episode FTS row stores.
        content: new TextDecoder("utf-8", { fatal: true }).decode(attachmentBytes),
        blob: { bytes: attachmentBytes, mime: "text/plain", name: DEMO_ATTACHMENT_NAME },
      },
    ],
  );
  const attachmentEpisode = attachment.attachmentEpisodes[0];
  const manifest = attachmentEpisode?.meta.manifest;
  if (attachmentEpisode === undefined || manifest === undefined || manifest.spans.length < 2) {
    throw new Error("the proof demo attachment was not chunked into spans");
  }
  const tailPage = pageFor(attachment.packet, "attachment-tail", true);
  const tailRead = readAttachmentSpan(vault, threadId, attachmentEpisode.seq, manifest.spans.length - 1);
  if (
    tailPage === null ||
    tailRead === null ||
    !new TextDecoder().decode(tailRead.bytes).includes(DEMO_TAIL_MARKER)
  ) {
    throw new Error("the proof demo could not verify the attachment tail");
  }

  const final = await scriptedTurn(vault, threadId, COLLECTION_QUERY, DEMO_COLLECTION_ANSWER);
  const finalState = turnState(COLLECTION_QUERY, final);

  const state: DemoState = {
    version: DEMO_VERSION,
    originalSeq: original.userEpisode.seq,
    correctionSeq: correction.userEpisode.seq,
    groundedFact: groundedFactState,
    forgottenSourceSeq: codeSource.userEpisode.seq,
    grounded: groundedState,
    repeated: repeatedState,
    collection: finalState,
    attachment: {
      seq: attachmentEpisode.seq,
      turn: turnState(ATTACHMENT_QUERY, attachment),
      manifestId: manifest.id,
      marker: DEMO_TAIL_MARKER,
    },
    final: finalState,
  };
  const after = vault.threads.get(threadId);
  if (after === null) throw missingThread(threadId);
  vault.threads.setSettings(threadId, { ...after.settings, demoVersion: DEMO_VERSION, demoState: state });
  return buildSummary(vault, threadId, state, true);
}

function scriptedTurn(
  vault: Vault,
  threadId: string,
  text: string,
  answer: string,
  attachments?: EpisodeInput[],
): Promise<TurnResult> {
  return runTurn(vault, threadId, {
    text,
    model: DEMO_MODEL,
    budget: DEMO_BUDGET,
    // The proof collection is a deterministic A13/A14 exhibit. Optional A15
    // semantic addresses remain available to ordinary turns, but must not add
    // approximate neighbors (for example archive filler) to this exact tour.
    compileOptions: { semantic: false },
    provider: scriptedProvider(answer),
    ...(attachments === undefined ? {} : { attachments }),
  });
}

/** A local scripted provider; the hidden map is only a proposal to the gate. */
function scriptedProvider(answer: string): Provider {
  return async function* (request) {
    yield { type: "delta", text: answer };
    const mapTool = request.tools.some((tool) => tool.name === "submit_claim_map");
    // The demo provider may propose mappings, but only current-authority
    // capabilities are appropriate inputs. Assistant/model capabilities are
    // deliberately omitted: the kernel must never let prior model prose turn
    // the collection answer into a released fact.
    const tokens =
      request.evidence
        ?.filter(
          (capability) =>
            capability.authority === "user" ||
            capability.authority === "tool" ||
            capability.authority === "attachment",
        )
        .map((capability) => capability.token)
        .filter(Boolean) ?? [];
    if (mapTool && tokens.length > 0) {
      yield {
        type: "tool_call",
        id: `demo-claim-map-${sha256(answer).slice(0, 12)}`,
        name: "submit_claim_map",
        arguments: JSON.stringify({
          claims: [{ outputSpan: [0, answer.length], capabilityTokens: tokens }],
        }),
      };
    }
    yield {
      type: "done",
      usage: { inputTokens: 0, outputTokens: Math.max(1, answer.length) },
    };
  };
}

function turnState(query: string, result: TurnResult): DemoTurnState {
  return {
    query,
    questionSeq: result.userEpisode.seq,
    answerSeq: result.assistantEpisode.seq,
    packetId: result.packet.id,
  };
}

function readDemoState(settings: Record<string, unknown>): DemoState | null {
  if (settings.demoVersion !== DEMO_VERSION || !isRecord(settings.demoState)) return null;
  const raw = settings.demoState as Partial<DemoState>;
  if (
    raw.version !== DEMO_VERSION ||
    !Number.isSafeInteger(raw.originalSeq) ||
    !Number.isSafeInteger(raw.correctionSeq) ||
    !isTurnState(raw.groundedFact) ||
    !Number.isSafeInteger(raw.forgottenSourceSeq) ||
    !isTurnState(raw.grounded) ||
    !isTurnState(raw.repeated) ||
    !isTurnState(raw.collection) ||
    !isTurnState(raw.final) ||
    !isRecord(raw.attachment) ||
    !Number.isSafeInteger(raw.attachment.seq) ||
    !isTurnState(raw.attachment.turn) ||
    typeof raw.attachment.manifestId !== "string" ||
    typeof raw.attachment.marker !== "string"
  ) {
    throw new Error("the proof demo marker is malformed");
  }
  return raw as DemoState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTurnState(value: unknown): value is DemoTurnState {
  if (!isRecord(value)) return false;
  return (
    typeof value.query === "string" &&
    Number.isSafeInteger(value.questionSeq) &&
    Number.isSafeInteger(value.answerSeq) &&
    typeof value.packetId === "string"
  );
}

function buildSummary(vault: Vault, threadId: string, state: DemoState, seeded: boolean): DemoSummary {
  const collection = turnRef(vault, threadId, state.final);
  const coverage = collection.coverage;
  if (coverage === undefined) throw new Error("the proof demo final packet has no coverage receipt");
  const correctedGroundedBase = turnRef(vault, threadId, state.groundedFact);
  const factRoute = latestActiveRoute(vault, threadId, ADDRESS_QUERY);
  if (factRoute === null) throw new Error("the proof demo corrected fact route is missing");
  const correctedGrounded = withRoute(correctedGroundedBase, routeHref(threadId, factRoute.id));
  const currentWitness = factRoute.witnesses.find((witness) => witness.seq === state.correctionSeq);
  if (currentWitness === undefined) {
    throw new Error("the proof demo corrected fact route has no current witness");
  }
  const originalText = userEpisodeText(vault, threadId, state.originalSeq, false);
  const currentText = userEpisodeText(vault, threadId, state.correctionSeq, false);
  const groundedBase = turnRef(vault, threadId, state.grounded);
  const repeatedBase = turnRef(vault, threadId, state.repeated);
  const invalidation = pageForPacket(repeatedBase, "invalidation", false);
  if (invalidation === null) throw new Error("the proof demo address page is missing");
  const invalidationRouteHref =
    invalidation.routeId === undefined || invalidation.routeId.length === 0
      ? undefined
      : routeHref(threadId, invalidation.routeId);
  const grounded = withRoute(groundedBase, invalidationRouteHref);
  const repeated = withRoute(repeatedBase, invalidationRouteHref);
  const sourceText = userEpisodeText(vault, threadId, state.forgottenSourceSeq, true);
  const removedEpisode = vault.episodes.getBounded(threadId, state.forgottenSourceSeq, 0, 16 * 1024);
  if (
    removedEpisode === null ||
    removedEpisode.meta.removed !== true ||
    removedEpisode.originalContentHash === undefined ||
    removedEpisode.locatorOmittedReason !== "removed"
  ) {
    throw new Error("the proof demo removed source has no bounded tombstone receipt");
  }
  const sourceReceipt: DemoRemovalReceipt = {
    status: "tombstoned",
    contentAvailable: false,
    ...(typeof removedEpisode.meta.tombstone === "string"
      ? { tombstoneId: removedEpisode.meta.tombstone }
      : {}),
    originalContentHash: removedEpisode.originalContentHash,
    locatorOmittedReason: removedEpisode.locatorOmittedReason,
  };
  const attachmentEpisode = vault.episodes.get(threadId, state.attachment.seq);
  const manifest = attachmentEpisode?.meta.manifest;
  if (attachmentEpisode === null || attachmentEpisode === undefined || manifest === undefined) {
    throw new Error("the proof demo attachment manifest is missing");
  }
  const attachmentTurn = turnRef(vault, threadId, state.attachment.turn);
  const actualTail = pageForPacket(attachmentTurn, "attachment-tail", true);
  if (actualTail === null) throw new Error("the proof demo attachment page is missing");

  const read = readAttachmentSpan(vault, threadId, state.attachment.seq, manifest.spans.length - 1);
  if (read === null || !new TextDecoder().decode(read.bytes).includes(state.attachment.marker)) {
    throw new Error("the proof demo tail marker is not byte-backed");
  }
  const packet = vault.packets.get(threadId, state.final.questionSeq);
  if (packet === null || packet.id !== state.final.packetId) throw missingPacket(state.final.packetId);
  // The proof surface must not show an unverified chain dash. This full check
  // also refuses to summarize a demo whose durable receipts no longer verify.
  const thread = stats(vault, threadId, { verify: true });
  const tailFrom = actualTail.byteRange?.[0] ?? read.span.from;
  const tailTo = actualTail.byteRange?.[1] ?? read.span.to;
  const sourceTexts = collectionSources(vault, threadId, coverage);
  assertDemoCollection(collection, coverage, sourceTexts, packet);
  const attachmentLinks = {
    ...attachmentTurn.links,
    attachment: episodeHref(threadId, state.attachment.seq),
    span: attachmentSpanHref(threadId, state.attachment.seq, manifest.spans.length - 1),
  };
  return {
    version: DEMO_VERSION,
    seeded,
    thread,
    proof: {
      correctedFact: {
        originalSeq: state.originalSeq,
        correctionSeq: state.correctionSeq,
        historicalValue: HISTORICAL_VALUE,
        currentValue: CURRENT_VALUE,
        originalText,
        currentText,
        grounded: correctedGrounded,
        routeId: factRoute.id,
        currentWitness: demoWitness(currentWitness, episodeHref(threadId, currentWitness.seq)),
      },
      collection: {
        ...collection,
        required: coverage.required ?? 0,
        located: coverage.located,
        supported: coverage.supported,
        completeness: coverage.completeness,
        sources: sourceTexts,
      },
      invalidation: {
        grounded,
        repeated,
        sourceSeq: state.forgottenSourceSeq,
        sourceText,
        sourceReceipt,
        sourceHref: episodeHref(threadId, state.forgottenSourceSeq),
        routeId: invalidation.routeId ?? "",
        page: invalidation,
      },
      attachment: {
        seq: state.attachment.seq,
        name: manifest.name,
        manifestId: manifest.id,
        spans: manifest.spans.length,
        tail: {
          from: tailFrom,
          to: tailTo,
          hash: actualTail.spanHash ?? read.span.hash,
          marker: state.attachment.marker,
        },
        page: actualTail,
        links: attachmentLinks,
      },
    },
    final: collection,
  };
}

function assertDemoCollection(
  collection: DemoTurnRef,
  coverage: NonNullable<DemoTurnRef["coverage"]>,
  sourceTexts: Array<{ seq: Seq; text: string; href: string }>,
  packet: Packet,
): void {
  const sourceWords = sourceTexts.map((source) => source.text);
  if (
    collection.query !== COLLECTION_QUERY ||
    collection.answer !== DEMO_COLLECTION_ANSWER ||
    coverage.required !== DEMO_COLLECTION_REQUIRED ||
    coverage.located !== DEMO_LAUNCH_NOTES.length ||
    coverage.supported !== DEMO_LAUNCH_NOTES.length ||
    coverage.historical !== 0 ||
    coverage.unresolved !== DEMO_COLLECTION_UNRESOLVED ||
    coverage.completeness !== "incomplete" ||
    sourceWords.length !== DEMO_LAUNCH_NOTES.length ||
    sourceWords.some((text, index) => text !== DEMO_LAUNCH_NOTES[index])
  ) {
    throw new Error("the proof demo collection receipt does not match its deterministic source set");
  }

  const receipt = packet.answerReceipt;
  const supportedCoverage = receipt?.classifications.some(
    (classification) =>
      classification.classification === "SUPPORTED" &&
      classification.kind === "collection" &&
      classification.basis?.kind === "coverage" &&
      classification.basis.metric === "located" &&
      classification.basis.value === DEMO_LAUNCH_NOTES.length &&
      classification.basis.digest === coverage.digest,
  );
  if (receipt?.status !== "released" || receipt.qualifications.length !== 0 || supportedCoverage !== true) {
    throw new Error("the proof demo final answer is not released against its coverage basis");
  }
}

function demoWitness(
  witness: {
    seq: Seq;
    contentHash: string;
    byteRange: [number, number];
    spanHash?: string;
    revision?: string;
    authority: DemoWitness["authority"];
    source?: string;
  },
  href?: string,
): DemoWitness {
  return {
    seq: witness.seq,
    source: witness.source ?? `episode:${witness.seq}`,
    byteRange: [...witness.byteRange] as [number, number],
    contentHash: witness.contentHash,
    ...(witness.spanHash === undefined ? {} : { spanHash: witness.spanHash }),
    ...(witness.revision === undefined ? {} : { revision: witness.revision }),
    authority: witness.authority,
    ...(href === undefined ? {} : { href }),
  };
}

function turnRef(vault: Vault, threadId: string, state: DemoTurnState): DemoTurnRef {
  const packet = vault.packets.get(threadId, state.questionSeq);
  const answer = vault.episodes.get(threadId, state.answerSeq);
  if (packet === null || packet.id !== state.packetId) throw missingPacket(state.packetId);
  if (answer === null || answer.role !== "assistant") {
    throw new Error(`proof demo answer episode ${state.answerSeq} is missing`);
  }
  return {
    query: state.query,
    questionSeq: state.questionSeq,
    answerSeq: state.answerSeq,
    packetId: packet.id,
    answer: answer.content,
    pages: packet.pages,
    ...(packet.coverage === undefined ? {} : { coverage: packet.coverage }),
    ...(packet.answerReceipt === undefined
      ? {}
      : { answerReceipt: { status: packet.answerReceipt.status, digest: packet.answerReceipt.digest } }),
    links: turnLinks(threadId, state),
  };
}

function withRoute(ref: DemoTurnRef, href: string | undefined): DemoTurnRef {
  return href === undefined ? ref : { ...ref, links: { ...ref.links, route: href } };
}

function turnLinks(threadId: string, state: DemoTurnState) {
  return {
    packet: packetHref(threadId, state.questionSeq),
    packetReceipt: packetReceiptHref(threadId, state.packetId),
    questionEpisode: episodeHref(threadId, state.questionSeq),
    answerEpisode: episodeHref(threadId, state.answerSeq),
  };
}

function apiRoot(threadId: string): string {
  return `/api/threads/${encodeURIComponent(threadId)}`;
}

function episodeHref(threadId: string, seq: Seq): string {
  return `${apiRoot(threadId)}/episodes/${seq}`;
}

function packetHref(threadId: string, turnSeq: Seq): string {
  return `${apiRoot(threadId)}/packets/${turnSeq}`;
}

function packetReceiptHref(threadId: string, packetId: string): string {
  return `${apiRoot(threadId)}/demo/packets/${encodeURIComponent(packetId)}`;
}

function routeHref(threadId: string, routeId: string): string {
  return `${apiRoot(threadId)}/demo/routes/${encodeURIComponent(routeId)}`;
}

function attachmentSpanHref(threadId: string, seq: Seq, ordinal: number): string {
  return `${apiRoot(threadId)}/demo/attachments/${seq}/spans/${ordinal}`;
}

function userEpisodeText(vault: Vault, threadId: string, seq: Seq, removed: boolean): string {
  const episode = vault.episodes.get(threadId, seq);
  if (
    episode === null ||
    episode.role !== "user" ||
    (removed ? episode.meta.removed !== true : episode.meta.removed === true)
  ) {
    throw new Error(`the proof demo source episode ${seq} is unavailable`);
  }
  return episode.content;
}

function collectionSources(
  vault: Vault,
  threadId: string,
  coverage: NonNullable<DemoTurnRef["coverage"]>,
): Array<{ seq: Seq; text: string; href: string }> {
  const seen = new Set<Seq>();
  return coverage.routes.flatMap((route) => {
    if (route.status === "unresolved") return [];
    const match = /^episode:(\d+)$/u.exec(route.source);
    const seq = match === null ? undefined : Number(match[1]);
    if (seq === undefined || !Number.isSafeInteger(seq) || seen.has(seq)) return [];
    const episode = vault.episodes.get(threadId, seq);
    if (episode === null || episode.role !== "user" || episode.meta.removed === true) {
      throw new Error(`the proof demo collection source ${route.source} is unavailable`);
    }
    const bytes = new TextEncoder().encode(episode.content).byteLength;
    if (route.byteRange[0] < 0 || route.byteRange[1] > bytes || route.byteRange[0] >= route.byteRange[1]) {
      throw new Error(`the proof demo collection source ${route.source} has an invalid byte range`);
    }
    seen.add(seq);
    return [{ seq, text: episode.content, href: episodeHref(threadId, seq) }];
  });
}

function latestActiveRoute(vault: Vault, threadId: string, query: string) {
  return (
    listCurrentAddressRoutes(vault, threadId, query)
      .filter((route) => route.status === "active")
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  );
}

function pageFor(packet: Packet, trigger: PageRecord["trigger"], resolved: boolean): PageRecord | null {
  return packet.pages.find((page) => page.trigger === trigger && page.resolved === resolved) ?? null;
}

function pageForPacket(
  ref: DemoTurnRef,
  trigger: PageRecord["trigger"],
  resolved: boolean,
): PageRecord | null {
  return ref.pages.find((page) => page.trigger === trigger && page.resolved === resolved) ?? null;
}

function demoAttachmentBytes(): Uint8Array {
  // Cross a real chunk boundary without manufacturing ten thousand distinct
  // numeric routing names.  Ordinary writes enforce the capsule-source name
  // bound before anything commits, including deterministic demo fixtures.
  const prefix = "proof archive padding line\n".repeat(4_000);
  const bytes = new TextEncoder().encode(`${prefix}${DEMO_TAIL_MARKER}`);
  if (bytes.byteLength <= ATTACHMENT_CHUNK_SIZE)
    throw new Error("proof demo attachment did not exceed one chunk");
  return bytes;
}

function missingThread(threadId: string): Error & { status: 404; code: "thread_not_found" } {
  return Object.assign(new Error(`unknown thread ${threadId}`), {
    status: 404 as const,
    code: "thread_not_found" as const,
  });
}

function requiresEmptyThread(): Error & { status: 409; code: "demo_requires_empty" } {
  return Object.assign(new Error("the proof demo can only seed an empty thread"), {
    status: 409 as const,
    code: "demo_requires_empty" as const,
  });
}

function missingPacket(packetId: string): Error {
  return new Error(`proof demo packet ${packetId} is missing`);
}
