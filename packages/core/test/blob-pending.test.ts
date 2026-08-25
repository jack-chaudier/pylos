import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBlobPromotion,
  createImportStage,
  MAX_BLOB_PENDING_STAGES,
  MAX_BLOB_PROMOTION_ENTRIES,
  recoverBlobPromotions,
  stageBlobBytesForPromotion,
} from "../src/blob-pending.ts";

const homes: string[] = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function objectsFixture(): string {
  const home = mkdtempSync(join(tmpdir(), "pylos-pending-limits-"));
  homes.push(home);
  const objects = join(home, "objects");
  mkdirSync(objects, { mode: 0o700 });
  return objects;
}

test("promotion recovery rejects a full pending root before collecting stages", () => {
  const objects = objectsFixture();
  const root = join(objects, ".pending");
  const importRoot = join(objects, ".import-pending");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(importRoot, { mode: 0o700 });
  for (let index = 0; index < MAX_BLOB_PENDING_STAGES; index += 1) {
    mkdirSync(join(root, `import-999999-${index}`), { mode: 0o700 });
    mkdirSync(join(importRoot, `import-999999-${index}`), { mode: 0o700 });
  }
  expect(() => createBlobPromotion(objects)).toThrow(/pending blob promotion stages exceed bounded capacity/);
  expect(() => createImportStage(objects)).toThrow(/pending import stages exceed bounded capacity/);
  mkdirSync(join(root, `import-999999-${MAX_BLOB_PENDING_STAGES}`), { mode: 0o700 });
  expect(() => recoverBlobPromotions(objects, () => null)).toThrow(
    /pending blob stages exceed bounded capacity/,
  );
});

test("promotion recovery rejects a sparse oversized committed marker before reading it", () => {
  const objects = objectsFixture();
  const dir = join(objects, ".pending", "import-999999-marker");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const marker = join(dir, ".committed");
  writeFileSync(marker, "", { mode: 0o600 });
  truncateSync(marker, 64 * 1024 * 1024);
  expect(() => recoverBlobPromotions(objects, () => null)).toThrow(/invalid committed blob promotion marker/);
});

test("promotion writer rejects an overfull staged object map before writing another file", () => {
  const objects = objectsFixture();
  const promotion = createBlobPromotion(objects);
  const staged = promotion.staged as Map<string, number>;
  for (let index = 0; index < MAX_BLOB_PROMOTION_ENTRIES; index += 1) {
    staged.set(index.toString(16).padStart(64, "0"), 0);
  }
  const bytes = new TextEncoder().encode("one more");
  const hash = "f".repeat(64);
  expect(() => stageBlobBytesForPromotion(promotion, bytes, hash)).toThrow(
    /blob promotion entries exceed bounded capacity/,
  );
  rmSync(promotion.dir, { recursive: true, force: true });
});
