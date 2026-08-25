import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as core from "../src/index.ts";
import { cleanup, tempVault } from "./helpers.ts";

afterAll(cleanup);

test("multi-file append stages all objects and removes them on a precommit exception", () => {
  const { vault, thread } = tempVault();
  const first = new TextEncoder().encode("first attachment survives only if the transaction commits");
  const second = new TextEncoder().encode("second attachment must never become an orphan");
  expect(() =>
    vault.episodes.appendMany(thread.id, [
      {
        role: "attachment",
        content: "first.txt",
        blob: { bytes: first, mime: "text/plain", name: "first.txt" },
      },
      {
        role: "attachment",
        // Exercise an exception after both whole/span objects have been
        // staged, before SQLite can publish either episode.
        content: undefined as unknown as string,
        blob: { bytes: second, mime: "text/plain", name: "second.txt" },
      },
    ]),
  ).toThrow();
  expect(vault.episodes.count(thread.id)).toBe(0);
  expect(vault.blobs.list()).toEqual([]);
  expect(readdirSync(vault.objectsDir)).toEqual([]);
});

test("append rejects corrupt, stale, and symlink canonical objects before publishing rows", () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode("canonical object validation fixture");
  const hash = core.sha256(bytes);
  const path = join(vault.objectsDir, hash);

  writeFileSync(path, "wrong bytes", { mode: 0o600 });
  expect(() =>
    vault.episodes.append(thread.id, {
      role: "attachment",
      content: "corrupt.txt",
      blob: { bytes, mime: "text/plain", name: "corrupt.txt" },
    }),
  ).toThrow();
  expect(vault.episodes.count(thread.id)).toBe(0);
  rmSync(path);

  const target = join(vault.home, "symlink-target");
  writeFileSync(target, bytes, { mode: 0o600 });
  symlinkSync(target, path);
  expect(existsSync(path)).toBe(true);
  expect(() =>
    vault.episodes.append(thread.id, {
      role: "attachment",
      content: "symlink.txt",
      blob: { bytes, mime: "text/plain", name: "symlink.txt" },
    }),
  ).toThrow();
  expect(vault.episodes.count(thread.id)).toBe(0);
  expect(vault.blobs.list()).toEqual([]);
});

test("attachment metadata is bounded before chain or blob publication and normal files round-trip", async () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode("metadata boundary fixture");
  const giant = "名".repeat(550_000);
  const before = vault.threads.get(thread.id);
  expect(() =>
    vault.episodes.append(thread.id, {
      role: "attachment",
      content: "giant filename",
      blob: { bytes, mime: "text/plain", name: giant },
    }),
  ).toThrow();
  expect(() =>
    vault.episodes.append(thread.id, {
      role: "attachment",
      content: "giant MIME",
      blob: { bytes, mime: giant, name: "small.txt" },
    }),
  ).toThrow();
  expect(vault.episodes.count(thread.id)).toBe(0);
  expect(vault.threads.get(thread.id)?.headSeq).toBe(before?.headSeq);
  expect(vault.threads.get(thread.id)?.headHash).toBe(before?.headHash);
  expect(vault.blobs.list()).toEqual([]);

  const normal = vault.episodes.append(thread.id, {
    role: "attachment",
    content: new TextDecoder().decode(bytes),
    blob: { bytes, mime: "text/plain", name: "round-trip.txt" },
  });
  const bundle = await core.exportBundle(vault, thread.id, { passphrase: "correct horse battery" });
  const target = tempVault().vault;
  const imported = await core.importBundle(target, bundle, { passphrase: "correct horse battery" });
  expect(imported.verified).toBe(true);
  expect(core.verify(target, imported.threadId, { full: true }).ok).toBe(true);
  expect(target.episodes.get(imported.threadId, normal.seq)?.meta.name).toBe("round-trip.txt");
});

test("attachment name index survives import and is removed by forget", async () => {
  const source = tempVault();
  const bytes = new TextEncoder().encode("indexed import target");
  source.vault.episodes.append(source.thread.id, {
    role: "attachment",
    content: new TextDecoder().decode(bytes),
    blob: { bytes, mime: "text/plain", name: "import-indexed.txt" },
  });
  const bundle = await core.exportBundle(source.vault, source.thread.id, {
    passphrase: "correct horse battery",
  });
  const target = tempVault().vault;
  const imported = await core.importBundle(target, bundle, { passphrase: "correct horse battery" });
  const question = target.episodes.append(imported.threadId, {
    role: "user",
    content: "What is in the final tail of import-indexed.txt?",
  });
  const packet = core.compile(target, imported.threadId, {
    turnSeq: question.seq,
    query: question.content,
    budget: 2048,
  });
  expect(packet.pages.some((page) => page.trigger === "attachment-tail" && page.resolved)).toBe(true);
  core.forget(target, imported.threadId, { seqs: [1], reason: "index removal oracle" });
  expect(
    (
      target.db
        .query("SELECT COUNT(*) AS count FROM attachment_name WHERE thread_id = ?")
        .get(imported.threadId) as {
        count: number;
      }
    ).count,
  ).toBe(0);
});

test("committed multi-file attachments reopen with durable whole and span objects", () => {
  const { vault, thread } = tempVault();
  const first = new TextEncoder().encode(`${"first café row\n".repeat(8_000)}FIRST-DURABLE-MARKER`);
  const second = new TextEncoder().encode(`${"second café row\n".repeat(8_000)}SECOND-DURABLE-MARKER`);
  const episodes = vault.episodes.appendMany(thread.id, [
    {
      role: "attachment",
      content: new TextDecoder().decode(first),
      blob: { bytes: first, mime: "text/plain", name: "first-durable.txt" },
    },
    {
      role: "attachment",
      content: new TextDecoder().decode(second),
      blob: { bytes: second, mime: "text/plain", name: "second-durable.txt" },
    },
  ]);
  const hashes = episodes.flatMap((episode) => [
    episode.meta.blob as string,
    ...(episode.meta.manifest?.spans.map((span) => span.objectHash) ?? []),
  ]);
  vault.db.close();

  const reopened = core.openVault({ home: vault.home });
  for (const hash of new Set(hashes)) expect(reopened.blobs.get(hash)).not.toBeNull();
  expect(reopened.episodes.count(thread.id)).toBe(2);
  expect(reopened.episodes.get(thread.id, episodes[0]?.seq ?? 0)?.meta.manifest).toBeDefined();
  reopened.db.close();
});

test("nested compile reads verified attachment bytes before outer promotion", () => {
  const { vault, thread } = tempVault({ budget: 2048 });
  const marker = "NESTED_PENDING_TAIL_MARKER";
  const content = `${"nested pending row — café\n".repeat(3_500)}${marker}\n`;
  let attachmentHash: string | undefined;
  let resolved = false;

  vault.tx(() => {
    const attachment = vault.episodes.append(thread.id, {
      role: "attachment",
      content,
      blob: { bytes: new TextEncoder().encode(content), mime: "text/plain", name: "nested-tail.txt" },
    });
    attachmentHash = attachment.meta.blob;
    const question = vault.episodes.append(thread.id, {
      role: "user",
      content: "What is in the final tail of nested-tail.txt?",
    });

    // The outer SQL transaction is still open, so promotion must not have
    // published the canonical object yet. The kernel reader nevertheless has
    // a verified, fsynced pending object available.
    expect(attachmentHash).toBeString();
    if (attachmentHash !== undefined) expect(existsSync(join(vault.objectsDir, attachmentHash))).toBe(false);
    const packet = core.compile(vault, thread.id, {
      turnSeq: question.seq,
      query: question.content,
      budget: 2048,
    });
    const tail = packet.pages.find((page) => page.trigger === "attachment-tail");
    resolved = tail?.resolved === true;
    expect(resolved).toBe(true);
    expect(packet.messages.map((message) => message.content).join("\n")).toContain(marker);
  });

  expect(attachmentHash).toBeString();
  if (attachmentHash !== undefined) expect(existsSync(join(vault.objectsDir, attachmentHash))).toBe(true);
});

test("a failed nested append rolls back its savepoint while outer work commits", () => {
  const { vault, thread } = tempVault();
  const first = new TextEncoder().encode("nested first object");
  const second = new TextEncoder().encode("nested second object");

  vault.tx(() => {
    vault.episodes.append(thread.id, { role: "user", content: "outer work survives" });
    expect(() =>
      vault.episodes.appendMany(thread.id, [
        { role: "attachment", content: "first.txt", blob: { bytes: first, mime: "text/plain" } },
        {
          role: "attachment",
          content: undefined as unknown as string,
          blob: { bytes: second, mime: "text/plain" },
        },
      ]),
    ).toThrow();
    expect(vault.episodes.count(thread.id)).toBe(1);
    expect(vault.blobs.list()).toEqual([]);
    expect(readdirSync(vault.objectsDir)).toEqual([]);
  });

  expect(vault.episodes.count(thread.id)).toBe(1);
  expect(vault.episodes.get(thread.id, 1)?.content).toBe("outer work survives");
  expect(vault.blobs.list()).toEqual([]);
  expect(readdirSync(vault.objectsDir)).toEqual([]);
});

test("a child killed after SQL commit is recovered from durable attachment stages", async () => {
  const { vault, thread } = tempVault();
  const first = new TextEncoder().encode(`${"child first café row\n".repeat(4_000)}CHILD-FIRST`);
  const second = new TextEncoder().encode(`${"child second café row\n".repeat(4_000)}CHILD-SECOND`);
  vault.db.close();

  const coreUrl = new URL("../src/index.ts", import.meta.url).href;
  // The payload literals push this script near a megabyte. Linux caps a single
  // argv string at 128 KiB (MAX_ARG_STRLEN), so `-e` cannot carry it; the child
  // runs from a script file instead.
  const childScript = `
        const { createRequire } = await import("node:module");
        const fs = createRequire(import.meta.url)("node:fs");
        const rename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if (String(from).includes("/.pending/") && String(to).includes("/objects/")) {
            process.kill(process.pid, "SIGKILL");
          }
          return rename(from, to);
        };
        const core = await import(${JSON.stringify(coreUrl)});
        const vault = core.openVault({ home: process.env.PYLOS_HOME });
        vault.episodes.appendMany(process.env.PYLOS_THREAD, [
          { role: "attachment", content: ${JSON.stringify(new TextDecoder().decode(first))},
            blob: { bytes: Uint8Array.from(${JSON.stringify([...first])}), mime: "text/plain", name: "child-first.txt" } },
          { role: "attachment", content: ${JSON.stringify(new TextDecoder().decode(second))},
            blob: { bytes: Uint8Array.from(${JSON.stringify([...second])}), mime: "text/plain", name: "child-second.txt" } },
        ]);
        process.exit(86);
      `;
  const childScriptPath = resolve(vault.home, "crash-child.mjs");
  await Bun.write(childScriptPath, childScript);
  const child = Bun.spawn([process.execPath, "run", childScriptPath], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, PYLOS_HOME: vault.home, PYLOS_THREAD: thread.id },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(child.stderr).text();
  const exit = await child.exited;
  expect(exit, stderr).not.toBe(0);

  const reopened = core.openVault({ home: vault.home });
  expect(reopened.episodes.count(thread.id)).toBe(2);
  const episodes = reopened.episodes.range(thread.id, 1, 2);
  for (const episode of episodes) {
    const whole = episode.meta.blob;
    expect(typeof whole).toBe("string");
    if (typeof whole === "string") expect(reopened.blobs.get(whole)).not.toBeNull();
    for (const span of episode.meta.manifest?.spans ?? []) {
      expect(reopened.blobs.get(span.objectHash)).not.toBeNull();
    }
  }
  expect(readdirSync(reopened.objectsDir).some((name) => name === ".pending")).toBe(false);
  reopened.db.close();
});

test("same-process reopen finishes a marked promotion after postcommit rename failure", async () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode(
    `${"same-process durable row — café\n".repeat(128)}POSTCOMMIT-REOPEN`,
  );
  vault.db.close();

  const coreUrl = new URL("../src/index.ts", import.meta.url).href;
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
        const { createRequire } = await import("node:module");
        const fs = createRequire(import.meta.url)("node:fs");
        const rename = fs.renameSync;
        let injected = false;
        fs.renameSync = (from, to) => {
          if (!injected && String(from).includes("/.pending/") && String(to).includes("/objects/")) {
            injected = true;
            throw new Error("injected postcommit rename failure");
          }
          return rename(from, to);
        };
        const core = await import(${JSON.stringify(coreUrl)});
        const vault = core.openVault({ home: process.env.PYLOS_HOME });
        let failed = false;
        try {
          vault.episodes.append(process.env.PYLOS_THREAD, {
            role: "attachment",
            content: ${JSON.stringify(new TextDecoder().decode(bytes))},
            blob: { bytes: Uint8Array.from(${JSON.stringify([...bytes])}), mime: "text/plain", name: "reopen.txt" },
          });
        } catch (error) {
          if (!String(error).includes("injected postcommit rename failure")) throw error;
          failed = true;
        }
        if (!failed) throw new Error("postcommit failure was not injected");
        vault.db.close();
        const reopened = core.openVault({ home: process.env.PYLOS_HOME });
        const episode = reopened.episodes.get(process.env.PYLOS_THREAD, 1);
        if (episode === null || typeof episode.meta.blob !== "string") throw new Error("committed episode missing");
        const object = reopened.blobs.get(episode.meta.blob);
        if (object === null || new TextDecoder().decode(object) !== ${JSON.stringify(new TextDecoder().decode(bytes))}) {
          throw new Error("same-process reopen did not recover the staged object");
        }
        reopened.db.close();
      `,
    ],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...process.env, PYLOS_HOME: vault.home, PYLOS_THREAD: thread.id },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stderr = await new Response(child.stderr).text();
  const exit = await child.exited;
  expect(exit, stderr).toBe(0);
});

test("attachment manifest never labels bytes beyond the indexed episode prefix", () => {
  const { vault, thread } = tempVault({ budget: 2048 });
  const encoder = new TextEncoder();
  const lines = Array.from({ length: 20_000 }, (_, index) => `indexed row ${index} — café\n`);
  const fullText = lines.join("");
  const indexedText = lines.slice(0, 4_000).join("");
  const bytes = encoder.encode(fullText);
  const indexedBytes = encoder.encode(indexedText);
  expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
  expect(indexedBytes.byteLength).toBeLessThan(bytes.byteLength);

  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    // This is the exact content inserted into episode_fts for this fixture;
    // the remainder is retained only in content-addressed attachment spans.
    content: indexedText,
    blob: { bytes, mime: "text/plain", name: "prefix-capped.txt" },
  });
  const manifest = attachment.meta.manifest;
  expect(manifest).toBeDefined();
  expect(manifest?.spans.length).toBeGreaterThan(2);

  const indexed = manifest?.spans.filter((span) => span.state === "indexed") ?? [];
  const opaque = manifest?.spans.filter((span) => span.state === "opaque") ?? [];
  expect(indexed.length).toBeGreaterThan(0);
  expect(opaque.length).toBeGreaterThan(0);
  expect(indexed.every((span) => span.to <= indexedBytes.byteLength)).toBe(true);
  expect(opaque.some((span) => span.from >= indexedBytes.byteLength)).toBe(true);
  for (const span of indexed) {
    expect(span.hash).toBe(core.sha256(bytes.subarray(span.from, span.to)));
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(span.from, span.to)),
    ).not.toThrow();
  }

  // The turn-time tail route lands on the final opaque span.  It must return a
  // custody receipt, never decode or expose the retained tail text.
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "What is in the final tail of prefix-capped.txt?",
  });
  const packet = core.compile(vault, thread.id, {
    turnSeq: question.seq,
    query: question.content,
    budget: 2048,
  });
  const tail = packet.pages.find((page) => (page as { trigger?: string }).trigger === "attachment-tail") as
    | (Record<string, unknown> & { resolved?: boolean; opaque?: boolean })
    | undefined;
  expect(tail?.resolved).toBe(true);
  expect(tail?.opaque).toBe(true);
  const rendered = packet.messages.map((message) => message.content).join("\n");
  expect(rendered).toMatch(/opaque attachment tail/i);
  expect(rendered).not.toContain("indexed row 19999");
  const opaqueTail = opaque.at(-1);
  expect(opaqueTail).toBeDefined();
  if (opaqueTail !== undefined) {
    expect(
      core.readAttachmentRange(vault, thread.id, attachment.seq, [opaqueTail.from, opaqueTail.to], {
        requireIndexed: true,
      }),
    ).toBeNull();
  }
});

test("a named attachment tail remains routable beyond the recent-view horizon", () => {
  const { vault, thread } = tempVault({ budget: 2048 });
  const marker = "OLD_ATTACHMENT_TAIL_MARKER";
  const content = `old attachment body\n${marker}\n`;
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes: new TextEncoder().encode(content), mime: "text/plain", name: "old-tail.txt" },
  });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: 5_001 }, (_, index) => ({
      role: "user" as const,
      content: `unrelated filler ${index}`,
    })),
  );
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "What is in the final tail of old-tail.txt?",
  });
  const packet = core.compile(vault, thread.id, {
    turnSeq: question.seq,
    query: question.content,
    budget: 2048,
  });
  const tail = packet.pages.find((page) => page.trigger === "attachment-tail");
  expect(tail?.resolved).toBe(true);
  expect(tail?.seqs).toEqual([attachment.seq]);
  expect(packet.messages.map((message) => message.content).join("\n")).toContain(marker);
});

test("attachment tail keyset pagination advances from the oldest returned row", () => {
  const { vault, thread } = tempVault({ budget: 2048 });
  const targetName = "oldest-target.txt";
  const attachmentCount = 300;
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: attachmentCount }, (_, index) => {
      const content = `attachment body ${index}\n`;
      return {
        role: "attachment" as const,
        content,
        blob: {
          bytes: new TextEncoder().encode(content),
          mime: "text/plain",
          name: index === 0 ? targetName : `filler-${index}.txt`,
        },
      };
    }),
  );

  const targetQuestion = vault.episodes.append(thread.id, {
    role: "user",
    content: `What is in the final tail of ${targetName}?`,
  });
  const noMatchQuestion = vault.episodes.append(thread.id, {
    role: "user",
    content: "What is in the final tail of missing-attachment.txt?",
  });
  const db = vault.db as unknown as {
    query: (sql: string, ...args: unknown[]) => unknown;
  };
  const originalQuery = db.query;
  const candidateSql = /FROM episode WHERE thread_id = \? AND role = 'attachment'/u;
  const calls = { target: 0, noMatch: 0 };
  let active: "target" | "noMatch" = "target";
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (!candidateSql.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "all") {
          return (...parameters: unknown[]) => {
            calls[active] += 1;
            const method = Reflect.get(target, property, receiver) as (...values: unknown[]) => unknown;
            return method.apply(target, parameters);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }) as typeof db.query;
  try {
    const targetPacket = core.compile(vault, thread.id, {
      turnSeq: targetQuestion.seq,
      query: targetQuestion.content,
      budget: 2048,
    });
    const targetTail = targetPacket.pages.find((page) => page.trigger === "attachment-tail");
    expect(targetTail?.resolved).toBe(true);
    expect(targetTail?.seqs).toEqual([1]);
    expect(calls.target).toBeLessThanOrEqual(2);

    active = "noMatch";
    const noMatchPacket = core.compile(vault, thread.id, {
      turnSeq: noMatchQuestion.seq,
      query: noMatchQuestion.content,
      budget: 2048,
    });
    expect(noMatchPacket.pages.some((page) => page.trigger === "attachment-tail")).toBe(false);
    expect(calls.noMatch).toBeLessThanOrEqual(2);
  } finally {
    db.query = originalQuery;
  }
});

test("named attachment tail lookup stays bounded for old and missing names", () => {
  const { vault, thread } = tempVault({ budget: 2048 });
  const attachmentCount = 2_048;
  const targetName = "old-indexed-target.txt";
  vault.episodes.append(thread.id, {
    role: "attachment",
    content: "indexed attachment target",
    blob: {
      bytes: new TextEncoder().encode("indexed attachment target"),
      mime: "text/plain",
      name: targetName,
    },
  });
  vault.episodes.appendMany(
    thread.id,
    Array.from({ length: attachmentCount - 1 }, (_, index) => ({
      role: "attachment" as const,
      content: `indexed attachment ${index + 1}`,
      meta: { name: `indexed-filler-${index + 1}.txt` },
    })),
  );
  const targetQuestion = vault.episodes.append(thread.id, {
    role: "user",
    content: `What is in the final tail of ${targetName}?`,
  });
  const missingQuestion = vault.episodes.append(thread.id, {
    role: "user",
    content: "What is in the final tail of never-indexed-target.txt?",
  });
  const db = vault.db as unknown as {
    query: (sql: string, ...args: unknown[]) => unknown;
  };
  const originalQuery = db.query;
  const calls = { target: 0, missing: 0 };
  let active: "target" | "missing" = "target";
  const candidateSql = /FROM episode WHERE thread_id = \? AND role = 'attachment'|FROM attachment_name/u;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    if (!candidateSql.test(sql)) return statement;
    return new Proxy(statement, {
      get(target, property, receiver) {
        if (property === "all") {
          return (...parameters: unknown[]) => {
            calls[active] += 1;
            const method = Reflect.get(target, property, receiver) as (...values: unknown[]) => unknown;
            return method.apply(target, parameters);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }) as typeof db.query;
  try {
    const targetPacket = core.compile(vault, thread.id, {
      turnSeq: targetQuestion.seq,
      query: targetQuestion.content,
      budget: 2048,
    });
    expect(targetPacket.pages.some((page) => page.trigger === "attachment-tail" && page.resolved)).toBe(true);
    expect(calls.target).toBeLessThanOrEqual(2);

    active = "missing";
    const missingPacket = core.compile(vault, thread.id, {
      turnSeq: missingQuestion.seq,
      query: missingQuestion.content,
      budget: 2048,
    });
    expect(missingPacket.pages.some((page) => page.trigger === "attachment-tail")).toBe(false);
    expect(calls.missing).toBeLessThanOrEqual(2);
  } finally {
    db.query = originalQuery;
  }
});

test("a large manifest range read verifies the whole hash without loading the whole object", () => {
  const { vault, thread } = tempVault();
  const marker = "LARGE_IMPORTED_TAIL_MARKER";
  const fullText = `${"bounded attachment row — café\n".repeat(12_000)}${marker}\n`;
  const bytes = new TextEncoder().encode(fullText);
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: fullText,
    blob: { bytes, mime: "text/plain", name: "large-import.txt" },
  });
  const manifest = attachment.meta.manifest;
  expect(manifest?.spans.length).toBeGreaterThan(2);
  const final = manifest?.spans.at(-1);
  expect(final).toBeDefined();
  if (final === undefined) return;

  // A malformed imported locator must fail before any allocation sized by an
  // untrusted range.  The evidence/page cap is one manifest span.
  expect(
    core.readAttachmentRange(vault, thread.id, attachment.seq, [0, core.ATTACHMENT_CHUNK_SIZE + 1]),
  ).toBeNull();
  expect(
    core.readAttachmentRange(vault, thread.id, attachment.seq, [final.from, final.to], {
      requireIndexed: true,
    }),
  ).not.toBeNull();

  const wholeHash = manifest?.hash as string;
  const originalGet = vault.blobs.get.bind(vault.blobs);
  vault.blobs.get = (hash: string) => {
    if (hash === wholeHash) throw new Error("whole attachment object must not be loaded");
    return originalGet(hash);
  };
  try {
    const range = core.readAttachmentRange(vault, thread.id, attachment.seq, [final.from, final.to]);
    expect(range?.byteRange).toEqual([final.from, final.to]);
    expect(range?.bytes).toEqual(bytes.subarray(final.from, final.to));
    expect(new TextDecoder("utf-8", { fatal: true }).decode(range?.bytes)).toContain(marker);
  } finally {
    vault.blobs.get = originalGet;
  }
});

test("a legacy large opaque tail uses size metadata and fixed-buffer verification", () => {
  const { vault, thread } = tempVault();
  const marker = "LEGACY_LARGE_OPAQUE_TAIL_MARKER";
  const bytes = new TextEncoder().encode(`${"legacy row — café\n".repeat(12_000)}${marker}\n`);
  const hash = vault.blobs.put(bytes, "text/plain");
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "legacy-large.txt",
    // Omit `size` to exercise the durable blob index lookup.  This is the v1
    // whole-object shape; it has no manifest and is always opaque.
    meta: { blob: hash, mime: "text/plain", name: "legacy-large.txt" },
  });
  const originalGet = vault.blobs.get.bind(vault.blobs);
  vault.blobs.get = (candidate: string) => {
    if (candidate === hash) throw new Error("legacy whole object must not be loaded");
    return originalGet(candidate);
  };
  try {
    const range = core.readAttachmentRange(vault, thread.id, attachment.seq, [0, 64 * 1024]);
    expect(range?.opaque).toBe(true);
    expect(range?.bytes).toEqual(bytes.subarray(0, 64 * 1024));
    expect(
      core.readAttachmentRange(vault, thread.id, attachment.seq, [0, 64 * 1024], {
        requireIndexed: true,
      }),
    ).toBeNull();

    const question = vault.episodes.append(thread.id, {
      role: "user",
      content: "What is in the tail of legacy-large.txt?",
    });
    const packet = core.compile(vault, thread.id, {
      turnSeq: question.seq,
      query: question.content,
      budget: 2048,
    });
    const tail = packet.pages.find((page) => page.trigger === "attachment-tail");
    expect(tail?.resolved).toBe(true);
    expect(tail?.opaque).toBe(true);
    expect(packet.messages.map((message) => message.content).join("\n")).not.toContain(marker);
  } finally {
    vault.blobs.get = originalGet;
  }
});

test("a persisted attachment address pages a large span without whole-object allocation", async () => {
  const { vault, thread } = tempVault();
  const marker = "PERSISTED_LARGE_TAIL_MARKER";
  const answer = `The final marker is ${marker}.`;
  const content = `${"large persisted row — café\n".repeat(12_000)}${answer}`;
  const bytes = new TextEncoder().encode(content);
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes, mime: "text/plain", name: "persisted-large.txt" },
  });
  const wholeHash = attachment.meta.manifest?.hash as string;
  const question = "What did the final tail of persisted-large.txt say?";
  const provider: core.Provider = async function* (request) {
    const capability = request.evidence?.find(
      (candidate) => candidate.authority === "attachment" && candidate.seq === attachment.seq,
    );
    if (capability === undefined) throw new Error("attachment evidence capability missing");
    yield { type: "delta", text: answer };
    yield {
      type: "tool_call",
      id: "large-attachment-claim-map",
      name: "submit_claim_map",
      arguments: JSON.stringify({
        claims: [{ outputSpan: [0, answer.length], capabilityTokens: [capability.token] }],
      }),
    };
    yield { type: "done" };
  };
  const first = await core.runTurn(vault, thread.id, {
    text: question,
    model: "attachment-oracle",
    provider,
    budget: 8192,
  });
  expect(first.assistantEpisode.meta.answerReceipt?.status).toBe("released");

  const repeated = vault.episodes.append(thread.id, { role: "user", content: question });
  // The route should be blob-bound; this assertion also protects the bounded
  // page oracle from accidentally exercising the episode-text fallback.
  const persistedRoutes = vault.addresses.list(thread.id, question);
  expect(persistedRoutes.some((route) => route.status === "active")).toBe(true);
  const originalGet = vault.blobs.get.bind(vault.blobs);
  vault.blobs.get = (hash: string) => {
    if (hash === wholeHash) throw new Error("whole attachment object must not be loaded during page");
    return originalGet(hash);
  };
  try {
    const packet = core.compile(vault, thread.id, {
      turnSeq: repeated.seq,
      query: question,
      budget: 8192,
    });
    expect(packet.pages.some((page) => page.trigger === "address" && page.resolved)).toBe(true);
    expect(packet.messages.map((message) => message.content).join("\n")).toContain(marker);
  } finally {
    vault.blobs.get = originalGet;
  }
});
