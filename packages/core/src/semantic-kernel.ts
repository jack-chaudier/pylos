/**
 * Kernel integration for the optional local semantic address route (A15.2).
 *
 * Native resources are discovered and hash-checked before the first SQLite
 * connection.  The vector index is derived state: it proposes exact source
 * ranges, while `page()` re-reads and verifies those ranges before exposing
 * any bytes.  Missing, partial, or incompatible resources remain receipts,
 * never lexical routes wearing a semantic label.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Episode, Role, SemanticReceipt } from "@pylos/protocol";
import { sha256 } from "./hash.ts";
import {
  createSemanticRuntime,
  SEMANTIC_RESOURCES,
  SEMANTIC_RUNTIME_SCHEMA_VERSION,
  type SemanticRuntime,
  type SemanticRuntimeOpenResult,
  type SemanticSqlDatabase,
  unavailableSemanticRuntime,
} from "./semantic-runtime.ts";

export const SEMANTIC_MANIFEST_SCHEMA = 1;
export const SEMANTIC_SPAN_BYTES = 1_024;
export const SEMANTIC_MAX_SPANS_PER_EPISODE = 16;
export const SEMANTIC_BACKFILL_EPISODES = 64;

const MODEL_REPOSITORY = "asg017/sqlite-lembed-model-examples";
const MODEL_COMMIT = "7a7bac37782986fe1d4f213de771a8a3d9170b35";
const SAFE_FILE = /^[A-Za-z0-9._-]+$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

interface ManifestAsset {
  file: string;
  sha256: string;
  version?: string;
}

interface SemanticManifest {
  schema: number;
  target: string;
  platform: string;
  arch: string;
  dimension: number;
  sqlite: ManifestAsset;
  extensions: {
    vec0: ManifestAsset;
    lembed0: ManifestAsset;
  };
  model: ManifestAsset & {
    name: string;
    repository: string;
    commit: string;
  };
}

export interface SemanticResourcePaths {
  directory: string;
  manifest: SemanticManifest;
  sqlitePath: string;
  sqliteVecPath: string;
  sqliteLembedPath: string;
  modelPath: string;
}

export interface SemanticBootstrap {
  status: "ready" | "unavailable" | "incompatible";
  receipt: SemanticReceipt;
  resources?: SemanticResourcePaths;
  reason?: string;
}

export interface SemanticIndexPlan {
  spans: Array<{
    threadId: string;
    seq: number;
    content: string;
    byteRange: [number, number];
    contentHash: string;
    spanHash: string;
    revision: string;
  }>;
  truncated: boolean;
}

let processBootstrap: SemanticBootstrap | undefined;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asset(value: unknown): ManifestAsset | null {
  const row = record(value);
  if (
    row === null ||
    typeof row.file !== "string" ||
    !SAFE_FILE.test(row.file) ||
    typeof row.sha256 !== "string" ||
    !SHA256.test(row.sha256) ||
    (row.version !== undefined && typeof row.version !== "string")
  ) {
    return null;
  }
  return {
    file: row.file,
    sha256: row.sha256,
    ...(typeof row.version === "string" ? { version: row.version } : {}),
  };
}

function parseManifest(value: unknown): SemanticManifest | null {
  const row = record(value);
  const extensions = record(row?.extensions);
  const modelRow = record(row?.model);
  const sqlite = asset(row?.sqlite);
  const vec0 = asset(extensions?.vec0);
  const lembed0 = asset(extensions?.lembed0);
  const model = asset(modelRow);
  if (
    row === null ||
    sqlite === null ||
    vec0 === null ||
    lembed0 === null ||
    model === null ||
    typeof row.schema !== "number" ||
    typeof row.target !== "string" ||
    typeof row.platform !== "string" ||
    typeof row.arch !== "string" ||
    typeof row.dimension !== "number" ||
    typeof modelRow?.name !== "string" ||
    typeof modelRow.repository !== "string" ||
    typeof modelRow.commit !== "string"
  ) {
    return null;
  }
  return {
    schema: row.schema,
    target: row.target,
    platform: row.platform,
    arch: row.arch,
    dimension: row.dimension,
    sqlite,
    extensions: { vec0, lembed0 },
    model: {
      ...model,
      name: modelRow.name,
      repository: modelRow.repository,
      commit: modelRow.commit,
    },
  };
}

function unavailable(reason: string, status: SemanticBootstrap["status"] = "unavailable"): SemanticBootstrap {
  const probe = unavailableSemanticRuntime(reason);
  return {
    status,
    receipt: {
      ...probe.receipt,
      status,
      reason,
    },
    reason,
  };
}

function resourceDirectory(explicit?: string): string | undefined {
  const configured = explicit ?? process.env.PYLOS_SEMANTIC_RESOURCES;
  if (configured !== undefined && configured.length > 0) return configured;
  const adjacent = join(dirname(process.execPath), "semantic");
  return existsSync(join(adjacent, "manifest.json")) ? adjacent : undefined;
}

function platformMatches(manifest: SemanticManifest): boolean {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "";
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : "";
  return platform.length > 0 && arch.length > 0 && manifest.platform === platform && manifest.arch === arch;
}

function checkedPath(directory: string, entry: ManifestAsset): string {
  const path = join(directory, entry.file);
  const info = statSync(path);
  if (!info.isFile()) throw new Error(`semantic asset is not a file: ${entry.file}`);
  const digest = sha256(readFileSync(path));
  if (digest !== entry.sha256) throw new Error(`semantic asset hash mismatch: ${entry.file}`);
  return path;
}

/**
 * Select the verified custom SQLite exactly once, before any `new Database()`.
 * A process that has already opened SQLite cannot be upgraded in place; it
 * receives an explicit incompatible receipt and must restart with the resource
 * environment set before startup.
 */
export function prepareSemanticSqlite(explicitDirectory?: string): SemanticBootstrap {
  if (processBootstrap !== undefined) return processBootstrap;
  const directory = resourceDirectory(explicitDirectory);
  if (directory === undefined) {
    processBootstrap = unavailable("semantic resources are not configured");
    return processBootstrap;
  }
  if (!isAbsolute(directory)) {
    processBootstrap = unavailable("PYLOS_SEMANTIC_RESOURCES must be an absolute directory", "incompatible");
    return processBootstrap;
  }
  try {
    const manifestPath = join(directory, "manifest.json");
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (manifest === null) throw new Error("semantic manifest is malformed");
    if (manifest.schema !== SEMANTIC_MANIFEST_SCHEMA)
      throw new Error("semantic manifest schema is unsupported");
    if (!platformMatches(manifest))
      throw new Error("semantic resources target another platform or architecture");
    if (manifest.dimension !== SEMANTIC_RESOURCES.model.dimensions) {
      throw new Error("semantic manifest dimension does not match the kernel");
    }
    if (
      manifest.extensions.vec0.version !== SEMANTIC_RESOURCES.sqliteVec.version ||
      manifest.extensions.lembed0.version !== SEMANTIC_RESOURCES.sqliteLembed.version
    ) {
      throw new Error("semantic extension version does not match the kernel");
    }
    if (
      manifest.model.name !== SEMANTIC_RESOURCES.model.name ||
      manifest.model.sha256 !== SEMANTIC_RESOURCES.model.sha256 ||
      manifest.model.repository !== MODEL_REPOSITORY ||
      manifest.model.commit !== MODEL_COMMIT
    ) {
      throw new Error("semantic model identity does not match the pinned kernel artifact");
    }
    const resources: SemanticResourcePaths = {
      directory,
      manifest,
      sqlitePath: checkedPath(directory, manifest.sqlite),
      sqliteVecPath: checkedPath(directory, manifest.extensions.vec0),
      sqliteLembedPath: checkedPath(directory, manifest.extensions.lembed0),
      modelPath: checkedPath(directory, manifest.model),
    };
    Database.setCustomSQLite(resources.sqlitePath);
    processBootstrap = {
      status: "ready",
      receipt: {
        status: "incomplete",
        model: SEMANTIC_RESOURCES.model.name,
        modelDigest: SEMANTIC_RESOURCES.model.sha256,
        indexed: 0,
        reason: "semantic resources verified; the vault index has not been measured",
      },
      resources,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    processBootstrap = unavailable(`semantic runtime bootstrap failed: ${detail}`, "incompatible");
  }
  return processBootstrap;
}

/** Load both packaged extensions into one caller-owned vault connection. */
export function openKernelSemanticRuntime(db: Database): {
  runtime: SemanticRuntime | null;
  probe: SemanticRuntimeOpenResult["probe"];
} {
  const bootstrap = prepareSemanticSqlite();
  if (bootstrap.resources === undefined) {
    return { runtime: null, probe: unavailableSemanticRuntime(bootstrap.reason) };
  }
  const opened = createSemanticRuntime(db as unknown as SemanticSqlDatabase, {
    modelPath: bootstrap.resources.modelPath,
    sqliteVecPath: bootstrap.resources.sqliteVecPath,
    sqliteLembedPath: bootstrap.resources.sqliteLembedPath,
    maxBatch: 64,
    maxSpanBytes: SEMANTIC_SPAN_BYTES,
    maxCandidates: 256,
  });
  return { runtime: opened.runtime, probe: opened.probe };
}

export function semanticRoleEligible(role: Role): boolean {
  return role === "user" || role === "tool" || role === "attachment" || role === "assistant";
}

/** Split one exact UTF-8 source into bounded, codepoint-aligned proposals. */
export function semanticIndexPlan(episode: Episode): SemanticIndexPlan {
  if (!semanticRoleEligible(episode.role) || episode.meta.removed === true || episode.content.length === 0) {
    return { spans: [], truncated: false };
  }
  const bytes = new TextEncoder().encode(episode.content);
  const contentHash = sha256(bytes);
  const spans: SemanticIndexPlan["spans"] = [];
  let from = 0;
  while (from < bytes.byteLength && spans.length < SEMANTIC_MAX_SPANS_PER_EPISODE) {
    let to = Math.min(bytes.byteLength, from + SEMANTIC_SPAN_BYTES);
    while (to < bytes.byteLength && to > from && ((bytes[to] as number) & 0xc0) === 0x80) to -= 1;
    if (to <= from) break;
    const slice = bytes.slice(from, to);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(slice);
    if (text.trim().length > 0) {
      spans.push({
        threadId: episode.threadId,
        seq: episode.seq,
        content: episode.content,
        byteRange: [from, to],
        contentHash,
        spanHash: sha256(slice),
        revision: episode.hash,
      });
    }
    from = to;
  }
  return { spans, truncated: from < bytes.byteLength };
}

export function semanticGenerationId(threadId: string): string {
  return `${SEMANTIC_RUNTIME_SCHEMA_VERSION}:${threadId}`;
}
