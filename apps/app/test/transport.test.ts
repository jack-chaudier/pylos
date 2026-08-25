import { afterEach, describe, expect, test } from "bun:test";
import { api } from "../src/api.ts";
import { MAX_WEB_BUNDLE_BYTES, saveBytes, streamBundleToFile } from "../src/tauri.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("bundle transport boundaries", () => {
  test("the browser compatibility writer refuses an oversized bundle before creating a Blob", async () => {
    await expect(saveBytes("thread.pylos", new Uint8Array(MAX_WEB_BUNDLE_BYTES + 1))).rejects.toThrow(
      /capped at 64 MiB/,
    );
  });

  test("native file streaming is never silently substituted in a browser", () => {
    expect(() =>
      streamBundleToFile("http://127.0.0.1:7334/export", "/tmp/thread.pylos", "password", null),
    ).toThrow(/desktop shell/);
  });

  test("a browser export rejects promptly when overflow cancellation never settles", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue({ byteLength: MAX_WEB_BUNDLE_BYTES + 1 } as Uint8Array);
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    globalThis.fetch = (async () =>
      ({ ok: true, headers: new Headers(), body }) as Response) as unknown as typeof fetch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("browser cancellation held overflow rejection open")), 250);
    });
    await expect(
      Promise.race([api.exportBundle("thread", "passphrase"), timeout]).finally(() => clearTimeout(timer)),
    ).rejects.toMatchObject({ code: "bundle_too_large", status: 413 });
    expect(cancelled).toBe(true);
  });
});
