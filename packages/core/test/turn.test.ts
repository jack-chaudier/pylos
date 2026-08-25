import { afterAll, expect, test } from "bun:test";
import type { ChatMessage, TurnEvent } from "@pylos/protocol";
import { MAX_THREAD_MODEL_BYTES } from "@pylos/protocol";
import {
  approxTokens,
  atomize,
  compact,
  fitRound,
  handoff,
  PROVIDER_TURN_OUTPUT_BYTES,
  type Provider,
  packetText,
  roundsDigest,
  runTurn,
  sha256,
  stats,
  verify,
} from "../src/index.ts";
import { cleanup, rng, syntheticTurn, tempVault } from "./helpers.ts";

afterAll(cleanup);

/** A provider that just echoes; enough to exercise the turn transaction shape. */
const echo: Provider = async function* (request) {
  yield { type: "delta", text: `answered from ${request.messages.length} messages` };
  yield { type: "done", usage: { inputTokens: 100, outputTokens: 8 } };
};

test("a turn appends both episodes, writes a packet and closes it", async () => {
  const { vault, thread } = tempVault();
  const events: TurnEvent[] = [];
  const result = await runTurn(vault, thread.id, {
    text: "Hello, my name is Ada Okafor.",
    model: "test-model",
    provider: echo,
    budget: 8192,
    onEvent: (e) => events.push(e),
  });
  expect(result.userEpisode.seq).toBe(1);
  expect(result.assistantEpisode.seq).toBe(2);
  expect(result.assistantEpisode.model).toBe("test-model");
  expect(result.assistantEpisode.meta.packetId).toBe(result.packet.id);
  expect(vault.packets.get(thread.id, 1)?.status).toBe("done");
  expect(vault.atoms.byKey(thread.id, "identity.name")[0]?.value).toBe("Ada Okafor");
  expect(events.map((e) => e.type)).toEqual(["episode", "packet", "gate", "delta", "done"]);
  expect(events.findIndex((event) => event.type === "gate")).toBeLessThan(
    events.findIndex((event) => event.type === "delta"),
  );
  const verification = verify(vault, thread.id, { full: true });
  expect(verification.ok, verification.reason).toBe(true);
});

test("an oversized model identifier is rejected before turn rows or provider work", async () => {
  const { vault, thread } = tempVault();
  let called = false;
  const provider: Provider = async function* () {
    called = true;
    yield { type: "done" };
  };
  await expect(
    runTurn(vault, thread.id, {
      text: "must not persist",
      model: "m".repeat(MAX_THREAD_MODEL_BYTES + 1),
      provider,
      budget: 8192,
    }),
  ).rejects.toThrow(/model/iu);
  expect(called).toBe(false);
  expect(vault.episodes.count(thread.id)).toBe(0);
  expect(
    (vault.db.query("SELECT COUNT(*) AS n FROM packet WHERE thread_id = ?").get(thread.id) as { n: number })
      .n,
  ).toBe(0);
});

test("the recall tool loop serves exact archive material and records the pages", async () => {
  const { vault, thread } = tempVault();
  await runTurn(vault, thread.id, {
    text: "Kestrel Systems signed the Valletta contract for 48250.75 usd. Keep that.",
    model: "m",
    provider: echo,
    budget: 8192,
  });
  const next = rng(51);
  for (let i = 0; i < 300; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  compact(vault, thread.id, { budget: 8192 });

  let round = 0;
  const recaller: Provider = async function* (request) {
    if (round === 0) {
      round += 1;
      yield {
        type: "tool_call",
        id: "call_1",
        name: "recall",
        arguments: JSON.stringify({ seq: 1 }),
      };
      yield { type: "done" };
      return;
    }
    const tool = request.messages.find((m) => m.role === "tool");
    yield { type: "delta", text: `I checked: ${tool?.content.slice(0, 60) ?? "nothing"}` };
    yield { type: "done" };
  };

  const result = await runTurn(vault, thread.id, {
    text: "How much did that contract cost?",
    model: "m",
    provider: recaller,
    budget: 8192,
  });
  expect(round).toBe(1);
  const modelPages = result.pages.filter((p) => p.trigger === "model");
  expect(modelPages.length).toBeGreaterThan(0);
  expect(modelPages[0]?.resolved).toBe(true);
  expect(modelPages[0]?.seqs).toContain(1);
  expect(result.text).toContain("Kestrel Systems");
  expect(result.toolEpisodes).toHaveLength(1);
  expect(result.toolEpisodes[0]?.role).toBe("tool");
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

/**
 * The model's own recall query is the user's question in much the same words, so
 * the question's episode — resident, indexed like any other turn — is the first
 * thing an AND search matches. Counted as a hit it reports "found" and suppresses
 * the broader pass that reaches the turn actually being asked for (KERNEL A9.4).
 */
test("a recall in the question's own words still reaches the archive, not UNKNOWN", async () => {
  const { vault, thread } = tempVault();
  await runTurn(vault, thread.id, {
    text: "The flue on the kiln was blocked, which is why it fired unevenly.",
    model: "m",
    provider: echo,
    budget: 8192,
  });
  const next = rng(71);
  for (let i = 0; i < 300; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  compact(vault, thread.id, { budget: 8192 });

  const question = "Remind me about the unevenly fired kiln, exactly.";
  let asked = false;
  const echoingRecaller: Provider = async function* (request) {
    if (!asked) {
      asked = true;
      yield { type: "tool_call", id: "c", name: "recall", arguments: JSON.stringify({ query: question }) };
      yield { type: "done" };
      return;
    }
    const tool = request.messages.find((m) => m.role === "tool");
    yield { type: "delta", text: tool?.content ?? "" };
    yield { type: "done" };
  };

  const result = await runTurn(vault, thread.id, {
    text: question,
    model: "m",
    provider: echoingRecaller,
    budget: 8192,
    check: false,
  });
  expect(result.text).not.toContain("UNKNOWN");
  expect(result.text).toContain("flue");
  expect(result.pages.some((p) => p.trigger === "model" && p.seqs.includes(1))).toBe(true);
});

test("recall for material that does not exist returns UNKNOWN, not a guess", async () => {
  const { vault, thread } = tempVault();
  await runTurn(vault, thread.id, { text: "hello", model: "m", provider: echo, budget: 8192 });
  let asked = false;
  const prober: Provider = async function* (request) {
    if (!asked) {
      asked = true;
      yield {
        type: "tool_call",
        id: "c",
        name: "recall",
        arguments: JSON.stringify({ range: [9000, 9010] }),
      };
      yield { type: "done" };
      return;
    }
    const tool = request.messages.find((m) => m.role === "tool");
    yield { type: "delta", text: tool?.content ?? "" };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "what happened at turn 9000?",
    model: "m",
    provider: prober,
    budget: 8192,
  });
  expect(result.text).toContain("UNKNOWN");
});

test("a provider error does not leave a half-written turn", async () => {
  const { vault, thread } = tempVault();
  const broken: Provider = async function* () {
    yield { type: "error", message: "provider exploded" };
  };
  await expect(
    runTurn(vault, thread.id, { text: "hi", model: "m", provider: broken, budget: 8192 }),
  ).rejects.toThrow("provider exploded");
  // The user turn is durable; the packet stays `pending` and renders as "no reply".
  expect(vault.threads.get(thread.id)?.headSeq).toBe(1);
  expect(vault.packets.get(thread.id, 1)?.status).toBe("pending");
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("a provider that streams nothing is a failed turn, not an empty assistant episode", async () => {
  const { vault, thread } = tempVault();
  const events: TurnEvent[] = [];
  const silent: Provider = async function* () {
    yield { type: "done", usage: { inputTokens: 120, outputTokens: 0 } };
  };
  await expect(
    runTurn(vault, thread.id, {
      text: "Who signed the Valletta contract?",
      model: "m",
      provider: silent,
      budget: 8192,
      onEvent: (event) => events.push(event),
    }),
  ).rejects.toMatchObject({ code: "empty_answer" });

  // The same shape a mid-stream provider failure leaves: one error event, no
  // gate, no `done`, the user's turn durable and the packet still `pending`.
  expect(events.filter((event) => event.type === "error")).toEqual([
    expect.objectContaining({ type: "error", code: "empty_answer" }),
  ]);
  expect(
    events.some((event) => event.type === "gate" || event.type === "delta" || event.type === "done"),
  ).toBe(false);
  expect(vault.threads.get(thread.id)?.headSeq).toBe(1);
  expect(vault.episodes.list(thread.id, { limit: 10 }).map((episode) => episode.role)).toEqual(["user"]);
  const packet = vault.packets.get(thread.id, 1);
  expect(packet?.status).toBe("pending");
  expect(packet?.answerReceipt).toBeUndefined();
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);

  // Resending the same question is an ordinary retry: nothing had to be undone.
  const retry = await runTurn(vault, thread.id, {
    text: "Who signed the Valletta contract?",
    model: "m",
    provider: echo,
    budget: 8192,
  });
  expect(retry.assistantEpisode.seq).toBe(3);
  expect(retry.assistantEpisode.content.length).toBeGreaterThan(0);
  expect(vault.episodes.list(thread.id, { limit: 10 }).map((episode) => episode.role)).toEqual([
    "user",
    "user",
    "assistant",
  ]);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("a whitespace-only answer is refused the same way silence is", async () => {
  const { vault, thread } = tempVault();
  const blank: Provider = async function* () {
    yield { type: "delta", text: " \n" };
    yield { type: "delta", text: "\t" };
    yield { type: "done" };
  };
  await expect(
    runTurn(vault, thread.id, { text: "Say something.", model: "m", provider: blank, budget: 8192 }),
  ).rejects.toMatchObject({ code: "empty_answer" });
  expect(vault.threads.get(thread.id)?.headSeq).toBe(1);
  expect(vault.packets.get(thread.id, 1)?.status).toBe("pending");
});

test("a recall loop that never answers records no assistant episode", async () => {
  const { vault, thread } = tempVault();
  let ordinal = 0;
  const evasive: Provider = async function* () {
    ordinal += 1;
    yield { type: "tool_call", id: `call_${ordinal}`, name: "recall", arguments: JSON.stringify({ seq: 1 }) };
    yield { type: "done" };
  };
  await expect(
    runTurn(vault, thread.id, {
      text: "Keep looking and never answer.",
      model: "m",
      provider: evasive,
      budget: 8192,
      maxRecallRounds: 2,
    }),
  ).rejects.toMatchObject({ code: "empty_answer" });
  expect(ordinal).toBe(3);
  expect(vault.episodes.list(thread.id, { limit: 10 }).map((episode) => episode.role)).toEqual(["user"]);
  expect(vault.packets.get(thread.id, 1)?.status).toBe("pending");
});
test("provider output bytes are refused before tx B and cancel the active round", async () => {
  const { vault, thread } = tempVault();
  const events: TurnEvent[] = [];
  let cancelled = false;
  const malicious: Provider = async function* (request) {
    request.signal?.addEventListener("abort", () => {
      cancelled = true;
    });
    try {
      for (let i = 0; i < 65; i += 1) {
        // Two UTF-8 bytes per character: the oracle fails if the meter counts
        // JavaScript code units instead of bytes.
        yield { type: "delta", text: "¢".repeat(512) };
      }
      yield { type: "done" };
    } finally {
      cancelled ||= request.signal?.aborted === true;
    }
  };

  await expect(
    runTurn(vault, thread.id, {
      text: "Keep this user episode, but never commit the oversized answer.",
      model: "m",
      provider: malicious,
      budget: 8192,
      onEvent: (event) => events.push(event),
    }),
  ).rejects.toMatchObject({ code: "provider_output_limit" });

  expect(cancelled).toBe(true);
  expect(
    events.some((event) => event.type === "gate" || event.type === "delta" || event.type === "done"),
  ).toBe(false);
  expect(events.filter((event) => event.type === "error")).toEqual([
    expect.objectContaining({ type: "error", code: "provider_output_limit" }),
  ]);
  expect(vault.threads.get(thread.id)?.headSeq).toBe(1);
  expect(vault.episodes.get(thread.id, 1)?.role).toBe("user");
  expect(vault.packets.get(thread.id, 1)?.status).toBe("pending");
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("oversized tool arguments are never accumulated or committed", async () => {
  const { vault, thread } = tempVault();
  const malicious: Provider = async function* () {
    yield {
      type: "tool_call",
      id: "call_oversized",
      name: "recall",
      arguments: JSON.stringify({ query: "x".repeat(65 * 1024) }),
    };
    yield { type: "done" };
  };

  await expect(
    runTurn(vault, thread.id, {
      text: "Try the malicious tool call.",
      model: "m",
      provider: malicious,
      budget: 8192,
    }),
  ).rejects.toMatchObject({ code: "provider_output_limit" });
  expect(vault.threads.get(thread.id)?.headSeq).toBe(1);
  expect(vault.episodes.list(thread.id, { limit: 10 }).map((episode) => episode.role)).toEqual(["user"]);
  expect(vault.packets.get(thread.id, 1)?.status).toBe("pending");
});

test("recall rounds share one fixed provider-output ceiling for the whole turn", async () => {
  const { vault, thread } = tempVault();
  let ordinal = 0;
  const malicious: Provider = async function* () {
    ordinal += 1;
    yield { type: "delta", text: "a".repeat(60 * 1024) };
    yield {
      type: "tool_call",
      id: `recall_${ordinal}`,
      name: "recall",
      arguments: JSON.stringify({ seq: 1 }),
    };
    yield { type: "done" };
  };

  await expect(
    runTurn(vault, thread.id, {
      text: "Keep paging forever.",
      model: "m",
      provider: malicious,
      budget: 8192,
      maxRecallRounds: 3,
    }),
  ).rejects.toMatchObject({
    code: "provider_output_limit",
    message: `Provider output exceeded the ${PROVIDER_TURN_OUTPUT_BYTES}-byte turn limit.`,
  });
  expect(ordinal).toBe(3);
  expect(vault.threads.get(thread.id)?.headSeq).toBe(1);
  expect(vault.packets.get(thread.id, 1)?.status).toBe("pending");
});

test("an oversized check reissue is fatal instead of committing the provisional draft", async () => {
  const { vault, thread } = threadWithLostNumber();
  const before = vault.threads.get(thread.id)?.headSeq ?? 0;
  let ordinal = 0;
  const malicious: Provider = async function* () {
    ordinal += 1;
    if (ordinal === 1) yield { type: "delta", text: "The amount was 48250 usd." };
    else yield { type: "delta", text: "x".repeat(65 * 1024) };
    yield { type: "done" };
  };

  await expect(
    runTurn(vault, thread.id, {
      text: "Tell me the number again.",
      model: "m",
      provider: malicious,
      budget: 8192,
    }),
  ).rejects.toMatchObject({ code: "provider_output_limit" });
  expect(ordinal).toBe(2);
  expect(vault.threads.get(thread.id)?.headSeq).toBe(before + 1);
  expect(vault.episodes.get(thread.id, before + 1)?.role).toBe("user");
  expect(vault.packets.get(thread.id, before + 1)?.status).toBe("pending");
});

test("a model switch is a handoff episode and the thread continues", async () => {
  const { vault, thread } = tempVault();
  await runTurn(vault, thread.id, { text: "first", model: "grok-4.6", provider: echo, budget: 8192 });
  const divider = handoff(vault, thread.id, "Grok", "Claude");
  expect(divider.role).toBe("handoff");
  expect(divider.content).toBe("Grok stopped here. Claude continued from the same thread.");
  await runTurn(vault, thread.id, {
    text: "second",
    model: "claude-sonnet-4.5",
    provider: echo,
    budget: 8192,
  });
  expect(stats(vault, thread.id).models.sort()).toEqual(["claude-sonnet-4.5", "grok-4.6"]);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("many turns keep the packet within budget and the chain intact", async () => {
  const { vault, thread } = tempVault();
  const next = rng(52);
  for (let i = 0; i < 150; i += 1) {
    const result = await runTurn(vault, thread.id, {
      text: syntheticTurn(next, i),
      model: "m",
      provider: echo,
      budget: 4096,
    });
    expect(result.packet.tokens).toBeLessThanOrEqual(4096);
  }
  const verification = verify(vault, thread.id, { full: true });
  expect(verification.ok, verification.reason).toBe(true);
  const summary = stats(vault, thread.id);
  expect(summary.turns).toBe(300);
  expect(summary.episodes.user).toBe(150);
  expect(summary.capsules).toBeGreaterThan(0);
});

/** A thread where an exact number was said early and has since been compacted out. */
function threadWithLostNumber() {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, {
    role: "user",
    content: "Kestrel Systems signed the Valletta contract for 48250 usd.",
  });
  const next = rng(61);
  for (let i = 0; i < 300; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  compact(vault, thread.id, { budget: 8192 });
  return { vault, thread };
}

test("a draft that states a lost value is checked against the archive (KERNEL A9.5)", async () => {
  const { vault, thread } = threadWithLostNumber();
  const seen: Array<ChatMessage[]> = [];
  const drafter: Provider = async function* (request) {
    seen.push(request.messages);
    yield {
      type: "delta",
      text: seen.length === 1 ? "The amount was 48250 usd." : "The amount was 48250 usd — Valletta contract.",
    };
    yield { type: "done" };
  };

  const events: TurnEvent[] = [];
  const result = await runTurn(vault, thread.id, {
    text: "Tell me the number again.",
    model: "m",
    provider: drafter,
    budget: 8192,
    onEvent: (e) => events.push(e),
  });

  expect(seen).toHaveLength(2);
  const check = events.find((e) => e.type === "check");
  expect(check?.type === "check" && check.names).toEqual(["48250 usd"]);
  const checkPages = result.pages.filter((p) => p.trigger === "check");
  expect(checkPages.some((p) => p.resolved && p.seqs.includes(1))).toBe(true);
  // The second round is given the exact archive text, as data.
  const last = (seen[1] as ChatMessage[]).at(-1) as ChatMessage;
  expect(last.role).toBe("user");
  expect(last.content).toContain("⟨pylos check⟩");
  expect(last.content).toContain("Kestrel Systems signed the Valletta contract for 48250 usd.");
  // The recovered turn keeps its role, and the message says what a role means.
  expect(last.content).toContain("⟦recovered #1 · user⟧");
  expect(last.content).toContain("an assistant turn is a previous model's word, not confirmation");
  expect((seen[1] as ChatMessage[]).at(-2)?.content).toBe("The amount was 48250 usd.");
  // The episode is the reissued answer, and A14 qualifies the sentence-level
  // paraphrase even though the nested number was recovered from the archive.
  expect(result.assistantEpisode.content).toContain("The amount was 48250 usd — Valletta contract.");
  expect(result.assistantEpisode.content).toMatch(/UNKNOWN|INFERENCE/i);
  expect(result.packet.answerReceipt?.qualifications.length).toBeGreaterThan(0);
  expect(result.text).toBe(result.assistantEpisode.content);
  expect(result.assistantEpisode.meta.check).toEqual({
    names: ["48250 usd"],
    status: "revised",
    draftSha256: sha256("The amount was 48250 usd."),
  });
  const verification = verify(vault, thread.id, { full: true });
  expect(verification.ok, verification.reason).toBe(true);
});

test("a draft that stays inside the view costs exactly one provider round", async () => {
  const { vault, thread } = threadWithLostNumber();
  let rounds = 0;
  const plain: Provider = async function* () {
    rounds += 1;
    yield { type: "delta", text: "Nothing outside the view here." };
    yield { type: "done" };
  };
  const events: TurnEvent[] = [];
  const result = await runTurn(vault, thread.id, {
    text: "How is it going?",
    model: "m",
    provider: plain,
    budget: 8192,
    onEvent: (e) => events.push(e),
  });
  expect(rounds).toBe(1);
  expect(events.some((e) => e.type === "check")).toBe(false);
  // The check ran and had nothing to check; the receipt says so (KERNEL A10.4).
  expect(result.assistantEpisode.meta.check?.status).toBe("none");
  expect(result.assistantEpisode.meta.check?.names).toEqual([]);
});

test("a failed check round keeps the draft: a reply is never lost to the check", async () => {
  const { vault, thread } = threadWithLostNumber();
  let rounds = 0;
  const flaky: Provider = async function* () {
    rounds += 1;
    if (rounds === 1) {
      yield { type: "delta", text: "The amount was 48250 usd." };
      yield { type: "done" };
      return;
    }
    yield { type: "error", message: "provider exploded" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "Tell me the number again.",
    model: "m",
    provider: flaky,
    budget: 8192,
  });
  expect(rounds).toBe(2);
  // The draft stands, but A14 qualifies its sentence-level paraphrase. The
  // failed provider receipt must not leave a contradictory legacy note.
  expect(result.assistantEpisode.content).toContain("The amount was 48250 usd.");
  expect(result.assistantEpisode.content).toMatch(/UNKNOWN|INFERENCE/i);
  expect(
    result.packet.answerReceipt?.classifications.some((entry) => entry.classification === "SUPPORTED"),
  ).toBe(true);
  expect(result.packet.answerReceipt?.qualifications.length).toBeGreaterThan(0);
  expect(result.assistantEpisode.meta.check).toEqual({
    names: ["48250 usd"],
    status: "check-failed",
    draftSha256: sha256("The amount was 48250 usd."),
  });
});

test("a check round that reissues the same text is recorded as confirmed", async () => {
  const { vault, thread } = threadWithLostNumber();
  const steady: Provider = async function* () {
    yield { type: "delta", text: "The amount was 48250 usd." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "Tell me the number again.",
    model: "m",
    provider: steady,
    budget: 8192,
  });
  expect(result.assistantEpisode.content).toContain("The amount was 48250 usd.");
  expect(result.assistantEpisode.content).toMatch(/UNKNOWN|INFERENCE/i);
  expect(result.packet.answerReceipt?.qualifications.length).toBeGreaterThan(0);
  expect(result.assistantEpisode.meta.check?.status).toBe("confirmed");
});

test("the check serves the user's turn before the model's own earlier turn", async () => {
  const { vault, thread } = tempVault();
  const next = rng(62);
  vault.episodes.append(thread.id, {
    role: "user",
    content: "Kestrel Systems signed the Valletta contract for 48250 usd.",
  });
  for (let i = 0; i < 200; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  // The model repeated the figure later; that repetition is not evidence.
  vault.episodes.append(thread.id, {
    role: "assistant",
    content: "Noted — the Valletta contract came to 48250 usd, as you say.",
  });
  for (let i = 0; i < 400; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  vault.episodes.append(thread.id, { role: "assistant", content: "Nothing to report today." });
  compact(vault, thread.id, { budget: 8192 });
  // Both mentions are in the ledger, the model's the more recent of the two.
  expect(vault.losses.byName(thread.id, "48250 usd", 4).map((l) => l.seq)).toEqual([202, 1]);

  const seen: Array<ChatMessage[]> = [];
  const drafter: Provider = async function* (request) {
    seen.push(request.messages);
    yield { type: "delta", text: "The amount was 48250 usd." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "Tell me the number again.",
    model: "m",
    provider: drafter,
    budget: 8192,
  });
  const checkPage = result.pages.find((p) => p.trigger === "check" && p.resolved);
  expect(checkPage?.seqs[0]).toBe(1);
  expect((seen[1] as ChatMessage[]).at(-1)?.content).toContain("⟦recovered #1 · user⟧");
});

test("the check round can be switched off", async () => {
  const { vault, thread } = threadWithLostNumber();
  let rounds = 0;
  const drafter: Provider = async function* () {
    rounds += 1;
    yield { type: "delta", text: "The amount was 48250 usd." };
    yield { type: "done" };
  };
  await runTurn(vault, thread.id, {
    text: "Tell me the number again.",
    model: "m",
    provider: drafter,
    budget: 8192,
    check: false,
  });
  expect(rounds).toBe(1);
});

/** An archive where an exact line has been compacted out and lives in the ledger. */
function threadWithLostLine(line: string, seed = 71) {
  const { vault, thread } = tempVault();
  vault.episodes.append(thread.id, { role: "user", content: line });
  const next = rng(seed);
  for (let i = 0; i < 300; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  compact(vault, thread.id, { budget: 8192 });
  return { vault, thread };
}

/** A provider that answers `reply` and remembers every request it was sent. */
function recorder(reply: string): { provider: Provider; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  const provider: Provider = async function* (request) {
    seen.push(request.messages);
    yield { type: "delta", text: reply };
    yield { type: "done" };
  };
  return { provider, seen };
}

test("the question is not its own witness: the page it names is served (KERNEL A10.1)", async () => {
  const line = "Kestrel Systems signed the Valletta contract for 48250 usd.";
  const { vault, thread } = threadWithLostLine(line);
  const { provider, seen } = recorder("Checking.");
  const result = await runTurn(vault, thread.id, {
    text: "Was the contract 48,250 USD?",
    model: "m",
    provider,
    budget: 8192,
  });
  // The first request the provider ever sees already contains the exact turn —
  // recovered by the ledger route, not by the lexical fallback.
  expect(packetText(seen[0] as ChatMessage[])).toContain(line);
  expect(result.pages.some((p) => p.trigger === "ledger" && p.resolved && p.seqs.includes(1))).toBe(true);
  // The current turn is the `query` span, once, and never part of the window.
  const query = result.packet.resident.filter((r) => r.type === "query");
  expect(query.map((r) => r.seq)).toEqual([result.userEpisode.seq]);
  expect(query[0]?.epistemic).toBe("NON_AUTHORITATIVE");
  expect(result.packet.resident.some((r) => r.type === "recent" && r.seq === result.userEpisode.seq)).toBe(
    false,
  );
});

test("a subject named in the turn is paged from the archive by name", async () => {
  const line = "Kestrel Systems signed the Valletta contract for 48250 usd.";
  const { vault, thread } = threadWithLostLine(line, 72);
  const { provider, seen } = recorder("Looking.");
  const result = await runTurn(vault, thread.id, {
    text: "Please recall Kestrel Systems.",
    model: "m",
    provider,
    budget: 8192,
  });
  expect(packetText(seen[0] as ChatMessage[])).toContain(line);
  expect(result.pages.some((p) => p.trigger === "ledger" && p.resolved && p.name === "kestrel systems")).toBe(
    true,
  );
});

test("presence in an assistant turn is not support; presence in a user turn is (KERNEL A10.1)", async () => {
  const run = async (role: "assistant" | "user") => {
    const { vault, thread } = threadWithLostLine(
      "Kestrel Systems signed the Valletta contract for 48250 usd.",
      role === "assistant" ? 73 : 74,
    );
    // Said again, recently, so it is verbatim in the recent window either way.
    vault.episodes.append(thread.id, { role, content: "The Valletta contract came to 48250 usd." });
    // A later, empty assistant turn, so the §5.1 route reads that one instead and
    // the only thing under test is what the resident claim is allowed to support.
    vault.episodes.append(thread.id, { role: "assistant", content: "Noted." });
    const { provider } = recorder("The amount was 48250 usd.");
    return runTurn(vault, thread.id, {
      text: "Tell me the number again.",
      model: "m",
      provider,
      budget: 8192,
    });
  };
  expect((await run("assistant")).assistantEpisode.meta.check?.status).not.toBe("none");
  expect((await run("user")).assistantEpisode.meta.check?.status).toBe("none");
});

test("a leading question the model then echoes is checked against the archive", async () => {
  const { vault, thread } = tempVault();
  // The only mention in the archive is the model's own earlier turn.
  vault.episodes.append(thread.id, {
    role: "assistant",
    content: "I believe the Valletta contract came to 48250 usd.",
  });
  const next = rng(75);
  for (let i = 0; i < 300; i += 1) {
    vault.episodes.append(thread.id, { role: "user", content: syntheticTurn(next, i) });
  }
  compact(vault, thread.id, { budget: 8192 });
  const seen: ChatMessage[][] = [];
  const drafter: Provider = async function* (request) {
    seen.push(request.messages);
    yield { type: "delta", text: "Yes — 48250 usd." };
    yield { type: "done" };
  };
  const result = await runTurn(vault, thread.id, {
    text: "Was the contract 48,250 USD?",
    model: "m",
    provider: drafter,
    budget: 8192,
  });
  expect(result.assistantEpisode.meta.check?.names).toEqual(["48250 usd"]);
  expect(seen).toHaveLength(2);
  // The question paged the archive's only mention — the model's own earlier turn,
  // labelled as such — and a labelled proposal is not support, so the check ran.
  expect(packetText(seen[0] as ChatMessage[])).toContain("⟦recovered #1 · assistant · ledger:48250 usd⟧");
  expect(result.packet.resident.find((r) => r.type === "paged" && r.seq === 1)?.epistemic).toBe("PROPOSED");
});

test("the user's correction is a certificate in the first request (KERNEL A10.2)", async () => {
  const { vault, thread } = tempVault();
  const first = vault.episodes.append(thread.id, { role: "user", content: "I live in Lisbon." });
  atomize(vault, thread.id, [first.seq]);
  const { provider, seen } = recorder("Noted.");
  await runTurn(vault, thread.id, { text: "I moved to Porto.", model: "m", provider, budget: 8192 });
  const sent = packetText(seen[0] as ChatMessage[]);
  expect(sent).toContain("user.location = Porto");
  expect(sent).not.toContain("user.location = Lisbon ⟨#1⟩");
  expect(vault.atoms.byKey(thread.id, "user.location", "HISTORICAL")[0]?.value).toBe("Lisbon");
});

test("a provider failure keeps the user's word: the atom is committed (KERNEL A10.2)", async () => {
  const { vault, thread } = tempVault();
  const broken: Provider = async function* () {
    yield { type: "error", message: "provider exploded" };
  };
  await expect(
    runTurn(vault, thread.id, { text: "I live in Porto.", model: "m", provider: broken, budget: 8192 }),
  ).rejects.toThrow("provider exploded");
  expect(vault.atoms.byKey(thread.id, "user.location")[0]?.value).toBe("Porto");
  const { provider, seen } = recorder("Understood.");
  await runTurn(vault, thread.id, { text: "Where do I live?", model: "m", provider, budget: 8192 });
  expect(packetText(seen[0] as ChatMessage[])).toContain("user.location = Porto");
});

test("every provider request of a turn is bounded and receipted (KERNEL A10.3)", async () => {
  const { vault, thread } = threadWithLostLine(
    "Kestrel Systems signed the Valletta contract for 48250 usd.",
    76,
  );
  let round = 0;
  const provider: Provider = async function* () {
    round += 1;
    if (round === 1) {
      yield { type: "tool_call", id: "c1", name: "recall", arguments: JSON.stringify({ seq: 5 }) };
      yield { type: "done", usage: { inputTokens: 100, outputTokens: 4 } };
      return;
    }
    yield {
      type: "delta",
      text: round === 2 ? "The amount was 48250 usd." : "The amount was 48250 usd (checked).",
    };
    yield { type: "done", usage: { inputTokens: 200, outputTokens: 8 } };
  };
  const result = await runTurn(vault, thread.id, {
    text: "Tell me the number again.",
    model: "m",
    provider,
    budget: 8192,
  });

  const rounds = result.packet.rounds ?? [];
  expect(rounds.map((r) => r.ordinal)).toEqual([0, 1, 2]);
  // Ordinal 0 is the compiled packet itself.
  expect(rounds[0]?.messagesDigest).toBe(result.packet.digest);
  for (const entry of rounds) {
    expect(entry.tokens).toBeLessThanOrEqual(8192);
    expect(entry.budget).toBe(8192);
    expect(entry.status).toBe("done");
    expect(entry.messagesDigest.length).toBe(64);
    expect(entry.responseDigest?.length).toBe(64);
  }
  // The recall round carries the page it was built from; the check round its own.
  expect(rounds[1]?.pages.some((p) => p.trigger === "model")).toBe(true);
  expect(rounds[2]?.pages.some((p) => p.trigger === "check")).toBe(true);
  // Usage is the turn's, summed across rounds.
  expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 20 });
  expect(result.assistantEpisode.meta.roundsDigest).toBe(roundsDigest(rounds));
  // The receipts are durable, and the digests are stable.
  const stored = vault.packets.get(thread.id, result.packet.turnSeq);
  expect(stored?.rounds?.map((r) => r.messagesDigest)).toEqual(rounds.map((r) => r.messagesDigest));
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("fitRound displaces the oldest window spans, never the header or the prompt", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "H".repeat(400) },
    { role: "user", content: "oldest ".repeat(60) },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "recall", args: "{}" }] },
    { role: "tool", content: "recalled ".repeat(60), toolCallId: "c1", name: "recall" },
    { role: "user", content: "the prompt this round is about" },
  ];
  const budget = 260;
  const fitted = fitRound(messages, budget);
  expect(approxTokens(packetText(fitted))).toBeLessThanOrEqual(budget);
  expect(fitted[0]).toBe(messages[0] as ChatMessage);
  expect(fitted.at(-1)).toBe(messages.at(-1) as ChatMessage);
  // The tool result never outlives the call that asked for it.
  const calls = fitted.filter((m) => m.toolCalls !== undefined).length;
  expect(fitted.filter((m) => m.role === "tool").length).toBeLessThanOrEqual(calls);
  // Nothing to give: a single oversized prompt is returned as it is, not truncated.
  const only: ChatMessage[] = [{ role: "user", content: "x".repeat(4000) }];
  expect(fitRound(only, 10)).toEqual(only);
});

test("a fault is handled by the model's own rewording (KERNEL A11.1)", async () => {
  const { vault, thread } = tempVault();
  const next = rng(63);
  for (let i = 0; i < 450; i += 1) {
    vault.episodes.append(thread.id, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: syntheticTurn(next, i),
    });
  }
  vault.episodes.append(thread.id, { role: "user", content: "The kiln at Sagres fired unevenly." });
  for (let i = 0; i < 450; i += 1) {
    vault.episodes.append(thread.id, {
      role: i % 2 === 0 ? "assistant" : "user",
      content: syntheticTurn(next, i),
    });
  }
  vault.episodes.append(thread.id, { role: "assistant", content: "Noted." });
  compact(vault, thread.id, { budget: 8192 });

  const seen: string[] = [];
  // The question uses none of the archive's words, so no route reaches it; the
  // fault tells the model to try other words, and the archive answers those.
  const rewording: Provider = async function* (request) {
    seen.push(packetText(request.messages));
    if (seen.length === 1) {
      yield {
        type: "tool_call",
        id: "call_1",
        name: "recall",
        arguments: JSON.stringify({ query: "kiln at Sagres fired unevenly" }),
      };
      yield { type: "done" };
      return;
    }
    const tool = request.messages.find((m) => m.role === "tool");
    yield { type: "delta", text: `It was uneven: ${tool?.content.slice(0, 120) ?? ""}` };
    yield { type: "done" };
  };

  const result = await runTurn(vault, thread.id, {
    text: "what did we agree about the pottery furnace?",
    model: "m",
    provider: rewording,
    budget: 8192,
    check: false,
  });

  expect(seen[0]).toContain("⟨pylos fault⟩");
  const fault = result.pages.findIndex((p) => p.trigger === "fault");
  const served = result.pages.findIndex((p) => p.trigger === "model" && p.resolved);
  expect(fault).toBeGreaterThanOrEqual(0);
  expect(result.pages[fault]?.resolved).toBe(false);
  expect(served).toBeGreaterThan(fault);
  expect(result.pages[served]?.seqs).toContain(451);
  expect(result.text).toContain("The kiln at Sagres fired unevenly.");
  expect(result.packet.rounds).toHaveLength(2);
  for (const round of result.packet.rounds ?? []) {
    expect(round.tokens).toBeLessThanOrEqual(8192);
  }
});
