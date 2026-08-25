import { afterAll, expect, test } from "bun:test";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AnswerReceipt,
  AttachmentManifest,
  ChatMessage,
  Episode,
  EvidenceCapability,
  Packet,
  TurnEvent,
} from "@pylos/protocol";
import { CLAIM_CAPS } from "@pylos/protocol";
import { claimTextSupported } from "../src/claim-gate.ts";
import {
  ATTACHMENT_CHUNK_SIZE,
  approxTokens,
  atomize,
  claimScanDigestOf,
  compact,
  forget,
  type Provider,
  readAttachmentRange,
  runTurn,
  scanRememberedClaims,
  sha256,
  type Vault,
  verify,
} from "../src/index.ts";
import { cleanup, rng, syntheticTurn, tempVault } from "./helpers.ts";

afterAll(cleanup);

function packetOf(result: { packet: Packet }): Packet {
  return result.packet;
}

function receiptOf(result: { packet: Packet; assistantEpisode: Episode }): AnswerReceipt {
  const packet = packetOf(result);
  expect(packet.evidence).toBeUndefined();
  expect(result.assistantEpisode.meta.evidence).toBeUndefined();
  expect(packet.answerReceipt).toBeDefined();
  expect(result.assistantEpisode.meta.answerReceipt).toEqual(packet.answerReceipt);
  expect(result.assistantEpisode.meta.answerReceiptDigest).toBe(packet.answerReceipt?.digest);
  return packet.answerReceipt as AnswerReceipt;
}

function providerReply(text: string): Provider {
  return async function* () {
    yield { type: "delta", text };
    yield { type: "done" };
  };
}

function packetText(messages: ChatMessage[]): string {
  return messages.map((message) => message.content).join("\n");
}

/**
 * The capability is opaque to the model, but it is present in the exact packet
 * sent to it. Accept both a future structured provider request and the rendered
 * packet form so this oracle does not depend on cosmetic markup.
 */
function firstCapabilityToken(request: unknown): string {
  if (request !== null && typeof request === "object") {
    const evidence = (request as { evidence?: EvidenceCapability[] }).evidence;
    const direct = evidence?.find((capability) => typeof capability.token === "string")?.token;
    if (direct !== undefined) return direct;
    const messages = (request as { messages?: ChatMessage[] }).messages;
    if (Array.isArray(messages)) return tokenFromText(packetText(messages));
  }
  return tokenFromText(JSON.stringify(request));
}

function messageOnlyCapabilityToken(request: unknown): string {
  if (request !== null && typeof request === "object") {
    const messages = (request as { messages?: ChatMessage[] }).messages;
    if (Array.isArray(messages)) return tokenFromText(packetText(messages));
  }
  throw new Error("the provider messages did not expose an evidence manifest");
}

function tokenFromText(text: string): string {
  const candidates = text.match(/[A-Za-z0-9_:-]{16,}/g) ?? [];
  const preferred = candidates.find(
    (candidate) =>
      /cap|evidence|witness/i.test(candidate) && !/^(?:capability|evidence|witness)$/i.test(candidate),
  );
  if (preferred !== undefined) return preferred;
  const fallback = candidates.find((candidate) => !/^[a-f0-9]{64}$/i.test(candidate));
  if (fallback !== undefined) return fallback;
  throw new Error("the provider packet did not expose an evidence capability");
}

function submitClaimMap(
  text: string,
  token: string,
  kindHint?: string,
): { type: "tool_call"; id: string; name: string; arguments: string } {
  return {
    type: "tool_call",
    id: "claim-map-1",
    name: "submit_claim_map",
    arguments: JSON.stringify({
      claims: [
        {
          outputSpan: [0, text.length],
          capabilityTokens: [token],
          ...(kindHint === undefined ? {} : { kindHint }),
        },
      ],
    }),
  };
}

function mappedProvider(text: string, token: (request: unknown) => string, kindHint?: string): Provider {
  return async function* (request) {
    yield { type: "delta", text };
    yield submitClaimMap(text, token(request), kindHint);
    yield { type: "done" };
  };
}

function appendIndexedAttachment(
  vault: Vault,
  threadId: string,
  name: string,
  marker: string,
): { episode: Episode; bytes: Uint8Array; answer: string; manifest: AttachmentManifest } {
  const answer = `The final marker is ${marker}.`;
  const prefix = "indexed attachment line\n".repeat(4_000);
  const content = `${prefix}${answer}`;
  const bytes = new TextEncoder().encode(content);
  const episode = vault.episodes.append(threadId, {
    role: "attachment",
    content,
    blob: { bytes, mime: "text/plain", name },
  });
  const manifest = episode.meta.manifest;
  if (manifest === undefined) throw new Error("the attachment manifest was not written");
  return { episode, bytes, answer, manifest };
}

function classes(receipt: AnswerReceipt): string[] {
  return receipt.classifications.map((entry) => entry.classification);
}

async function seededNumber() {
  const fixture = tempVault();
  await runTurn(fixture.vault, fixture.thread.id, {
    text: "Kestrel Systems signed the Valletta contract for 48250 USD.",
    model: "oracle",
    provider: providerReply("Noted."),
    budget: 8192,
  });
  return fixture;
}

test("a current capability supports a mapped remembered number", async () => {
  const { vault, thread } = await seededNumber();
  const text = "The amount was 48250 USD.";
  let seenCapability: EvidenceCapability | undefined;
  const result = await runTurn(vault, thread.id, {
    text: "What was the contract amount?",
    model: "oracle",
    provider: mappedProvider(text, (request) => {
      seenCapability = (request as { evidence?: EvidenceCapability[] }).evidence?.[0];
      return firstCapabilityToken(request);
    }),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(seenCapability).toMatchObject({
    threadId: thread.id,
    turnSeq: result.userEpisode.seq,
    packetDigest: result.packet.digest,
    authority: "user",
  });
  expect(receipt.candidates.length).toBeGreaterThan(0);
  expect(classes(receipt)).toContain("SUPPORTED");
  expect(classes(receipt)).toContain("INFERENCE");
  expect(receipt.qualifications.length).toBeGreaterThan(0);
  expect(result.text).toMatch(/INFERENCE/i);
});

test("an indexed attachment tail capability witnesses the exact blob span", async () => {
  const { vault, thread } = tempVault();
  const marker = "ATTACHMENT_TAIL_MARKER";
  const answer = `The final marker is ${marker}.`;
  const prefix = "indexed attachment line\n".repeat(4_000);
  const bytes = new TextEncoder().encode(`${prefix}${answer}`);
  expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: `${prefix}${answer}`,
    blob: { bytes, mime: "text/plain", name: "tail.txt" },
  });
  const manifest = attachment.meta.manifest;
  expect(manifest).toBeDefined();
  let seenCapability: EvidenceCapability | undefined;
  const result = await runTurn(vault, thread.id, {
    text: "What did the tail of tail.txt say?",
    model: "oracle",
    provider: mappedProvider(answer, (request) => {
      seenCapability = (request as { evidence?: EvidenceCapability[] }).evidence?.find(
        (capability) => capability.authority === "attachment" && capability.seq === attachment.seq,
      );
      return seenCapability?.token ?? "missing-attachment-capability";
    }),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(seenCapability).toMatchObject({
    seq: attachment.seq,
    manifestId: manifest?.id,
    authority: "attachment",
    sourceDigest: manifest?.hash,
  });
  expect(seenCapability?.byteRange[1]).toBe(bytes.byteLength);
  expect(classes(receipt)).toContain("SUPPORTED");
  const identity = receipt.classifications.find((entry) => entry.kind === "identity");
  expect(identity?.witness).toMatchObject({
    source: `blob:${manifest?.hash}`,
    seq: attachment.seq,
    manifestId: manifest?.id,
    authority: "attachment",
  });
  expect(identity?.evidenceWitness).toMatchObject({
    source: `blob:${manifest?.hash}`,
    seq: attachment.seq,
    manifestId: manifest?.id,
    authority: "attachment",
    spanHash: expect.any(String),
  });
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("an imported attachment evidence range cannot exceed one bounded span", () => {
  const { vault, thread } = tempVault();
  const fixture = appendIndexedAttachment(vault, thread.id, "bounded.txt", "BOUNDED_MARKER");
  expect(
    readAttachmentRange(vault, thread.id, fixture.episode.seq, [0, ATTACHMENT_CHUNK_SIZE + 1]),
  ).toBeNull();
});

test("tampered or deleted indexed attachment tails fail closed without a witness", async () => {
  for (const mode of ["tamper", "delete"] as const) {
    const { vault, thread } = tempVault();
    const fixture = appendIndexedAttachment(
      vault,
      thread.id,
      `${mode}.txt`,
      `ATTACHMENT_${mode.toUpperCase()}`,
    );
    const provider: Provider = async function* (request) {
      const capability = request.evidence?.find(
        (candidate) => candidate.authority === "attachment" && candidate.seq === fixture.episode.seq,
      );
      expect(capability).toBeDefined();
      const span = fixture.manifest.spans.find(
        (candidate) =>
          capability !== undefined &&
          candidate.from < capability.byteRange[1] &&
          candidate.to > capability.byteRange[0],
      );
      expect(span).toBeDefined();
      if (mode === "tamper") {
        const corrupted = vault.blobs.get(span?.objectHash ?? "");
        expect(corrupted).not.toBeNull();
        if (corrupted !== null) {
          corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
          writeFileSync(join(vault.objectsDir, span?.objectHash ?? ""), corrupted);
        }
      } else {
        rmSync(join(vault.objectsDir, span?.objectHash ?? ""), { force: true });
      }
      yield { type: "delta", text: fixture.answer };
      yield submitClaimMap(fixture.answer, capability?.token ?? "forged-attachment-capability");
      yield { type: "done" };
    };
    const result = await runTurn(vault, thread.id, {
      text: `What did the tail of ${mode}.txt say?`,
      model: "oracle",
      provider,
      budget: 8192,
    });
    const receipt = receiptOf(result);
    expect(classes(receipt)).not.toContain("SUPPORTED");
    expect(
      receipt.classifications.every(
        (entry) => entry.witness === undefined && entry.evidenceWitness === undefined,
      ),
    ).toBe(true);
  }
});

test("opaque attachment tails expose custody only, never a remembered witness", async () => {
  const { vault, thread } = tempVault();
  const marker = "OPAQUE_ATTACHMENT_TAIL";
  const prefix = "indexed attachment prefix\n".repeat(4_000);
  const content = prefix;
  const bytes = new TextEncoder().encode(`${prefix}${marker}`);
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes, mime: "text/plain", name: "opaque-tail.txt" },
  });
  expect(attachment.meta.manifest?.spans.some((span) => span.state === "opaque")).toBe(true);
  const result = await runTurn(vault, thread.id, {
    text: "What did the tail of opaque-tail.txt say?",
    model: "oracle",
    provider: mappedProvider(`The final marker is ${marker}.`, () => "forged-opaque-attachment-capability"),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).not.toContain("SUPPORTED");
  expect(
    receipt.classifications.every(
      (entry) => entry.witness === undefined && entry.evidenceWitness === undefined,
    ),
  ).toBe(true);
  expect(result.text).toMatch(/UNKNOWN|INFERENCE/i);
});

test("duplicate same-hash attachments retain exact sequence and manifest provenance", async () => {
  const { vault, thread } = tempVault();
  const first = appendIndexedAttachment(vault, thread.id, "first.txt", "DUPLICATE_MARKER");
  const second = vault.episodes.append(thread.id, {
    role: "attachment",
    content: new TextDecoder().decode(first.bytes),
    blob: { bytes: first.bytes, mime: "text/plain", name: "second.txt" },
  });
  expect(second.meta.manifest?.hash).toBe(first.manifest.hash);
  expect(second.meta.manifest?.id).not.toBe(first.manifest.id);
  const result = await runTurn(vault, thread.id, {
    text: "What did the tail of second.txt say?",
    model: "oracle",
    provider: mappedProvider(first.answer, (request) => {
      const capability = (request as { evidence?: EvidenceCapability[] }).evidence?.find(
        (candidate) => candidate.authority === "attachment" && candidate.seq === second.seq,
      );
      return capability?.token ?? "forged-duplicate-capability";
    }),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  const identity = receipt.classifications.find((entry) => entry.kind === "identity");
  expect(identity?.evidenceWitness?.seq).toBe(second.seq);
  expect(identity?.evidenceWitness?.manifestId).toBe(second.meta.manifest?.id);
  expect(identity?.evidenceWitness?.seq).not.toBe(first.episode.seq);
  forget(vault, thread.id, { seqs: [first.episode.seq], reason: "duplicate provenance oracle" });
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("an exact check page remains a witness when its manifest cannot fit", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, {
    role: "user",
    content: "The amount was 48250 usd.",
  });
  const next = rng(76);
  for (let index = 0; index < 300; index += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, index) });
  }
  compact(vault, thread.id, { budget: 8192 });
  const result = await runTurn(vault, thread.id, {
    text: "Tell me the number again.",
    model: "oracle",
    provider: providerReply("The amount was 48250 usd."),
    budget: 1024,
  });
  const receipt = receiptOf(result);
  expect(result.pages.some((page) => page.seqs.includes(1))).toBe(true);
  expect(classes(receipt)).toContain("SUPPORTED");
  expect(receipt.qualifications).toEqual([]);
});

test("the message-visible evidence manifest survives a provider adapter without structured evidence", async () => {
  const { vault, thread } = tempVault();
  const text = "The amount was 48250 USD.";
  vault.episodes.append(thread.id, { role: "user", content: text });
  const result = await runTurn(vault, thread.id, {
    text: "What was the contract amount?",
    model: "oracle",
    provider: mappedProvider(text, messageOnlyCapabilityToken),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).toContain("SUPPORTED");
  expect(receipt.qualifications).toEqual([]);
  expect(result.text).toBe(text);
});

test("an unrelated wrong map entry cannot hide an exact current sentence witness", async () => {
  const { vault, thread } = tempVault();
  const text = "The amount was 48250 USD.";
  vault.episodes.append(thread.id, { role: "user", content: text });
  const result = await runTurn(vault, thread.id, {
    text: "What was the contract amount?",
    model: "oracle",
    provider: async function* () {
      yield { type: "delta", text };
      yield {
        type: "tool_call",
        id: "claim-map-wrong-span",
        name: "submit_claim_map",
        arguments: JSON.stringify({
          claims: [
            {
              outputSpan: [text.length - 1, text.length],
              capabilityTokens: ["forged-unrelated-capability"],
            },
          ],
        }),
      };
      yield { type: "done" };
    },
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).toContain("SUPPORTED");
  expect(receipt.qualifications).toEqual([]);
  expect(
    receipt.classifications.some((entry) =>
      entry.capabilityDigests.includes(sha256("forged-unrelated-capability")),
    ),
  ).toBe(true);
});

test("a capability from another turn is rejected even when its source text matches", async () => {
  const { vault, thread } = await seededNumber();
  let priorToken = "";
  await runTurn(vault, thread.id, {
    text: "Repeat the contract amount.",
    model: "oracle",
    provider: mappedProvider("The amount was 48250 USD.", (request) => {
      priorToken = firstCapabilityToken(request);
      return priorToken;
    }),
    budget: 8192,
  });
  expect(priorToken.length).toBeGreaterThan(0);

  const result = await runTurn(vault, thread.id, {
    text: "What was the contract amount again?",
    model: "oracle",
    provider: mappedProvider("The amount was 48250 USD.", () => priorToken),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).not.toContain("SUPPORTED");
  expect(receipt.qualifications.length).toBeGreaterThan(0);
  expect(result.text).toMatch(/UNKNOWN|HISTORICAL|PROPOSED|INFERENCE/i);
});

test("a tampered capability digest cannot authorize a remembered number", async () => {
  const { vault, thread } = await seededNumber();
  const result = await runTurn(vault, thread.id, {
    text: "What was the contract amount?",
    model: "oracle",
    provider: mappedProvider("The amount was 48250 USD.", (request) => {
      const token = firstCapabilityToken(request);
      return `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    }),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).not.toContain("SUPPORTED");
  expect(receipt.qualifications.length).toBeGreaterThan(0);
});

test("omitting the hidden map cannot evade the independent candidate scan", async () => {
  const cases = [
    { question: "What number did I give you?", answer: "The amount was 48250 USD.", kind: "number" },
    {
      question: "Who did we say owned Kestrel?",
      answer: "Ada Okafor is the owner of Kestrel Systems.",
      kind: "identity",
    },
    {
      question: "What did the note say?",
      answer: 'The note says "keep the keel dry and bright".',
      kind: "quote",
    },
    {
      question: "What did we decide about Kestrel?",
      answer: "Kestrel Systems signed the Valletta contract.",
      kind: "fact",
    },
    { question: "List every launch note.", answer: "There were 2 launch notes.", kind: "collection" },
  ];

  for (const candidate of cases) {
    const { vault, thread } = tempVault();
    const result = await runTurn(vault, thread.id, {
      text: candidate.question,
      model: "oracle",
      provider: providerReply(candidate.answer),
      budget: 8192,
    });
    const receipt = receiptOf(result);
    expect(receipt.candidates.some((entry) => entry.kind === candidate.kind)).toBe(true);
    expect(classes(receipt)).not.toContain("SUPPORTED");
    expect(receipt.qualifications.length).toBeGreaterThan(0);
    expect(result.text).toMatch(/UNKNOWN|HISTORICAL|PROPOSED|INFERENCE/i);
  }
});

test("a current citation with a changed generic relation is INFERENCE, not support", async () => {
  const { vault, thread } = tempVault();
  await runTurn(vault, thread.id, {
    text: "Kestrel Systems signed the Valletta contract.",
    model: "oracle",
    provider: providerReply("Noted."),
    budget: 8192,
  });
  const text = "Kestrel Systems owns the Valletta contract.";
  const result = await runTurn(vault, thread.id, {
    text: "What did we decide about Kestrel?",
    model: "oracle",
    provider: mappedProvider(text, firstCapabilityToken),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).toContain("INFERENCE");
  expect(classes(receipt)).not.toContain("SUPPORTED");
  const fact = receipt.classifications.find((entry) => entry.kind === "fact");
  expect(fact?.witness).toBeUndefined();
});

test("identity fallback does not cross polarity, relation direction, or nearby claims", async () => {
  const { vault, thread } = tempVault();
  await runTurn(vault, thread.id, {
    text: "Alice is not the owner of Bob. Alice lives in Lisbon. Charlie is the owner of Dana.",
    model: "oracle",
    provider: providerReply("Noted."),
    budget: 8192,
  });

  const answer =
    "Alice is the owner of Bob. Alice lives in Lisbon. Bob is the owner of Alice. " +
    "Alice is the owner of Charlie. Charlie is not the owner of Dana.";
  const result = await runTurn(vault, thread.id, {
    text: "What did we say about Alice and the owners?",
    model: "oracle",
    provider: mappedProvider(answer, (request) => {
      const evidence = (request as { evidence?: EvidenceCapability[] }).evidence ?? [];
      const widest = evidence.reduce<EvidenceCapability | undefined>(
        (best, capability) =>
          best === undefined ||
          capability.byteRange[1] - capability.byteRange[0] > best.byteRange[1] - best.byteRange[0]
            ? capability
            : best,
        undefined,
      );
      if (widest === undefined) throw new Error("the full source capability was not exposed");
      return widest.token;
    }),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  const classificationFor = (needle: string) => {
    const candidate = receipt.candidates.find((entry) => entry.text.includes(needle));
    expect(candidate).toBeDefined();
    return receipt.classifications.find(
      (entry) => entry.span[0] === candidate?.span[0] && entry.span[1] === candidate?.span[1],
    );
  };

  for (const needle of [
    "Alice is the owner of Bob",
    "Bob is the owner of Alice",
    "Alice is the owner of Charlie",
    "Charlie is not the owner of Dana",
  ]) {
    const classification = classificationFor(needle);
    expect(classification?.classification).not.toBe("SUPPORTED");
    expect(classification?.witness).toBeUndefined();
  }
  const location = classificationFor("Alice lives in Lisbon");
  expect(location?.classification).toBe("SUPPORTED");
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("mixed-polarity identity text cannot witness either relation direction", async () => {
  expect(
    claimTextSupported(
      { kind: "identity", text: "Alice owns Bob." },
      "Alice owns Bob. Alice does not own Bob.",
    ),
  ).toBe(false);
  expect(
    claimTextSupported(
      { kind: "identity", text: "Alice does not own Bob." },
      "Alice owns Bob. Alice does not own Bob.",
    ),
  ).toBe(false);
  expect(claimTextSupported({ kind: "identity", text: "Bob owns Alice." }, "Alice owns Bob.")).toBe(false);
});

test("number witnesses require exact numeric tokens and compatible units", async () => {
  expect(claimTextSupported({ kind: "number", text: "48250 USD" }, "The amount was 148250 USD.")).toBe(false);
  expect(claimTextSupported({ kind: "number", text: "50" }, "The separate code was 150.")).toBe(false);
  expect(claimTextSupported({ kind: "number", text: "48,250 USD" }, "The amount was 48250 USD.")).toBe(true);
  expect(claimTextSupported({ kind: "number", text: "48250 USD" }, "The amount was 48250 EUR.")).toBe(false);
});

test("bounded code-like identifiers are gated as identifiers, not nested numbers", () => {
  const candidates = scanRememberedClaims(
    "What did we say about the manifest code?",
    "The manifest code was 77A.",
  );
  expect(candidates.some((candidate) => candidate.kind === "identity" && candidate.text === "77A")).toBe(
    true,
  );
  expect(candidates.some((candidate) => candidate.kind === "number" && candidate.text === "77")).toBe(false);
  expect(
    scanRememberedClaims("What did we say about the manifest code?", "The manifest code was 77A."),
  ).toEqual(candidates);
  expect(claimTextSupported({ kind: "identity", text: "77A" }, "The manifest code was 77A.")).toBe(true);
  expect(claimTextSupported({ kind: "identity", text: "88B" }, "The manifest code was 77A.")).toBe(false);
  expect(scanRememberedClaims("Write a poem about code 77A.", "The code 77A glows.")).toEqual([]);
  const launchCodeCandidates = scanRememberedClaims(
    "What is the launch code 77A?",
    "The launch code is 77A.",
  );
  expect(launchCodeCandidates).toContainEqual({ span: [19, 22], kind: "identity", text: "77A" });
  expect(launchCodeCandidates.some((candidate) => candidate.kind === "fact")).toBe(true);
  const draft = "The amber ferry left Skagen at 06:40 with manifest 77A.";
  expect(claimScanDigestOf(scanRememberedClaims("When did the amber ferry leave?", draft))).toBe(
    claimScanDigestOf(scanRememberedClaims("When did the amber ferry leave?", draft)),
  );
});

test("a specialized number cannot hide an adjacent unsupported remembered clause", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: "The budget is 48,250 USD." });
  const answer = "The budget is 48,250 USD and Alice signed the contract.";
  const result = await runTurn(vault, thread.id, {
    text: "What did we record about the budget and signer?",
    model: "oracle",
    provider: mappedProvider(answer, firstCapabilityToken),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(receipt.candidates.some((candidate) => candidate.kind === "number")).toBe(true);
  expect(
    receipt.candidates.some((candidate) => candidate.kind === "fact" && /Alice signed/u.test(candidate.text)),
  ).toBe(true);
  expect(classes(receipt)).toContain("INFERENCE");
  expect(result.text).toMatch(/INFERENCE/i);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("a 20k-identifier answer gets a bounded scan receipt before tx B materialization", async () => {
  const { vault, thread } = tempVault();
  const answer = `Recorded codes: ${Array.from({ length: 20_000 }, () => "A0").join(" ")}.`;
  expect(new TextEncoder().encode(answer).byteLength).toBeLessThan(128 * 1024);
  const result = await runTurn(vault, thread.id, {
    text: "What did we record about the launch codes?",
    model: "oracle",
    provider: async function* () {
      yield { type: "delta" as const, text: answer };
      yield { type: "done" as const };
    },
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(receipt.candidates.length).toBeLessThanOrEqual(CLAIM_CAPS.maxCandidates);
  expect(receipt.candidateOverflow?.reason).toBe("candidate-cap");
  expect(receipt.status).toBe("qualified");
  expect(new TextEncoder().encode(JSON.stringify(receipt)).byteLength).toBeLessThanOrEqual(
    CLAIM_CAPS.maxReceiptBytes,
  );
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("independent punctuation clauses remain fact candidates beside a specialized number", async () => {
  const variants = [
    { separator: ";", tail: "Alice signed the contract." },
    { separator: "—", tail: "Alice forged the contract." },
    { separator: ",", tail: "Alice paid Bob." },
  ];
  for (const variant of variants) {
    const { vault, thread } = tempVault();
    vault.episodes.append(thread.id, { role: "user", content: "The budget is 48,250 USD." });
    const answer = `The budget is 48,250 USD${variant.separator} ${variant.tail}`;
    const scanned = scanRememberedClaims("What did we record about the budget and signer?", answer);
    expect(scanned.some((candidate) => candidate.kind === "number")).toBe(true);
    expect(scanned.some((candidate) => candidate.kind === "fact" && candidate.text.includes("Alice"))).toBe(
      true,
    );
    const result = await runTurn(vault, thread.id, {
      text: "What did we record about the budget and signer?",
      model: "oracle",
      provider: mappedProvider(answer, firstCapabilityToken),
      budget: 8192,
    });
    const receipt = receiptOf(result);
    expect(classes(receipt)).toContain("INFERENCE");
    expect(result.text).toMatch(/INFERENCE/i);
    expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  }
});

test("the gate does not release mixed-polarity or substring-number claims", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, {
    role: "user",
    content: "Alice owns Bob. Alice does not own Bob. The archived amount was 148250 USD. The code was 150.",
  });
  const answer =
    "Alice owns Bob. Alice does not own Bob. The archived amount was 48250 USD. The code was 50.";
  const result = await runTurn(vault, thread.id, {
    text: "What did we say about Alice and the archived amounts?",
    model: "oracle",
    provider: mappedProvider(answer, (request) => {
      const evidence = (request as { evidence?: EvidenceCapability[] }).evidence ?? [];
      const widest = evidence.reduce<EvidenceCapability | undefined>(
        (best, capability) =>
          best === undefined ||
          capability.byteRange[1] - capability.byteRange[0] > best.byteRange[1] - best.byteRange[0]
            ? capability
            : best,
        undefined,
      );
      if (widest === undefined) throw new Error("the full source capability was not exposed");
      return widest.token;
    }),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).not.toContain("SUPPORTED");
  expect(receipt.qualifications.length).toBeGreaterThan(0);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("atom revalidation pages high-cardinality sources without losing the matching atom", async () => {
  const { vault, thread } = tempVault();
  const facts = Array.from(
    { length: 320 },
    (_, index) => `Remember that archived launch fact ${index} is value ${index}.`,
  );
  facts.push("Remember that the final launch amount is 48250 USD.");
  const source = vault.episodes.append(thread.id, { role: "user", content: facts.join(" ") });
  atomize(vault, thread.id, [source.seq]);
  const atomCount = (
    vault.db
      .query("SELECT COUNT(*) AS count FROM atom WHERE thread_id = ? AND source_seq = ?")
      .get(thread.id, source.seq) as {
      count: number;
    }
  ).count;
  expect(atomCount).toBeGreaterThan(256);
  const answer = "The final launch amount was 48250 USD.";
  const result = await runTurn(vault, thread.id, {
    text: "What did we say about the final launch amount?",
    model: "oracle",
    provider: mappedProvider(answer, (request) => {
      const evidence = (request as { evidence?: EvidenceCapability[] }).evidence ?? [];
      const sourceCapability = evidence.find((capability) => capability.seq === source.seq);
      if (sourceCapability === undefined) throw new Error("the high-cardinality source was not exposed");
      return sourceCapability.token;
    }),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).toContain("SUPPORTED");
  expect(classes(receipt)).toContain("UNKNOWN");
  expect(receipt.qualifications.length).toBeGreaterThan(0);
});

test("dense atom revalidation stays qualified when the matching atom is not displayed", async () => {
  const { vault, thread } = tempVault();
  const facts = Array.from(
    { length: 1_000 },
    (_, index) => `Archived launch fact ${index} is value ${index}.`,
  );
  // The amount is authored first so its atom is the oldest row of the source:
  // the frontier shows the newest atoms of a sequence, so this one stays outside
  // the displayed and capability sets, which is what this test is about.
  facts.unshift("The final launch amount is 48250 USD.");
  const content = facts.join(" ");
  const source = vault.episodes.append(thread.id, { role: "user", content });
  let offset = 0;
  for (const [index, fact] of facts.entries()) {
    const start = offset;
    const end = start + fact.length;
    offset = end + 1;
    vault.db
      .query(
        "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
          "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
          "VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, ?, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'dense-revalidation-oracle', ?)",
      )
      .run(
        `dense-revalidation-${index}`,
        thread.id,
        `dense.revalidation.${index}`,
        fact.includes("48250") ? "48250 USD" : `value ${index}`,
        fact,
        source.seq,
        JSON.stringify([start, end]),
        source.seq,
        index,
      );
  }

  const stats = { maxRows: 0, totalRows: 0 };
  const db = vault.db as unknown as { query: (sql: string, ...args: unknown[]) => unknown };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (!/source_span.*__rowid|__rowid.*source_span/u.test(sql.replace(/\s+/gu, " "))) return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property !== "all") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (...parameters: unknown[]) => {
          const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
          const value = method.apply(target, parameters);
          const rows = Array.isArray(value) ? value.length : 0;
          stats.maxRows = Math.max(stats.maxRows, rows);
          stats.totalRows += rows;
          return value;
        };
      },
    });
  }) as typeof db.query;
  try {
    const result = await runTurn(vault, thread.id, {
      text: "What did we say about the final launch amount?",
      model: "oracle",
      provider: mappedProvider("The final launch amount was 48250 USD.", (request) => {
        const evidence = (request as { evidence?: EvidenceCapability[] }).evidence ?? [];
        const capability = evidence.find((item) => item.seq === source.seq);
        if (capability === undefined) throw new Error("dense source capability missing");
        return capability.token;
      }),
      budget: 8192,
    });
    const receipt = receiptOf(result);
    // The provider deliberately cites the first same-source frontier span.
    // The matching amount atom is outside the displayed/capability set, so an
    // episode-wide fallback would be unsound. The bounded directed probe still
    // finds no authority to mint for the undisplayed bytes; qualification is
    // the truthful outcome.
    expect(classes(receipt)).not.toContain("SUPPORTED");
    expect(classes(receipt)).toContain("UNKNOWN");
    expect(classes(receipt)).toContain("INFERENCE");
    expect(receipt.qualifications.length).toBeGreaterThan(0);
    stats.maxRows = 0;
    stats.totalRows = 0;
    const verified = verify(vault, thread.id, { full: true });
    expect(verified.ok, verified.reason).toBe(true);
    // Stored receipt replay uses the same candidate-directed cap+1 lookup as
    // tx B. It must never keyset-walk all 1,001 source atoms, nor repeat a
    // bounded fallback window for every classification in the answer.
    expect(stats.maxRows).toBeLessThanOrEqual(257);
    expect(stats.totalRows).toBeLessThanOrEqual(257 * 2);
  } finally {
    db.query = originalQuery;
  }
});

test("a paraphrased relation cannot escape a historical atom on a current episode fallback", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "My name is Ada Okafor. I live in Lisbon.",
  });
  atomize(vault, thread.id, [source.seq]);
  const correction = vault.episodes.append(thread.id, { role: "user", content: "I moved to Porto." });
  atomize(vault, thread.id, [correction.seq]);

  const answer = "Ada Okafor lives in Lisbon.";
  const result = await runTurn(vault, thread.id, {
    text: "What did I say about my location?",
    model: "oracle",
    provider: mappedProvider(answer, (request) => {
      const evidence = (request as { evidence?: EvidenceCapability[] }).evidence ?? [];
      const widest = evidence.reduce<EvidenceCapability | undefined>(
        (best, capability) =>
          best === undefined ||
          capability.byteRange[1] - capability.byteRange[0] > best.byteRange[1] - best.byteRange[0]
            ? capability
            : best,
        undefined,
      );
      if (widest === undefined) throw new Error("the full source capability was not exposed");
      return widest.token;
    }),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).not.toContain("SUPPORTED");
  expect(receipt.qualifications.length).toBeGreaterThan(0);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("a planted count is not a collection witness without coverage routes", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, {
    role: "user",
    content: "I found 10 launch notes.",
  });
  const result = await runTurn(vault, thread.id, {
    text: "List every launch note about the nonexistent harbor.",
    model: "oracle",
    provider: providerReply("I found 10 launch notes."),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(result.packet.coverage).toBeDefined();
  expect(result.packet.coverage?.located).toBe(0);
  const collection = receipt.classifications.find((entry) => entry.kind === "collection");
  expect(collection?.classification).not.toBe("SUPPORTED");
  expect(collection?.witness).toBeUndefined();
  expect(receipt.qualifications.length).toBeGreaterThan(0);
});

test("collection counts use typed located and unresolved coverage bases", async () => {
  const { vault, thread } = tempVault();
  for (let index = 1; index <= 10; index += 1) {
    vault.episodes.append(thread.id, {
      role: "user",
      content: `launch note ${index}: harbor route ${index % 2 === 0 ? "green" : "amber"}.`,
    });
  }
  const result = await runTurn(vault, thread.id, {
    text: "List all 11 launch notes.",
    model: "oracle",
    provider: providerReply("There were 10 launch notes. Incomplete by 1."),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  const collection = receipt.classifications.find((entry) => entry.kind === "collection");
  const unresolved = receipt.classifications.find(
    (entry) => entry.kind === "number" && entry.span[0] > (collection?.span[1] ?? 0),
  );
  expect(result.packet.coverage?.located).toBe(10);
  expect(result.packet.coverage?.unresolved).toBe(1);
  expect(collection?.classification).toBe("SUPPORTED");
  expect(collection?.basis).toMatchObject({ kind: "coverage", metric: "located", value: 10 });
  expect(unresolved?.classification).toBe("SUPPORTED");
  expect(unresolved?.basis).toMatchObject({ kind: "coverage", metric: "unresolved", value: 1 });
  expect(receipt.qualifications).toEqual([]);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("All-N collection rewrite keeps receipt spans bound to final answer bytes", async () => {
  const { vault, thread } = tempVault();
  for (let index = 1; index <= 10; index += 1) {
    vault.episodes.append(thread.id, {
      role: "user",
      content: `launch note ${index}: harbor route ${index % 2 === 0 ? "green" : "amber"}.`,
    });
  }
  const result = await runTurn(vault, thread.id, {
    text: "List all 11 launch notes.",
    model: "oracle",
    provider: providerReply("All 10 launch notes were found."),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(result.text).toBe("I found 10 launch notes.");
  const collection = receipt.classifications.find((entry) => entry.kind === "collection");
  expect(collection?.span).toEqual([0, result.text.length]);
  expect(collection?.basis).toMatchObject({ kind: "coverage", metric: "located", value: 10 });
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("an extra number in one collection sentence fails the aggregate basis closed", async () => {
  const { vault, thread } = tempVault();
  for (let index = 1; index <= 10; index += 1) {
    vault.episodes.append(thread.id, {
      role: "user",
      content: `launch note ${index}: harbor route ${index % 2 === 0 ? "green" : "amber"}.`,
    });
  }
  const result = await runTurn(vault, thread.id, {
    text: "List all 11 launch notes.",
    model: "oracle",
    provider: providerReply("I found 10 launch notes, incomplete by 2."),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  const collection = receipt.classifications.find((entry) => entry.kind === "collection");
  expect(collection?.classification).not.toBe("SUPPORTED");
  expect(collection?.basis).toBeUndefined();
  expect(receipt.qualifications.length).toBeGreaterThan(0);
});

test("wrong unresolved counts and unrelated numbers cannot borrow collection coverage", async () => {
  const { vault, thread } = tempVault();
  for (let index = 1; index <= 10; index += 1) {
    vault.episodes.append(thread.id, {
      role: "user",
      content: `launch note ${index}: harbor route ${index % 2 === 0 ? "green" : "amber"}.`,
    });
  }
  const result = await runTurn(vault, thread.id, {
    text: "List all 11 launch notes.",
    model: "oracle",
    provider: providerReply("I found 10 launch notes. Incomplete by 2. The unrelated amount was 10."),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  const collection = receipt.classifications.find((entry) => entry.kind === "collection");
  const numbers = receipt.classifications.filter((entry) => entry.kind === "number");
  expect(collection?.classification).toBe("SUPPORTED");
  expect(collection?.basis).toMatchObject({ metric: "located", value: 10 });
  expect(numbers.length).toBe(2);
  expect(numbers.every((entry) => entry.classification !== "SUPPORTED")).toBe(true);
  expect(numbers.every((entry) => entry.basis === undefined)).toBe(true);
  expect(receipt.qualifications.length).toBeGreaterThan(0);
});

test("a WORLD_KNOWLEDGE hint and a forged map do not turn a memory claim into fact", async () => {
  const { vault, thread } = tempVault();
  const text = "The amount was 48250 USD.";
  const result = await runTurn(vault, thread.id, {
    text: "What number did I give you?",
    model: "oracle",
    provider: mappedProvider(text, () => "forged-capability-token", "WORLD_KNOWLEDGE"),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).not.toContain("WORLD_KNOWLEDGE");
  expect(classes(receipt)).not.toContain("SUPPORTED");
  expect(receipt.qualifications.length).toBeGreaterThan(0);
  expect(
    receipt.classifications.some((entry) =>
      entry.capabilityDigests.includes(sha256("forged-capability-token")),
    ),
  ).toBe(true);
});

test("reasoning and creative prose stay free when they make no remembered assertion", async () => {
  const controls = [
    {
      question: "What should we do if the harbor closes?",
      answer: "I would compare the routes and explain the tradeoffs before deciding.",
    },
    {
      question: "Write a poem about a harbor.",
      answer: "A harbor keeps the moon in a silver cup.",
    },
  ];
  for (const control of controls) {
    const { vault, thread } = tempVault();
    const result = await runTurn(vault, thread.id, {
      text: control.question,
      model: "oracle",
      provider: providerReply(control.answer),
      budget: 8192,
    });
    const receipt = receiptOf(result);
    expect(receipt.candidates).toEqual([]);
    expect(receipt.qualifications).toEqual([]);
    expect(result.text).toBe(control.answer);
  }
});

test("invented creative numbers and identities stay outside the memory gate", async () => {
  const { vault, thread } = tempVault();
  const answer = "Ada is the captain of 48250 imaginary lanterns.";
  const result = await runTurn(vault, thread.id, {
    text: "Write a poem about an imaginary harbor with Ada and 48250 lanterns.",
    model: "oracle",
    provider: providerReply(answer),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(receipt.candidates).toEqual([]);
  expect(receipt.qualifications).toEqual([]);
  expect(result.text).toBe(answer);
});

test("creative prompts that explicitly recall personal/archive material stay qualified without a witness", async () => {
  const { vault, thread } = tempVault();
  const answer = 'The amount was 48250 USD, and the note said "keep the keel dry and bright".';
  const result = await runTurn(vault, thread.id, {
    text: "Write a song about my contract amount from earlier and the phrase in our archive.",
    model: "oracle",
    provider: providerReply(answer),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(receipt.candidates.some((entry) => entry.kind === "number")).toBe(true);
  expect(receipt.candidates.some((entry) => entry.kind === "quote")).toBe(true);
  expect(classes(receipt)).not.toContain("SUPPORTED");
  expect(receipt.qualifications.length).toBeGreaterThan(0);
  expect(result.text).toMatch(/UNKNOWN|unresolved|witness/i);
});

test("a creative recall can be released when one current witness covers its number and quote", async () => {
  const { vault, thread } = tempVault();
  const source =
    'The current contract amount is 48250 USD, and the note says "keep the keel dry and bright".';
  vault.episodes.append(thread.id, { role: "user", content: source });
  const answer = 'The amount was 48250 USD, and the note said "keep the keel dry and bright".';
  const result = await runTurn(vault, thread.id, {
    text: "Write a song about my contract amount from earlier and the phrase in our archive.",
    model: "oracle",
    provider: mappedProvider(answer, firstCapabilityToken),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(receipt.candidates.some((entry) => entry.kind === "number")).toBe(true);
  expect(receipt.candidates.some((entry) => entry.kind === "quote")).toBe(true);
  expect(
    classes(receipt).filter((classification) => classification === "SUPPORTED").length,
  ).toBeGreaterThanOrEqual(2);
  expect(classes(receipt)).toContain("INFERENCE");
  expect(receipt.qualifications.length).toBeGreaterThan(0);
  expect(result.text).toMatch(/INFERENCE/i);
});

test("a seed assertion followed by an acknowledgement is not a memory question", async () => {
  const { vault, thread } = tempVault();
  const result = await runTurn(vault, thread.id, {
    text: "The Valletta contract is 48250 USD. Noted.",
    model: "oracle",
    provider: providerReply("The amount was 48250 USD."),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(receipt.candidates).toEqual([]);
  expect(receipt.qualifications).toEqual([]);
  expect(result.text).toBe("The amount was 48250 USD.");
});

test("ordinary world totals stay world knowledge outside A13", async () => {
  const { vault, thread } = tempVault();
  const result = await runTurn(vault, thread.id, {
    text: "How many planets are in the solar system?",
    model: "oracle",
    provider: providerReply("There are 8 planets."),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(result.packet.coverage).toBeUndefined();
  expect(result.text).toBe("There are 8 planets.");
  expect(receipt.classifications.some((entry) => entry.classification === "WORLD_KNOWLEDGE")).toBe(true);
  expect(receipt.qualifications).toEqual([]);
});

test("the kernel revalidates capabilities atomically before assistant commit", async () => {
  const { vault, thread } = tempVault();
  const first = vault.episodes.append(thread.id, { role: "user", content: "I live in Lisbon." });
  atomize(vault, thread.id, [first.seq]);
  const text = "I live in Lisbon.";
  let mutated = false;
  const provider: Provider = async function* (request) {
    const token = firstCapabilityToken(request);
    yield { type: "delta", text };
    yield submitClaimMap(text, token);
    if (!mutated) {
      mutated = true;
      const correction = vault.episodes.append(thread.id, { role: "user", content: "I live in Porto." });
      atomize(vault, thread.id, [correction.seq]);
    }
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "Where do I live?",
    model: "oracle",
    provider,
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).not.toContain("SUPPORTED");
  expect(classes(receipt)).toContain("HISTORICAL");
  expect(receipt.qualifications.length).toBeGreaterThan(0);
  expect(result.text).toMatch(/HISTORICAL|unverified|changed|Porto/i);
});

test("the answer receipt binds answer, packet, rounds and survives persistence", async () => {
  const { vault, thread } = await seededNumber();
  const result = await runTurn(vault, thread.id, {
    text: "What was the contract amount?",
    model: "oracle",
    provider: providerReply("The amount was 48250 USD."),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(receipt.answerDigest).toBe(sha256(result.text));
  expect(receipt.scanDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(receipt.packetDigest).toBe(result.packet.digest);
  expect(receipt.roundsDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(receipt.grammarVersion.length).toBeGreaterThan(0);
  expect(receipt.digest).toMatch(/^[0-9a-f]{64}$/);
  const stored = vault.packets.get(thread.id, result.userEpisode.seq);
  expect(stored?.answerReceipt).toEqual(receipt);
  expect(result.assistantEpisode.meta.answerReceipt).toEqual(receipt);
});

test("core deltas are held until the gate event, then expose only committed text", async () => {
  const { vault, thread } = await seededNumber();
  const events: TurnEvent[] = [];
  const result = await runTurn(vault, thread.id, {
    text: "What was the contract amount?",
    model: "oracle",
    provider: providerReply("The amount was 48250 USD."),
    budget: 8192,
    onEvent: (event) => events.push(event),
  });
  const gate = events.findIndex((event) => event.type === "gate");
  expect(gate).toBeGreaterThanOrEqual(0);
  const deltas = events
    .map((event, index) => (event.type === "delta" ? index : -1))
    .filter((index) => index >= 0);
  expect(deltas.length).toBeGreaterThan(0);
  expect(deltas.every((index) => index > gate)).toBe(true);
  const done = events.find((event) => event.type === "done");
  expect(done?.type === "done" && done.episode.content).toBe(result.text);
});

test("an oversized current turn is rejected before tx A changes episodes, packets, or objects", async () => {
  const { vault, thread } = tempVault({ budget: 64 });
  vault.episodes.append(thread.id, {
    role: "attachment",
    content: "existing attachment",
    blob: { bytes: new TextEncoder().encode("existing attachment"), mime: "text/plain" },
  });
  const beforeThread = vault.threads.get(thread.id);
  const beforeEpisodes = vault.episodes.count(thread.id);
  const beforePackets = Number(
    (
      vault.db.query("SELECT COUNT(*) AS count FROM packet WHERE thread_id = ?").get(thread.id) as {
        count: number;
      }
    ).count,
  );
  const beforeObjects = readdirSync(vault.objectsDir).sort();
  let providerCalls = 0;
  const provider: Provider = async function* () {
    providerCalls += 1;
    yield { type: "delta", text: "must not run" };
    yield { type: "done" };
  };

  const promise = runTurn(vault, thread.id, {
    text: "x".repeat(20_000),
    model: "oracle",
    provider,
    budget: 64,
    attachments: [
      {
        role: "attachment",
        content: "new attachment",
        blob: { bytes: new TextEncoder().encode("new attachment"), mime: "text/plain" },
      },
    ],
  });
  await expect(promise).rejects.toMatchObject({ code: "turn_too_large" });
  expect(providerCalls).toBe(0);
  expect(vault.threads.get(thread.id)).toEqual(beforeThread);
  expect(vault.episodes.count(thread.id)).toBe(beforeEpisodes);
  expect(
    Number(
      (
        vault.db.query("SELECT COUNT(*) AS count FROM packet WHERE thread_id = ?").get(thread.id) as {
          count: number;
        }
      ).count,
    ),
  ).toBe(beforePackets);
  expect(readdirSync(vault.objectsDir).sort()).toEqual(beforeObjects);
});

test("preflight rejects a prompt that fits alone but not with mandatory packet material", async () => {
  const { vault, thread } = tempVault({ budget: 128 });
  vault.threads.setTitle(thread.id, "H".repeat(2_000));
  const beforeThread = vault.threads.get(thread.id);
  const beforeEpisodes = vault.episodes.count(thread.id);
  const beforePackets = Number(
    (
      vault.db.query("SELECT COUNT(*) AS count FROM packet WHERE thread_id = ?").get(thread.id) as {
        count: number;
      }
    ).count,
  );
  const beforeObjects = readdirSync(vault.objectsDir).sort();
  let providerCalls = 0;
  const provider: Provider = async function* () {
    providerCalls += 1;
    yield { type: "delta", text: "must not run" };
    yield { type: "done" };
  };

  const text = "x".repeat(180);
  expect(approxTokens(text)).toBeLessThanOrEqual(128);
  await expect(
    runTurn(vault, thread.id, {
      text,
      model: "oracle",
      provider,
      budget: 128,
      attachments: [
        {
          role: "attachment",
          content: "manifest route remains outside the prompt budget",
          blob: { bytes: new TextEncoder().encode("opaque bytes"), mime: "text/plain" },
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "turn_too_large" });
  expect(providerCalls).toBe(0);
  expect(vault.threads.get(thread.id)).toEqual(beforeThread);
  expect(vault.episodes.count(thread.id)).toBe(beforeEpisodes);
  expect(
    Number(
      (
        vault.db.query("SELECT COUNT(*) AS count FROM packet WHERE thread_id = ?").get(thread.id) as {
          count: number;
        }
      ).count,
    ),
  ).toBe(beforePackets);
  expect(readdirSync(vault.objectsDir).sort()).toEqual(beforeObjects);
});

test("preflight prices an attachment's manifest route at the edge without writing spans", async () => {
  const budget = 256;
  const text = "x".repeat(80);
  expect(approxTokens(text)).toBeLessThanOrEqual(budget);
  const baseline = tempVault({ budget });
  baseline.vault.threads.setTitle(baseline.thread.id, "Title");
  const baselineResult = await runTurn(baseline.vault, baseline.thread.id, {
    text,
    model: "oracle",
    provider: providerReply("Noted."),
    budget,
  });
  expect(baselineResult.packet.tokens).toBeLessThanOrEqual(budget);

  const { vault, thread } = tempVault({ budget });
  vault.threads.setTitle(thread.id, "Title");
  const beforeThread = vault.threads.get(thread.id);
  const beforeEpisodes = vault.episodes.count(thread.id);
  const beforeObjects = readdirSync(vault.objectsDir).sort();
  let providerCalls = 0;
  const provider: Provider = async function* () {
    providerCalls += 1;
    yield { type: "done" };
  };
  await expect(
    runTurn(vault, thread.id, {
      text,
      model: "oracle",
      provider,
      budget,
      attachments: [
        {
          role: "attachment",
          content: "attachment text",
          blob: {
            bytes: new Uint8Array(64 * 1024),
            mime: "application/octet-stream",
            name: "blob.bin",
          },
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "turn_too_large" });
  expect(providerCalls).toBe(0);
  expect(vault.threads.get(thread.id)).toEqual(beforeThread);
  expect(vault.episodes.count(thread.id)).toBe(beforeEpisodes);
  expect(readdirSync(vault.objectsDir).sort()).toEqual(beforeObjects);
});

test("the asking turn cannot witness its own remembered number or identity", async () => {
  const cases = [
    { question: "What number did I give you: 48250 USD?", answer: "48250 USD." },
    { question: "Who did we say Ada Okafor owned?", answer: "Ada Okafor owned Kestrel Systems." },
  ];
  for (const candidate of cases) {
    const { vault, thread } = tempVault();
    const result = await runTurn(vault, thread.id, {
      text: candidate.question,
      model: "oracle",
      provider: async function* (request) {
        const token = request.evidence?.[0]?.token ?? "forged-capability-token";
        yield { type: "delta", text: candidate.answer };
        yield submitClaimMap(candidate.answer, token);
        yield { type: "done" };
      },
      budget: 8192,
    });
    const receipt = receiptOf(result);
    expect(classes(receipt)).not.toContain("SUPPORTED");
    expect(receipt.qualifications.length).toBeGreaterThan(0);
  }
});

test("a failed legacy check cannot leave a contradictory note after A14 supports the draft", async () => {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, {
    role: "user",
    content: "Kestrel Systems hosted the archived launch.",
  });
  const next = rng(71);
  for (let index = 0; index < 300; index += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, index) });
  }
  compact(vault, thread.id, { budget: 8192 });
  // Pin the old entity to the unresolved ledger for this focused gate oracle;
  // it is intentionally absent from the current source shown below.
  vault.losses.noteFrontierEviction(thread.id, "kestrel systems", 1);
  const current = vault.episodes.append(thread.id, {
    role: "user",
    content: "The current launch amount remains 48250 USD.",
  });
  atomize(vault, thread.id, [current.seq]);
  const draft = "The amount was 48250 USD. Kestrel Systems recorded it.";
  let round = 0;
  const provider: Provider = async function* (request) {
    round += 1;
    if (round > 1) throw new Error("check unavailable");
    const evidence = request.evidence ?? [];
    const currentCap = evidence.find((capability) => capability.seq === current.seq);
    yield { type: "delta", text: draft };
    if (currentCap !== undefined) yield submitClaimMap(draft, currentCap.token);
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "What amount did we record?",
    model: "oracle",
    provider,
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(result.assistantEpisode.meta.check?.status).toBe("check-failed");
  expect(classes(receipt)).toContain("SUPPORTED");
  expect(result.text).not.toContain("archive could not be re-read");
  expect(result.text).not.toContain("unverified");
});

test("a visible assistant span is a PROPOSED witness, never current support", async () => {
  const { vault, thread } = tempVault();
  await runTurn(vault, thread.id, {
    text: "Write a sentence containing the launch amount.",
    model: "oracle",
    provider: providerReply("The launch amount was 48250 USD."),
    budget: 8192,
  });
  const text = "The launch amount was 48250 USD.";
  const result = await runTurn(vault, thread.id, {
    text: "What did you say about the launch amount?",
    model: "oracle",
    provider: mappedProvider(text, (request) => {
      const evidence = (request as { evidence?: EvidenceCapability[] }).evidence;
      const assistant = evidence?.find((capability) => capability.authority === "assistant");
      if (assistant === undefined) throw new Error("the assistant source was not exposed");
      return assistant.token;
    }),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).toContain("PROPOSED");
  expect(classes(receipt)).not.toContain("SUPPORTED");
  expect(result.text).toMatch(/PROPOSED|prior model prose/i);
});

test("a superseded atom does not make an unchanged fact from the same episode historical", async () => {
  const { vault, thread } = tempVault();
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "My name is Ada Okafor. I live in Lisbon.",
  });
  atomize(vault, thread.id, [source.seq]);
  const correction = vault.episodes.append(thread.id, { role: "user", content: "I moved to Porto." });
  atomize(vault, thread.id, [correction.seq]);

  const answer = "My name is Ada Okafor. I live in Lisbon.";
  const result = await runTurn(vault, thread.id, {
    text: "What did I say about my name and location?",
    model: "oracle",
    provider: mappedProvider(answer, (request) => {
      const evidence = (request as { evidence?: EvidenceCapability[] }).evidence ?? [];
      const widest = evidence.reduce<EvidenceCapability | undefined>(
        (best, capability) =>
          best === undefined ||
          capability.byteRange[1] - capability.byteRange[0] > best.byteRange[1] - best.byteRange[0]
            ? capability
            : best,
        undefined,
      );
      if (widest === undefined) throw new Error("the full source capability was not exposed");
      return widest.token;
    }),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  const classifications = receipt.classifications.map((classification) => ({
    classification,
    candidate: receipt.candidates.find(
      (candidate) =>
        candidate.span[0] === classification.span[0] && candidate.span[1] === classification.span[1],
    ),
  }));
  expect(
    classifications.find((entry) => entry.candidate?.text.includes("Ada"))?.classification.classification,
  ).toBe("SUPPORTED");
  expect(
    classifications.find((entry) => entry.candidate?.text.includes("Lisbon"))?.classification.classification,
  ).toBe("HISTORICAL");
});

test("all-N collection wording is lower-bound language and remains qualified", async () => {
  const { vault, thread } = tempVault();
  const result = await runTurn(vault, thread.id, {
    text: "List every launch note.",
    model: "oracle",
    provider: providerReply("All 6 launch notes were found."),
    budget: 8192,
  });
  const receipt = receiptOf(result);
  expect(classes(receipt)).toContain("UNKNOWN");
  expect(result.text).toContain("I found 6");
  expect(result.text).not.toMatch(/\bAll 6\b/i);
});
