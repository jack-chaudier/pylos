import { afterAll, expect, test } from "bun:test";
import type { TurnEvent } from "@pylos/protocol";
import { compact, handoff, type Provider, runTurn, stats, verify } from "../src/index.ts";
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
  expect(events.map((e) => e.type)).toEqual(["episode", "packet", "delta", "done"]);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
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
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
  const summary = stats(vault, thread.id);
  expect(summary.turns).toBe(300);
  expect(summary.episodes.user).toBe(150);
  expect(summary.capsules).toBeGreaterThan(0);
});
