import { afterEach, expect, test } from "bun:test";
import type {
  ThreadCompactionStatus,
  ThreadFragmentStatus,
  ThreadSourceReadiness,
  ThreadStats,
} from "@pylos/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api } from "../src/api.ts";
import {
  CompactionBanner,
  FragmentBanner,
  fragmentOriginLabel,
  fragmentRangeLabel,
  isReadOnlyFragment,
  isReadOnlySource,
  SourceReadinessBanner,
} from "../src/components/FragmentBanner.tsx";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const fragment: ThreadFragmentStatus = {
  readOnly: true,
  threadId: "th_fragment",
  originalThreadId: "th_original",
  fromSeq: 12,
  toSeq: 34,
  prevHash: "a".repeat(64),
  headHash: "b".repeat(64),
  createdAt: 1_725_000_000_000,
};

const readiness: ThreadSourceReadiness = {
  status: "noncompactable",
  readOnly: true,
  seq: 7,
  reason: "episode exceeds capsule source byte capacity",
};

const stats = (): ThreadStats => ({
  threadId: fragment.threadId,
  title: "Imported range",
  turns: fragment.toSeq,
  episodes: { user: 1, assistant: 1, other: 0 },
  archiveBytes: 123,
  capsules: 0,
  losses: 0,
  atoms: { supported: 0, historical: 0, proposed: 0 },
  headHash: fragment.headHash,
  models: ["model-a"],
  modelsTruncated: false,
  modelsComplete: true,
  selectedBudget: 32_768,
  fragment,
});

test("reopened fragment stats drive durable read-only provenance UI", () => {
  const thread = stats();
  expect(isReadOnlyFragment(thread)).toBe(true);
  expect(fragmentRangeLabel(fragment)).toBe("#12–#34");
  expect(fragmentOriginLabel(fragment)).toBe("original thread th_original");

  const html = renderToStaticMarkup(createElement(FragmentBanner, { fragment }));
  expect(html).toContain('data-fragment-read-only="true"');
  expect(html).toContain("read-only fragment");
  expect(html).toContain("#12–#34");
  expect(html).toContain("original thread th_original");
  expect(html).toContain("aaaaaaaa…aaaa");
});

test("partial fragment export sends the authenticated range instead of full-vault intent", async () => {
  let requestBody: unknown;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("/api/threads/th_fragment/export");
    requestBody = JSON.parse(String(init?.body));
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
  }) as unknown as typeof fetch;

  await expect(
    api.exportBundle(fragment.threadId, "secret", [fragment.fromSeq, fragment.toSeq]),
  ).resolves.toEqual(new Uint8Array([1, 2, 3]));
  expect(requestBody).toEqual({ passphrase: "secret", range: [12, 34] });
});

test("reopened legacy quarantine stats drive durable read-only UI while retaining full export", () => {
  const thread = { ...stats(), fragment: undefined, sourceReadiness: readiness };
  expect(isReadOnlySource(thread)).toBe(true);
  const html = renderToStaticMarkup(createElement(SourceReadinessBanner, { readiness }));
  expect(html).toContain('data-source-readiness="noncompactable"');
  expect(html).toContain("episode #7");
  expect(html).toContain("Forget this");
  expect(html).toContain("full export remain available");
});

test("maintenance API advances one bounded progress envelope", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("/api/threads/th_fragment/maintenance");
    expect(init?.method).toBe("POST");
    return new Response(
      JSON.stringify({
        ...stats(),
        compaction: { pending: true, sealedThrough: 32, headSeq: 128 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  const next = await api.maintenance(fragment.threadId);
  expect(next.compaction).toEqual({ pending: true, sealedThrough: 32, headSeq: 128 });
});

test("compaction progress is visible without presenting a mutable composer", () => {
  const status: ThreadCompactionStatus = { pending: true, sealedThrough: 32, headSeq: 128 };
  const html = renderToStaticMarkup(createElement(CompactionBanner, { status }));
  expect(html).toContain('data-compaction-pending="true"');
  expect(html).toContain("rebuilding bounded index");
  expect(html).toContain("episode #32");
  expect(html).toContain("#128");
});
