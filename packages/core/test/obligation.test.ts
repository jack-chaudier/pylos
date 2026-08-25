import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import type { Atom, AttachmentManifest, CoverageReceipt, Episode, Packet, PageRecord } from "@pylos/protocol";
import { canonicalHash } from "../src/hash.ts";
import {
  ATTACHMENT_CHUNK_SIZE,
  atomize,
  chainHash,
  chainRecord,
  compact,
  coverageFor,
  manifestDigestOf,
  metaHashOf,
  type Provider,
  renderCoverage,
  runTurn,
  verify,
} from "../src/index.ts";
import { cleanup, rng, syntheticTurn, tempVault } from "./helpers.ts";

afterAll(cleanup);

function coverageOf(result: { packet: Packet; assistantEpisode: Episode }): CoverageReceipt {
  const packet = result.packet;
  expect(packet.coverage).toBeDefined();
  expect(result.assistantEpisode.meta.coverage).toEqual(packet.coverage);
  return packet.coverage as CoverageReceipt;
}

function providerReply(text: string): Provider {
  return async function* () {
    yield { type: "delta", text };
    yield { type: "done" };
  };
}

/**
 * Build an authenticated imported/legacy-shaped attachment fixture whose
 * manifest has many small indexed spans without making the episode content
 * exceed the capsule-source write cap.  The production append path still
 * rejects oversized episode sources; this helper exercises the read-time
 * span-cap oracle against a structurally valid chain row instead.
 */
function rebindAttachmentWithManyIndexedSpans(
  vault: ReturnType<typeof tempVault>["vault"],
  threadId: string,
  episode: Episode,
  bytes: Uint8Array,
): Episode {
  const manifest = episode.meta.manifest;
  if (manifest === undefined || typeof episode.meta.blob !== "string") {
    throw new Error("attachment manifest fixture");
  }
  const spans = Array.from({ length: bytes.byteLength }, (_, ordinal) => {
    const objectHash = vault.blobs.put(bytes.slice(ordinal, ordinal + 1), "text/plain");
    return {
      ordinal,
      from: ordinal,
      to: ordinal + 1,
      hash: objectHash,
      state: "indexed" as const,
      objectHash,
      encoding: "utf-8" as const,
    };
  });
  const replacement: AttachmentManifest = {
    ...manifest,
    // Keep the production chunk-size declaration; the imported partition is
    // valid while deliberately containing >256 independently addressed spans.
    chunkSize: ATTACHMENT_CHUNK_SIZE,
    size: bytes.byteLength,
    spans,
    digest: "",
  };
  replacement.digest = manifestDigestOf(replacement);
  const meta = { ...episode.meta, size: bytes.byteLength, manifest: replacement };
  const raw = vault.db
    .query(
      "SELECT ts, role, model, provider, prev_hash, content_hash FROM episode WHERE thread_id = ? AND seq = ?",
    )
    .get(threadId, episode.seq) as {
    ts: number;
    role: string;
    model: string | null;
    provider: string | null;
    prev_hash: string;
    content_hash: string;
  } | null;
  if (raw === null) throw new Error("attachment fixture row disappeared");
  const hash = chainHash(
    raw.prev_hash,
    chainRecord({
      seq: episode.seq,
      ts: raw.ts,
      role: raw.role,
      ...(raw.model === null ? {} : { model: raw.model }),
      ...(raw.provider === null ? {} : { provider: raw.provider }),
      contentHash: raw.content_hash,
      metaHash: metaHashOf(meta),
    }),
  );
  vault.db
    .query("UPDATE episode SET meta = ?, hash = ? WHERE thread_id = ? AND seq = ?")
    .run(JSON.stringify(meta), hash, threadId, episode.seq);
  vault.db.query("UPDATE thread SET head_hash = ? WHERE id = ?").run(hash, threadId);
  const rebound = vault.episodes.get(threadId, episode.seq);
  if (rebound === null) throw new Error("attachment fixture reload failed");
  return rebound;
}

function expectBasisIntegrity(coverage: CoverageReceipt): void {
  const basis = coverage.basis;
  expect(basis.version).toBe(1);
  expect(basis.queryContentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(basis.initialPagesDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(basis.locatorDigests).toEqual([...basis.locatorDigests].sort());
  expect(basis.locatorDigests.length).toBeLessThanOrEqual(1024);
  const locatorDigestSet = new Set(basis.locatorDigests);
  for (const route of Object.values(basis.routeMembers)) {
    expect(route.memberCount).toBeGreaterThanOrEqual(route.members.length);
    expect(route.members.length).toBeLessThanOrEqual(4353);
    expect(route.membersDigest).toBe(
      canonicalHash({
        members: route.members,
        memberCount: route.memberCount,
        overflow: route.overflow,
        outcome: route.outcome,
      }),
    );
    for (const member of route.members) {
      for (const digest of member.locatorDigests) expect(locatorDigestSet.has(digest)).toBe(true);
    }
  }
  const { digest: _digest, ...basisBody } = basis;
  expect(basis.digest).toBe(canonicalHash(basisBody));
}

function seedNotes(count: number): ReturnType<typeof tempVault> {
  const fixture = tempVault({ budget: 1024 });
  for (let i = 1; i <= count; i += 1) {
    fixture.vault.episodes.append(fixture.thread.id, {
      role: "user",
      content: `launch note ${i}: the harbor route is ${i % 2 === 0 ? "green" : "amber"}.`,
    });
  }
  const next = rng(901);
  for (let i = 0; i < 300; i += 1) {
    fixture.vault.episodes.append(fixture.thread.id, {
      role: "user",
      content: syntheticTurn(next, i),
    });
  }
  compact(fixture.vault, fixture.thread.id, { budget: 1024 });
  return fixture;
}

test("system-authored launch notes cannot become supported collection evidence", async () => {
  for (const role of ["system", "handoff"] as const) {
    const { vault, thread } = tempVault();
    const kernelEpisode = vault.episodes.append(thread.id, {
      role,
      content: "Launch note alpha was generated by the kernel.",
    });
    const result = await runTurn(vault, thread.id, {
      text: "List every 1 launch note.",
      model: "oracle",
      provider: providerReply("I found 1 launch note."),
      budget: 8192,
    });
    const coverage = coverageOf(result);
    const kernelRoutes = coverage.routes.filter((route) => route.source === `episode:${kernelEpisode.seq}`);
    expect(kernelRoutes.some((route) => route.authority === "user" && route.status === "supported")).toBe(
      false,
    );
    expect(coverage.completeness).not.toBe("complete");
    expect(result.text).toMatch(/UNKNOWN|unresolved|incomplete/i);
  }
});

test("the asking turn is excluded from names and search route counts", async () => {
  const { vault, thread } = tempVault();
  const result = await runTurn(vault, thread.id, {
    text: "I live in Lisbon. List every 1 Lisbon record.",
    model: "oracle",
    provider: providerReply("I found 0 Lisbon records."),
    budget: 8192,
  });
  const coverage = coverageOf(result);
  expect(coverage.routesRun).toContainEqual(expect.objectContaining({ route: "names", returned: 0 }));
  expect(coverage.routesRun).toContainEqual(expect.objectContaining({ route: "search", returned: 0 }));
  expect(coverage.completeness).toBe("incomplete");
  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok, verified.reason).toBe(true);
});

test("collection search basis stays at its query snapshot after later matching appends", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  vault.episodes.append(thread.id, {
    role: "user",
    content: "The launch note was Oslo.",
  });
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "List every 1 launch note.",
  });
  const before = coverageFor(vault, thread.id, {
    question: question.content,
    querySeq: question.seq,
    routerVersion: "2",
  });
  expect(before).toBeDefined();
  vault.episodes.append(thread.id, {
    role: "user",
    content: "The launch note was Porto.",
  });
  const after = coverageFor(vault, thread.id, {
    question: question.content,
    querySeq: question.seq,
    routerVersion: "2",
  });
  expect(after).toEqual(before);
  expect(after?.routes.some((route) => route.source === "episode:3")).toBe(false);
  expect(after?.basis.routeMembers.search.members.some((member) => member.sourceSeq === 3)).toBe(false);
});

test("valid indexed attachment bytes can support a collection route", async () => {
  const { vault, thread } = tempVault();
  const content = "Launch note alpha was attached.";
  const bytes = new TextEncoder().encode(content);
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes, mime: "text/plain", name: "launch.txt" },
  });
  const result = await runTurn(vault, thread.id, {
    text: "List every 1 launch note.",
    model: "oracle",
    provider: providerReply("I found 1 launch note."),
    budget: 8192,
  });
  const coverage = coverageOf(result);
  const routes = coverage.routes.filter((route) => route.source === `episode:${attachment.seq}`);
  expect(routes.length).toBeGreaterThan(0);
  expect(routes.every((route) => route.authority === "attachment" && route.status === "supported")).toBe(
    true,
  );
  expect(coverage.completeness).toBe("complete");
  expect(result.text).toBe("I found 1 launch note.");
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("coverage verifies a large indexed attachment without hydrating its episode", () => {
  const { vault, thread } = tempVault();
  const content = `Launch note bounded attachment.\n${"indexed bytes ".repeat(8_000)}`;
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes: new TextEncoder().encode(content), mime: "text/plain", name: "bounded.txt" },
  });
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "List every 1 launch note.",
  });
  const episodes = vault.episodes as unknown as { get: (...args: unknown[]) => Episode | null };
  const originalGet = episodes.get;
  episodes.get = () => {
    throw new Error("coverage attachment path must not hydrate full episodes");
  };
  try {
    const coverage = coverageFor(vault, thread.id, {
      question: question.content,
      querySeq: question.seq,
      routerVersion: "2",
    });
    expect(coverage?.routes.some((route) => route.source === `episode:${attachment.seq}`)).toBe(true);
    expect(coverage?.supported).toBe(1);
  } finally {
    episodes.get = originalGet;
  }
});

test("malformed attachment manifest IDs and digests never enter a coverage revision", async () => {
  const { vault, thread } = tempVault();
  const content = "Launch note malformed metadata.";
  const seed = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes: new TextEncoder().encode(content), mime: "text/plain", name: "seed.txt" },
  });
  const manifest = seed.meta.manifest;
  if (manifest === undefined || typeof seed.meta.blob !== "string") throw new Error("manifest fixture");
  const malformed = [
    { id: `${manifest.id}:forged`, digest: manifest.digest },
    { id: "m".repeat(129), digest: manifest.digest },
    { id: manifest.id, digest: "not-a-sha256-digest" },
  ];
  const malformedSeqs: number[] = [];
  for (const [index, values] of malformed.entries()) {
    malformedSeqs.push(
      vault.episodes.append(thread.id, {
        role: "attachment",
        content,
        meta: {
          blob: seed.meta.blob,
          mime: seed.meta.mime,
          name: `malformed-${index}.txt`,
          size: seed.meta.size,
          manifest: { ...manifest, ...values },
        },
      }).seq,
    );
  }
  const result = await runTurn(vault, thread.id, {
    text: "List every launch note.",
    model: "oracle",
    provider: providerReply("I found 1 launch note."),
    budget: 8192,
  });
  const coverage = coverageOf(result);
  expect(coverage.routesRun).toContainEqual(
    expect.objectContaining({ route: "search", status: "unresolved" }),
  );
  expect(coverage.completeness).not.toBe("complete");
  for (const seq of malformedSeqs) {
    expect(coverage.routes.some((route) => route.source === `episode:${seq}`)).toBe(false);
  }
  // The malformed source is still in the append-only chain, and a full audit
  // can preserve it only because the route-level unresolved receipt is
  // explicit; it must never be certified as a byte witness.
  const verified = verify(vault, thread.id, { full: true });
  expect(verified.ok, verified.reason).toBe(true);
});

test("a multi-span attachment counts as one exact collection source", () => {
  const { vault, thread } = tempVault();
  const content = `Launch note alpha was attached.\n${"indexed attachment filler ".repeat(4_000)}`;
  const bytes = new TextEncoder().encode(content);
  expect(bytes.byteLength).toBeGreaterThan(ATTACHMENT_CHUNK_SIZE);
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes, mime: "text/plain", name: "multi-span.txt" },
  });
  expect(attachment.meta.manifest?.spans.filter((span) => span.state === "indexed").length).toBeGreaterThan(
    1,
  );
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "List every 1 launch note.",
  });
  const coverage = coverageFor(vault, thread.id, {
    question: question.content,
    querySeq: question.seq,
    routerVersion: "2",
  });
  expect(coverage).toBeDefined();
  const routes = coverage?.routes.filter((route) => route.source === `episode:${attachment.seq}`) ?? [];
  expect(routes).toHaveLength(1);
  expect(routes[0]?.status).toBe("supported");
  expect(routes[0]?.authority).toBe("attachment");
  expect((routes[0]?.byteRange[1] ?? 0) - (routes[0]?.byteRange[0] ?? 0)).toBeLessThanOrEqual(
    ATTACHMENT_CHUNK_SIZE,
  );
  expect(coverage?.located).toBe(1);
  expect(coverage?.supported).toBe(1);
  expect(coverage?.completeness).toBe("complete");
});

test("an attachment span overflow is an explicit unresolved sentinel", async () => {
  const { vault, thread } = tempVault();
  // The obligation cap is intentionally lower than this manifest's indexed
  // span count.  This exercises the +1 sentinel without hydrating all spans
  // into coverage locators or reading their objects.
  // Keep the inline source small enough for the production capsule-source
  // cap; the raw/authenticated manifest below supplies the adversarial span
  // cardinality independently.
  const content = `Launch note overflow.\n${"x".repeat(236)}`;
  const bytes = new TextEncoder().encode(content);
  const appended = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes, mime: "text/plain", name: "overflow.txt" },
  });
  const attachment = rebindAttachmentWithManyIndexedSpans(vault, thread.id, appended, bytes);
  expect(attachment.meta.manifest?.spans.filter((span) => span.state === "indexed").length).toBeGreaterThan(
    256,
  );
  const result = await runTurn(vault, thread.id, {
    text: "List every 1 launch note.",
    model: "oracle",
    provider: providerReply("I found 1 launch note."),
    budget: 8192,
  });
  const coverage = coverageOf(result);
  const routes = coverage?.routes.filter((route) => route.source === `episode:${attachment.seq}`) ?? [];
  expect(routes).toHaveLength(1);
  expect(routes[0]?.status).toBe("unresolved");
  expect(coverage?.supported).toBe(0);
  expect(coverage?.completeness).toBe("incomplete");
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test(
  "high-hit attachment collection is bounded with an explicit overflow route",
  () => {
    const { vault, thread } = tempVault();
    const sources: Episode[] = [];
    const bytesBySource = new TextEncoder();
    for (let index = 0; index < 1_030; index += 1) {
      const content = `Launch note ${index} was retained.`;
      sources.push(
        vault.episodes.append(thread.id, {
          role: "attachment",
          content,
          blob: { bytes: bytesBySource.encode(content), mime: "text/plain", name: `note-${index}.txt` },
        }),
      );
    }
    const question = vault.episodes.append(thread.id, {
      role: "user",
      content: "List every 1030 launch notes.",
    });
    const coverage = coverageFor(vault, thread.id, {
      question: question.content,
      querySeq: question.seq,
      pages: [
        {
          trigger: "search",
          seqs: sources.map((source) => source.seq),
          tokens: 1,
          latencyMs: 0,
          resolved: true,
        },
      ],
      routerVersion: "2",
    });
    expect(coverage).toBeDefined();
    expect(coverage?.routes.length).toBeLessThanOrEqual(1_024);
    expect(coverage?.routesRun).toContainEqual(
      expect.objectContaining({ route: "search", status: "unresolved" }),
    );
    expect(coverage?.completeness).toBe("incomplete");
  },
  { timeout: 30_000 },
);

test(
  "coverage routes giant imported sources through scalar projections",
  () => {
    const { vault, thread } = tempVault({ budget: 1024 });
    const giantTail = "x".repeat(512 * 1024);
    const sources = Array.from({ length: 8 }, (_, index) =>
      vault.episodes.append(thread.id, {
        role: "user",
        content: `launch note ${index} was retained. ${giantTail}`,
      }),
    );
    const question = vault.episodes.append(thread.id, {
      role: "user",
      content: "List every 8 launch notes.",
    });
    const episodes = vault.episodes as unknown as {
      get: (...args: unknown[]) => Episode | null;
      search: (...args: unknown[]) => Episode[];
    };
    const originalGet = episodes.get;
    const originalSearch = episodes.search;
    episodes.get = () => {
      throw new Error("coverage must not hydrate full episodes");
    };
    episodes.search = () => {
      throw new Error("coverage must use bounded search projection");
    };
    try {
      const coverage = coverageFor(vault, thread.id, {
        question: question.content,
        querySeq: question.seq,
        routerVersion: "2",
      });
      expect(coverage?.supported).toBe(sources.length);
      expect(coverage?.located).toBe(sources.length);
      expect(coverage?.completeness).toBe("complete");
      expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
    } finally {
      episodes.get = originalGet;
      episodes.search = originalSearch;
    }
  },
  { timeout: 30_000 },
);

test(
  "global coverage locator cap stops atom expansion after the +1 source",
  () => {
    const { vault, thread } = tempVault();
    const sources: Episode[] = [];
    for (let index = 0; index < 1_024; index += 1) {
      const source = vault.episodes.append(thread.id, {
        role: "user",
        content: `launch note ${index} was retained.`,
      });
      sources.push(source);
      for (let atomIndex = 0; atomIndex < 2; atomIndex += 1) {
        vault.db
          .query(
            "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
              "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
              "VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, ?, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'coverage-global-cap-oracle', ?)",
          )
          .run(
            `coverage-global-atom-${index}-${atomIndex}`,
            thread.id,
            `coverage.global.${index}.${atomIndex}`,
            atomIndex === 0 ? "launch" : "note",
            atomIndex === 0 ? "launch" : "note",
            source.seq,
            JSON.stringify(atomIndex === 0 ? [0, 6] : [7, 11]),
            source.seq,
            index * 2 + atomIndex,
          );
      }
    }
    const question = vault.episodes.append(thread.id, {
      role: "user",
      content: "List every 1024 launch notes.",
    });
    const coverage = coverageFor(vault, thread.id, {
      question: question.content,
      querySeq: question.seq,
      pages: [
        {
          trigger: "search",
          seqs: sources.map((source) => source.seq),
          tokens: 1,
          latencyMs: 0,
          resolved: true,
        },
      ],
      routerVersion: "2",
    });
    expect(coverage).toBeDefined();
    expect(coverage?.routes.length).toBeLessThanOrEqual(1_024);
    expect(coverage?.routesRun).toContainEqual(
      expect.objectContaining({ route: "pages", status: "unresolved" }),
    );
    expect(coverage?.routesRun).toContainEqual(
      expect.objectContaining({ route: "search", status: "unresolved" }),
    );
    expect(coverage?.completeness).toBe("incomplete");
  },
  { timeout: 30_000 },
);

test("missing or tampered attachment bytes remain unresolved collection evidence", async () => {
  for (const mode of ["missing", "tampered"] as const) {
    const { vault, thread } = tempVault();
    const content = "Launch note alpha was attached.";
    const bytes = new TextEncoder().encode(content);
    const attachment = vault.episodes.append(thread.id, {
      role: "attachment",
      content,
      blob: { bytes, mime: "text/plain", name: "launch.txt" },
    });
    const blob = attachment.meta.blob;
    expect(blob).toBeDefined();
    const path = vault.blobObjectPath(blob as string, bytes.byteLength);
    expect(path).not.toBeNull();
    if (mode === "missing") rmSync(path as string);
    else writeFileSync(path as string, new Uint8Array(bytes.byteLength).fill(0x5a));
    const result = await runTurn(vault, thread.id, {
      text: "List every 1 launch note.",
      model: "oracle",
      provider: providerReply("I found 1 launch note."),
      budget: 8192,
    });
    const coverage = coverageOf(result);
    const routes = coverage.routes.filter((route) => route.source === `episode:${attachment.seq}`);
    expect(routes.some((route) => route.status === "supported")).toBe(false);
    expect(routes.some((route) => route.status === "unresolved")).toBe(true);
    expect(coverage.completeness).not.toBe("complete");
    expect(result.text).toMatch(/UNKNOWN|unresolved|incomplete/i);
    const verified = verify(vault, thread.id, { full: true });
    expect(verified.ok, verified.reason).toBe(true);
  }
});

test("opaque attachment text cannot support a collection route", async () => {
  const { vault, thread } = tempVault();
  const content = "Launch note alpha was extracted from the attachment.";
  const bytes = new TextEncoder().encode("opaque bytes with no indexed prefix");
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content,
    blob: { bytes, mime: "text/plain", name: "launch.txt" },
  });
  const result = await runTurn(vault, thread.id, {
    text: "List every 1 launch note.",
    model: "oracle",
    provider: providerReply("I found 1 launch note."),
    budget: 8192,
  });
  const coverage = coverageOf(result);
  const routes = coverage.routes.filter((route) => route.source === `episode:${attachment.seq}`);
  expect(routes.some((route) => route.status === "supported")).toBe(false);
  expect(routes.some((route) => route.status === "unresolved")).toBe(true);
  expect(coverage.completeness).not.toBe("complete");
  expect(result.text).toMatch(/UNKNOWN|unresolved|incomplete/i);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("an indexed attachment prefix cannot witness an unbacked inline suffix", async () => {
  const { vault, thread } = tempVault();
  const bytes = new TextEncoder().encode("safe prefix ");
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "safe prefix Launch note phantom.",
    blob: { bytes, mime: "text/plain", name: "prefix-only.txt" },
  });
  const result = await runTurn(vault, thread.id, {
    text: "List every 1 launch note.",
    model: "oracle",
    provider: providerReply("I found 1 launch note."),
    budget: 8192,
  });
  const coverage = coverageOf(result);
  const routes = coverage.routes.filter((route) => route.source === `episode:${attachment.seq}`);
  expect(routes.some((route) => route.status === "supported")).toBe(false);
  expect(routes.some((route) => route.status === "unresolved")).toBe(true);
  expect(coverage.completeness).toBe("incomplete");
  expect(
    Object.values(coverage.basis.routeMembers).some((route) =>
      route.members.some((member) => member.sourceSeq === attachment.seq && member.outcome === "unresolved"),
    ),
  ).toBe(true);
  expectBasisIntegrity(coverage);
  expect(result.text).toMatch(/UNKNOWN|unresolved|incomplete/i);
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("an empty attachment uses a route-level unresolved status without a zero range", async () => {
  const { vault, thread } = tempVault();
  const attachment = vault.episodes.append(thread.id, {
    role: "attachment",
    content: "Launch note empty attachment.",
    blob: { bytes: new Uint8Array(0), mime: "text/plain", name: "empty.txt" },
  });
  const result = await runTurn(vault, thread.id, {
    text: "List every 1 launch note.",
    model: "oracle",
    provider: providerReply("I found 1 launch note."),
    budget: 8192,
  });
  const coverage = coverageOf(result);
  expect(coverage.routes.some((route) => route.source === `episode:${attachment.seq}`)).toBe(false);
  expect(coverage.routesRun).toContainEqual(
    expect.objectContaining({ route: "search", status: "unresolved" }),
  );
  expect(coverage.unresolved).toBe(1);
  expect(coverage.completeness).toBe("incomplete");
  expect(verify(vault, thread.id, { full: true }).ok).toBe(true);
});

test("whole-word collection cues create one coverage receipt before routing", async () => {
  for (const cue of ["all", "every", "compare", "list", "each"] as const) {
    const { vault, thread } = tempVault();
    const result = await runTurn(vault, thread.id, {
      text: `${cue} launch notes`,
      model: "oracle",
      provider: providerReply("I found the launch note."),
      budget: 8192,
    });
    const coverage = coverageOf(result);
    expect(coverage.cue).toBe(cue);
    expect(coverage.querySeq).toBe(result.userEpisode.seq);
    expect(coverage.asOfSeq).toBe(result.userEpisode.seq);
    expect(coverage.routerVersion).toBe("2");
    expect(coverage.routesRun).toEqual([
      expect.objectContaining({ route: "names" }),
      expect.objectContaining({ route: "pages" }),
      expect.objectContaining({ route: "search" }),
    ]);
    expect(coverage.routes).toBeArray();
    expect(coverage.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(coverage.basis.initialPagesDigest).toBe(canonicalHash(result.packet.pages));
    expectBasisIntegrity(coverage);
  }
});

test("empty collection routes still carry a closed issuance basis", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "List every launch note about the nonexistent harbor.",
  });
  const coverage = coverageFor(vault, thread.id, {
    question: question.content,
    querySeq: question.seq,
    pages: [],
    routerVersion: "2",
  });
  expect(coverage).toBeDefined();
  expectBasisIntegrity(coverage as CoverageReceipt);
  const basis = (coverage as CoverageReceipt).basis;
  expect(basis.routeMembers.search.memberCount).toBe(0);
  expect(basis.routeMembers.search.members).toEqual([]);
  expect(basis.routeMembers.search.outcome).toMatchObject({ route: "search", status: "empty" });
});

test("cue parser has no substring false positives and no-cue questions have no receipt", async () => {
  for (const question of ["Tell me about the smallest launch note", "A listing is useful here"]) {
    const { vault, thread } = tempVault();
    const result = await runTurn(vault, thread.id, {
      text: question,
      model: "oracle",
      provider: providerReply("The launch note is in the archive."),
      budget: 8192,
    });
    expect(result.packet.coverage).toBeUndefined();
    expect(result.assistantEpisode.meta.coverage).toBeUndefined();
  }
});

test("unknown cardinality is never inferred, including an empty result", async () => {
  const { vault, thread } = tempVault();
  const result = await runTurn(vault, thread.id, {
    text: "List every launch note about the nonexistent harbor",
    model: "oracle",
    provider: providerReply("I found 0 launch notes."),
    budget: 8192,
  });
  const coverage = coverageOf(result);
  expect(coverage).not.toHaveProperty("required");
  expect(coverage.located).toBe(0);
  expect(coverage.supported).toBe(0);
  expect(coverage.historical).toBe(0);
  expect(coverage.unresolved ?? 0).toBe(0);
  expect(coverage.completeness).toBe("not-established");
  expect(result.text).toContain("I found 0");
  expect(result.text.toLowerCase()).not.toContain("there were 0");
});

test("an explicit cardinality is copied from the question, never from provider prose", async () => {
  const { vault, thread } = tempVault();
  const result = await runTurn(vault, thread.id, {
    text: "List all 11 launch notes in the archive",
    model: "oracle",
    provider: providerReply("There were 3 launch notes."),
    budget: 8192,
  });
  const coverage = coverageOf(result);
  expect(coverage.required).toBe(11);
  expect(result.text.toLowerCase()).not.toContain("there were 3");
  expect(result.text).toContain("I found 3");
});

test("partial known collection reports 10 located of 11 and remains incomplete", async () => {
  const { vault, thread } = seedNotes(10);
  const names = Array.from({ length: 11 }, (_, i) => `launch note ${i + 1}`).join(", ");
  const result = await runTurn(vault, thread.id, {
    text: `List all 11 launch notes: ${names}.`,
    model: "oracle",
    provider: providerReply("I found 10 launch notes."),
    budget: 1024,
  });
  const coverage = coverageOf(result);
  expect(coverage.required).toBe(11);
  expect(coverage.located).toBe(10);
  expect(coverage.supported).toBe(10);
  expect(coverage.historical).toBe(0);
  expect(coverage.unresolved).toBe(1);
  expect(coverage.completeness).toBe("incomplete");
  expect(result.text).toContain("I found 10");
  expect(result.text.toLowerCase()).not.toContain("there were 10");
});

test("known cardinality rejects excess supported hits instead of certifying an exact total", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const sources = Array.from({ length: 6 }, (_, index) =>
    vault.episodes.append(thread.id, {
      role: "user",
      content: `launch note ${index + 1}: harbor route ${index % 2 === 0 ? "green" : "amber"}.`,
    }),
  );
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "List all 5 launch notes.",
  });
  const coverage = coverageFor(vault, thread.id, {
    question: question.content,
    querySeq: question.seq,
    routerVersion: "2",
  });
  expect(coverage).toBeDefined();
  expect(coverage?.required).toBe(5);
  expect(coverage?.supported).toBe(6);
  expect(coverage?.unresolved).toBe(0);
  expect(coverage?.completeness).toBe("incomplete");
  expect(coverage?.routesRun.find((run) => run.route === "search")).toMatchObject({
    returned: sources.length,
    status: "complete",
  });
});

test("a proposed extra locator prevents exact known-cardinality completion", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  vault.episodes.append(thread.id, {
    role: "user",
    content: "launch note 1: harbor route.",
  });
  vault.episodes.append(thread.id, {
    role: "assistant",
    content: "launch note draft: harbor route.",
  });
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "List all 1 launch note.",
  });
  const coverage = coverageFor(vault, thread.id, {
    question: question.content,
    querySeq: question.seq,
    routerVersion: "2",
  });
  expect(coverage?.located).toBe(2);
  expect(coverage?.supported).toBe(1);
  expect(coverage?.completeness).toBe("incomplete");
});

test("name-route overflow is an explicit unresolved outcome, never a complete exact list", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  for (let index = 0; index < 17; index += 1) {
    const source = vault.episodes.append(thread.id, {
      role: "user",
      content: `Launch note ${index + 1}: harbor route.`,
    });
    const atom: Atom = {
      id: `obligation-name-cap-${index}`,
      threadId: thread.id,
      kind: "fact",
      key: "launch",
      value: "Launch",
      text: "Launch",
      sourceSeq: source.seq,
      sourceSpan: [0, 6],
      validFromSeq: source.seq,
      phase: "SUPPORTED",
      authority: "user",
      scope: "global",
      pinned: false,
      confidence: 1,
      createdBy: "obligation-name-cap-oracle",
      createdAt: index,
    };
    vault.atoms.insert(atom);
  }
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "List all 16 launch notes: Launch.",
  });
  const coverage = coverageFor(vault, thread.id, {
    question: question.content,
    querySeq: question.seq,
    routerVersion: "2",
  });
  expect(coverage?.routesRun.find((run) => run.route === "names")).toMatchObject({
    returned: 17,
    status: "unresolved",
  });
  expect(coverage?.completeness).toBe("incomplete");
});

test("FTS overflow is an explicit unresolved outcome, never a silently truncated exact list", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  for (let index = 0; index < 1025; index += 1) {
    vault.episodes.append(thread.id, {
      role: "user",
      content: `launch note ${index + 1}: harbor route.`,
    });
  }
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "List all 1024 launch notes.",
  });
  const coverage = coverageFor(vault, thread.id, {
    question: question.content,
    querySeq: question.seq,
    routerVersion: "2",
  });
  expect(coverage?.routesRun.find((run) => run.route === "search")).toMatchObject({
    returned: 1025,
    status: "unresolved",
  });
  const searchBasis = coverage?.basis.routeMembers.search;
  expect(searchBasis?.memberCount).toBe(257);
  expect(searchBasis?.members.at(-1)?.kind).toBe("sentinel");
  expect(searchBasis?.members.length).toBe(257);
  expect(searchBasis?.overflow).toBe(false);
  expect(coverage?.completeness).toBe("incomplete");
});

test("page basis bounds empty unresolved records with one explicit sentinel", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "List every launch note.",
  });
  const pages: PageRecord[] = Array.from({ length: 2_048 }, (_, index) => ({
    trigger: "search",
    seqs: [],
    tokens: 0,
    latencyMs: 0,
    resolved: false,
    routeId: `empty-page-${index}`,
  }));
  const coverage = coverageFor(vault, thread.id, {
    question: question.content,
    querySeq: question.seq,
    pages,
    routerVersion: "2",
  });
  expect(coverage).toBeDefined();
  const pageBasis = (coverage as CoverageReceipt).basis.routeMembers.pages;
  expect(pageBasis.memberCount).toBe(257);
  expect(pageBasis.members.length).toBe(257);
  expect(pageBasis.members.at(-1)?.kind).toBe("sentinel");
  expect(pageBasis.members.at(-1)?.key).toBe("__page-overflow__");
  expect(pageBasis.overflow).toBe(false);
  expect(pageBasis.outcome).toMatchObject({ route: "pages", status: "unresolved", returned: 0 });
  expectBasisIntegrity(coverage as CoverageReceipt);
});

test("coverage counts exact source locators once and separates current from historical revisions", async () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const lisbon = vault.episodes.append(thread.id, {
    role: "user",
    content: "I live in Lisbon.",
  });
  atomize(vault, thread.id, [lisbon.seq]);
  const porto = vault.episodes.append(thread.id, {
    role: "user",
    content: "Correction: I live in Porto.",
  });
  atomize(vault, thread.id, [porto.seq]);
  const result = await runTurn(vault, thread.id, {
    text: "Compare each place I have lived: Lisbon and Porto.",
    model: "oracle",
    provider: providerReply("I found Lisbon and Porto."),
    budget: 1024,
  });
  const coverage = coverageOf(result);
  expect(coverage.located).toBe(2);
  expect(coverage.supported).toBe(1);
  expect(coverage.historical).toBe(1);
  expect(coverage.routes.length).toBeGreaterThan(0);
  const locators = coverage.routes.map((route) =>
    JSON.stringify([route.source, route.byteRange, route.revision]),
  );
  expect(new Set(locators).size).toBe(locators.length);
});

test("same-episode atom spans keep one stale fact historical and its neighbor current", async () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const facts = vault.episodes.append(thread.id, {
    role: "user",
    content: "Ada Okafor lives in Lisbon. Ada Okafor works at Kestrel Systems.",
  });
  atomize(vault, thread.id, [facts.seq]);
  const correction = vault.episodes.append(thread.id, {
    role: "user",
    content: "Ada Okafor moved to Porto.",
  });
  atomize(vault, thread.id, [correction.seq]);

  const result = await runTurn(vault, thread.id, {
    text: "Compare each fact: Lisbon, Porto, and Kestrel Systems.",
    model: "oracle",
    provider: providerReply("I found Lisbon, Porto, and Kestrel Systems."),
    budget: 1024,
  });
  const coverage = coverageOf(result);
  const bytes = new TextEncoder().encode(facts.content);
  const textAt = (route: CoverageReceipt["routes"][number]): string =>
    new TextDecoder().decode(bytes.slice(route.byteRange[0], route.byteRange[1]));
  const sourceRoutes = coverage.routes.filter((route) => route.source === `episode:${facts.seq}`);
  const lisbonRoutes = sourceRoutes.filter((route) => textAt(route).includes("Lisbon"));
  const kestrelRoutes = sourceRoutes.filter((route) => textAt(route).includes("Kestrel Systems"));
  expect(lisbonRoutes.length).toBeGreaterThan(0);
  expect(kestrelRoutes.length).toBeGreaterThan(0);
  expect(lisbonRoutes.every((route) => route.status === "historical")).toBe(true);
  expect(kestrelRoutes.every((route) => route.status === "supported")).toBe(true);
  expect(new Set(sourceRoutes.map((route) => JSON.stringify(route.byteRange))).size).toBeGreaterThan(1);
  const atomMembers = Object.values(coverage.basis.routeMembers)
    .flatMap((route) => route.members)
    .filter((member) => member.sourceSeq === facts.seq);
  expect(atomMembers.length).toBeGreaterThanOrEqual(2);
  expect(new Set(atomMembers.flatMap((member) => member.locatorDigests)).size).toBeGreaterThan(1);
});

test("coverage fails closed with an explicit unresolved locator when one source exceeds the atom bound", () => {
  const { vault, thread } = tempVault({ budget: 1024 });
  const source = vault.episodes.append(thread.id, {
    role: "user",
    content: "launch note overflow source",
  });
  const question = vault.episodes.append(thread.id, {
    role: "user",
    content: "List every launch note.",
  });
  const atomCount = 600;
  for (let index = 0; index < atomCount; index += 1) {
    vault.db
      .query(
        "INSERT INTO atom (id, thread_id, kind, key, value, text, source_seq, source_span, valid_from_seq, " +
          "valid_to_seq, superseded_by, phase, authority, scope, pinned, confidence, created_by, created_at) " +
          "VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, ?, NULL, NULL, 'SUPPORTED', 'user', 'global', 0, 1, 'coverage-cap-oracle', ?)",
      )
      .run(
        `coverage-cap-atom-${index}`,
        thread.id,
        `coverage.cap.${index}`,
        "launch",
        "launch",
        source.seq,
        JSON.stringify([0, 6]),
        source.seq,
        index,
      );
  }

  const stats = { rows: 0, maxRows: 0 };
  const db = vault.db as unknown as {
    query: (sql: string, ...args: unknown[]) => unknown;
  };
  const originalQuery = db.query;
  db.query = ((sql: string, ...args: unknown[]) => {
    const statement = originalQuery.call(vault.db, sql, ...args) as Record<string, unknown>;
    const normalizedSql = sql.replace(/\s+/gu, " ");
    if (
      !/SELECT id, key, value, source_span, valid_from_seq, valid_to_seq, phase, authority FROM atom WHERE thread_id = \? AND source_seq = \? ORDER BY valid_from_seq, id/u.test(
        normalizedSql,
      )
    ) {
      return statement;
    }
    return new Proxy(statement, {
      get(target, property) {
        if (property === "all") {
          return (...parameters: unknown[]) => {
            const method = Reflect.get(target, property, target) as (...values: unknown[]) => unknown;
            const value = method.apply(target, parameters);
            const count = Array.isArray(value) ? value.length : 0;
            stats.rows += count;
            stats.maxRows = Math.max(stats.maxRows, count);
            return value;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof db.query;
  try {
    const coverage = coverageFor(vault, thread.id, {
      question: question.content,
      querySeq: question.seq,
      pages: [{ trigger: "search", seqs: [source.seq], tokens: 1, latencyMs: 0, resolved: true }],
    });
    expect(coverage).toBeDefined();
    expect(coverage?.routes.some((route) => route.status === "unresolved")).toBe(true);
    expect(coverage?.supported).toBe(0);
    expect(coverage?.located).toBe(0);
    expect(coverage?.completeness).toBe("not-established");
  } finally {
    db.query = originalQuery;
  }
  expect(stats.maxRows).toBeLessThanOrEqual(513);
  expect(stats.rows).toBeLessThanOrEqual(513);
});

test("the stored packet and answer keep one identical coverage digest", async () => {
  const { vault, thread } = tempVault();
  const result = await runTurn(vault, thread.id, {
    text: "Every launch note?",
    model: "oracle",
    provider: providerReply("I found one."),
    budget: 8192,
  });
  const coverage = coverageOf(result);
  const storedPacket = vault.packets.get(thread.id, result.userEpisode.seq);
  expect(storedPacket?.coverage).toEqual(coverage);
  expect(storedPacket?.coverage?.digest).toBe(coverage.digest);
  expect(result.assistantEpisode.meta.coverage?.digest).toBe(coverage.digest);
  expect(result.assistantEpisode.meta.answerReceipt?.coverageRouterVersion).toBe(coverage.routerVersion);
  expect(result.assistantEpisode.meta.answerReceipt?.coverageRoutesRun).toEqual(coverage.routesRun);
  expect(renderCoverage(coverage)).toContain(`digest ${coverage.digest}`);
});
