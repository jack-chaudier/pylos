#!/usr/bin/env bun
/**
 * Build the optional semantic runtime that ships with Pylos.
 *
 * This is intentionally a build-time boundary.  The sidecar never downloads
 * an extension or model: it receives a complete, hash-recorded `semantic/`
 * directory from this script (or fails closed when one cannot be produced).
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { arch as hostArch, platform as hostPlatform } from "node:process";

export const SQLITE_VEC_VERSION = "0.1.8";
export const SQLITE_LEMBED_VERSION = "0.0.1-alpha.8";
export const EMBEDDING_DIMENSION = 384;
export const MODEL_REPOSITORY = "asg017/sqlite-lembed-model-examples";
export const MODEL_COMMIT = "7a7bac37782986fe1d4f213de771a8a3d9170b35";
export const MODEL_RELATIVE_PATH = "all-MiniLM-L6-v2/all-MiniLM-L6-v2.e4ce9877.q8_0.gguf";
export const MODEL_FILENAME = "all-MiniLM-L6-v2.e4ce9877.q8_0.gguf";
export const MODEL_SHA256 = "71f1d177171468fb5f186c07019e303015aea17af275a67767760bba7be8d2e6";

const here = dirname(new URL(import.meta.url).pathname);
export const REPO_ROOT = resolve(here, "..");
export const DEFAULT_OUTPUT_DIR = join(REPO_ROOT, "apps", "desktop", "src-tauri", "semantic");

type SemanticPlatform = "darwin" | "linux";
type SemanticArch = "arm64" | "x64";

export interface SemanticTarget {
  target: string;
  platform: SemanticPlatform;
  arch: SemanticArch;
  extensionSuffix: "dylib" | "so";
}

export interface SemanticAsset {
  file: string;
  sha256: string;
  version?: string;
}

export interface SemanticManifest {
  schema: 1;
  target: string;
  platform: SemanticPlatform;
  arch: SemanticArch;
  dimension: typeof EMBEDDING_DIMENSION;
  sqlite: SemanticAsset;
  extensions: {
    vec0: SemanticAsset;
    lembed0: SemanticAsset;
  };
  model: SemanticAsset & {
    name: "all-MiniLM-L6-v2";
    repository: typeof MODEL_REPOSITORY;
    commit: typeof MODEL_COMMIT;
  };
}

export const SEMANTIC_PREFLIGHT_SOURCE_INPUTS = [
  "scripts/prepare-semantic-assets.ts",
  "packages/core/package.json",
  "package.json",
  "bun.lock",
] as const;

export const SEMANTIC_SMOKE_CHECKS = [
  "compiled-against-bundled-sqlite",
  "loaded-vec0-and-lembed0",
  "queried-nonempty-extension-versions",
  "registered-pinned-minilm-model",
  "executed-vec0-knn",
] as const;

export interface SemanticSmokeResult {
  status: "passed";
  checks: [...typeof SEMANTIC_SMOKE_CHECKS];
}

export interface SemanticSourceTreeBinding {
  gitRevision: string;
  files: Array<{ path: string; sha256: string }>;
  digest: string;
}

export interface SemanticPreflightReceipt {
  schema: 1;
  kind: "pylos-semantic-preflight";
  generatedAt: string;
  target: string;
  platform: SemanticPlatform;
  arch: SemanticArch;
  dimension: typeof EMBEDDING_DIMENSION;
  manifest: { file: "manifest.json"; sha256: string; status: "verified" };
  assets: {
    status: "verified";
    sqlite: SemanticAsset;
    extensions: SemanticManifest["extensions"];
    model: SemanticManifest["model"];
  };
  smoke: SemanticSmokeResult;
  sourceTree: SemanticSourceTreeBinding;
  notClaimed: string[];
  receiptSha256: string;
}

export function targetForTriple(triple: string): SemanticTarget {
  if (triple.endsWith("-apple-darwin")) {
    const arch = triple.startsWith("aarch64-") ? "arm64" : triple.startsWith("x86_64-") ? "x64" : undefined;
    if (arch === undefined) throw new Error(`unsupported macOS target: ${triple}`);
    return { target: triple, platform: "darwin", arch, extensionSuffix: "dylib" };
  }
  if (triple.endsWith("-unknown-linux-gnu") || triple.endsWith("-linux-gnu")) {
    const arch = triple.startsWith("aarch64-") ? "arm64" : triple.startsWith("x86_64-") ? "x64" : undefined;
    if (arch === undefined) throw new Error(`unsupported Linux target: ${triple}`);
    return { target: triple, platform: "linux", arch, extensionSuffix: "so" };
  }
  throw new Error(`semantic assets are not packaged for target ${triple}; use macOS or Linux`);
}

export function hostTarget(): SemanticTarget {
  const arch = hostArch === "arm64" ? "arm64" : hostArch === "x64" ? "x64" : undefined;
  if (arch === undefined) throw new Error(`unsupported host architecture: ${hostArch}`);
  if (hostPlatform === "darwin") {
    return targetForTriple(`${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`);
  }
  if (hostPlatform === "linux") {
    return targetForTriple(`${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`);
  }
  throw new Error(`semantic assets are not packaged for host ${hostPlatform}`);
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function packageName(base: "sqlite-vec" | "sqlite-lembed", target: SemanticTarget): string {
  const platform = target.platform === "darwin" ? "darwin" : "linux";
  return `${base}-${platform}-${target.arch}`;
}

function extensionFile(base: "sqlite-vec" | "sqlite-lembed", target: SemanticTarget): string {
  return `${base === "sqlite-vec" ? "vec0" : "lembed0"}.${target.extensionSuffix}`;
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (existsSync(path)) {
      const info = await stat(path).catch(() => undefined);
      if (info?.isFile()) return path;
    }
  }
  return undefined;
}

export async function findExtension(
  base: "sqlite-vec" | "sqlite-lembed",
  target: SemanticTarget,
): Promise<string> {
  const version = base === "sqlite-vec" ? SQLITE_VEC_VERSION : SQLITE_LEMBED_VERSION;
  const nativePackage = packageName(base, target);
  const file = extensionFile(base, target);
  const bunRoot = join(REPO_ROOT, "node_modules", ".bun");
  const candidates = [
    join(bunRoot, `${nativePackage}@${version}`, "node_modules", nativePackage, file),
    join(bunRoot, `${base}@${version}`, "node_modules", nativePackage, file),
    join(bunRoot, "node_modules", nativePackage, file),
    join(REPO_ROOT, "node_modules", nativePackage, file),
    join(REPO_ROOT, "packages", "core", "node_modules", nativePackage, file),
    join(REPO_ROOT, "packages", "core", "node_modules", base, nativePackage, file),
  ];
  const found = await firstExisting(candidates);
  if (found === undefined) {
    throw new Error(
      `missing ${base} ${version} for ${target.target}; run bun install --frozen-lockfile before preparing semantic assets`,
    );
  }
  return found;
}

async function commandOutput(args: string[], cwd = REPO_ROOT): Promise<string | undefined> {
  try {
    const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();
    const code = await process.exited;
    if (code !== 0) return undefined;
    return stdout.trim() || stderr.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function runCommand(
  args: string[],
  cwd = REPO_ROOT,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(process.stdout).text();
  const stderr = await new Response(process.stderr).text();
  return { code: await process.exited, stdout, stderr };
}

interface SqliteRuntime {
  library: string;
  includeDir: string;
  linker: "darwin" | "linux";
}

async function findSqlite(target: SemanticTarget): Promise<SqliteRuntime> {
  if (target.platform === "darwin") {
    const brewPrefix = await commandOutput(["brew", "--prefix", "sqlite"]);
    const prefixes = [
      ...(brewPrefix === undefined ? [] : [brewPrefix]),
      "/opt/homebrew/opt/sqlite",
      "/usr/local/opt/sqlite",
    ];
    const library = await firstExisting(
      prefixes.flatMap((prefix) => [
        join(prefix, "lib", "libsqlite3.dylib"),
        join(prefix, "lib", "libsqlite3.0.dylib"),
      ]),
    );
    const includeDir = await firstExisting(prefixes.map((prefix) => join(prefix, "include", "sqlite3.h")));
    if (library === undefined || includeDir === undefined) {
      throw new Error("Homebrew SQLite with headers is required; run `brew install sqlite` and retry");
    }
    return { library, includeDir: dirname(includeDir), linker: "darwin" };
  }

  const pkgConfigLib = await commandOutput(["pkg-config", "--variable=libdir", "sqlite3"]);
  const pkgConfigInclude = await commandOutput(["pkg-config", "--variable=includedir", "sqlite3"]);
  const library = await firstExisting(
    [
      ...(pkgConfigLib === undefined ? [] : [pkgConfigLib]),
      "/usr/lib/x86_64-linux-gnu",
      "/usr/lib/aarch64-linux-gnu",
      "/usr/lib64",
      "/usr/lib",
    ].flatMap((directory) => [join(directory, "libsqlite3.so"), join(directory, "libsqlite3.so.0")]),
  );
  const include = await firstExisting(
    [...(pkgConfigInclude === undefined ? [] : [pkgConfigInclude]), "/usr/include", "/usr/local/include"].map(
      (directory) => join(directory, "sqlite3.h"),
    ),
  );
  if (library === undefined || include === undefined) {
    throw new Error("SQLite development files are required; install sqlite3 and libsqlite3-dev and retry");
  }
  return { library, includeDir: dirname(include), linker: "linux" };
}

async function copyAsset(source: string, destination: string, expected?: string): Promise<string> {
  const digest = await sha256File(source);
  if (expected !== undefined && digest !== expected) {
    throw new Error(`SHA256 mismatch for ${source}: expected ${expected}, got ${digest}`);
  }
  await copyFile(source, destination);
  await chmod(destination, 0o755).catch(() => undefined);
  return digest;
}

async function nativeLibraryFilename(path: string): Promise<string> {
  const resolved = await realpath(path).catch(() => path);
  const filename = basename(resolved);
  if (!/^libsqlite3\.(?:.*\.dylib|so(?:\..*)?)$/.test(filename)) {
    throw new Error(`SQLite library has an unexpected filename: ${filename}`);
  }
  return filename;
}

const SMOKE_SOURCE = String.raw`#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>

static void fail(sqlite3 *db, const char *where, int rc) {
  fprintf(stderr, "%s (%d): %s\n", where, rc, db == NULL ? "no database" : sqlite3_errmsg(db));
  if (db != NULL) sqlite3_close(db);
  exit(1);
}

static void exec_sql(sqlite3 *db, const char *sql) {
  char *error = NULL;
  int rc = sqlite3_exec(db, sql, NULL, NULL, &error);
  if (rc != SQLITE_OK) {
    fprintf(stderr, "SQL failed: %s\n", error == NULL ? sqlite3_errmsg(db) : error);
    sqlite3_free(error);
    fail(db, "sqlite3_exec", rc);
  }
}

static int nonempty_callback(void *unused, int argc, char **argv, char **names) {
  (void)unused;
  (void)names;
  if (argc != 2 || argv[0] == NULL || argv[1] == NULL || argv[0][0] == '\0' || argv[1][0] == '\0') exit(1);
  return 0;
}

static int row_callback(void *found, int argc, char **argv, char **names) {
  (void)argc;
  (void)argv;
  (void)names;
  *(int *)found = 1;
  return 0;
}

static void load_extension(sqlite3 *db, const char *path) {
  char *error = NULL;
  int rc = sqlite3_load_extension(db, path, NULL, &error);
  if (rc != SQLITE_OK) {
    fprintf(stderr, "extension %s failed: %s\n", path, error == NULL ? sqlite3_errmsg(db) : error);
    sqlite3_free(error);
    fail(db, "sqlite3_load_extension", rc);
  }
}

int main(int argc, char **argv) {
  if (argc != 4) return 2;
  sqlite3 *db = NULL;
  int rc = sqlite3_open_v2(":memory:", &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL);
  if (rc != SQLITE_OK) fail(db, "sqlite3_open_v2", rc);
  sqlite3_enable_load_extension(db, 1);
  load_extension(db, argv[1]);
  load_extension(db, argv[2]);
  exec_sql(db, "SELECT vec_version(), lembed_version()");
  char *error = NULL;
  rc = sqlite3_exec(db, "SELECT vec_version(), lembed_version()", nonempty_callback, NULL, &error);
  if (rc != SQLITE_OK) {
    fprintf(stderr, "version probe failed: %s\n", error == NULL ? sqlite3_errmsg(db) : error);
    sqlite3_free(error);
    fail(db, "version probe", rc);
  }
  sqlite3_stmt *model = NULL;
  rc = sqlite3_prepare_v2(db, "INSERT INTO temp.lembed_models(name, model) SELECT 'all-MiniLM-L6-v2', lembed_model_from_file(?)", -1, &model, NULL);
  if (rc != SQLITE_OK) fail(db, "lembed model prepare", rc);
  sqlite3_bind_text(model, 1, argv[3], -1, SQLITE_TRANSIENT);
  rc = sqlite3_step(model);
  sqlite3_finalize(model);
  if (rc != SQLITE_DONE) fail(db, "lembed model register", rc);
  exec_sql(db, "CREATE VIRTUAL TABLE semantic_vectors USING vec0(embedding float[384])");
  exec_sql(db, "INSERT INTO semantic_vectors(rowid, embedding) VALUES (1, lembed('all-MiniLM-L6-v2', 'the quick brown fox')), (2, lembed('all-MiniLM-L6-v2', 'a completely different sentence'))");
  int found = 0;
  rc = sqlite3_exec(db, "SELECT rowid FROM semantic_vectors WHERE embedding MATCH lembed('all-MiniLM-L6-v2', 'the quick brown fox') ORDER BY distance LIMIT 1", row_callback, &found, &error);
  if (rc != SQLITE_OK || !found) {
    fprintf(stderr, "KNN probe failed: %s\n", error == NULL ? sqlite3_errmsg(db) : error);
    sqlite3_free(error);
    fail(db, "KNN probe", rc == SQLITE_OK ? SQLITE_ERROR : rc);
  }
  sqlite3_close(db);
  return 0;
}
`;

async function runSmoke(
  target: SemanticTarget,
  runtime: SqliteRuntime,
  directory: string,
  sqliteFile: string,
  model: string,
): Promise<SemanticSmokeResult> {
  const smokeRoot = await mkdtemp(join(tmpdir(), "pylos-semantic-smoke-"));
  const source = join(smokeRoot, "smoke.c");
  const binary = join(smokeRoot, "smoke");
  await writeFile(source, SMOKE_SOURCE, "utf8");
  const args = [
    "cc",
    source,
    "-I",
    runtime.includeDir,
    join(directory, sqliteFile),
    "-o",
    binary,
    ...(runtime.linker === "darwin" ? ["-Wl,-rpath,@loader_path"] : ["-Wl,-rpath,$ORIGIN"]),
  ];
  const compile = await runCommand(args, smokeRoot).catch(() => undefined);
  if (compile === undefined || compile.code !== 0 || !existsSync(binary)) {
    await rm(smokeRoot, { recursive: true, force: true });
    const detail = compile?.stderr.trim();
    throw new Error(
      `could not compile the semantic SQLite smoke probe; install a C compiler and SQLite headers${detail === undefined || detail.length === 0 ? "" : `: ${detail}`}`,
    );
  }
  const env = { ...process.env };
  if (runtime.linker === "darwin") env.DYLD_LIBRARY_PATH = directory;
  else env.LD_LIBRARY_PATH = directory;
  const childProcess = Bun.spawn(
    [
      binary,
      join(directory, `vec0.${target.extensionSuffix}`),
      join(directory, `lembed0.${target.extensionSuffix}`),
      model,
    ],
    {
      cwd: smokeRoot,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(childProcess.stdout).text();
  const stderr = await new Response(childProcess.stderr).text();
  const code = await childProcess.exited;
  await rm(smokeRoot, { recursive: true, force: true });
  if (code !== 0) {
    throw new Error(`semantic compiled-artifact smoke failed (exit ${code}): ${stderr || stdout}`.trim());
  }
  return { status: "passed", checks: [...SEMANTIC_SMOKE_CHECKS] };
}

export function manifestFor(
  target: SemanticTarget,
  assets: {
    sqlite: SemanticAsset;
    vec0: SemanticAsset;
    lembed0: SemanticAsset;
    model: SemanticAsset & {
      name: "all-MiniLM-L6-v2";
      repository: typeof MODEL_REPOSITORY;
      commit: typeof MODEL_COMMIT;
    };
  },
): SemanticManifest {
  return {
    schema: 1,
    target: target.target,
    platform: target.platform,
    arch: target.arch,
    dimension: EMBEDDING_DIMENSION,
    sqlite: assets.sqlite,
    extensions: { vec0: assets.vec0, lembed0: assets.lembed0 },
    model: assets.model,
  };
}

export async function verifyManifest(directory: string, manifest: SemanticManifest): Promise<void> {
  if (manifest.schema !== 1 || manifest.dimension !== EMBEDDING_DIMENSION) {
    throw new Error("semantic manifest schema or embedding dimension is invalid");
  }
  const assets: SemanticAsset[] = [
    manifest.sqlite,
    manifest.extensions.vec0,
    manifest.extensions.lembed0,
    manifest.model,
  ];
  for (const asset of assets) {
    if (!/^[A-Za-z0-9._-]+$/.test(asset.file) || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
      throw new Error(`semantic manifest has an invalid asset record: ${asset.file}`);
    }
    const path = join(directory, asset.file);
    if ((await stat(path).catch(() => undefined))?.isFile() !== true) {
      throw new Error(`semantic asset is missing: ${asset.file}`);
    }
    const actual = await sha256File(path);
    if (actual !== asset.sha256) throw new Error(`semantic asset hash mismatch: ${asset.file}`);
  }
  if (
    manifest.extensions.vec0.version !== SQLITE_VEC_VERSION ||
    manifest.extensions.lembed0.version !== SQLITE_LEMBED_VERSION
  ) {
    throw new Error("semantic extension versions are not pinned to the supported releases");
  }
  if (
    manifest.model.name !== "all-MiniLM-L6-v2" ||
    manifest.model.repository !== MODEL_REPOSITORY ||
    manifest.model.commit !== MODEL_COMMIT ||
    manifest.model.sha256 !== MODEL_SHA256
  ) {
    throw new Error("semantic model is not the pinned all-MiniLM-L6-v2 artifact");
  }
}

export async function semanticSourceTreeBinding(): Promise<SemanticSourceTreeBinding> {
  const gitRevision = await commandOutput(["git", "rev-parse", "HEAD"]);
  if (gitRevision === undefined || !/^[0-9a-f]{40,64}$/.test(gitRevision)) {
    throw new Error("could not bind the semantic preflight to a Git source revision");
  }
  const files = await Promise.all(
    SEMANTIC_PREFLIGHT_SOURCE_INPUTS.map(async (path) => ({
      path,
      sha256: await sha256File(join(REPO_ROOT, path)),
    })),
  );
  return {
    gitRevision,
    files,
    digest: sha256Text(canonicalJson({ gitRevision, files })),
  };
}

export function semanticPreflightReceipt(input: {
  target: SemanticTarget;
  manifest: SemanticManifest;
  manifestSha256: string;
  smoke: SemanticSmokeResult;
  sourceTree: SemanticSourceTreeBinding;
  generatedAt: string;
}): SemanticPreflightReceipt {
  const { target, manifest, manifestSha256, smoke, sourceTree, generatedAt } = input;
  if (
    manifest.target !== target.target ||
    manifest.platform !== target.platform ||
    manifest.arch !== target.arch
  ) {
    throw new Error("semantic receipt target does not match the verified manifest");
  }
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new Error("semantic receipt manifest hash is invalid");
  }
  if (
    !/^[0-9a-f]{40,64}$/.test(sourceTree.gitRevision) ||
    sourceTree.files.some((file) => file.path.length === 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) ||
    sourceTree.digest !==
      sha256Text(canonicalJson({ gitRevision: sourceTree.gitRevision, files: sourceTree.files }))
  ) {
    throw new Error("semantic receipt source-tree binding is invalid");
  }
  if (new Date(generatedAt).toISOString() !== generatedAt) {
    throw new Error("semantic receipt timestamp must be canonical ISO-8601 UTC");
  }
  const base: Omit<SemanticPreflightReceipt, "receiptSha256"> = {
    schema: 1 as const,
    kind: "pylos-semantic-preflight" as const,
    generatedAt,
    target: target.target,
    platform: target.platform,
    arch: target.arch,
    dimension: EMBEDDING_DIMENSION,
    manifest: { file: "manifest.json" as const, sha256: manifestSha256, status: "verified" as const },
    assets: {
      status: "verified" as const,
      sqlite: structuredClone(manifest.sqlite),
      extensions: structuredClone(manifest.extensions),
      model: structuredClone(manifest.model),
    },
    smoke: structuredClone(smoke),
    sourceTree: structuredClone(sourceTree),
    notClaimed: [
      `No evidence is claimed for any target other than ${target.target}.`,
      "The smoke proves artifact loading and one vector query, not semantic retrieval quality.",
      "The receipt does not attest the identity of the machine or builder.",
    ],
  };
  return { ...base, receiptSha256: sha256Text(canonicalJson(base)) };
}

export function verifySemanticPreflightReceiptDigest(receipt: SemanticPreflightReceipt): void {
  const { receiptSha256, ...base } = receipt;
  if (!/^[0-9a-f]{64}$/.test(receiptSha256) || sha256Text(canonicalJson(base)) !== receiptSha256) {
    throw new Error("semantic preflight receipt digest mismatch");
  }
}

export function semanticPreflightMarkdown(receipt: SemanticPreflightReceipt): string {
  const rows = [
    [
      "SQLite",
      receipt.assets.sqlite.file,
      receipt.assets.sqlite.sha256,
      receipt.assets.sqlite.version ?? "system",
    ],
    [
      "vec0",
      receipt.assets.extensions.vec0.file,
      receipt.assets.extensions.vec0.sha256,
      receipt.assets.extensions.vec0.version ?? "unknown",
    ],
    [
      "lembed0",
      receipt.assets.extensions.lembed0.file,
      receipt.assets.extensions.lembed0.sha256,
      receipt.assets.extensions.lembed0.version ?? "unknown",
    ],
    [
      receipt.assets.model.name,
      receipt.assets.model.file,
      receipt.assets.model.sha256,
      receipt.assets.model.commit,
    ],
  ];
  return `# Semantic runtime preflight receipt

- Result: **PASS**
- Generated: ${receipt.generatedAt}
- Target: \`${receipt.target}\` (${receipt.platform}/${receipt.arch})
- Embedding dimension: ${receipt.dimension}
- Manifest: \`${receipt.manifest.file}\` · \`${receipt.manifest.sha256}\` · ${receipt.manifest.status}

## Verified assets

| Asset | File | SHA-256 | Version / commit |
| --- | --- | --- | --- |
${rows.map((row) => `| ${row[0]} | \`${row[1]}\` | \`${row[2]}\` | \`${row[3]}\` |`).join("\n")}

## Compiled smoke

${receipt.smoke.checks.map((check) => `- ${check}`).join("\n")}

## Source-tree binding

- Git revision: \`${receipt.sourceTree.gitRevision}\`
- Input digest: \`${receipt.sourceTree.digest}\`
${receipt.sourceTree.files.map((file) => `- \`${file.path}\` · \`${file.sha256}\``).join("\n")}

## Not claimed

${receipt.notClaimed.map((claim) => `- ${claim}`).join("\n")}

Receipt digest: \`${receipt.receiptSha256}\`
`;
}

export async function writeSemanticPreflightReceipt(
  directory: string,
  target: SemanticTarget,
  manifest: SemanticManifest,
  smoke: SemanticSmokeResult,
  jsonPath: string,
  generatedAt = new Date().toISOString(),
): Promise<SemanticPreflightReceipt> {
  if (!jsonPath.endsWith(".json")) throw new Error("semantic receipt path must end in .json");
  const manifestPath = join(directory, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  if (manifestText !== canonicalJson(manifest)) {
    throw new Error("installed semantic manifest differs from the verified manifest");
  }
  await verifyManifest(directory, manifest);
  const receipt = semanticPreflightReceipt({
    target,
    manifest,
    manifestSha256: await sha256File(manifestPath),
    smoke,
    sourceTree: await semanticSourceTreeBinding(),
    generatedAt,
  });
  verifySemanticPreflightReceiptDigest(receipt);
  const markdownPath = `${jsonPath.slice(0, -".json".length)}.md`;
  await mkdir(dirname(jsonPath), { recursive: true });
  const suffix = `.tmp-${process.pid}`;
  const jsonTemp = `${jsonPath}${suffix}`;
  const markdownTemp = `${markdownPath}${suffix}`;
  try {
    await Promise.all([
      writeFile(jsonTemp, canonicalJson(receipt), "utf8"),
      writeFile(markdownTemp, semanticPreflightMarkdown(receipt), "utf8"),
    ]);
    await rename(markdownTemp, markdownPath);
    await rename(jsonTemp, jsonPath);
  } finally {
    await Promise.all([
      rm(jsonTemp, { force: true }).catch(() => undefined),
      rm(markdownTemp, { force: true }).catch(() => undefined),
    ]);
  }
  return receipt;
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function downloadModel(destination: string): Promise<void> {
  const url = `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_COMMIT}/${MODEL_RELATIVE_PATH}?download=true`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null)
    throw new Error(`could not download pinned embedding model: HTTP ${response.status}`);
  await Bun.write(destination, response);
}

async function modelSource(outputDir: string, stagingDir: string): Promise<string> {
  const existing = join(outputDir, MODEL_FILENAME);
  if (existsSync(existing) && (await sha256File(existing)) === MODEL_SHA256) return existing;
  const downloaded = join(stagingDir, MODEL_FILENAME);
  await downloadModel(downloaded);
  const digest = await sha256File(downloaded);
  if (digest !== MODEL_SHA256)
    throw new Error(`SHA256 mismatch for ${MODEL_FILENAME}: expected ${MODEL_SHA256}, got ${digest}`);
  return downloaded;
}

async function prepare(outputDir: string, target: SemanticTarget, receiptPath?: string): Promise<void> {
  const parent = dirname(outputDir);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(tmpdir(), "pylos-semantic-assets-"));
  const stagedOutput = join(staging, "semantic");
  await mkdir(stagedOutput);
  try {
    // The checked-in placeholders keep local Tauri configuration valid before
    // assets are prepared. Preserve them across the atomic directory swap so
    // release reproducibility checks do not observe tracked-file deletions.
    for (const name of [".gitkeep", "README.txt"]) {
      const source = join(outputDir, name);
      if (existsSync(source)) await copyFile(source, join(stagedOutput, name));
    }
    const [vecSource, lembedSource, sqlite] = await Promise.all([
      findExtension("sqlite-vec", target),
      findExtension("sqlite-lembed", target),
      findSqlite(target),
    ]);
    const vecFile = `vec0.${target.extensionSuffix}`;
    const lembedFile = `lembed0.${target.extensionSuffix}`;
    const sqliteFile = await nativeLibraryFilename(sqlite.library);
    const vecDigest = await copyAsset(vecSource, join(stagedOutput, vecFile));
    const lembedDigest = await copyAsset(lembedSource, join(stagedOutput, lembedFile));
    const sqliteDigest = await copyAsset(sqlite.library, join(stagedOutput, sqliteFile));
    const modelPath = await modelSource(outputDir, staging);
    if (modelPath !== join(stagedOutput, MODEL_FILENAME))
      await copyAsset(modelPath, join(stagedOutput, MODEL_FILENAME), MODEL_SHA256);
    const modelDigest = await sha256File(join(stagedOutput, MODEL_FILENAME));
    if (modelDigest !== MODEL_SHA256) throw new Error(`SHA256 mismatch for ${MODEL_FILENAME}`);
    const smoke = await runSmoke(
      target,
      sqlite,
      stagedOutput,
      sqliteFile,
      join(stagedOutput, MODEL_FILENAME),
    );
    const manifest = manifestFor(target, {
      sqlite: { file: sqliteFile, sha256: sqliteDigest },
      vec0: { file: vecFile, sha256: vecDigest, version: SQLITE_VEC_VERSION },
      lembed0: { file: lembedFile, sha256: lembedDigest, version: SQLITE_LEMBED_VERSION },
      model: {
        file: MODEL_FILENAME,
        sha256: modelDigest,
        name: "all-MiniLM-L6-v2",
        repository: MODEL_REPOSITORY,
        commit: MODEL_COMMIT,
      },
    });
    await writeFile(join(stagedOutput, "manifest.json"), canonicalJson(manifest), "utf8");
    await verifyManifest(stagedOutput, manifest);
    const oldOutput = `${outputDir}.previous-${process.pid}`;
    await rm(oldOutput, { recursive: true, force: true });
    if (existsSync(outputDir)) await rename(outputDir, oldOutput);
    try {
      await rename(stagedOutput, outputDir);
    } catch (error) {
      if (existsSync(oldOutput)) await rename(oldOutput, outputDir).catch(() => undefined);
      throw error;
    }
    await rm(oldOutput, { recursive: true, force: true });
    if (receiptPath !== undefined) {
      await writeSemanticPreflightReceipt(outputDir, target, manifest, smoke, receiptPath);
      process.stdout.write(`semantic preflight receipt: ${receiptPath}\n`);
    }
    process.stdout.write(`semantic resources ready: ${outputDir}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  const value = index < 0 ? undefined : process.argv[index + 1];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function receiptPath(target: SemanticTarget): string | undefined {
  const index = process.argv.indexOf("--receipt");
  if (index < 0) return undefined;
  const candidate = process.argv[index + 1];
  if (candidate !== undefined && !candidate.startsWith("--")) return resolve(candidate);
  return join(REPO_ROOT, "bench", "results", `semantic-preflight-${target.target}.json`);
}

if (import.meta.main) {
  const target = targetForTriple(
    argValue("--target") ?? process.env.PYLOS_TARGET_TRIPLE ?? hostTarget().target,
  );
  const output = resolve(argValue("--out") ?? process.env.PYLOS_SEMANTIC_RESOURCES ?? DEFAULT_OUTPUT_DIR);
  prepare(output, target, receiptPath(target)).catch((error: unknown) => {
    process.stderr.write(
      `semantic resource preparation failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
