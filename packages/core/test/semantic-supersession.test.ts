import { afterAll, expect, test } from "bun:test";
import type { EvidenceCapability } from "@pylos/protocol";
import {
  atomize,
  compact,
  compile,
  type Provider,
  packetText,
  runTurn,
  sha256,
  verifySemanticHit,
} from "../src/index.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

test("a semantic hit stays historical when the recent window is refilled after routing", () => {
  const { vault, thread } = tempVault({ budget: 2_048 });
  const old = vault.episodes.append(thread.id, { role: "user", content: "I live in Lisbon." });
  const correction = vault.episodes.append(thread.id, {
    role: "user",
    content: "Correction: I moved to Porto.",
  });
  atomize(vault, thread.id, [old.seq, correction.seq]);
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 256 }, (_, index) => ({
      role: "user" as const,
      content: `Bench filler ${index + 1}: deterministic archive context remains available for measurement.`,
    })),
  );
  compact(vault, thread.id, { budget: 2_048 });
  const asking = vault.episodes.append(thread.id, {
    role: "user",
    content: "Where do I live now?",
  });
  const bytes = new TextEncoder().encode(old.content);

  const packet = compile(vault, thread.id, {
    query: asking.content,
    turnSeq: asking.seq,
    budget: 2_048,
    supportsTools: true,
    semanticHits: [
      {
        seq: old.seq,
        byteRange: [0, bytes.byteLength],
        contentHash: sha256(bytes),
        spanHash: sha256(bytes),
        revision: old.hash,
      },
    ],
    semanticReceipt: {
      status: "ready",
      model: "test-semantic",
      modelDigest: "a".repeat(64),
      indexed: 1,
      eligible: 1,
    },
  });

  expect(packet.pages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ trigger: "semantic", resolved: true, seqs: [old.seq] }),
    ]),
  );
  expect(packet.resident).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: "paged", seq: old.seq, epistemic: "HISTORICAL" }),
    ]),
  );
  expect(packetText(packet.messages)).toContain(`⟦recovered #${old.seq} · user · semantic⟧\n${old.content}`);
});

test("a semantic address over a superseded atom is historical through the packet and gate", async () => {
  const { vault, thread } = tempVault();
  const old = vault.episodes.append(thread.id, { role: "user", content: "I live in Lisbon." });
  atomize(vault, thread.id, [old.seq]);
  const correction = vault.episodes.append(thread.id, {
    role: "user",
    content: "Correction: I moved to Porto.",
  });
  atomize(vault, thread.id, [correction.seq]);
  for (let index = 0; index < 600; index += 1) {
    vault.episodes.append(thread.id, {
      role: "user",
      content: `Archive filler ${index} records an unrelated harbor inventory line.`,
    });
  }

  const bytes = new TextEncoder().encode(old.content);
  const semanticHit = {
    seq: old.seq,
    byteRange: [0, bytes.byteLength] as [number, number],
    contentHash: sha256(bytes),
    spanHash: sha256(bytes),
    revision: old.hash,
  };
  const semanticReceipt = {
    status: "ready" as const,
    model: "test-semantic",
    modelDigest: "a".repeat(64),
    indexed: 1,
    eligible: 1,
  };
  const answer = "I lived in Lisbon.";
  let seenCapability: EvidenceCapability | undefined;
  const provider: Provider = async function* (request) {
    seenCapability = request.evidence?.find((capability) => capability.seq === old.seq);
    yield { type: "delta", text: answer };
    if (seenCapability !== undefined) {
      yield {
        type: "tool_call",
        id: "claim-map",
        name: "submit_claim_map",
        arguments: JSON.stringify({
          claims: [{ outputSpan: [0, answer.length], capabilityTokens: [seenCapability.token] }],
        }),
      };
    }
    yield { type: "done" };
  };

  const result = await runTurn(vault, thread.id, {
    text: "What did I say about the old harbor?",
    model: "oracle",
    provider,
    check: false,
    budget: 8192,
    compileOptions: {
      semanticHits: [semanticHit],
      semanticReceipt,
    },
  });

  const semanticPages = result.packet.pages.filter((page) => page.trigger === "semantic");
  expect(semanticPages.some((page) => page.resolved && page.seqs.includes(old.seq))).toBe(true);
  const resident = result.packet.resident.find((item) => item.seq === old.seq);
  expect(resident?.epistemic).toBe("HISTORICAL");
  expect(seenCapability).toBeDefined();
  expect(result.text).toMatch(/HISTORICAL|changed|unverified/i);
  expect(result.assistantEpisode.meta.answerReceipt?.classifications).toEqual(
    expect.arrayContaining([expect.objectContaining({ classification: "HISTORICAL" })]),
  );
  expect(packetText(result.packet.messages)).toContain(old.content);

  const exact = verifySemanticHit(semanticHit, {
    seq: old.seq,
    content: old.content,
    contentHash: sha256(bytes),
    role: "user",
    revision: old.hash,
  });
  expect(exact).toMatchObject({ accepted: true, addressOnly: true, seq: old.seq });
  if (exact.accepted) expect(exact.authority).toBe("user");
});
