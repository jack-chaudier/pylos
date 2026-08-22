import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/auth/store.ts";
import { AuthService, XAI_CLIENT_ID } from "../src/auth/xai.ts";

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
    await auth.setApiKey("anthropic", "sk-ant-abcdefghijklmnop");
    const info = await stat(join(home, "auth.json"));
    expect(info.mode & 0o777).toBe(0o600);
  });

  test("status masks the key and never returns it", async () => {
    const auth = service();
    const status = await auth.setApiKey("openai", "sk-proj-supersecretvalue");
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
    const status = await auth.setApiKey(
      "openai-compatible",
      "key-123456",
      "https://example.test/v1/",
    );
    expect(status.ok).toBe(true);
    expect(await auth.baseUrl("openai-compatible")).toBe("https://example.test/v1");
  });
});

describe("the xAI device flow", () => {
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
});
