import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  EMBEDDING_DIMENSION,
  MODEL_COMMIT,
  MODEL_REPOSITORY,
  MODEL_SHA256,
  manifestFor,
  SEMANTIC_PREFLIGHT_SOURCE_INPUTS,
  SEMANTIC_SMOKE_CHECKS,
  SQLITE_LEMBED_VERSION,
  SQLITE_VEC_VERSION,
  semanticPreflightMarkdown,
  semanticPreflightReceipt,
  semanticSourceTreeBinding,
  sha256File,
  targetForTriple,
  verifyManifest,
  verifySemanticPreflightReceiptDigest,
} from "./prepare-semantic-assets.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("semantic asset packaging", () => {
  test("maps only the release triples to a pinned native suffix", () => {
    expect(targetForTriple("aarch64-apple-darwin")).toMatchObject({
      platform: "darwin",
      arch: "arm64",
      extensionSuffix: "dylib",
    });
    expect(targetForTriple("x86_64-unknown-linux-gnu")).toMatchObject({
      platform: "linux",
      arch: "x64",
      extensionSuffix: "so",
    });
    expect(() => targetForTriple("x86_64-pc-windows-msvc")).toThrow();
  });

  test("canonical manifest verification rejects even one changed byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "pylos-semantic-manifest-test-"));
    roots.push(root);
    const files = {
      sqlite: "libsqlite3.dylib",
      vec0: "vec0.dylib",
      lembed0: "lembed0.dylib",
      model: "all-MiniLM-L6-v2.e4ce9877.q8_0.gguf",
    } as const;
    await Promise.all(Object.values(files).map((file) => writeFile(join(root, file), `${file}\n`, "utf8")));
    const manifest = manifestFor(targetForTriple("aarch64-apple-darwin"), {
      sqlite: { file: files.sqlite, sha256: await sha256File(join(root, files.sqlite)) },
      vec0: {
        file: files.vec0,
        sha256: await sha256File(join(root, files.vec0)),
        version: SQLITE_VEC_VERSION,
      },
      lembed0: {
        file: files.lembed0,
        sha256: await sha256File(join(root, files.lembed0)),
        version: SQLITE_LEMBED_VERSION,
      },
      model: {
        file: files.model,
        sha256: MODEL_SHA256,
        name: "all-MiniLM-L6-v2",
        repository: MODEL_REPOSITORY,
        commit: MODEL_COMMIT,
      },
    });
    // The fake model is intentionally not verified as a real model here; the
    // production preparer verifies its pinned digest before writing this file.
    const fakeModelDigest = await sha256File(join(root, files.model));
    const checkedManifest = {
      ...manifest,
      model: { ...manifest.model, sha256: fakeModelDigest },
    };
    await expect(verifyManifest(root, checkedManifest)).rejects.toThrow(/pinned/);
    await writeFile(join(root, files.vec0), "tampered\n", "utf8");
    await expect(verifyManifest(root, checkedManifest)).rejects.toThrow(/hash mismatch/);
    expect(EMBEDDING_DIMENSION).toBe(384);
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{\n  "b": 2,\n  "a": 1\n}\n');
  });

  test("a target-specific preflight receipt binds assets, smoke, source inputs, and claims", async () => {
    const target = targetForTriple("aarch64-apple-darwin");
    const manifest = manifestFor(target, {
      sqlite: { file: "libsqlite3.3.dylib", sha256: "1".repeat(64) },
      vec0: { file: "vec0.dylib", sha256: "2".repeat(64), version: SQLITE_VEC_VERSION },
      lembed0: {
        file: "lembed0.dylib",
        sha256: "3".repeat(64),
        version: SQLITE_LEMBED_VERSION,
      },
      model: {
        file: "all-MiniLM-L6-v2.e4ce9877.q8_0.gguf",
        sha256: MODEL_SHA256,
        name: "all-MiniLM-L6-v2",
        repository: MODEL_REPOSITORY,
        commit: MODEL_COMMIT,
      },
    });
    const files = [{ path: "scripts/prepare-semantic-assets.ts", sha256: "4".repeat(64) }];
    const gitRevision = "5".repeat(40);
    const sourceTree = {
      gitRevision,
      files,
      digest: createHash("sha256").update(canonicalJson({ gitRevision, files })).digest("hex"),
    };
    const receipt = semanticPreflightReceipt({
      target,
      manifest,
      manifestSha256: "6".repeat(64),
      smoke: { status: "passed", checks: [...SEMANTIC_SMOKE_CHECKS] },
      sourceTree,
      generatedAt: "2026-08-23T17:00:00.000Z",
    });

    verifySemanticPreflightReceiptDigest(receipt);
    expect(receipt).toMatchObject({
      target: "aarch64-apple-darwin",
      platform: "darwin",
      arch: "arm64",
      manifest: { status: "verified", sha256: "6".repeat(64) },
      assets: {
        status: "verified",
        extensions: {
          vec0: { version: SQLITE_VEC_VERSION },
          lembed0: { version: SQLITE_LEMBED_VERSION },
        },
        model: { commit: MODEL_COMMIT, sha256: MODEL_SHA256 },
      },
      smoke: { status: "passed", checks: [...SEMANTIC_SMOKE_CHECKS] },
      sourceTree: { gitRevision, digest: sourceTree.digest },
    });
    expect(receipt.notClaimed[0]).toContain("aarch64-apple-darwin");
    expect(receipt.notClaimed[0]).not.toContain("linux");
    const markdown = semanticPreflightMarkdown(receipt);
    expect(markdown).toContain("# Semantic runtime preflight receipt");
    expect(markdown).toContain("No evidence is claimed for any target other than aarch64-apple-darwin");
    expect(markdown).toContain(receipt.receiptSha256);

    const tampered = structuredClone(receipt);
    tampered.assets.extensions.vec0.sha256 = "7".repeat(64);
    expect(() => verifySemanticPreflightReceiptDigest(tampered)).toThrow(/digest mismatch/);

    const liveBinding = await semanticSourceTreeBinding();
    expect(liveBinding.files.map((file) => file.path)).toEqual([...SEMANTIC_PREFLIGHT_SOURCE_INPUTS]);
    expect(liveBinding.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
