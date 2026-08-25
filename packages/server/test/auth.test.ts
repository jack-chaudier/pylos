import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/auth/store.ts";
import { AuthService, MAX_GROK_CLI_AUTH_BYTES, MAX_PENDING_DEVICES, XAI_CLIENT_ID } from "../src/auth/xai.ts";
import { createContext } from "../src/context.ts";
import { authPath } from "../src/home.ts";
import { MAX_PROVIDER_JSON_BODY_BYTES } from "../src/providers/openai-chat.ts";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "pylos-auth-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function service(fetcher?: (url: string, init?: RequestInit) => Promise<Response>): AuthService {
  return new AuthService({
    store: new CredentialStore(join(home, "auth.json")),
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
  });
}

describe("credential custody", () => {
  test("the auth file is written 0600", async () => {
    const auth = service();
    await auth.setApiKey("anthropic", "sk-ant-abcdefghijklmnop"); // scan-secrets:allow (fixture)
    const info = await stat(join(home, "auth.json"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("status masks the key and never returns it", async () => {
    const auth = service();
    const status = await auth.setApiKey("openai", "sk-proj-supersecretvalue"); // scan-secrets:allow (fixture)
    expect(status.identity).toBe("sk-••••alue");
    expect(JSON.stringify(await auth.statuses())).not.toContain("supersecretvalue");
  });

  test("the token is available to providers but not to status", async () => {
    const auth = service();
    await auth.setApiKey("xai", "xai-abcdefghijklmnop");
    expect(await auth.token("xai")).toBe("xai-abcdefghijklmnop");
    const statuses = await auth.statuses();
    expect(JSON.stringify(statuses)).not.toContain("abcdefghijklmnop");
  });

  test("ollama needs no credential", async () => {
    const auth = service();
    expect(await auth.configured("ollama")).toBe(true);
    const status = await auth.status("ollama");
    expect(status.mode).toBe("local");
  });

  test("openai-compatible requires a base URL", async () => {
    const auth = service();
    await expect(auth.setApiKey("openai-compatible", "key-123456")).rejects.toThrow();
    const status = await auth.setApiKey("openai-compatible", "key-123456", "https://example.test/v1/");
    expect(status.ok).toBe(true);
    expect(await auth.baseUrl("openai-compatible")).toBe("https://example.test/v1");
  });

  test("local mode preserves explicitly configured loopback gateways", async () => {
    const auth = service();
    const status = await auth.setApiKey("openai-compatible", "key-123456", "http://127.0.0.1:8080/v1/");
    expect(status.ok).toBe(true);
    expect(await auth.baseUrl("openai-compatible")).toBe("http://127.0.0.1:8080/v1");
  });
});

describe("a profile owns its credentials", () => {
  test("`--home DIR` keeps the credential file in DIR, 0600", async () => {
    const context = await createContext({ home });
    try {
      expect(context.auth.store.path).toBe(join(home, "auth.json"));
      await context.auth.setApiKey("openai", "sk-proj-profile-scoped"); // scan-secrets:allow (fixture)
      const info = await stat(join(home, "auth.json"));
      expect(info.mode & 0o777).toBe(0o600);
    } finally {
      await context.kernel.close();
    }
  });

  test("PYLOS_AUTH_PATH still wins, and no home means the profile in the environment", () => {
    expect(authPath({ PYLOS_AUTH_PATH: "/somewhere/else/auth.json" }, home)).toBe(
      "/somewhere/else/auth.json",
    );
    expect(authPath({}, home)).toBe(join(home, "auth.json"));
    expect(authPath({ PYLOS_HOME: "/profiles/one" })).toBe(join("/profiles/one", "auth.json"));
  });
});

describe("the xAI device flow", () => {
  test("abandoned device grants cannot exceed 8192 pending entries", async () => {
    let now = 0;
    let requests = 0;
    const auth = new AuthService({
      store: new CredentialStore(join(home, "pending-auth.json")),
      now: () => now,
      fetch: async () => {
        requests += 1;
        return Response.json({
          device_code: `device-${requests}`,
          user_code: "ABCD-EFGH",
          verification_uri: "https://x.ai/device",
          expires_in: 600,
          interval: 5,
        });
      },
    });

    for (let index = 0; index < MAX_PENDING_DEVICES; index += 1) await auth.startDevice();
    await expect(auth.startDevice()).rejects.toMatchObject({ code: "auth_busy", status: 429 });
    expect(requests).toBe(MAX_PENDING_DEVICES);

    now += 600_000;
    await expect(auth.startDevice()).resolves.toMatchObject({ userCode: "ABCD-EFGH" });
    expect(requests).toBe(MAX_PENDING_DEVICES + 1);
  });

  test("an in-flight device grant reserves the final pending slot", async () => {
    let requests = 0;
    let releaseResponse: ((response: Response) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const heldResponse = new Promise<Response>((resolve) => {
      releaseResponse = resolve;
    });
    const response = (): Response =>
      Response.json({
        device_code: `device-${requests}`,
        user_code: "ABCD-EFGH",
        verification_uri: "https://x.ai/device",
        expires_in: 600,
        interval: 5,
      });
    const auth = new AuthService({
      store: new CredentialStore(join(home, "pending-race-auth.json")),
      fetch: async () => {
        requests += 1;
        if (requests !== MAX_PENDING_DEVICES) return response();
        markStarted?.();
        return heldResponse;
      },
    });

    for (let index = 1; index < MAX_PENDING_DEVICES; index += 1) await auth.startDevice();
    const finalSlot = auth.startDevice();
    await started;
    await expect(auth.startDevice()).rejects.toMatchObject({ code: "auth_busy", status: 429 });
    expect(requests).toBe(MAX_PENDING_DEVICES);
    releaseResponse?.(response());
    await expect(finalSlot).resolves.toMatchObject({ userCode: "ABCD-EFGH" });
  });

  test("start returns a user code and never the device code", async () => {
    const auth = service(async (url) => {
      expect(url).toBe("https://auth.x.ai/oauth2/device/code");
      return Response.json({
        device_code: "SECRET-DEVICE-CODE",
        user_code: "ABCD-EFGH",
        verification_uri: "https://x.ai/device",
        verification_uri_complete: "https://x.ai/device?code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      });
    });
    const started = await auth.startDevice();
    expect(started.userCode).toBe("ABCD-EFGH");
    expect(JSON.stringify(started)).not.toContain("SECRET-DEVICE-CODE");
  });

  test("an oversized fragmented OAuth body is refused and cancelled", async () => {
    let chunks = 0;
    let cancelled = false;
    const auth = service(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunks += 1;
          controller.enqueue(new Uint8Array(64 * 1024).fill(120));
          if (chunks >= 20) controller.close();
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      });
      return new Response(body, { status: 200 });
    });

    await expect(auth.startDevice()).rejects.toMatchObject({ code: "invalid_response", status: 502 });
    expect(MAX_PROVIDER_JSON_BODY_BYTES).toBe(1024 * 1024);
    expect(chunks).toBeLessThanOrEqual(18);
    expect(cancelled).toBe(true);
  });

  test("an auth fetcher that never returns headers is bounded", async () => {
    const auth = new AuthService({
      store: new CredentialStore(join(home, "auth.json")),
      fetch: () => new Promise<Response>(() => {}),
      headerTimeoutMs: 25,
    });
    await expect(auth.startDevice()).rejects.toMatchObject({
      code: "auth_unavailable",
      status: 502,
      message: "Unable to reach xAI authentication.",
    });
  });

  test("stalled userinfo JSON returns an empty profile without awaiting cancellation", async () => {
    let pulls = 0;
    let cancelled = false;
    const auth = service(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(new TextEncoder().encode('{"name":"Ada"'));
            return;
          }
          return new Promise<void>(() => {});
        },
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {});
        },
      });
      return new Response(body, { status: 200 });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("stalled userinfo held the auth flow open")), 1500);
    });
    try {
      expect(await Promise.race([auth.userInfo("access-token"), timeout])).toEqual({});
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    expect(cancelled).toBe(true);
  });

  test("poll reports pending, then connects and stores the token", async () => {
    let calls = 0;
    const auth = new AuthService({
      store: new CredentialStore(join(home, "auth.json")),
      now: () => 1_000_000 + calls * 10_000,
      fetch: async (url, init) => {
        if (url.endsWith("/device/code")) {
          return Response.json({
            device_code: "dc",
            user_code: "AAAA-BBBB",
            verification_uri: "https://x.ai/device",
            expires_in: 600,
            interval: 5,
          });
        }
        const body = String((init?.body as URLSearchParams | undefined)?.toString() ?? "");
        expect(body).toContain(XAI_CLIENT_ID);
        calls += 1;
        if (calls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
        return Response.json({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3600,
        });
      },
    });
    const started = await auth.startDevice();
    expect(await auth.pollDevice(started.handle)).toEqual({ pending: true });
    const status = await auth.pollDevice(started.handle);
    expect("provider" in status && status.provider).toBe("xai");
    expect("mode" in status && status.mode).toBe("device");
    expect(await auth.token("xai")).toBe("at-1");
  });

  test("an expired access token is refreshed once, single-flight", async () => {
    let refreshes = 0;
    const auth = new AuthService({
      store: new CredentialStore(join(home, "auth.json")),
      now: () => 5_000_000,
      fetch: async () => {
        refreshes += 1;
        return Response.json({ access_token: "fresh", refresh_token: "rt-2", expires_in: 3600 });
      },
    });
    await auth.store.set("xai", {
      mode: "oauth",
      accessToken: "stale",
      refreshToken: "rt-1",
      expiresAt: 4_000_000,
    });
    const [a, b] = await Promise.all([auth.token("xai"), auth.token("xai")]);
    expect(a).toBe("fresh");
    expect(b).toBe("fresh");
    expect(refreshes).toBe(1);
  });

  test("invalid_grant clears the credential", async () => {
    const auth = new AuthService({
      store: new CredentialStore(join(home, "auth.json")),
      now: () => 5_000_000,
      fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    await auth.store.set("xai", {
      mode: "oauth",
      accessToken: "stale",
      refreshToken: "rt-1",
      expiresAt: 4_000_000,
    });
    await expect(auth.token("xai")).rejects.toThrow();
    expect(await auth.configured("xai")).toBe(false);
  });
});

describe("importing a Grok CLI login", () => {
  test("adopts the session without echoing the token", async () => {
    const path = join(home, "grok-auth.json");
    await writeFile(
      path,
      JSON.stringify({
        [`https://auth.x.ai::${XAI_CLIENT_ID}`]: {
          key: "eyJhbGciOi.payload.sig",
          auth_mode: "oauth",
          email: "someone@example.com",
          refresh_token: "grok-refresh-token",
          expires_at: "2030-01-01T00:00:00Z",
        },
      }),
    );
    const auth = service();
    expect(await auth.grokCliAvailable(path)).toBe(true);
    const status = await auth.importGrokCli(path);
    expect(status.provider).toBe("xai");
    expect(status.mode).toBe("device");
    expect(status.identity).toBe("s•••@example.com");
    expect(JSON.stringify(status)).not.toContain("grok-refresh-token");
    expect(await auth.token("xai")).toBe("eyJhbGciOi.payload.sig");
  });

  test("a missing file is a clean 404, not a crash", async () => {
    const auth = service();
    expect(await auth.grokCliAvailable(join(home, "nope.json"))).toBe(false);
    await expect(auth.importGrokCli(join(home, "nope.json"))).rejects.toThrow();
  });

  test("an oversized local session is refused before JSON parsing", async () => {
    const path = join(home, "oversized-grok-auth.json");
    await writeFile(path, Buffer.alloc(MAX_GROK_CLI_AUTH_BYTES + 1, 123));
    const auth = service();
    expect(await auth.grokCliAvailable(path)).toBe(false);
    await expect(auth.importGrokCli(path)).rejects.toMatchObject({
      code: "grok_cli_invalid",
      status: 422,
      message: `The Grok CLI login exceeds the ${MAX_GROK_CLI_AUTH_BYTES}-byte limit.`,
    });
    expect(await auth.configured("xai")).toBe(false);
  });
});
