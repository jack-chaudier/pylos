import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthStatus, type Episode, MAX_THREAD_BUDGET, type Me, type ThreadStats } from "@pylos/protocol";
import { clientKey, HeavyOperationGate, MAX_RATE_LIMIT_KEYS, TokenBucket } from "../src/limits.ts";
import { RAW_IMPORT_CONTENT_TYPE, RAW_IMPORT_PASSPHRASE_HEADER } from "../src/serve.ts";
import { staticSite } from "../src/static.ts";
import { HOSTED_ORIGIN, type HostedHarness, hostedHarness, jsonPost, withSession } from "./harness.ts";

let h: HostedHarness;

beforeAll(async () => {
  h = await hostedHarness();
});

afterAll(async () => {
  await h.dispose();
});

describe("signing in with xAI", () => {
  test("start hands back a user code and never the device code", async () => {
    const started = await h.json<Record<string, unknown>>("/api/login/xai/start", jsonPost({}));
    expect(started.userCode).toBe("WXYZ-1234");
    expect(started.verificationUrl).toBe("https://x.ai/device");
    expect(started.verificationUrlComplete).toBe("https://x.ai/device?code=WXYZ-1234");
    expect(started.expiresIn).toBe(600);
    expect(JSON.stringify(started)).not.toContain("dc-");
  });

  test("poll mints a session and identifies the account", async () => {
    const { session, me } = await h.login("sub-alpha", { name: "Alpha", email: "alpha@example.com" });
    expect(session.length).toBeGreaterThan(32);
    expect(me).toMatchObject({ hosted: true, sub: "sub-alpha", name: "Alpha", email: "alpha@example.com" });

    const identity = await h.json<Me>("/api/me", {}, session);
    expect(identity.sub).toBe("sub-alpha");
    expect(identity.hosted).toBe(true);
  });

  test("the user's own xAI credential lands in their auth.json", async () => {
    const { session } = await h.login("sub-cred");
    const user = h.registry.resolve(session);
    expect(user).toBeDefined();
    expect(existsSync(join(user?.dir ?? "", "auth.json"))).toBe(true);

    const statuses = await h.json<AuthStatus[]>("/api/auth", {}, session);
    const xai = statuses.find((status) => status.provider === "xai");
    expect(xai?.mode).toBe("device");
    expect(xai?.ok).toBe(true);
    expect(JSON.stringify(statuses)).not.toContain("rt-sub-cred");
  });

  test("an unknown handle is refused", async () => {
    const response = await h.fetch("/api/login/xai/poll", jsonPost({ handle: "nope" }));
    expect(response.status).toBe(410);
  });
});

describe("session guards", () => {
  test("no bearer is a 401", async () => {
    const response = await h.fetch("/api/threads");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "no_session" });
  });

  test("an unknown bearer is a 401", async () => {
    const response = await h.fetch("/api/me", withSession({}, "not-a-session"));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "invalid_session" });
  });

  test("logout revokes the session", async () => {
    const { session } = await h.login("sub-logout");
    expect((await h.fetch("/api/me", withSession({}, session))).status).toBe(200);
    const out = await h.fetch("/api/logout", withSession(jsonPost({}), session));
    expect(out.status).toBe(200);
    expect((await h.fetch("/api/me", withSession({}, session))).status).toBe(401);
  });

  test("health is public and does not leak the home path", async () => {
    const body = await h.json<Record<string, unknown>>("/api/health");
    expect(body).toEqual({ ok: true, version: expect.any(String), hosted: true });
    expect(JSON.stringify(body)).not.toContain(h.home);
  });

  test("a foreign origin cannot mutate, even with a session", async () => {
    const { session } = await h.login("sub-origin");
    const response = await h.fetch("/api/threads", {
      ...withSession(jsonPost({}), session),
      headers: {
        "Content-Type": "application/json",
        origin: "https://evil.example",
        Authorization: `Bearer ${session}`,
      },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "origin_denied" });
  });

  test("a literal null Origin is rejected even with a bearer", async () => {
    const { session } = await h.login("sub-cli");
    const read = await h.fetch("/api/health", {
      headers: { origin: "null", Authorization: `Bearer ${session}` },
    });
    expect(read.status).toBe(403);
    expect(read.headers.get("access-control-allow-origin")).toBeNull();

    const denied = await h.fetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json", origin: "null" },
      body: "{}",
    });
    expect(denied.status).toBe(403);

    const preflight = await h.fetch("/api/threads", {
      method: "OPTIONS",
      headers: { origin: "null" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const stillDenied = await h.fetch("/api/threads", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: "null",
        Authorization: `Bearer ${session}`,
      },
      body: "{}",
    });
    expect(stillDenied.status).toBe(403);
  });

  test("CORS reflects only a configured origin and never grants credentials", async () => {
    const preflight = await h.fetch("/api/threads", { method: "OPTIONS" });
    expect(preflight.headers.get("access-control-allow-origin")).toBe(HOSTED_ORIGIN);
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();

    const foreign = await h.fetch("/api/health", { headers: { origin: "https://evil.example" } });
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a non-loopback Host is fine when hosted", async () => {
    const response = await h.fetch("/api/health", { headers: { host: "pylos.example.com" } });
    expect(response.status).toBe(200);
  });
});

describe("one vault per account", () => {
  test("two users never see each other's threads", async () => {
    const a = await h.login("sub-one");
    const b = await h.login("sub-two");

    const threadA = await h.json<ThreadStats>("/api/threads", jsonPost({ title: "A" }), a.session);
    const threadB = await h.json<ThreadStats>("/api/threads", jsonPost({ title: "B" }), b.session);

    const listA = await h.json<ThreadStats[]>("/api/threads", {}, a.session);
    const listB = await h.json<ThreadStats[]>("/api/threads", {}, b.session);
    expect(listA.map((thread) => thread.threadId)).toContain(threadA.threadId);
    expect(listA.map((thread) => thread.threadId)).not.toContain(threadB.threadId);
    expect(listB.map((thread) => thread.threadId)).not.toContain(threadA.threadId);

    const denied = await h.fetch(`/api/threads/${threadB.threadId}`, withSession({}, a.session));
    expect(denied.status).toBe(404);
  });

  test("each account gets its own vault directory", async () => {
    const a = await h.login("sub-dir-a");
    const b = await h.login("sub-dir-b");
    const dirA = h.registry.resolve(a.session)?.dir ?? "";
    const dirB = h.registry.resolve(b.session)?.dir ?? "";
    expect(dirA).not.toBe(dirB);
    expect(dirA.startsWith(join(h.home, "users"))).toBe(true);

    await h.json<ThreadStats>("/api/threads", jsonPost({}), a.session);
    expect(existsSync(join(dirA, "vault.sqlite"))).toBe(true);
    expect(existsSync(join(dirA, "auth.json"))).toBe(true);
  });

  test("an API key set by one account is invisible to the other", async () => {
    const a = await h.login("sub-key-a");
    const b = await h.login("sub-key-b");
    await h.fetch(
      "/api/auth/openai/api-key",
      withSession(jsonPost({ apiKey: "sk-test-abcdefgh" }), a.session), // scan-secrets:allow (fixture)
    );
    const statusesA = await h.json<AuthStatus[]>("/api/auth", {}, a.session);
    const statusesB = await h.json<AuthStatus[]>("/api/auth", {}, b.session);
    expect(statusesA.find((status) => status.provider === "openai")?.ok).toBe(true);
    expect(statusesB.find((status) => status.provider === "openai")?.mode).toBe("none");
  });

  test("a turn runs against the signed-in user's vault and streams unbuffered", async () => {
    const { session } = await h.login("sub-turn");
    const thread = await h.json<ThreadStats>("/api/threads", jsonPost({}), session);
    h.provider.reply("Hosted answer.");

    const response = await h.fetch(`/api/threads/${thread.threadId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
      body: JSON.stringify({ text: "hello host" }),
    });
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("cache-control")).toContain("no-cache");

    const events = await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "again" }, session);
    expect(events.at(-1)?.type).toBe("done");

    const episodes = await h.json<Episode[]>(`/api/threads/${thread.threadId}/episodes`, {}, session);
    expect(episodes.some((episode) => episode.content === "hello host")).toBe(true);
  });

  test("the gateway takes the session as its API key", async () => {
    const { session } = await h.login("sub-gateway");
    h.provider.reply("Gateway answer.");
    const response = await h.fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
      body: JSON.stringify({ model: "grok-4.6", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe("Gateway answer.");

    const anonymous = await h.fetch("/v1/chat/completions", jsonPost({ messages: [] }));
    expect(anonymous.status).toBe(401);
  });
});

describe("hosted provider endpoint boundary", () => {
  test("authenticated users cannot configure server-side gateway targets", async () => {
    const local = await hostedHarness();
    const { session } = await local.login("sub-provider-ssrf");
    const targets = [
      "http://127.0.0.1:11434/v1",
      "http://[::1]:11434/v1",
      "http://10.0.0.8/v1",
      "http://172.16.0.8/v1",
      "http://192.168.0.8/v1",
      "http://169.254.169.254/latest/meta-data",
      "https://user:password@example.test/v1",
      "file:///etc/passwd",
      "ftp://example.test/v1",
      "https://public.example.test/redirect-to-127.0.0.1",
      "https://rebind.example.test/v1",
    ];

    try {
      for (const baseUrl of targets) {
        const response = await local.fetch(
          "/api/auth/openai-compatible/api-key",
          withSession(jsonPost({ apiKey: "key-123456", baseUrl }), session),
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "hosted_provider_forbidden" });
      }

      for (const model of ["ollama/llama3", "openai-compatible/redirecting-model"]) {
        const response = await local.fetch(
          "/v1/chat/completions",
          withSession(jsonPost({ model, messages: [{ role: "user", content: "hello" }] }), session),
        );
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "hosted_provider_forbidden" });
      }

      const catalogue = await local.json<{ data: Array<{ owned_by: string }> }>("/v1/models", {}, session);
      expect(catalogue.data.some((model) => model.owned_by === "ollama")).toBe(false);
      expect(catalogue.data.some((model) => model.owned_by === "openai-compatible")).toBe(false);
    } finally {
      await local.dispose();
    }
  });
});

describe("limits", () => {
  test("fresh forwarded client keys cannot grow one rate limiter past 8192", () => {
    let now = 0;
    const bucket = new TokenBucket(1, 60_000, () => now);
    const proxy = { requestIP: () => ({ address: "127.0.0.1" }) };
    const requestFor = (key: string): Request =>
      new Request("https://pylos.test/api/login/xai/start", { headers: { "x-forwarded-for": key } });

    let accepted = 0;
    for (let index = 0; index < MAX_RATE_LIMIT_KEYS; index += 1) {
      const request = requestFor(`198.51.${Math.floor(index / 256)}.${index % 256}`);
      if (bucket.take(clientKey(request, proxy))) accepted += 1;
    }
    expect(accepted).toBe(MAX_RATE_LIMIT_KEYS);
    expect(bucket.take(clientKey(requestFor("203.0.113.254"), proxy))).toBe(false);

    // A direct public peer cannot manufacture new keys with X-Forwarded-For.
    const publicPeer = { requestIP: () => ({ address: "203.0.113.9" }) };
    expect(clientKey(requestFor("10.0.0.1"), publicPeer)).toBe("203.0.113.9");

    now += 60_000;
    expect(bucket.take(clientKey(requestFor("203.0.113.254"), proxy))).toBe(true);
  });

  test("a huge budget is rejected before the hosted lane or archive mutation", async () => {
    const local = await hostedHarness();
    try {
      const { session } = await local.login("sub-budget-boundary");
      const thread = await local.json<ThreadStats>("/api/threads", jsonPost({}), session);
      for (let i = 0; i < 40; i += 1) {
        local.provider.reply(`archive reply ${i}`);
        await local.sse(
          `/api/threads/${thread.threadId}/turn`,
          { text: `archive turn ${i}`, budget: 1_024 },
          session,
        );
      }
      const before = await local.json<ThreadStats>(`/api/threads/${thread.threadId}`, {}, session);
      expect(before.turns).toBeGreaterThanOrEqual(80);

      const user = local.registry.resolve(session);
      expect(user).toBeDefined();
      const contextLease = await local.registry.acquire(user as NonNullable<typeof user>);
      const kernel = contextLease.context.kernel;
      const originalEnter = kernel.enterTurn;
      let entered = 0;
      kernel.enterTurn = (threadId) => {
        entered += 1;
        return originalEnter.call(kernel, threadId);
      };
      contextLease.release();
      try {
        const response = await local.fetch(
          `/api/threads/${thread.threadId}/turn`,
          withSession(jsonPost({ text: "must not compile", budget: MAX_THREAD_BUDGET + 1 }), session),
        );
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({ code: "budget_too_large" });
        expect(entered).toBe(0);

        const afterRejected = await local.json<ThreadStats>(`/api/threads/${thread.threadId}`, {}, session);
        expect(afterRejected.turns).toBe(before.turns);

        local.provider.reply("the lane recovered");
        const recovered = await local.sse(
          `/api/threads/${thread.threadId}/turn`,
          { text: "valid follow-up", budget: 1_024 },
          session,
        );
        expect(recovered.at(-1)?.type).toBe("done");
      } finally {
        kernel.enterTurn = originalEnter;
      }
    } finally {
      await local.dispose();
    }
  }, 20_000);

  test("a second heavy request for one subject is refused before its handler enters", async () => {
    const local = await hostedHarness({ heavy: new HeavyOperationGate(1, 4) });
    try {
      const { session } = await local.login("sub-heavy-serial");
      const thread = await local.json<ThreadStats>("/api/threads", jsonPost({}), session);
      const held = local.registry.heavy.tryAcquire("sub-heavy-serial");
      expect(held).toBeDefined();
      const acquire = local.registry.acquire;
      let entered = 0;
      local.registry.acquire = async (user) => {
        entered += 1;
        return acquire.call(local.registry, user);
      };
      try {
        const light = await local.fetch("/api/me", withSession({}, session));
        expect(light.status).toBe(200);
        const requests = [
          [`/api/threads/${thread.threadId}/verify`, jsonPost({})],
          [`/api/threads/${thread.threadId}/forget`, jsonPost({})],
          [`/api/threads/${thread.threadId}/demo`, jsonPost({})],
          [`/api/threads/${thread.threadId}/export`, jsonPost({ passphrase: "heavy-passphrase" })],
        ] as const;
        for (const [path, init] of requests) {
          const response = await local.fetch(path, withSession(init, session));
          expect(response.status).toBe(429);
          expect(await response.json()).toMatchObject({ code: "heavy_busy" });
        }
        expect(entered).toBe(0);
      } finally {
        local.registry.acquire = acquire;
        held?.release();
      }
    } finally {
      await local.dispose();
    }
  });

  test("the global heavy cap refuses a different subject before its handler enters", async () => {
    const local = await hostedHarness({ heavy: new HeavyOperationGate(1, 1) });
    try {
      const { session } = await local.login("sub-heavy-global");
      const thread = await local.json<ThreadStats>("/api/threads", jsonPost({}), session);
      const held = local.registry.heavy.tryAcquire("another-subject");
      expect(held).toBeDefined();
      const acquire = local.registry.acquire;
      let entered = 0;
      local.registry.acquire = async (user) => {
        entered += 1;
        return acquire.call(local.registry, user);
      };
      try {
        const response = await local.fetch(
          `/api/threads/${thread.threadId}/verify`,
          withSession(jsonPost({}), session),
        );
        expect(response.status).toBe(429);
        expect(await response.json()).toMatchObject({ code: "heavy_busy" });
        expect(entered).toBe(0);
      } finally {
        local.registry.acquire = acquire;
        held?.release();
      }
    } finally {
      await local.dispose();
    }
  });

  test("a failed heavy route releases its subject lease", async () => {
    const local = await hostedHarness({ heavy: new HeavyOperationGate(1, 1) });
    try {
      const { session } = await local.login("sub-heavy-failure");
      const thread = await local.json<ThreadStats>("/api/threads", jsonPost({}), session);
      const user = local.registry.resolve(session);
      expect(user).toBeDefined();
      const contextLease = await local.registry.acquire(user as NonNullable<typeof user>);
      const kernel = contextLease.context.kernel;
      const verify = kernel.verify;
      let fail = true;
      kernel.verify = async (threadId) => {
        if (fail) {
          fail = false;
          throw new Error("verify fixture failure");
        }
        return verify.call(kernel, threadId);
      };
      contextLease.release();
      try {
        const first = await local.fetch(
          `/api/threads/${thread.threadId}/verify`,
          withSession(jsonPost({}), session),
        );
        expect(first.status).toBe(500);
        const second = await local.fetch(
          `/api/threads/${thread.threadId}/verify`,
          withSession(jsonPost({}), session),
        );
        expect(second.status).toBe(200);
      } finally {
        kernel.verify = verify;
      }
    } finally {
      await local.dispose();
    }
  });

  test("cancelling an export releases the heavy lease", async () => {
    const local = await hostedHarness({ heavy: new HeavyOperationGate(1, 1) });
    try {
      const { session } = await local.login("sub-heavy-cancel");
      const thread = await local.json<ThreadStats>("/api/threads", jsonPost({}), session);
      const exportRequest = (): Promise<Response> =>
        local.fetch(
          `/api/threads/${thread.threadId}/export`,
          withSession(jsonPost({ passphrase: "heavy-passphrase" }), session),
        );
      const first = await exportRequest();
      expect(first.status).toBe(200);
      await first.body?.cancel("client disconnected");
      const second = await exportRequest();
      expect(second.status).toBe(200);
      await second.body?.cancel("test cleanup");
    } finally {
      await local.dispose();
    }
  });

  test("a failed raw import releases the heavy lease for the next upload", async () => {
    const local = await hostedHarness({ heavy: new HeavyOperationGate(1, 1) });
    try {
      const { session } = await local.login("sub-heavy-import");
      const importRequest = (): Promise<Response> =>
        local.fetch("/api/import", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session}`,
            "Content-Type": RAW_IMPORT_CONTENT_TYPE,
            [RAW_IMPORT_PASSPHRASE_HEADER]: Buffer.from("heavy-passphrase").toString("base64url"),
          },
          body: Uint8Array.of(0x00, 0x01, 0x02),
        });
      const first = await importRequest();
      expect(first.status).not.toBe(429);
      await first.arrayBuffer();
      const second = await importRequest();
      expect(second.status).not.toBe(429);
      await second.arrayBuffer();
    } finally {
      await local.dispose();
    }
  });

  test("turns are capped per account", async () => {
    const local = await hostedHarness();
    const { session } = await local.login("sub-busy");
    const send = (): Promise<Response> =>
      local.fetch("/v1/chat/completions", withSession(jsonPost({ messages: [] }), session));
    for (let i = 0; i < 64; i += 1) {
      const response = await send();
      expect(response.status).toBe(400); // no user message; the token is spent all the same
    }
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited" });
    await local.dispose();
  }, 20_000);

  test("sign-in attempts are capped per address", async () => {
    const local = await hostedHarness();
    for (let i = 0; i < 20; i += 1) {
      expect((await local.fetch("/api/login/xai/start", jsonPost({}))).status).toBe(200);
    }
    const limited = await local.fetch("/api/login/xai/start", jsonPost({}));
    expect(limited.status).toBe(429);
    await local.dispose();
  });

  test("polling a sign-in that is in flight does not spend the address's attempts", async () => {
    const local = await hostedHarness();
    local.holdGrant(true);
    const address = "203.0.113.7";
    const start = (): Promise<Response> => local.fetch("/api/login/xai/start", jsonPost({}), address);
    const started = await start();
    const { handle } = (await started.json()) as { handle: string };
    const poll = (): Promise<Response> => local.fetch("/api/login/xai/poll", jsonPost({ handle }), address);

    // 40 polls: twice the per-address cap, all of them for a handle we issued.
    for (let i = 0; i < 40; i += 1) {
      const response = await poll();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ pending: true });
    }
    local.holdGrant(false);
    expect((await poll()).status).toBe(200);
    // The address spent one start and no polls, so it can still begin a sign-in.
    expect((await start()).status).toBe(200);
    await local.dispose();
  }, 20_000);

  test("polling a handle nobody started counts against the address", async () => {
    const local = await hostedHarness();
    const address = "203.0.113.8";
    const poll = (): Promise<Response> =>
      local.fetch("/api/login/xai/poll", jsonPost({ handle: "nope" }), address);
    for (let i = 0; i < 20; i += 1) expect((await poll()).status).toBe(410);
    expect((await poll()).status).toBe(429);
    await local.dispose();
  });

  test("an oversized JSON body is refused", async () => {
    const { session } = await h.login("sub-fat");
    const thread = await h.json<ThreadStats>("/api/threads", jsonPost({}), session);
    const response = await h.fetch(`/api/threads/${thread.threadId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
      body: JSON.stringify({ text: "x".repeat(1_100_000) }),
    });
    expect(response.status).toBe(413);
  });
});

describe("serving the app", () => {
  let base: string;
  let site: HostedHarness;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "pylos-web-"));
    const web = join(base, "dist");
    await mkdir(join(web, "assets"), { recursive: true });
    await writeFile(join(web, "index.html"), "<!doctype html><title>Pylos</title>");
    await writeFile(join(web, "assets", "app.js"), "export const ok = 1;\n");
    await writeFile(join(base, "secret.txt"), "not for the web");
    await symlink(join(base, "secret.txt"), join(web, "assets", "escape.js"));
    site = await hostedHarness({ web });
  });

  afterAll(async () => {
    await site.dispose();
    await rm(base, { recursive: true, force: true });
  });

  test("the root redirects to the app", async () => {
    const response = await site.fetch("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/app/");
  });

  test("index.html carries the content security policy and is never cached", async () => {
    const response = await site.fetch("/app/");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Pylos");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  test("assets are immutable and typed", async () => {
    const response = await site.fetch("/app/assets/app.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toContain("javascript");
  });

  test("an unknown path falls back to the app shell", async () => {
    const response = await site.fetch("/app/threads/abc/xray");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Pylos");
  });

  test("traversal cannot escape the directory", async () => {
    // A literal `../` is normalized away by URL parsing; an encoded slash is not,
    // which is the case the resolver has to refuse.
    const sibling = await site.fetch("/app/..%2fsecret.txt");
    expect(sibling.status).toBe(404);
    expect(await sibling.text()).not.toContain("not for the web");
    expect((await site.fetch("/app/..%2f..%2fetc%2fpasswd")).status).toBe(404);
    expect((await site.fetch("/app/%2e%2e%2fsecret.txt")).status).toBe(404);
  });

  test("symlinked assets and index files are refused", async () => {
    const asset = await site.fetch("/app/assets/escape.js");
    expect(asset.status).toBe(404);
    expect(await asset.text()).not.toContain("not for the web");

    const linkedRoot = join(base, "linked-dist");
    await mkdir(linkedRoot, { recursive: true });
    await symlink(join(base, "secret.txt"), join(linkedRoot, "index.html"));
    const linked = staticSite(linkedRoot);
    const index = await linked.handle(new URL("http://127.0.0.1:7334/app/"), "GET");
    expect(index?.status).toBe(404);
    expect(await index?.text()).not.toContain("not for the web");
  });

  test("literal null Origin cannot reach hosted static assets", async () => {
    const response = await site.fetch("/app/", { headers: { origin: "null" } });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Pylos");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("the API still answers under a static site", async () => {
    expect((await site.fetch("/api/health")).status).toBe(200);
    expect((await site.fetch("/api/threads")).status).toBe(401);
  });
});
