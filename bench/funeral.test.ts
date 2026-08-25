import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateMillionArtifact } from "./funeral.ts";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function validMillionFixture(): Record<string, unknown> {
  const body = {
    schema: "pylos.bench.million.v3",
    seed: "fixture",
    N: 1_000_000,
    final: { ok: true },
    checkpoints: [{ verify: { ok: true, headHash: "1".repeat(64) } }],
  };
  return {
    ...body,
    digest: createHash("sha256")
      .update(JSON.stringify({ ...body, digest: "" }))
      .digest("hex"),
  };
}

test("million custody validation is red against digest, count, and final-pass tampering", () => {
  const home = mkdtempSync(join(tmpdir(), "pylos-million-validator-"));
  homes.push(home);
  const validPath = join(home, "valid.json");
  const valid = validMillionFixture();
  writeFileSync(validPath, JSON.stringify(valid), "utf8");
  expect(validateMillionArtifact(validPath).digest).toBe(valid.digest as string);

  const digestTampered = { ...valid, digest: "0".repeat(64) };
  const digestPath = join(home, "digest-tampered.json");
  writeFileSync(digestPath, JSON.stringify(digestTampered), "utf8");
  expect(() => validateMillionArtifact(digestPath)).toThrow("million artifact digest mismatch");

  const failedBody = { ...valid, final: { ok: false } };
  const failed = {
    ...failedBody,
    digest: createHash("sha256")
      .update(JSON.stringify({ ...failedBody, digest: "" }))
      .digest("hex"),
  };
  const failedPath = join(home, "failed.json");
  writeFileSync(failedPath, JSON.stringify(failed), "utf8");
  expect(() => validateMillionArtifact(failedPath)).toThrow("not a passing one-million-turn run");

  const wrongNBody = { ...valid, N: 999_999 };
  const wrongN = {
    ...wrongNBody,
    digest: createHash("sha256")
      .update(JSON.stringify({ ...wrongNBody, digest: "" }))
      .digest("hex"),
  };
  const wrongNPath = join(home, "wrong-n.json");
  writeFileSync(wrongNPath, JSON.stringify(wrongN), "utf8");
  expect(() => validateMillionArtifact(wrongNPath)).toThrow("not a passing one-million-turn run");
});

test("the 1,000-turn funeral fixture streams, restores, verifies, and pages its planted turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "pylos-funeral-bench-"));
  homes.push(home);
  const source = join(home, "source");
  const reportPath = join(home, "report.json");
  const process = Bun.spawn(
    [
      "bun",
      "run",
      resolve(import.meta.dir, "funeral.ts"),
      "--home",
      source,
      "--thread",
      "smoke",
      "--turns",
      "1000",
      "--out",
      reportPath,
      "--passphrase",
      "funeral-test-passphrase",
    ],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await process.exited;
  const stdout = process.stdout === undefined ? "" : await new Response(process.stdout).text();
  const stderr = process.stderr === undefined ? "" : await new Response(process.stderr).text();
  expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    schema: string;
    ok: boolean;
    source: {
      turns: number;
      headHash: string;
      manifest: { digest: string; tables: Record<string, { count: number; digest: string }> };
    };
    restore: {
      turns: number;
      fullVerify: { ok: boolean };
      manifest: { digest: string; tables: Record<string, { count: number; digest: string }> };
    };
    bundle: {
      sha256: string;
      exportProgress: {
        declaredBufferBoundBytes: number;
        withinDeclaredBufferBound: boolean;
        max: { peakBufferedBytes: number | null };
      };
      importProgress: {
        declaredBufferBoundBytes: number;
        withinDeclaredBufferBound: boolean;
        max: { peakBufferedBytes: number | null };
      };
    };
    receiptCoverage: {
      namespaces: Record<string, { source: number; restore: number; exercised: boolean }>;
      exercised: string[];
      unexercised: string[];
      digest: string;
    };
    page: { byteExact: boolean | null; digestEqual: boolean | null };
    destinationCleaned: boolean;
  };
  expect(report.schema).toBe("pylos.bench.laptop-funeral.v3");
  expect(report.ok).toBe(true);
  expect(report.source.turns).toBe(1000);
  expect(report.restore.turns).toBe(1000);
  expect(report.restore.fullVerify.ok).toBe(true);
  expect(report.source.manifest.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(report.restore.manifest.digest).toBe(report.source.manifest.digest);
  expect(Object.keys(report.source.manifest.tables).sort()).toEqual(
    [
      "addressAliases",
      "addressRoutes",
      "atomizationReceipts",
      "atoms",
      "capsuleLedgerEntries",
      "capsules",
      "episodes",
      "loss",
      "packets",
      "tombstones",
    ].sort(),
  );
  expect(report.source.manifest.tables.episodes?.count).toBe(1000);
  expect(report.restore.manifest.tables).toEqual(report.source.manifest.tables);
  const bundlePath = `${reportPath}.pylos`;
  expect(report.bundle.sha256).toBe(createHash("sha256").update(readFileSync(bundlePath)).digest("hex"));
  expect(existsSync(`${reportPath}.source.tar`)).toBe(false);
  expect(Object.keys(report.receiptCoverage.namespaces).sort()).toEqual(
    [
      "address-alias",
      "address-route",
      "answer",
      "atomization",
      "attachment-manifest",
      "capsule-ledger",
      "coverage",
      "evidence",
      "packet",
      "reachability",
      "request-round",
      "semantic",
      "tombstone",
    ].sort(),
  );
  expect(report.receiptCoverage.unexercised).toContain("packet");
  expect(report.receiptCoverage.namespaces.packet).toEqual({
    source: 0,
    restore: 0,
    exercised: false,
  });
  expect(report.receiptCoverage.digest).toMatch(/^[0-9a-f]{64}$/);
  const absoluteStrings: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith("/")) absoluteStrings.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value)) visit(entry);
    }
  };
  visit(report);
  expect(absoluteStrings).toEqual([]);
  expect(report.page.byteExact).toBe(true);
  expect(report.page.digestEqual).toBe(true);
  expect(report.bundle.exportProgress.withinDeclaredBufferBound).toBe(true);
  expect(report.bundle.importProgress.withinDeclaredBufferBound).toBe(true);
  expect(report.bundle.exportProgress.max.peakBufferedBytes).toBeLessThanOrEqual(
    report.bundle.exportProgress.declaredBufferBoundBytes,
  );
  expect(report.bundle.importProgress.max.peakBufferedBytes).toBeLessThanOrEqual(
    report.bundle.importProgress.declaredBufferBoundBytes,
  );
  expect(report.destinationCleaned).toBe(true);

  const markdownPath = join(home, "report.md");
  expect(existsSync(markdownPath)).toBe(true);
  const markdown = readFileSync(markdownPath, "utf8");
  expect(markdown).toContain("| packet | 0 | 0 |");
  expect(markdown).toContain(`Bundle SHA-256: \`${report.bundle.sha256}\``);
  expect(markdown).toContain(`Source manifest: \`${report.source.manifest.digest}\``);
  expect(markdown).toContain("Unexercised namespaces: `packet`");
  expect(markdown).toContain("does **not** license nonempty Phase 2/4 receipt survival");

  const renderedPath = join(home, "rendered.md");
  const renderProcess = Bun.spawn(
    [
      "bun",
      "run",
      resolve(import.meta.dir, "funeral.ts"),
      "--render-existing",
      reportPath,
      "--markdown-out",
      renderedPath,
    ],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  const renderExit = await renderProcess.exited;
  const renderStderr =
    renderProcess.stderr === undefined ? "" : await new Response(renderProcess.stderr).text();
  expect(renderExit, renderStderr).toBe(0);
  expect(readFileSync(renderedPath, "utf8")).toBe(markdown);

  const tamperedPath = join(home, "tampered.json");
  const tampered = structuredClone(report);
  const episodes = tampered.source.manifest.tables.episodes;
  if (episodes === undefined) throw new Error("missing episode table receipt");
  episodes.count += 1;
  await Bun.write(tamperedPath, `${JSON.stringify(tampered)}\n`);
  const tamperedRender = Bun.spawn(
    [
      "bun",
      "run",
      resolve(import.meta.dir, "funeral.ts"),
      "--render-existing",
      tamperedPath,
      "--markdown-out",
      join(home, "tampered.md"),
    ],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  const tamperedExit = await tamperedRender.exited;
  const tamperedStderr =
    tamperedRender.stderr === undefined ? "" : await new Response(tamperedRender.stderr).text();
  expect(tamperedExit).toBe(2);
  expect(tamperedStderr).toContain("source archive manifest digest is invalid");
});
