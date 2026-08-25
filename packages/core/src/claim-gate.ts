/** One-turn evidence capabilities and the deterministic remembered-claim gate (A14). */

import type {
  AnswerReceipt,
  ByteLocator,
  ClaimCandidate,
  ClaimClassification,
  ClaimClassificationReceipt,
  ClaimCoverageBasis,
  ClaimScanOverflow,
  CoverageMetric,
  CoverageReceipt,
  EvidenceAuthority,
  EvidenceCapability,
  EvidenceLocator,
  RememberedClaimKind,
  Seq,
  Sha256,
  ToolDef,
} from "@pylos/protocol";
import { CLAIM_CAPS } from "@pylos/protocol";
import { canonicalHash, newId, sha256 } from "./hash.ts";
import type { SemanticSourcePhase } from "./semantic-phase.ts";

export const CLAIM_GRAMMAR_VERSION = "a14-grammar-v1";

/**
 * The scan receipt is deliberately derived from the kernel's candidate list,
 * rather than from provider prose.  Keep this in one exported helper so the
 * verifier can recompute the exact value without duplicating the grammar
 * contract (KERNEL A14).
 */
export function claimScanDigestOf(
  candidates: readonly ClaimCandidate[],
  overflow?: ClaimScanOverflow,
): Sha256 {
  return canonicalHash({
    grammarVersion: CLAIM_GRAMMAR_VERSION,
    candidates,
    ...(overflow === undefined ? {} : { overflow }),
  });
}

/** Return the canonical digest of an answer receipt body (excluding `digest`). */
export function answerReceiptDigestOf(receipt: AnswerReceipt): Sha256 {
  const { digest: _digest, ...body } = receipt;
  return canonicalHash(body);
}

/**
 * A non-authoritative, hidden provider tool.  The kernel never uses its
 * contents to discover claims or decide their kind; it is only a compact way
 * for a provider to associate already-rendered output with capabilities.
 */
export const SUBMIT_CLAIM_MAP_TOOL: ToolDef = {
  name: "submit_claim_map",
  description:
    "Associate remembered assertions in the final answer with one-turn evidence capability tokens. " +
    "The kernel independently scans the answer and ignores unsupported hints.",
  parameters: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            outputSpan: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
            capabilityTokens: { type: "array", items: { type: "string" } },
            kindHint: { type: "string" },
          },
          required: ["outputSpan", "capabilityTokens"],
        },
      },
    },
    required: ["claims"],
  },
};

export interface EvidenceSource {
  seq?: Seq;
  manifestId?: string;
  byteRange: [number, number];
  sourceDigest: Sha256;
  /** Exact hash of `text`/`byteRange`; sourceDigest is the whole source hash. */
  spanDigest?: Sha256;
  revision?: string;
  authority: EvidenceAuthority;
  text: string;
  /** Kernel-derived atom/span phase for semantic addresses. */
  phase?: SemanticSourcePhase;
}

export interface IssuedEvidence {
  capability: EvidenceCapability;
  source: EvidenceSource;
}

export function issueEvidenceCapabilities(input: {
  threadId: string;
  turnSeq: Seq;
  roundOrdinal: number;
  messagesDigest: Sha256;
  packetDigest: Sha256;
  sources: readonly EvidenceSource[];
}): IssuedEvidence[] {
  return input.sources.map((source) => {
    const token = newId("cap");
    return {
      capability: {
        token,
        threadId: input.threadId,
        turnSeq: input.turnSeq,
        roundOrdinal: input.roundOrdinal,
        messagesDigest: input.messagesDigest,
        packetDigest: input.packetDigest,
        ...(source.seq === undefined ? {} : { seq: source.seq }),
        ...(source.manifestId === undefined ? {} : { manifestId: source.manifestId }),
        byteRange: source.byteRange,
        sourceDigest: source.sourceDigest,
        ...(source.spanDigest === undefined ? {} : { spanDigest: source.spanDigest }),
        ...(source.revision === undefined ? {} : { revision: source.revision }),
        authority: source.authority,
      },
      source,
    };
  });
}

export interface ClaimMapEntry {
  outputSpan: [number, number];
  capabilityTokens: string[];
  kindHint?: string;
}

export function parseClaimMap(raw: string): ClaimMapEntry[] {
  try {
    const parsed = JSON.parse(raw) as { claims?: unknown };
    if (!Array.isArray(parsed.claims)) return [];
    let remainingTokenBudget = CLAIM_CAPS.maxCapabilityDigests;
    return parsed.claims.slice(0, CLAIM_CAPS.maxCandidates).flatMap((value) => {
      if (value === null || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      const span = row.outputSpan;
      const tokens = row.capabilityTokens;
      if (!Array.isArray(span) || span.length !== 2 || !Array.isArray(tokens)) return [];
      const from = Number(span[0]);
      const to = Number(span[1]);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) return [];
      const capabilityTokens = tokens
        .filter((token): token is string => typeof token === "string")
        .slice(0, Math.min(32, remainingTokenBudget));
      remainingTokenBudget -= capabilityTokens.length;
      return [
        {
          outputSpan: [from, to] as [number, number],
          capabilityTokens,
          ...(typeof row.kindHint === "string" ? { kindHint: row.kindHint.slice(0, 64) } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

export function isMemoryQuestion(question: string): boolean {
  const text = question.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  // Lexical words such as "signed" and "contract" occur in ordinary user
  // assertions.  A seed statement followed by "Noted." is not a request to
  // gate the acknowledgement.  No-question-mark statements are still allowed
  // when they begin with a clear recall/collection imperative ("list every…",
  // "repeat…", etc.).
  const startsRecall =
    /^(?:what|who|where|when|which|how|did|do|does|is|are|was|were|remember|repeat|recall|list|compare|show|tell|name)\b/u.test(
      text,
    );
  const creative = isFreeProseRequest(question);
  const explicitMemory = isExplicitMemoryCue(text);
  // A creative wrapper normally opts out of A14, but an explicit personal or
  // archive reference inside it still asks the model to retrieve remembered
  // material.  Keep ordinary assertions (and fictional framing) outside the
  // gate unless the user supplied one of these retrieval cues.
  if (creative && !explicitMemory) return false;
  if (!text.includes("?") && !startsRecall && !(creative && explicitMemory)) return false;
  return (
    /\b(?:remember|recalled?|earlier|before|again|archive|conversation|thread|note|notes|said|say|gave|decided|signed|lived|live|contract|amount|phrase|token)\b/u.test(
      text,
    ) ||
    /\b(?:vault|pin|deployment|launch|rollout|owner|source|memory|location|budget|decision|plan)\b/u.test(
      text,
    ) ||
    /\b(?:did|do|was|were|where|when|who|what|how)\s+(?:i|we|you|the)\b/u.test(text) ||
    /\b(?:all|every|each|compare|list)\b/u.test(text) ||
    explicitMemory
  );
}

function isExplicitMemoryCue(text: string): boolean {
  const fictional = /\b(?:fictional|imaginary|invented|made[- ]up|pretend|hypothetical|fantasy)\b/u.test(
    text,
  );
  const archiveOrPast =
    /\b(?:archive|archived|conversation|thread|earlier|again|remember(?:ed|ing)?|recalled?)\b/u.test(text);
  if (archiveOrPast) return true;
  if (
    !fictional &&
    /\b(?:i|we|you)\s+(?:signed|gave|said|decided|recorded|noted|agreed|lived|owned|sent|chose)\b/u.test(text)
  ) {
    return true;
  }
  if (fictional) return false;
  return /\b(?:my|our)\b[^.!?\n]{0,80}\b(?:number|amount|identity|name|quote|quotation|phrase|note|notes|contract|decision|launch|deployment|location|budget|token|source|value|date|owner)\b/u.test(
    text,
  );
}

function isFreeProseRequest(question: string): boolean {
  const text = question.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  return (
    /^(?:write|compose|create|invent|imagine|draft)\b/u.test(text) ||
    /\b(?:poem|story|fiction|song|brainstorm)\b/u.test(text) ||
    /^(?:what|how)\s+(?:should|could|would|might)\b/u.test(text) ||
    /^(?:explain|reason|analy[sz]e|compare\s+the\s+(?:options|tradeoffs))\b/u.test(text)
  );
}

function isWorldFactQuestion(question: string): boolean {
  const text = question.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
  return (
    !isMemoryQuestion(question) &&
    !isFreeProseRequest(question) &&
    /^(?:what|who|where|when|which|how\s+(?:many|much|old|long)|is|are|was|were|does|do|did|name)\b/u.test(
      text,
    )
  );
}

interface LocatedCandidate extends ClaimCandidate {
  priority: number;
}

interface CandidateAccumulator {
  candidates: LocatedCandidate[];
  keys: Set<string>;
  bytes: number;
  overflowReason?: ClaimScanOverflow["reason"];
}

function pushCandidate(
  state: CandidateAccumulator,
  draft: string,
  span: [number, number],
  kind: RememberedClaimKind,
  priority: number,
): boolean {
  const [from, to] = span;
  if (from < 0 || to <= from || to > draft.length) return true;
  const key = `${kind}:${from}:${to}`;
  if (state.keys.has(key)) return true;
  const candidate = { span, kind, text: draft.slice(from, to), priority };
  const candidateBytes = new TextEncoder().encode(
    JSON.stringify({ span, kind, text: candidate.text }),
  ).byteLength;
  if (state.candidates.length >= CLAIM_CAPS.maxCandidates) {
    state.overflowReason ??= "candidate-cap";
    return false;
  }
  if (state.bytes + candidateBytes > CLAIM_CAPS.maxCandidateBytes) {
    state.overflowReason ??= "candidate-bytes";
    return false;
  }
  state.keys.add(key);
  state.candidates.push(candidate);
  state.bytes += candidateBytes;
  return true;
}

// A code-like token is a bounded identifier when it contains both a letter
// and a digit. It must be scanned as one exact token; treating the numeric
// suffix as a standalone number would let a nearby source code witness the
// wrong identifier.
const CODE_IDENTIFIER_PATTERN =
  /(?<![\p{L}\p{N}_-])(?=[\p{L}\p{N}_-]*\p{L})(?=[\p{L}\p{N}_-]*\p{N})[\p{L}\p{N}][\p{L}\p{N}_-]*(?![\p{L}\p{N}_-])/gu;

function isCodeIdentifier(text: string): boolean {
  const pattern = new RegExp(CODE_IDENTIFIER_PATTERN.source, CODE_IDENTIFIER_PATTERN.flags);
  const match = pattern.exec(text);
  return match?.[0] === text;
}

function isDeclarativeFactClause(text: string): boolean {
  const trimmed = text
    .normalize("NFKC")
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, "")
    .trim();
  if (trimmed.length === 0) return false;
  if (/^(?:and|or|but|while|then|because|if|when|to|with|for|from|by|of|in|on|at)\b/iu.test(trimmed)) {
    return false;
  }
  if (/^(?:i\s+(?:would|could|should)|let(?:'s| us)|perhaps|maybe)\b/iu.test(trimmed)) return false;
  // This is intentionally a shape check, not a finite-verb allow-list. Any
  // sufficiently populated declarative-looking clause is safer as a
  // qualified fact than as silently unscanned prose.
  const words = [...trimmed.matchAll(/[\p{L}][\p{L}'’_-]*/gu)];
  return words.length >= 1;
}

function hasIndependentSeparator(text: string): boolean {
  if (/\s+(?:and|but|while|then)\s+|[;—:•()]/iu.test(text)) return true;
  for (const match of text.matchAll(/,/gu)) {
    const at = match.index;
    if (at === undefined) continue;
    if (/\d/u.test(text[at - 1] ?? "") && /\d/u.test(text[at + 1] ?? "")) continue;
    return true;
  }
  return false;
}

export interface ClaimScanResult {
  candidates: ClaimCandidate[];
  overflow?: ClaimScanOverflow;
}

/** Candidate discovery never trusts the provider's hidden map. */
export function scanRememberedClaimsDetailed(question: string, draft: string): ClaimScanResult {
  if (draft.length === 0) return { candidates: [] };
  // Reasoning and creative prose are deliberately outside the memory gate.
  // This decision is based on the user's request, never on a provider hint.
  const state: CandidateAccumulator = { candidates: [], keys: new Set(), bytes: 0 };
  const memory = isMemoryQuestion(question);
  const worldFact = isWorldFactQuestion(question);
  // A seed/assertion turn (for example, "The contract is signed. Noted.") is
  // neither a request to recall nor a world-fact question. Its numbers and
  // names must not be promoted into remembered-claim candidates merely because
  // the assistant happened to repeat them.
  if (!memory && !worldFact) return { candidates: [] };

  for (const match of draft.matchAll(
    new RegExp(CODE_IDENTIFIER_PATTERN.source, CODE_IDENTIFIER_PATTERN.flags),
  )) {
    const start = match.index;
    if (
      start !== undefined &&
      !pushCandidate(state, draft, [start, start + match[0].length], "identity", 0)
    ) {
      break;
    }
  }
  if (state.overflowReason === undefined) {
    for (const match of draft.matchAll(
      /(?<![\p{L}\p{N}])\d[\d,.]*(?:\s*(?:USD|EUR|GBP|%|ms|seconds?|minutes?|hours?|units?))?(?![\p{L}\p{N}])/giu,
    )) {
      const start = match.index;
      if (
        start !== undefined &&
        !pushCandidate(state, draft, [start, start + match[0].length], "number", 0)
      ) {
        break;
      }
    }
  }
  if (state.overflowReason === undefined) {
    for (const match of draft.matchAll(/["“]([^"”]+)["”]/gu)) {
      const start = match.index;
      const words = (match[1] ?? "").trim().split(/\s+/u);
      if (
        start !== undefined &&
        words.length >= 3 &&
        !pushCandidate(state, draft, [start, start + match[0].length], "quote", 1)
      ) {
        break;
      }
    }
  }

  if (state.overflowReason === undefined) {
    for (const match of draft.matchAll(/[^.!?\n]+(?:[.!?]|$)/gu)) {
      const raw = match[0];
      const leading = raw.length - raw.trimStart().length;
      const text = raw.trim();
      const start = (match.index ?? 0) + leading;
      if (text.length === 0) continue;
      const end = start + text.length;
      if (memory && /\b(?:there\s+(?:were|are)|exactly|all\s+\d+|i\s+found\s+\d+)\b/iu.test(text)) {
        if (!pushCandidate(state, draft, [start, end], "collection", 2)) break;
      }
      const hasNumber = state.candidates.some(
        (candidate) => candidate.kind === "number" && overlaps(candidate.span, [start, end]),
      );
      const hasQuote = state.candidates.some(
        (candidate) => candidate.kind === "quote" && overlaps(candidate.span, [start, end]),
      );
      if (
        !hasNumber &&
        !hasQuote &&
        !state.candidates.some(
          (candidate) =>
            (candidate.kind === "collection" || candidate.kind === "identity") &&
            overlaps(candidate.span, [start, end]),
        ) &&
        /\b(?:is|are|was|were|live|lives|lived|owner|owned|called|named)\b/iu.test(text)
      ) {
        if (!pushCandidate(state, draft, [start, end], "identity", 3)) break;
      }
      const fullCollection =
        state.candidates.some(
          (candidate) =>
            candidate.kind === "collection" && candidate.span[0] === start && candidate.span[1] === end,
        ) && !hasIndependentSeparator(text);
      const fullRelationIdentity =
        state.candidates.some(
          (candidate) =>
            candidate.kind === "identity" && candidate.span[0] === start && candidate.span[1] === end,
        ) &&
        relationSignatures(text).length === 1 &&
        !hasIndependentSeparator(text);
      if (
        (memory || worldFact) &&
        !fullCollection &&
        !fullRelationIdentity &&
        isDeclarativeFactClause(text) &&
        !/^(?:i\s+(?:would|could|should)|let(?:'s| us)|perhaps|maybe)\b/iu.test(text) &&
        !pushCandidate(state, draft, [start, end], "fact", 4)
      ) {
        break;
      }
    }
  }

  const ordered = state.candidates.sort(
    (a, b) => a.span[0] - b.span[0] || a.priority - b.priority || a.span[1] - b.span[1],
  );
  const collections = ordered.filter((candidate) => candidate.kind === "collection");
  const codeIdentifiers = ordered.filter(
    (candidate) => candidate.kind === "identity" && isCodeIdentifier(candidate.text),
  );
  const candidates = ordered
    // The sentence-level collection candidate owns its cardinality. Keeping a
    // nested generic number would let a source-string capability authorize the
    // same count without consulting the A13 receipt.
    .filter(
      (candidate) =>
        candidate.kind !== "number" ||
        (!collections.some((collection) => overlaps(candidate.span, collection.span)) &&
          !codeIdentifiers.some((code) => overlaps(candidate.span, code.span))),
    )
    .map(({ priority: _priority, ...candidate }) => candidate);
  return {
    candidates,
    ...(state.overflowReason === undefined
      ? {}
      : {
          overflow: {
            reason: state.overflowReason,
            maxCandidates: CLAIM_CAPS.maxCandidates,
            maxCandidateBytes: CLAIM_CAPS.maxCandidateBytes,
            retainedCandidates: candidates.length,
            retainedBytes: state.bytes,
            observedAtLeast:
              state.overflowReason === "candidate-cap" ? CLAIM_CAPS.maxCandidates + 1 : candidates.length + 1,
          },
        }),
  };
}

export function scanRememberedClaims(question: string, draft: string): ClaimCandidate[] {
  return scanRememberedClaimsDetailed(question, draft).candidates;
}

export interface RevalidationResult {
  valid: boolean;
  classification?: "current" | "historical" | "proposed";
  text?: string;
  source?: EvidenceLocator;
}

function overlaps(left: [number, number], right: [number, number]): boolean {
  return left[0] < right[1] && right[0] < left[1];
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

interface TextClaim {
  kind: string;
  text: string;
}

interface RelationSignature {
  relation: "owner" | "location";
  subject: string;
  object: string;
  negated: boolean;
}

function relationArgument(value: string): string {
  return normalized(value)
    .replace(/^[\s"“”'`]+|[\s"“”'`.,!?;:]+$/gu, "")
    .replace(/^(?:the|a|an)\s+/u, "")
    .trim();
}

function relationSignatures(text: string): RelationSignature[] {
  const signatures: RelationSignature[] = [];
  for (const rawClause of text.split(/[.!?;\n]+/u)) {
    const clause = rawClause.trim();
    if (clause.length === 0) continue;
    const ownerCopula =
      /^(.+?)\s+(?:is|are|was|were)\s+(?:(not|never)\s+)?(?:the\s+)?owner\s+of\s+(.+)$/iu.exec(clause);
    if (ownerCopula !== null) {
      const subject = relationArgument(ownerCopula[1] ?? "");
      const object = relationArgument(ownerCopula[3] ?? "");
      if (subject.length > 0 && object.length > 0) {
        signatures.push({
          relation: "owner",
          subject,
          object,
          negated: ownerCopula[2] !== undefined,
        });
        continue;
      }
    }
    const ownerVerb = /^(.+?)\s+(?:(?:(?:does|do|did)\s+)?(?:(not|never)\s+)?own(?:s|ed)?)\s+(.+)$/iu.exec(
      clause,
    );
    if (ownerVerb !== null) {
      const subject = relationArgument(ownerVerb[1] ?? "");
      const object = relationArgument(ownerVerb[3] ?? "");
      if (subject.length > 0 && object.length > 0) {
        signatures.push({
          relation: "owner",
          subject,
          object,
          negated: ownerVerb[2] !== undefined,
        });
        continue;
      }
    }
    const locationVerb =
      /^(.+?)\s+(?:(?:(?:does|do|did)\s+)?(?:(not|never)\s+)?live(?:s|d)?|(?:is|are|was|were)\s+(?:(not|never)\s+)?(?:living|based))\s+in\s+(.+)$/iu.exec(
        clause,
      );
    if (locationVerb !== null) {
      const subject = relationArgument(locationVerb[1] ?? "");
      const object = relationArgument(locationVerb[4] ?? "");
      if (subject.length > 0 && object.length > 0) {
        signatures.push({
          relation: "location",
          subject,
          object,
          negated: (locationVerb[2] ?? locationVerb[3]) !== undefined,
        });
        continue;
      }
    }
    const locationCopula = /^(.+?)\s+(?:is|are|was|were)\s+(?:(not|never)\s+)?in\s+(.+)$/iu.exec(clause);
    if (locationCopula !== null) {
      const subject = relationArgument(locationCopula[1] ?? "");
      const object = relationArgument(locationCopula[3] ?? "");
      if (subject.length > 0 && object.length > 0) {
        signatures.push({
          relation: "location",
          subject,
          object,
          negated: locationCopula[2] !== undefined,
        });
      }
    }
  }
  return signatures;
}

function identityNameValue(text: string): string | undefined {
  const match =
    /^(?:my\s+name\s+is|i\s+am|i['’]?m|call\s+me|i\s+am\s+called|i\s+was\s+called)\s+(.+)$/iu.exec(
      text.trim().replace(/[.!?]+$/gu, ""),
    );
  return match === null ? undefined : relationArgument(match[1] ?? "");
}

function relationPresent(candidate: TextClaim, source: string): boolean {
  const candidateRelations = relationSignatures(candidate.text);
  if (candidateRelations.length === 1) {
    const wanted = candidateRelations[0] as RelationSignature;
    const matching = relationSignatures(source).filter(
      (relation) =>
        relation.relation === wanted.relation &&
        relation.subject === wanted.subject &&
        relation.object === wanted.object,
    );
    // A contradictory source is not a witness, even if another nearby clause
    // happens to repeat the same names.  If both polarities are present, remain
    // conservative and qualify the answer rather than choosing one.
    return matching.length > 0 && matching.every((relation) => relation.negated === wanted.negated);
  }
  // The atomizer may expose only the named value (for example `Ada Okafor`) to
  // the verifier while the answer carries identity framing.  This narrow
  // fallback does not apply to relational claims, so a bare name can never
  // witness a reversed or negated owner/location assertion.
  const value = identityNameValue(candidate.text);
  return value !== undefined && normalized(source) === value;
}

const NUMBER_UNIT_PATTERN = /^(?:usd|eur|gbp|%|ms|seconds?|minutes?|hours?|units?)$/iu;
const NUMBER_TOKEN_PATTERN = /(?<![\p{L}\p{N}])\d[\d,]*(?:\.\d+)?/gu;

interface NumericClaim {
  value: string;
  unit?: string;
}

function canonicalNumber(raw: string): string | undefined {
  // Accept plain integers/decimals and conventional three-digit grouping. Do
  // not silently reinterpret malformed grouping as a different number.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u.test(raw)) return undefined;
  const compact = raw.replace(/,/gu, "");
  const [whole = "0", fraction = ""] = compact.split(".");
  const canonicalWhole = whole.replace(/^0+(?=\d)/u, "") || "0";
  const canonicalFraction = fraction.replace(/0+$/u, "");
  return canonicalFraction.length === 0 ? canonicalWhole : `${canonicalWhole}.${canonicalFraction}`;
}

function numericClaim(value: string): NumericClaim | undefined {
  const matches = [...value.normalize("NFKC").matchAll(NUMBER_TOKEN_PATTERN)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  const raw = match?.[0];
  const index = match?.index;
  if (raw === undefined || index === undefined) return undefined;
  const afterNumber = value.normalize("NFKC").slice(index + raw.length);
  if (/^[\p{L}\p{N}]/u.test(afterNumber)) return undefined;
  const canonical = canonicalNumber(raw);
  if (canonical === undefined) return undefined;
  const unitMatch = /^\s*(usd|eur|gbp|%|ms|seconds?|minutes?|hours?|units?)(?![\p{L}\p{N}])/iu.exec(
    afterNumber,
  );
  const unit = unitMatch?.[1]?.toLocaleLowerCase("en-US");
  if (unit !== undefined && !NUMBER_UNIT_PATTERN.test(unit)) return undefined;
  return unit === undefined ? { value: canonical } : { value: canonical, unit };
}

function numberPresent(candidateText: string, source: string): boolean {
  const wanted = numericClaim(candidateText);
  if (wanted === undefined) return false;
  const normalizedSource = source.normalize("NFKC");
  for (const match of normalizedSource.matchAll(NUMBER_TOKEN_PATTERN)) {
    const raw = match[0];
    const index = match.index;
    if (index === undefined) continue;
    const afterNumber = normalizedSource.slice(index + raw.length);
    if (/^[\p{L}\p{N}]/u.test(afterNumber)) continue;
    const value = canonicalNumber(raw);
    if (value === undefined || value !== wanted.value) continue;
    const unitMatch = /^\s*(usd|eur|gbp|%|ms|seconds?|minutes?|hours?|units?)(?![\p{L}\p{N}])/iu.exec(
      afterNumber,
    );
    const unit = unitMatch?.[1]?.toLocaleLowerCase("en-US");
    if (wanted.unit !== undefined && unit !== wanted.unit) continue;
    return true;
  }
  return false;
}

/** The shared kernel text-presence oracle used by both gate and receipt verifier. */
export function claimTextSupported(candidate: TextClaim, source: string): boolean {
  // Closed-class remembered assertions need their semantic predicate before
  // any generic substring shortcut.  Otherwise a negated relation or a
  // shorter number can borrow the surrounding source bytes as a witness.
  if (candidate.kind === "number") return numberPresent(candidate.text, source);
  const relations = relationSignatures(candidate.text);
  if (relations.length > 0) return relationPresent(candidate, source);
  const haystack = normalized(source);
  const needle = normalized(candidate.text.replace(/^["“]|["”]$/gu, ""));
  if (candidate.kind === "identity") {
    if (needle.length > 0 && haystack.includes(needle)) return true;
    const value = identityNameValue(candidate.text);
    return value !== undefined && haystack === value;
  }
  // A generic remembered fact is an assertion about a relation, not merely a
  // bag of entities. Names shared by a different sentence are an inference
  // witness and must not be released as exact support.
  if (candidate.kind === "fact") return needle.length > 0 && haystack.includes(needle);
  if (candidate.kind === "quote") return needle.split(/\s+/u).length >= 3 && haystack.includes(needle);
  return false;
}

export interface GateInput {
  question: string;
  draft: string;
  packetDigest: Sha256;
  roundsDigest: Sha256;
  coverage?: CoverageReceipt;
  claimMap: readonly ClaimMapEntry[];
  capabilities: ReadonlyMap<string, IssuedEvidence>;
  /** Revalidation may use the scanned candidate to distinguish atom spans
   * within one source episode; legacy callers can ignore the second argument. */
  revalidate: (issued: IssuedEvidence, candidate?: ClaimCandidate) => RevalidationResult;
}

export interface GateResult {
  text: string;
  receipt: AnswerReceipt;
}

function collectionCount(text: string): number | undefined {
  const matches = [
    ...text.matchAll(
      /(?<![\p{L}\p{N}])\d[\d,.]*(?:\s*(?:USD|EUR|GBP|%|ms|seconds?|minutes?|hours?|units?))?/giu,
    ),
  ];
  if (matches.length !== 1) return undefined;
  const match = /\b(?:i\s+found|there\s+(?:were|are)|exactly|all)\s+(\d[\d,]*)\b/iu.exec(text);
  if (match?.[1] === undefined) return undefined;
  const count = Number(match[1].replace(/,/gu, ""));
  return Number.isSafeInteger(count) ? count : undefined;
}

function integerCandidateValue(text: string): number | undefined {
  const match =
    /^\s*(\d[\d,]*)(?:\s*(?:USD|EUR|GBP|%|ms|seconds?|minutes?|hours?|units?))?[.!?,]?\s*$/iu.exec(text);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1].replace(/,/gu, ""));
  return Number.isSafeInteger(value) ? value : undefined;
}

function sentenceContaining(draft: string, span: [number, number]): string {
  const delimiters = [
    draft.lastIndexOf("\n", span[0]),
    draft.lastIndexOf(".", span[0]),
    draft.lastIndexOf("!", span[0]),
    draft.lastIndexOf("?", span[0]),
  ];
  const from = Math.max(...delimiters) + 1;
  const ending = draft.slice(span[1]).search(/[.!?\n]/u);
  const to = ending < 0 ? draft.length : span[1] + ending;
  return draft.slice(from, to);
}

/** Identify an answer number whose meaning is supplied by the A13 receipt. */
export function coverageMetricForCandidate(
  candidate: ClaimCandidate,
  draft: string,
): { metric: CoverageMetric; value: number } | undefined {
  if (candidate.kind === "collection") {
    const value = collectionCount(candidate.text);
    return value === undefined ? undefined : { metric: "located", value };
  }
  if (candidate.kind !== "number" && candidate.kind !== "fact") return undefined;
  const value = integerCandidateValue(candidate.text);
  if (candidate.kind === "fact") {
    const sentence = sentenceContaining(draft, candidate.span);
    const metricPatterns: Array<{ metric: CoverageMetric; pattern: RegExp }> = [
      {
        metric: "unresolved",
        pattern: /\b(?:incomplete|unresolved|missing|remaining|short\s+by)\s+(?:by\s+)?(\d[\d,]*)\b/iu,
      },
      {
        metric: "supported",
        pattern: /\b(?:supported|current)\s+(\d[\d,]*)\b/iu,
      },
      {
        metric: "historical",
        pattern: /\b(?:historical|prior|superseded)\s+(\d[\d,]*)\b/iu,
      },
      {
        metric: "located",
        pattern: /\b(?:located|returned)\s+(\d[\d,]*)\b/iu,
      },
    ];
    const numericOccurrences = [
      ...sentence.matchAll(
        /(?<![\p{L}\p{N}])\d[\d,.]*(?:\s*(?:USD|EUR|GBP|%|ms|seconds?|minutes?|hours?|units?))?(?![\p{L}\p{N}])/giu,
      ),
    ];
    if (numericOccurrences.length !== 1) return undefined;
    for (const candidateMetric of metricPatterns) {
      const match = candidateMetric.pattern.exec(sentence);
      if (match?.[1] === undefined) continue;
      const metricValue = Number(match[1].replace(/,/gu, ""));
      if (Number.isSafeInteger(metricValue)) return { metric: candidateMetric.metric, value: metricValue };
    }
    return undefined;
  }
  if (value === undefined) return undefined;
  const sentence = sentenceContaining(draft, candidate.span);
  if (
    /\b(?:incomplete\s+(?:by\s+)?\d[\d,]*|unresolved\s+\d[\d,]*|\d[\d,]*\s+(?:unresolved|missing|remaining)|short\s+by\s+\d[\d,]*)\b/iu.test(
      sentence,
    )
  ) {
    return { metric: "unresolved", value };
  }
  if (/\b(?:supported|current)\s+\d[\d,]*|\b\d[\d,]*\s+(?:supported|current)\b/iu.test(sentence)) {
    return { metric: "supported", value };
  }
  if (
    /\b(?:historical|prior|superseded)\s+\d[\d,]*|\b\d[\d,]*\s+(?:historical|prior|superseded)\b/iu.test(
      sentence,
    )
  ) {
    return { metric: "historical", value };
  }
  if (
    /\b(?:i\s+found|there\s+(?:were|are)|located|returned)\s+\d[\d,]*|\b\d[\d,]*\s+(?:sources?|items?|notes?)\b/iu.test(
      sentence,
    )
  ) {
    return { metric: "located", value };
  }
  return undefined;
}

/** Return a typed, digest-bound basis only for an exact A13 field match. */
export function coverageBasisForCandidate(
  candidate: ClaimCandidate,
  draft: string,
  coverage: CoverageReceipt | undefined,
): ClaimCoverageBasis | undefined {
  if (coverage === undefined) return undefined;
  const metric = coverageMetricForCandidate(candidate, draft);
  if (metric === undefined) return undefined;
  const expected = coverage[metric.metric];
  if (expected === undefined || metric.value !== expected) return undefined;
  return { kind: "coverage", digest: coverage.digest, metric: metric.metric, value: metric.value };
}

function collectionClassificationFor(
  candidate: ClaimCandidate,
  input: GateInput,
): ClaimClassificationReceipt {
  const mapped = input.claimMap.filter((entry) => overlaps(candidate.span, entry.outputSpan));
  const capabilityDigests = mapped.flatMap((entry) => entry.capabilityTokens).map((token) => sha256(token));
  const basis = coverageBasisForCandidate(candidate, input.draft, input.coverage);
  // A collection count is an obligation result, not an arbitrary source
  // string. Provider capabilities are still hashed for tamper audit, but can
  // never authorize this candidate; only the digest-bound route receipt can.
  return {
    span: candidate.span,
    kind: candidate.kind,
    classification: basis === undefined ? "UNKNOWN" : "SUPPORTED",
    ...(basis === undefined ? {} : { basis }),
    capabilityDigests: [...new Set(capabilityDigests)]
      .sort()
      .slice(0, CLAIM_CAPS.maxCapabilityDigestsPerClaim),
  };
}

function classificationFor(candidate: ClaimCandidate, input: GateInput): ClaimClassificationReceipt {
  if (
    input.coverage !== undefined &&
    (candidate.kind === "collection" ||
      candidate.kind === "number" ||
      coverageMetricForCandidate(candidate, input.draft) !== undefined)
  ) {
    return collectionClassificationFor(candidate, input);
  }
  // A map entry is a proposal for the complete candidate only when its output
  // span contains that candidate. Merely overlapping a nested number must not
  // suppress the kernel's independent exact-source fallback for the enclosing
  // sentence FACT.
  const overlappingMapped = input.claimMap.filter((entry) => overlaps(candidate.span, entry.outputSpan));
  const mapped = overlappingMapped.filter(
    (entry) => entry.outputSpan[0] <= candidate.span[0] && entry.outputSpan[1] >= candidate.span[1],
  );
  const tokenDigests: string[] = overlappingMapped
    .flatMap((entry) => entry.capabilityTokens)
    .map((token) => sha256(token));
  let best:
    | { classification: ClaimClassification; validation?: RevalidationResult; textSupported: boolean }
    | undefined;
  const rank: Record<ClaimClassification, number> = {
    SUPPORTED: 6,
    HISTORICAL: 5,
    PROPOSED: 4,
    INFERENCE: 3,
    UNKNOWN: 2,
    WORLD_KNOWLEDGE: 1,
  };
  const consider = (issued: IssuedEvidence): void => {
    const validation = input.revalidate(issued, candidate);
    if (!validation.valid) return;
    const textSupported = claimTextSupported(candidate, validation.text ?? issued.source.text);
    let classification: ClaimClassification;
    // A phase is only meaningful for the exact assertion it covers.  In
    // particular, a current span that merely shares an episode with a changed
    // relation is an inference, and must not carry that span as its witness.
    if (validation.classification === "historical" && textSupported) classification = "HISTORICAL";
    else if (validation.classification === "proposed" && textSupported) classification = "PROPOSED";
    else if (validation.classification === "current" && textSupported) classification = "SUPPORTED";
    else classification = "INFERENCE";
    if (best === undefined || rank[classification] > rank[best.classification]) {
      best = { classification, validation, textSupported };
    }
  };
  for (const token of mapped.flatMap((entry) => entry.capabilityTokens)) {
    // Keep the digest even when the token is forged, expired, or absent.  The
    // receipt is an audit of what the provider proposed, not only what happened
    // to validate; dropping unknown tokens would make tampering invisible.
    tokenDigests.push(sha256(token));
    const issued = input.capabilities.get(token);
    if (issued !== undefined) consider(issued);
  }
  // A provider may omit the hidden map.  The kernel's scanner remains the
  // authority, and an exact current capability may still witness the claim.
  // Once any map entry overlaps this candidate, however, absence/forgery of its
  // token is a qualification; falling back would let a forged map evade the
  // gate.  Historical and proposed capabilities never authorize this path.
  if (mapped.length === 0) {
    for (const [token, issued] of input.capabilities) {
      const validation = input.revalidate(issued, candidate);
      if (!validation.valid || validation.classification !== "current") continue;
      if (!claimTextSupported(candidate, validation.text ?? issued.source.text)) continue;
      tokenDigests.push(sha256(token));
      consider(issued);
    }
  }

  const classification =
    best?.classification ?? (isMemoryQuestion(input.question) ? "UNKNOWN" : "WORLD_KNOWLEDGE");
  return {
    span: candidate.span,
    kind: candidate.kind,
    classification,
    ...(best?.textSupported === true && best.validation?.source !== undefined
      ? {
          witness: best.validation.source as ByteLocator,
          evidenceWitness: best.validation.source,
        }
      : {}),
    capabilityDigests: [...new Set(tokenDigests)].sort().slice(0, CLAIM_CAPS.maxCapabilityDigestsPerClaim),
  };
}

function safeCollectionWording(text: string): string {
  return text
    .replace(/\bThere\s+(?:were|are)\s+(\d+)\b/giu, "I found $1")
    .replace(/\bExactly\s+(\d+)\b/giu, "I found $1")
    .replace(/\bAll\s+(\d+)\s+([^.!?\n]+?)\s+(?:were|are)\s+(?:found|located|listed)\b/giu, "I found $1 $2")
    .replace(/\bAll\s+(\d+)\b/giu, "I found $1");
}

export function qualificationLinesFor(
  classifications: readonly ClaimClassificationReceipt[],
  overflow?: ClaimScanOverflow,
): string[] {
  const unsafe = classifications.filter(
    (entry) => entry.classification !== "SUPPORTED" && entry.classification !== "WORLD_KNOWLEDGE",
  );
  const classes = [...new Set(unsafe.map((entry) => entry.classification))];
  const qualifications = classes.map((classification) => {
    const message =
      classification === "HISTORICAL"
        ? "the turn this cites has since been revised"
        : classification === "PROPOSED"
          ? "the turn this cites is an earlier model's words, not the user's"
          : classification === "INFERENCE"
            ? "the archive holds the text; the conclusion is the model's own"
            : "no turn in the archive backs this recollection";
    return `⟨pylos ${classification} · ${message}⟩`;
  });
  if (overflow !== undefined) {
    qualifications.push("⟨pylos UNKNOWN · too many remembered claims to check inside the receipt budget⟩");
  }
  return qualifications;
}

export function gateAnswer(input: GateInput): GateResult {
  // The legacy check-failed line is a kernel receipt, not assistant prose. It
  // may repeat a number/name from the draft; remove it before the independent
  // scan so one assertion cannot become two candidates merely because the old
  // receipt was appended during the check round.
  const scanDraft = input.draft.replace(/\n\n⟨pylos: the archive could not be re-read for:[^\n]+⟩/gu, "");
  // Collection wording is a kernel rewrite, so scan the exact text that will
  // be committed. This keeps candidate spans and any coverage basis aligned
  // with the persisted assistant bytes.
  const rewrittenDraft = input.coverage === undefined ? scanDraft : safeCollectionWording(scanDraft);
  const scan = scanRememberedClaimsDetailed(input.question, rewrittenDraft);
  const candidates = scan.candidates;
  const scanDigest = claimScanDigestOf(candidates, scan.overflow);
  const classificationInput = { ...input, draft: rewrittenDraft };
  const classifications = candidates.map((candidate) => classificationFor(candidate, classificationInput));
  const qualifications = qualificationLinesFor(classifications, scan.overflow);
  const text =
    qualifications.length === 0 ? rewrittenDraft : `${rewrittenDraft}\n\n${qualifications.join("\n")}`;
  const base = {
    answerDigest: sha256(text),
    scanDigest,
    packetDigest: input.packetDigest,
    roundsDigest: input.roundsDigest,
    ...(input.coverage === undefined
      ? {}
      : {
          coverageDigest: input.coverage.digest,
          coverageRouterVersion: input.coverage.routerVersion,
          coverageRoutesRun: input.coverage.routesRun,
        }),
    grammarVersion: CLAIM_GRAMMAR_VERSION,
    candidates,
    ...(scan.overflow === undefined ? {} : { candidateOverflow: scan.overflow }),
    classifications,
    qualifications,
    status: qualifications.length === 0 ? ("released" as const) : ("qualified" as const),
  };
  const serializedBytes = new TextEncoder().encode(
    JSON.stringify({ ...base, digest: "0".repeat(64) }),
  ).byteLength;
  if (serializedBytes > CLAIM_CAPS.maxReceiptBytes) {
    const error = new Error("answer receipt exceeds bounded byte budget") as Error & { code?: string };
    error.code = "answer_receipt_too_large";
    throw error;
  }
  const receipt = { ...base, digest: canonicalHash(base) };
  return { text, receipt };
}
