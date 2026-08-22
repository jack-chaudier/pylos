#!/usr/bin/env bun
/**
 * `bun bench/live-run.ts [--model grok-4.3] [--turns 2000] [--seed live-1] [--budget 8192]`
 * Runs the live bench with the real xAI provider from @pylos/server (credentials in
 * ~/.pylos/auth.json; imports the Grok CLI login if nothing is configured).
 */
import type { Provider as CoreProvider } from "@pylos/core";
import { AuthService } from "../packages/server/src/auth/xai.ts";
import { XaiProvider } from "../packages/server/src/providers/xai.ts";
import { runLive } from "./live.ts";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};
const model = arg("model", "grok-4.3");
const turns = Number(arg("turns", "2000"));
const seed = arg("seed", "live-1");
const budget = Number(arg("budget", "8192"));

const auth = new AuthService();
if (!(await auth.configured("xai"))) {
  const st = await auth.importGrokCli();
  if (!st.ok) throw new Error("xAI not configured and Grok CLI import failed");
}
const xai = new XaiProvider(auth);

const provider: CoreProvider = (r) =>
  (async function* () {
    let usage: unknown;
    for await (const ev of xai.stream(r.messages, {
      model: r.model,
      tools: r.tools,
      temperature: 0,
      maxTokens: 400,
    })) {
      if (ev.type === "delta") yield { type: "delta" as const, text: ev.text };
      else if (ev.type === "tool_call")
        yield { type: "tool_call" as const, id: ev.id, name: ev.name, arguments: ev.args };
      else if (ev.type === "usage") usage = ev.usage;
      else if (ev.type === "done") yield { type: "done" as const, usage: usage as never };
    }
  })();

const t0 = Date.now();
const result = await runLive({
  model,
  turns,
  seed,
  budget,
  provider,
  out: `bench/results/million-live-${seed}.json`,
});
console.log(
  JSON.stringify(
    {
      ok: result.ok,
      model,
      turns,
      seed,
      budget,
      summary: result.summary,
      probes: result.probes.length,
      secs: Math.round((Date.now() - t0) / 1000),
      reason: result.reason,
    },
    null,
    2,
  ),
);
if (result.trap) {
  console.log(
    `\n--- TRAP · pylos ---\n${result.trap.pylos.answer}\n\n--- TRAP · rolling ---\n${result.trap.rolling.answer}`,
  );
}
