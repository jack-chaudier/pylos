import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const indexPath = resolve(import.meta.dir, "..", "index.html");

describe("app entry document", () => {
  test("keeps the React mount and gives no-JavaScript users a local start path", async () => {
    const html = await readFile(indexPath, "utf8");

    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
    expect(html).toContain("The conversation needs JavaScript to open.");
    expect(html).toContain("pylos serve");
    expect(html).toContain("http://127.0.0.1:7334/api/health");
    expect(html).toContain("interactive proof thread");
  });
});
