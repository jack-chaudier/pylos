import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CORE_URL = new URL("../src/index.ts", import.meta.url).href;
const LOCAL_RESOURCES = [
  process.env.PYLOS_SEMANTIC_TEST_RESOURCES,
  "/private/tmp/pylos-semantic-preflight",
  resolve(import.meta.dir, "../../../apps/desktop/src-tauri/semantic"),
].find((path): path is string => path !== undefined && existsSync(join(path, "manifest.json")));

async function child(
  code: string,
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const spawned = Bun.spawn([process.execPath, "-e", code], {
    cwd: resolve(import.meta.dir, "../../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(spawned.stdout).text();
  const stderr = await new Response(spawned.stderr).text();
  const exit = await spawned.exited;
  if (exit !== 0) throw new Error(`semantic child failed (${exit}): ${stderr || stdout}`);
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

test("A15.2 an ordinary vault fails closed without packaged resources", async () => {
  const env = { ...process.env, PYLOS_SEMANTIC_RESOURCES: undefined };
  const result = await child(
    `
      import { mkdtempSync, rmSync } from "node:fs";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      const core = await import(${JSON.stringify(CORE_URL)});
      const home = mkdtempSync(join(tmpdir(), "pylos-semantic-off-"));
      const vault = core.openVault({ home, fast: true });
      const thread = vault.threads.create("off");
      vault.episodes.append(thread.id, { role: "user", content: "The tea tasted smoky after the rain." });
      const asking = vault.episodes.append(thread.id, { role: "user", content: "What flavor followed the storm?" });
      const packet = core.compile(vault, thread.id, { query: asking.content, turnSeq: asking.seq });
      console.log(JSON.stringify({ status: packet.semantic?.status, hits: packet.pages.filter((p) => p.trigger === "semantic" && p.resolved).length }));
      vault.close();
      rmSync(home, { recursive: true, force: true });
    `,
    env,
  );
  expect(result).toEqual({ status: "unavailable", hits: 0 });
});

test("A15.2 the packaged Vault route pages a noun-free paraphrase and forget removes its vector", async () => {
  if (LOCAL_RESOURCES === undefined) return;
  const result = await child(
    `
      import { mkdtempSync, rmSync } from "node:fs";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      const core = await import(${JSON.stringify(CORE_URL)});
      const home = mkdtempSync(join(tmpdir(), "pylos-semantic-on-"));
      const vault = core.openVault({ home, fast: true });
      const thread = vault.threads.create("on", { budget: 8192 });
      const source = vault.episodes.append(thread.id, { role: "user", content: "The tea tasted smoky after the rain." });
      vault.episodes.append(thread.id, { role: "user", content: "A brass hinge was catalogued beside the eastern window." });
      const asking = vault.episodes.append(thread.id, { role: "user", content: "What flavor followed the storm?" });
      const packet = core.compile(vault, thread.id, { query: asking.content, turnSeq: asking.seq, budget: 8192 });
      const page = packet.pages.find((candidate) => candidate.trigger === "semantic" && candidate.resolved && candidate.seqs.includes(source.seq));
      const before = {
        status: packet.semantic?.status,
        modelDigest: packet.semantic?.modelDigest,
        source: page?.seqs[0],
        exact: core.packetText(packet.messages).includes(source.content),
        lexicalSource: packet.pages.some((candidate) => candidate.trigger === "search" && candidate.seqs.includes(source.seq)),
      };
      core.forget(vault, thread.id, { seqs: [source.seq], reason: "semantic deletion oracle" });
      const askingAfter = vault.episodes.append(thread.id, { role: "user", content: "What flavor followed the storm?" });
      const afterPacket = core.compile(vault, thread.id, { query: askingAfter.content, turnSeq: askingAfter.seq, budget: 8192 });
      const after = afterPacket.pages.some((candidate) => candidate.resolved && candidate.seqs.includes(source.seq));
      const rows = Number(vault.db.query("SELECT count(*) AS count FROM pylos_semantic_spans WHERE thread_id = ? AND seq = ?").get(thread.id, source.seq).count);
      console.log(JSON.stringify({ before, after, rows }));
      vault.close();
      rmSync(home, { recursive: true, force: true });
    `,
    { ...process.env, PYLOS_SEMANTIC_RESOURCES: LOCAL_RESOURCES },
  );
  expect(result).toEqual({
    before: {
      status: "ready",
      modelDigest: "71f1d177171468fb5f186c07019e303015aea17af275a67767760bba7be8d2e6",
      source: 1,
      exact: true,
      lexicalSource: false,
    },
    after: false,
    rows: 0,
  });
});

test("A15.2 an existing archive backfills in bounded visible steps before claiming readiness", async () => {
  if (LOCAL_RESOURCES === undefined) return;
  const home = mkdtempSync(join(tmpdir(), "pylos-semantic-backfill-"));
  try {
    await child(
      `
        const core = await import(${JSON.stringify(CORE_URL)});
        const vault = core.openVault({ home: ${JSON.stringify(home)}, fast: true });
        const thread = vault.threads.create("backfill", { budget: 8192 });
        for (let seq = 1; seq <= 130; seq += 1) {
          vault.episodes.append(thread.id, {
            role: "user",
            content: seq === 120
              ? "The tea tasted smoky after the rain."
              : "Archive filler " + seq + " records an unrelated brass inventory line.",
          });
        }
        console.log(JSON.stringify({ head: vault.threads.get(thread.id).headSeq }));
        vault.close();
      `,
      { ...process.env, PYLOS_SEMANTIC_RESOURCES: undefined },
    );
    const result = await child(
      `
        const core = await import(${JSON.stringify(CORE_URL)});
        const vault = core.openVault({ home: ${JSON.stringify(home)}, fast: true });
        const thread = vault.threads.list()[0];
        const observed = [];
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const asking = vault.episodes.append(thread.id, { role: "user", content: "What flavor followed the storm?" });
          const packet = core.compile(vault, thread.id, { query: asking.content, turnSeq: asking.seq, budget: 8192 });
          observed.push({
            status: packet.semantic?.status,
            source: packet.pages.some((page) => page.trigger === "semantic" && page.resolved && page.seqs.includes(120)),
          });
        }
        const generation = vault.db.query("SELECT watermark_seq, gaps FROM semantic_generation WHERE thread_id = ?").get(thread.id);
        console.log(JSON.stringify({ observed, generation }));
        vault.close();
      `,
      { ...process.env, PYLOS_SEMANTIC_RESOURCES: LOCAL_RESOURCES },
    );
    expect(result).toEqual({
      observed: [
        { status: "incomplete", source: false },
        { status: "incomplete", source: true },
        { status: "ready", source: true },
      ],
      generation: { watermark_seq: 133, gaps: 0 },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
