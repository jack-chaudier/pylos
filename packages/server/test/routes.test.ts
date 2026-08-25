import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthStatus,
  CapsulePage,
  Episode,
  EpisodeView,
  LedgerPage,
  Me,
  ModelInfo,
  Packet,
  ThreadStats,
  TurnEvent,
} from "@pylos/protocol";
import type { ForgetOutcome } from "../src/kernel.ts";
import { MAX_UPLOAD_BYTES } from "../src/limits.ts";
import {
  checkAttachmentAggregate,
  checkAttachmentMetadata,
  createFetch,
  MAX_ATTACHMENT_FILES,
  RAW_IMPORT_PASSPHRASE_HEADER,
} from "../src/serve.ts";
import { FakeProvider } from "./fake-provider.ts";
import { type Fetcher, type Harness, harness, jsonPost } from "./harness.ts";

let h: Harness;
let provider: FakeProvider;

beforeAll(async () => {
  provider = new FakeProvider();
  h = await harness({ provider });
});

afterAll(async () => {
  await h.dispose();
});

async function newThread(): Promise<ThreadStats> {
  return h.json<ThreadStats>("/api/threads", jsonPost({ title: "Test" }));
}

async function withTransferDeadline<T>(
  key: "PYLOS_TEST_JSON_TRANSFER_DEADLINE_MS" | "PYLOS_TEST_UPLOAD_TRANSFER_DEADLINE_MS",
  milliseconds: number,
  run: () => Promise<T>,
): Promise<T> {
  const priorNodeEnv = process.env.NODE_ENV;
  const prior = process.env[key];
  process.env.NODE_ENV = "test";
  process.env[key] = String(milliseconds);
  try {
    return await run();
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
}

function heartbeatBody(byte = 0x20): ReadableStream<Uint8Array> {
  let interval: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(byte));
      interval = setInterval(() => {
        try {
          controller.enqueue(Uint8Array.of(byte));
        } catch {
          clearInterval(interval);
        }
      }, 10);
    },
    cancel() {
      clearInterval(interval);
    },
  });
}

describe("guards", () => {
  test("health reports the backend", async () => {
    const body = await h.json<{ ok: boolean; version: string; home: string; backend: string }>("/api/health");
    expect(body.ok).toBe(true);
    expect(body.backend).toBe("core");
    expect(body.home).toBe(h.home);
  });

  test("a foreign origin cannot mutate", async () => {
    const response = await h.fetch("/api/threads", {
      ...jsonPost({}),
      headers: { "Content-Type": "application/json", origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "origin_denied" });
  });

  test("a foreign origin is rejected before read-only route or static work", async () => {
    let routeWork = 0;
    const kernel = h.context.kernel;
    const listThreads = kernel.listThreads;
    kernel.listThreads = async () => {
      routeWork += 1;
      return listThreads.call(kernel);
    };
    let staticWork = 0;
    const guarded = createFetch(h.context, {
      site: {
        async handle(): Promise<Response | undefined> {
          staticWork += 1;
          return undefined;
        },
      },
    });
    try {
      const headers = { Origin: "https://evil.example" };
      const route = await guarded(new Request("http://127.0.0.1:7334/api/threads", { headers }));
      const asset = await guarded(new Request("http://127.0.0.1:7334/app/", { headers }));
      expect(route.status).toBe(403);
      expect(asset.status).toBe(403);
    } finally {
      kernel.listThreads = listThreads;
    }
    expect(routeWork).toBe(0);
    expect(staticWork).toBe(0);
  });

  test("literal null Origin is rejected before route or static work", async () => {
    let routeWork = 0;
    const kernel = h.context.kernel;
    const listThreads = kernel.listThreads;
    kernel.listThreads = async () => {
      routeWork += 1;
      return listThreads.call(kernel);
    };
    let staticWork = 0;
    const guarded = createFetch(h.context, {
      site: {
        async handle(): Promise<Response | undefined> {
          staticWork += 1;
          return undefined;
        },
      },
    });
    try {
      const nullHeaders = { Origin: "null" };
      const get = await guarded(new Request("http://127.0.0.1:7334/api/threads", { headers: nullHeaders }));
      const post = await guarded(
        new Request("http://127.0.0.1:7334/api/threads", {
          method: "POST",
          headers: { ...nullHeaders, "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      const asset = await guarded(new Request("http://127.0.0.1:7334/app/", { headers: nullHeaders }));
      const preflight = await guarded(
        new Request("http://127.0.0.1:7334/app/", { method: "OPTIONS", headers: nullHeaders }),
      );
      expect(get.status).toBe(403);
      expect(post.status).toBe(403);
      expect(asset.status).toBe(403);
      expect(preflight.status).toBe(204);
      for (const response of [get, post, asset, preflight]) {
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      }
    } finally {
      kernel.listThreads = listThreads;
    }
    expect(routeWork).toBe(0);
    expect(staticWork).toBe(0);
  });

  test("a foreign origin cannot read", async () => {
    const response = await h.fetch("/api/health", { headers: { origin: "https://evil.example" } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "origin_denied" });
  });

  test("missing Origin and the explicit loopback/Tauri origins stay allowed", async () => {
    const handler = createFetch(h.context);
    const absent = await handler(new Request("http://127.0.0.1:7334/api/health"));
    expect(absent.status).toBe(200);
    const opaque = await handler(
      new Request("http://127.0.0.1:7334/api/health", { headers: { Origin: "null" } }),
    );
    expect(opaque.status).toBe(403);
    for (const origin of [
      "tauri://localhost",
      "http://localhost:5173",
      "http://127.0.0.1:7334",
      "http://[::1]:7334",
    ]) {
      const response = await handler(
        new Request("http://127.0.0.1:7334/api/health", { headers: { Origin: origin } }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
  });

  test("raw import passphrase header is allowed by local CORS preflight", async () => {
    const response = await h.fetch("/api/import", {
      method: "OPTIONS",
      headers: {
        origin: "tauri://localhost",
        "access-control-request-headers": "X-Pylos-Passphrase",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toContain("X-Pylos-Passphrase");
  });

  test("a foreign preflight keeps its 204 response but receives no CORS grant", async () => {
    const response = await h.fetch("/api/threads", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("chunked JSON is bounded while it is being read", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const totalChunks = 32;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === totalChunks) {
          controller.close();
          return;
        }
        pulls += 1;
        controller.enqueue(chunk);
      },
    });
    const response = await h.fetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "payload_too_large" });
    expect(pulls).toBeLessThan(totalChunks);
  });

  test("a JSON body cancel that never resolves cannot hold the 413 open", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("body cancellation held the 413 open")), 250);
    });
    const response = await Promise.race([
      h.fetch("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      timeout,
    ]).finally(() => clearTimeout(timer));
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  test("a JSON body that stalls after a partial chunk is cancelled with 408", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"title":'));
      },
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await h.fetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ code: "request_timeout" });
    expect(cancelled).toBe(true);
  });

  test("a slow-drip upload hits its absolute transfer deadline", async () => {
    const response = await withTransferDeadline("PYLOS_TEST_UPLOAD_TRANSFER_DEADLINE_MS", 100, () =>
      h.fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "multipart/form-data; boundary=slow-drip" },
        body: heartbeatBody(0x2d),
      }),
    );
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ code: "request_timeout" });
  });

  test("a non-loopback Host is refused", async () => {
    const response = await h.fetch("/api/health", { headers: { host: "pylos.example.com" } });
    expect(response.status).toBe(403);
  });

  test("a remote peer cannot spoof a loopback Host on the local server", async () => {
    let staticWork = 0;
    const guarded = createFetch(h.context, {
      site: {
        async handle(): Promise<Response | undefined> {
          staticWork += 1;
          return undefined;
        },
      },
    });
    const remote = await guarded(
      new Request("http://127.0.0.1:7334/api/health", { headers: { Host: "localhost" } }),
      { requestIP: () => ({ address: "192.0.2.1" }) },
    );
    expect(remote.status).toBe(403);
    expect(await remote.json()).toMatchObject({ code: "not_loopback" });
    const remoteAsset = await guarded(
      new Request("http://127.0.0.1:7334/app/", { headers: { Host: "localhost" } }),
      { requestIP: () => ({ address: "192.0.2.1" }) },
    );
    expect(remoteAsset.status).toBe(403);
    expect(staticWork).toBe(0);

    const local = await createFetch(h.context)(
      new Request("http://127.0.0.1:7334/api/health", { headers: { Host: "localhost" } }),
      { requestIP: () => ({ address: "127.0.0.1" }) },
    );
    expect(local.status).toBe(200);
    const ipv6 = await createFetch(h.context)(
      new Request("http://[::1]:7334/api/health", { headers: { Host: "[::1]" } }),
      { requestIP: () => ({ address: "::1" }) },
    );
    expect(ipv6.status).toBe(200);
  });

  test("unknown routes are JSON 404s", async () => {
    const response = await h.fetch("/api/nope");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("the local server has no login and no session", async () => {
    expect(await h.json<Me>("/api/me")).toEqual({ hosted: false });
    expect((await h.fetch("/api/login/xai/start", jsonPost({}))).status).toBe(404);
    expect((await h.fetch("/api/logout", jsonPost({}))).status).toBe(404);
  });

  test("without a built app there are no static routes", async () => {
    expect((await h.fetch("/")).status).toBe(404);
    expect((await h.fetch("/app/")).status).toBe(404);
  });
});

describe("the app, served locally", () => {
  let base: string;
  let local: Harness;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "pylos-local-web-"));
    await writeFile(join(base, "index.html"), "<!doctype html><title>Pylos</title>");
    local = await harness({ web: base });
  });

  afterAll(async () => {
    await local.dispose();
    await rm(base, { recursive: true, force: true });
  });

  test("a headless server hands the UI to the browser at /app/", async () => {
    const root = await local.fetch("/");
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe("/app/");

    const shell = await local.fetch("/app/");
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("Pylos");
    expect(shell.headers.get("content-security-policy")).toContain("default-src 'none'");

    expect((await local.fetch("/api/health")).status).toBe(200);
  });
});

describe("threads and episodes", () => {
  test("create, list, get", async () => {
    const created = await newThread();
    expect(created.turns).toBe(0);
    expect(created.headHash).toMatch(/^[0-9a-f]{64}$/);
    const list = await h.json<ThreadStats[]>("/api/threads");
    expect(list.some((thread) => thread.threadId === created.threadId)).toBe(true);
    const fetched = await h.json<ThreadStats>(`/api/threads/${created.threadId}`);
    expect(fetched.threadId).toBe(created.threadId);
  });

  test("episodes paginate backwards for the virtualized transcript", async () => {
    const thread = await newThread();
    for (let i = 1; i <= 12; i += 1) {
      provider.reply(`answer ${i}`);
      await h.sse(`/api/threads/${thread.threadId}/turn`, { text: `question ${i}` });
    }
    const tail = await h.json<Episode[]>(`/api/threads/${thread.threadId}/episodes?limit=5`);
    expect(tail).toHaveLength(5);
    expect(tail.at(-1)?.seq).toBe(24);
    const older = await h.json<Episode[]>(
      `/api/threads/${thread.threadId}/episodes?before=${tail[0]?.seq}&limit=5`,
    );
    expect(older.at(-1)?.seq).toBe((tail[0]?.seq ?? 0) - 1);
    const after = await h.json<Episode[]>(`/api/threads/${thread.threadId}/episodes?after=20`);
    expect(after[0]?.seq).toBe(21);
  });

  test("the hash chain verifies", async () => {
    const thread = await newThread();
    provider.reply("hello");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "hi" });
    const verified = await h.json<{ ok: boolean; checkedTo: number }>(
      `/api/threads/${thread.threadId}/verify`,
      jsonPost({}),
    );
    expect(verified.ok).toBe(true);
    expect(verified.checkedTo).toBe(2);
  });

  test("thread stats carry the verified frontier only once a verify has passed", async () => {
    const thread = await newThread();
    provider.reply("hello");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "hi" });
    expect((await h.json<ThreadStats>(`/api/threads/${thread.threadId}`)).verifiedTo).toBeUndefined();

    const verified = await h.json<{ ok: boolean; checkedTo: number }>(
      `/api/threads/${thread.threadId}/verify`,
      jsonPost({}),
    );
    expect(verified.ok).toBe(true);
    const after = await h.json<ThreadStats>(`/api/threads/${thread.threadId}`);
    expect(after.verifiedTo).toBe(verified.checkedTo);
    expect(after.verifiedTo).toBe(after.turns);
    const listed = (await h.json<ThreadStats[]>("/api/threads")).find(
      (entry) => entry.threadId === thread.threadId,
    );
    expect(listed?.verifiedTo).toBe(verified.checkedTo);

    // The next turn is not covered by that pass, and the frontier stays honest.
    provider.reply("again");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "more" });
    const later = await h.json<ThreadStats>(`/api/threads/${thread.threadId}`);
    expect(later.verifiedTo).toBe(verified.checkedTo);
    expect(later.turns).toBeGreaterThan(verified.checkedTo);
  });
});

describe("the turn", () => {
  test("a never-producing turn body times out and releases the thread lane", async () => {
    const thread = await newThread();
    const stalledBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
    });
    const stalled = h.fetch(`/api/threads/${thread.threadId}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stalledBody,
    });
    provider.reply("The next turn entered after the stalled ticket was released.");
    const next = h.fetch(
      `/api/threads/${thread.threadId}/turn`,
      jsonPost({ text: "Does the lane still work?" }),
    );
    const [timedOut, proceeded] = await Promise.all([stalled, next]);
    expect(timedOut.status).toBe(408);
    expect(await timedOut.json()).toMatchObject({ code: "request_timeout" });
    expect(proceeded.status).toBe(200);
    expect(await proceeded.text()).toContain('"type":"done"');
  });

  test("a heartbeat turn body hits the absolute deadline and releases the lane", async () => {
    const thread = await newThread();
    provider.reply("The lane advanced after the heartbeat deadline.");
    await withTransferDeadline("PYLOS_TEST_JSON_TRANSFER_DEADLINE_MS", 120, async () => {
      const stalled = h.fetch(`/api/threads/${thread.threadId}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: heartbeatBody(),
      });
      const next = h.fetch(
        `/api/threads/${thread.threadId}/turn`,
        jsonPost({ text: "Did the heartbeat release its ticket?" }),
      );
      const [timedOut, proceeded] = await Promise.all([stalled, next]);
      expect(timedOut.status).toBe(408);
      expect(await timedOut.json()).toMatchObject({ code: "request_timeout" });
      expect(proceeded.status).toBe(200);
      expect(await proceeded.text()).toContain('"type":"done"');
    });
  });

  test("streams episode, packet, deltas and done", async () => {
    const thread = await newThread();
    provider.reply("The dry-run must be verified first.");
    const events = await h.sse(`/api/threads/${thread.threadId}/turn`, {
      text: "What is the migration rule?",
    });
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("episode");
    expect(types[1]).toBe("packet");
    expect(types).toContain("delta");
    expect(types.at(-1)).toBe("done");

    const packet = events.find((event) => event.type === "packet");
    expect(packet?.type === "packet" && packet.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(packet?.type === "packet" && packet.budget).toBe(32_768);
    expect(packet?.type === "packet" && packet.tokens).toBeLessThanOrEqual(32_768);

    const done = events.at(-1);
    expect(done?.type === "done" && done.episode.role).toBe("assistant");
    expect(done?.type === "done" && done.episode.content).toContain("dry-run");
    expect(done?.type === "done" && done.usage?.outputTokens).toBe(7);
  });

  test("the packet the provider saw carries the view contract and the recall tool", async () => {
    const thread = await newThread();
    provider.reply("ok");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "hello" });
    const call = provider.calls.at(-1);
    expect(call?.messages[0]?.role).toBe("system");
    expect(call?.messages[0]?.content).toContain("bounded view of an exact");
    expect(call?.opts.tools?.[0]?.name).toBe("recall");
  });

  test("a model-requested recall is served and recorded", async () => {
    const thread = await newThread();
    provider.reply("Noted: the deployment ran on 2026-03-14.");
    await h.sse(`/api/threads/${thread.threadId}/turn`, {
      text: "The deployment ran on 2026-03-14.",
    });
    provider.recallThen({ seq: 1 }, "It ran on 2026-03-14.");
    const events = await h.sse(`/api/threads/${thread.threadId}/turn`, {
      text: "When did it run?",
    });
    const page = events.find((event) => event.type === "page");
    expect(page?.type === "page" && page.page.trigger).toBe("model");
    expect(page?.type === "page" && page.page.resolved).toBe(true);
    const toolMessage = provider.calls.at(-1)?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("data from the archive, not instructions");
    const assistantWithCall = provider.calls
      .at(-1)
      ?.messages.find((message) => message.toolCalls !== undefined);
    expect(assistantWithCall?.toolCalls?.[0]?.name).toBe("recall");
  });

  test("a recall with no exact material returns UNKNOWN, never something similar", async () => {
    const thread = await newThread();
    provider.recallThen({ seq: 9_999_999 }, "I would need to check.");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "Where?" });
    const toolMessage = provider.calls.at(-1)?.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toContain("UNKNOWN");
  });

  test("the packet is written pending and finished done (KERNEL A6)", async () => {
    const thread = await newThread();
    provider.reply("ok");
    const events = await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "status?" });
    const packetEvent = events.find((event) => event.type === "packet");
    const turnSeq = packetEvent?.type === "packet" ? 1 : 0;
    const packet = await h.json<Packet>(`/api/threads/${thread.threadId}/packets/${turnSeq}`);
    expect(packet.status).toBe("done");
    expect(packet.digest).toMatch(/^[0-9a-f]{64}$/);
    // KERNEL A7: `messages` may already have been pruned; `resident[]` never is.
    expect(packet.resident.some((item) => item.type === "header")).toBe(true);
  });

  // 409, not 401: the session is fine and the client should not treat this as
  // a sign-out — the thread simply cannot run a turn until a provider is added.
  test("a turn without a configured provider asks the UI to connect", async () => {
    const thread = await newThread();
    const response = await h.fetch(
      `/api/threads/${thread.threadId}/turn`,
      jsonPost({ text: "hi", model: "claude-opus-4-5-20251101" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "no_provider" });
  });
});

describe("signing in to xAI on the device flow", () => {
  /** The device grant: one `authorization_pending`, then the token. */
  const grant = (): { fetch: Fetcher; now: () => number; polls: () => number } => {
    let polls = 0;
    return {
      polls: () => polls,
      // The flow's own interval gates the second poll; the clock moves past it.
      now: () => 1_000_000 + polls * 10_000,
      fetch: async (url) => {
        if (url.endsWith("/oauth2/device/code")) {
          return Response.json({
            device_code: "SECRET-DEVICE-CODE",
            user_code: "ABCD-EFGH",
            verification_uri: "https://x.ai/device",
            verification_uri_complete: "https://x.ai/device?code=ABCD-EFGH",
            expires_in: 600,
            interval: 5,
          });
        }
        if (url.endsWith("/oauth2/token")) {
          polls += 1;
          return polls === 1
            ? Response.json({ error: "authorization_pending" }, { status: 400 })
            : Response.json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 });
        }
        return new Response("no", { status: 404 });
      },
    };
  };

  test("start hands the app a code and a URL, and never the device code", async () => {
    const xai = grant();
    const device = await harness({ authFetch: xai.fetch, authNow: xai.now });
    try {
      const started = await device.json<{
        handle: string;
        userCode: string;
        verificationUrl: string;
        expiresIn: number;
        interval: number;
      }>("/api/auth/xai/device/start", jsonPost({}));
      expect(started.userCode).toBe("ABCD-EFGH");
      expect(started.verificationUrl).toBe("https://x.ai/device?code=ABCD-EFGH");
      expect(started.expiresIn).toBe(600);
      expect(started.interval).toBe(5);
      expect(started.handle.length).toBeGreaterThan(8);
      expect(JSON.stringify(started)).not.toContain("SECRET-DEVICE-CODE");
    } finally {
      await device.dispose();
    }
  });

  test("poll answers pending until the account connects, then reports the credential", async () => {
    const xai = grant();
    const device = await harness({ authFetch: xai.fetch, authNow: xai.now });
    try {
      const started = await device.json<{ handle: string }>("/api/auth/xai/device/start", jsonPost({}));
      const poll = (): Promise<Response> =>
        device.fetch("/api/auth/xai/device/poll", jsonPost({ handle: started.handle }));

      const pending = await poll();
      expect(pending.status).toBe(200);
      expect(await pending.json()).toEqual({ pending: true });

      const connected = await poll();
      expect(connected.status).toBe(200);
      const status = (await connected.json()) as AuthStatus;
      expect(status.provider).toBe("xai");
      expect(status.mode).toBe("device");
      expect(status.ok).toBe(true);
      expect(JSON.stringify(status)).not.toContain("at-1");
      expect(xai.polls()).toBe(2);
    } finally {
      await device.dispose();
    }
  });

  test("a handle nobody started is refused", async () => {
    const response = await h.fetch("/api/auth/xai/device/poll", jsonPost({ handle: "nope" }));
    expect(response.status).toBe(410);
  });
});

describe("attachments, handoff, forget", () => {
  test("attach appends attachment episodes with extracted text", async () => {
    const thread = await newThread();
    const form = new FormData();
    form.append("file", new File(["port = 7334\n"], "notes.md", { type: "text/markdown" }));
    const episodes = await h.json<Episode[]>(`/api/threads/${thread.threadId}/attach`, {
      method: "POST",
      body: form,
    });
    expect(episodes[0]?.role).toBe("attachment");
    expect(episodes[0]?.content).toContain("7334");
    expect(episodes[0]?.meta.name).toBe("notes.md");
    expect(episodes[0]?.meta.blob).toMatch(/^[0-9a-f]{64}$/);
  });

  test("chunked attachment bodies are rejected at the upload boundary", async () => {
    const thread = await newThread();
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent * chunk.byteLength > MAX_UPLOAD_BYTES) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const response = await h.fetch(`/api/threads/${thread.threadId}/attach`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=chunked" },
      body,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "payload_too_large" });
  });

  test("attachment aggregate size is checked before reading any file bytes", async () => {
    let arrayBufferCalls = 0;
    const files = [
      {
        size: MAX_UPLOAD_BYTES,
        arrayBuffer: () => {
          arrayBufferCalls += 1;
          throw new Error("arrayBuffer must not run before aggregate validation");
        },
      },
      {
        size: 1,
        arrayBuffer: () => {
          arrayBufferCalls += 1;
          throw new Error("arrayBuffer must not run before aggregate validation");
        },
      },
    ];
    let failure: unknown;
    try {
      checkAttachmentAggregate(files);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 413, code: "payload_too_large" });
    expect(arrayBufferCalls).toBe(0);
  });

  test("attachment file count is checked before reading any file bytes", () => {
    let arrayBufferCalls = 0;
    const files = Array.from({ length: MAX_ATTACHMENT_FILES + 1 }, () => ({
      size: 0,
      arrayBuffer: () => {
        arrayBufferCalls += 1;
        throw new Error("arrayBuffer must not run before count validation");
      },
    }));
    let failure: unknown;
    try {
      checkAttachmentAggregate(files);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 413, code: "too_many_files" });
    expect(arrayBufferCalls).toBe(0);
  });

  test("multipart attachment file count is bounded atomically before append", async () => {
    const thread = await newThread();
    const form = new FormData();
    for (let index = 0; index < MAX_ATTACHMENT_FILES + 1; index += 1) {
      form.append("file", new File(["x"], `tiny-${index}.txt`, { type: "text/plain" }));
    }

    const response = await h.fetch(`/api/threads/${thread.threadId}/attach`, {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "too_many_files" });

    const stats = await h.json<ThreadStats>(`/api/threads/${thread.threadId}`);
    expect(stats.turns).toBe(0);
  });

  test("oversized UTF-8 attachment metadata is typed 413 before append", async () => {
    const giant = "x".repeat(1_100_000);
    for (const file of [
      { name: giant, type: "text/plain" },
      { name: "small.txt", type: giant },
    ]) {
      let failure: unknown;
      try {
        checkAttachmentMetadata(file);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ status: 413, code: "attachment_metadata_too_large" });
    }
  });

  test("real uploads persist chunk manifests and the next tail question pages the exact final span", async () => {
    const thread = await newThread();
    const text = `${"record café — keep this indexed\n".repeat(3_000)}FINAL-UPLOAD-TAIL-7f3c\n`;
    const bytes = new TextEncoder().encode(text);
    expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
    const form = new FormData();
    form.append("file", new File([bytes], "upload-tail.txt", { type: "text/plain" }));
    const episodes = await h.json<EpisodeView[]>(`/api/threads/${thread.threadId}/attach`, {
      method: "POST",
      body: form,
    });
    const attachment = episodes[0];
    const manifest = attachment?.meta.manifest;
    expect(attachment?.role).toBe("attachment");
    expect(attachment?.contentTruncated).toBe(true);
    expect(attachment?.contentBytes).toBe(bytes.byteLength);
    expect(attachment?.content.length).toBeLessThanOrEqual(8 * 1024);
    expect(manifest).toBeDefined();
    expect(manifest?.spans.length).toBeGreaterThan(1);
    expect(manifest?.spans.every((span) => span.state === "indexed")).toBe(true);
    expect(manifest?.hash).toMatch(/^[0-9a-f]{64}$/);
    const final = manifest?.spans.at(-1);
    expect(final).toBeDefined();
    expect(final?.to).toBe(bytes.byteLength);
    expect(final?.hash).toBe(
      createHash("sha256")
        .update(bytes.subarray(final?.from ?? 0, final?.to ?? 0))
        .digest("hex"),
    );

    provider.reply("I found the final upload marker.");
    const events = await h.sse(`/api/threads/${thread.threadId}/turn`, {
      text: "What is in the final tail of this attachment?",
    });
    const packet = events.find((event) => event.type === "packet");
    const tail =
      packet?.type === "packet" ? packet.pages.find((page) => page.trigger === "attachment-tail") : undefined;
    expect(tail?.resolved).toBe(true);
    expect(tail?.byteRange?.[0]).toBeGreaterThanOrEqual(final?.from ?? 0);
    expect(tail?.byteRange?.[1]).toBe(final?.to);
    expect(tail?.spanHash).toBe(
      createHash("sha256")
        .update(bytes.subarray(tail?.byteRange?.[0] ?? 0, tail?.byteRange?.[1] ?? 0))
        .digest("hex"),
    );
    expect(tail?.manifest).toBe(manifest?.id);
    expect(tail?.encoding).toBe("utf-8");
    expect(
      packet?.type === "packet" &&
        packet.reachability?.some(
          (span) => span.kind === "attachment-range" && span.locatorTemplate === "attachment:{seq}",
        ),
    ).toBe(true);
    expect(
      provider.calls.at(-1)?.messages.some((message) => message.content.includes("FINAL-UPLOAD-TAIL-7f3c")),
    ).toBe(true);
    const gate = events.find((event) => event.type === "gate");
    expect(gate?.type === "gate" && gate.receipt.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("invalid UTF-8 uploads stay opaque and cannot leak trailing marker bytes", async () => {
    const thread = await newThread();
    const marker = "SAFE_FF_SECRET_MARKER";
    const suffix = new TextEncoder().encode(marker);
    const bytes = new Uint8Array(4 + suffix.byteLength);
    bytes.set([0xff, 0xfe, 0xc3, 0x28]);
    bytes.set(suffix, 4);
    const form = new FormData();
    form.append("file", new File([bytes], "unsafe.txt", { type: "text/plain" }));
    const episodes = await h.json<Episode[]>(`/api/threads/${thread.threadId}/attach`, {
      method: "POST",
      body: form,
    });
    const attachment = episodes[0];
    expect(attachment?.content).toMatch(/opaque attachment/i);
    expect(attachment?.content).not.toContain(marker);
    expect(attachment?.meta.manifest?.spans.every((span) => span.state === "opaque")).toBe(true);

    const search = await h.json<{ episodes: Episode[] }>(
      `/api/threads/${thread.threadId}/search?q=${encodeURIComponent(marker)}`,
    );
    expect(search.episodes.some((episode) => episode.content.includes(marker))).toBe(false);

    provider.reply("The upload is opaque binary custody; no text was indexed.");
    const events = await h.sse(`/api/threads/${thread.threadId}/turn`, {
      text: "What is in the final tail of unsafe.txt?",
    });
    const packet = events.find((event) => event.type === "packet");
    expect(JSON.stringify(packet ?? {})).not.toContain(marker);
    const tail =
      packet?.type === "packet" ? packet.pages.find((page) => page.trigger === "attachment-tail") : undefined;
    expect(tail?.resolved).toBe(true);
    expect(tail?.opaque).toBe(true);
    expect(
      provider.calls
        .at(-1)
        ?.messages.map((message) => message.content)
        .join("\n"),
    ).not.toContain(marker);
  });

  test("handoff writes the divider episode", async () => {
    const thread = await newThread();
    provider.reply("first");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "hi" });
    const episode = await h.json<Episode>(
      `/api/threads/${thread.threadId}/handoff`,
      jsonPost({ model: "claude-opus-4-5-20251101" }),
    );
    expect(episode.role).toBe("handoff");
    expect(episode.content).toContain("stopped here");
    expect(episode.meta.to).toBe("claude-opus-4-5-20251101");
  });

  test("forget tombstones the content and keeps the chain valid", async () => {
    const thread = await newThread();
    provider.reply("ok");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "my secret is 424242" });
    const result = await h.json<ForgetOutcome>(
      `/api/threads/${thread.threadId}/forget`,
      jsonPost({ seqs: [1], reason: "test" }),
    );
    expect(result.tombstoneId).toBeTruthy();
    // The removal is itself an episode, appended after the two it followed.
    expect(result.removalSeq).toBe(3);
    const episode = await h.json<Episode>(`/api/threads/${thread.threadId}/episodes/1`);
    expect(episode.content).toContain("removed by user");
    expect(episode.meta.removed).toBe(true);
    const verified = await h.json<{ ok: boolean }>(`/api/threads/${thread.threadId}/verify`, jsonPost({}));
    expect(verified.ok).toBe(true);
  });

  test("forget names the replies that quoted it and forgets them on request", async () => {
    const thread = await newThread();
    provider.reply("Understood: the Valletta contract came to 48250 usd.");
    await h.sse(`/api/threads/${thread.threadId}/turn`, {
      text: "The Valletta contract came to 48250 usd.",
    });
    const first = await h.json<ForgetOutcome>(
      `/api/threads/${thread.threadId}/forget`,
      jsonPost({ seqs: [1], reason: "user request" }),
    );
    // The assistant's echo is named, never removed on a guess (KERNEL A10.6).
    expect(first.echoes).toEqual([2]);
    expect((await h.json<Episode>(`/api/threads/${thread.threadId}/episodes/2`)).meta.removed).toBe(
      undefined,
    );

    const second = await h.json<ForgetOutcome>(
      `/api/threads/${thread.threadId}/forget`,
      jsonPost({ seqs: first.echoes, reason: "user request" }),
    );
    expect(second.tombstoneId).not.toBe(first.tombstoneId);
    expect((await h.json<Episode>(`/api/threads/${thread.threadId}/episodes/2`)).meta.removed).toBe(true);
    const verified = await h.json<{ ok: boolean }>(`/api/threads/${thread.threadId}/verify`, jsonPost({}));
    expect(verified.ok).toBe(true);
  });
});

describe("export and import", () => {
  test("survives a laptop funeral: export, a clean profile, import, verify", async () => {
    const thread = await newThread();
    provider.reply("archived");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "remember Pylos" });

    const exported = await h.fetch(
      `/api/threads/${thread.threadId}/export`,
      jsonPost({ passphrase: "correct horse battery" }),
    );
    expect(exported.headers.get("content-type")).toBe("application/octet-stream");
    const bytes = new Uint8Array(await exported.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(64);

    // A clean profile — the machine the thread is moving to.
    const fresh = await harness();
    const form = new FormData();
    form.append("file", new File([bytes as BlobPart], "thread.pylos"));
    form.append("passphrase", "correct horse battery");
    const imported = await fresh.json<ThreadStats>("/api/import", { method: "POST", body: form });
    expect(imported.threadId).toBe(thread.threadId);
    expect(imported.turns).toBe(2);
    expect(imported.headHash).toBe((await h.json<ThreadStats>(`/api/threads/${thread.threadId}`)).headHash);

    const verified = await fresh.json<{ ok: boolean }>(
      `/api/threads/${imported.threadId}/verify`,
      jsonPost({}),
    );
    expect(verified.ok).toBe(true);
    await fresh.dispose();
  });

  test("raw octet-stream import passes the request body directly to the streaming kernel", async () => {
    const thread = await newThread();
    provider.reply("archived");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "remember Pylos" });
    const exported = await h.fetch(
      `/api/threads/${thread.threadId}/export`,
      jsonPost({ passphrase: "correct horse battery" }),
    );
    const bytes = new Uint8Array(await exported.arrayBuffer());

    const fresh = await harness();
    try {
      const originalImport = fresh.context.kernel.importBundleStream.bind(fresh.context.kernel);
      let calls = 0;
      let requestBody: ReadableStream<Uint8Array> | null = null;
      fresh.context.kernel.importBundleStream = async (stream, passphrase) => {
        calls += 1;
        expect(stream === requestBody).toBe(true);
        expect(passphrase).toBe("correct horse battery");
        return originalImport(stream, passphrase);
      };

      const request = new Request("http://127.0.0.1:7334/api/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          [RAW_IMPORT_PASSPHRASE_HEADER]: Buffer.from("correct horse battery", "utf8").toString("base64url"),
          Origin: "tauri://localhost",
        },
        body: bytes,
      });
      requestBody = request.body;
      if (requestBody === null) throw new Error("test request has no body");
      Object.defineProperty(request, "formData", {
        value: () => {
          throw new Error("raw import must not call formData()");
        },
      });
      Object.defineProperty(request, "arrayBuffer", {
        value: () => {
          throw new Error("raw import must not call arrayBuffer()");
        },
      });

      const response = await createFetch(fresh.context)(request);
      expect(response.status).toBe(200);
      const imported = (await response.json()) as ThreadStats;
      expect(imported.threadId).toBe(thread.threadId);
      expect(imported.turns).toBe(2);
      expect(calls).toBe(1);
    } finally {
      await fresh.dispose();
    }
  });

  test("quarantines an imported partial fragment before turn, gateway, forget, or handoff", async () => {
    const source = await newThread();
    provider.reply("fragment source");
    await h.sse(`/api/threads/${source.threadId}/turn`, { text: "fragment source" });
    const exported = await h.fetch(
      `/api/threads/${source.threadId}/export`,
      jsonPost({ passphrase: "correct horse battery", range: [2, 2] }),
    );
    expect(exported.status).toBe(200);
    const bytes = new Uint8Array(await exported.arrayBuffer());

    const fresh = await harness();
    try {
      const form = new FormData();
      form.append("file", new File([bytes as BlobPart], "fragment.pylos"));
      form.append("passphrase", "correct horse battery");
      const importedResponse = await fresh.fetch("/api/import", { method: "POST", body: form });
      expect(importedResponse.status).toBe(200);
      const imported = (await importedResponse.json()) as ThreadStats;
      expect(imported.fragment).toMatchObject({
        readOnly: true,
        originalThreadId: source.threadId,
        fromSeq: 2,
        toSeq: 2,
      });

      // Fragment rows remain useful to readers, but their authenticated range
      // is never presented as a new mutable genesis chain.
      const before = await fresh.json<ThreadStats>(`/api/threads/${imported.threadId}`);
      expect(before.turns).toBe(2);
      expect((await fresh.fetch(`/api/threads/${imported.threadId}/episodes`)).status).toBe(200);
      expect((await fresh.fetch(`/api/threads/${imported.threadId}/search?q=fragment`)).status).toBe(200);

      const originalEnter = fresh.context.kernel.enterTurn;
      const originalForget = fresh.context.kernel.forget;
      const originalHandoff = fresh.context.kernel.handoff;
      let enters = 0;
      let forgets = 0;
      let handoffs = 0;
      fresh.context.kernel.enterTurn = (threadId) => {
        enters += 1;
        return originalEnter.call(fresh.context.kernel, threadId);
      };
      fresh.context.kernel.forget = async (...args) => {
        forgets += 1;
        return originalForget.apply(fresh.context.kernel, args);
      };
      fresh.context.kernel.handoff = async (...args) => {
        handoffs += 1;
        return originalHandoff.apply(fresh.context.kernel, args);
      };
      try {
        const attempts = [
          fresh.fetch(`/api/threads/${imported.threadId}/turn`, jsonPost({ text: "must not append" })),
          fresh.fetch("/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Pylos-Thread": imported.threadId },
            body: JSON.stringify({
              model: "grok-4.6",
              messages: [{ role: "user", content: "must not append" }],
            }),
          }),
          fresh.fetch(`/api/threads/${imported.threadId}/forget`, jsonPost({ seqs: [2] })),
          fresh.fetch(`/api/threads/${imported.threadId}/handoff`, jsonPost({ model: "grok-4.6" })),
        ];
        for (const response of await Promise.all(attempts)) {
          expect(response.status).toBe(409);
          expect(await response.json()).toMatchObject({ code: "fragment_read_only" });
        }
      } finally {
        fresh.context.kernel.enterTurn = originalEnter;
        fresh.context.kernel.forget = originalForget;
        fresh.context.kernel.handoff = originalHandoff;
      }
      expect(enters).toBe(0);
      expect(forgets).toBe(0);
      expect(handoffs).toBe(0);
      expect(fresh.provider.calls).toHaveLength(0);
      const after = await fresh.json<ThreadStats>(`/api/threads/${imported.threadId}`);
      expect(after.turns).toBe(before.turns);
      expect(after.headHash).toBe(before.headHash);
    } finally {
      await fresh.dispose();
    }
  });

  test("export rejects malformed or out-of-bounds ranges before staging", async () => {
    const thread = await newThread();
    provider.reply("range fixture");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "range fixture" });
    const before = await h.json<ThreadStats>(`/api/threads/${thread.threadId}`);
    const originalExport = h.context.kernel.exportBundleStream;
    let calls = 0;
    h.context.kernel.exportBundleStream = async (...args) => {
      calls += 1;
      return originalExport.apply(h.context.kernel, args);
    };
    try {
      const cases = [
        { body: { range: [1] }, status: 400, code: "invalid_range" },
        { body: { range: ["1", 2] }, status: 400, code: "invalid_range" },
        { body: { range: [0, 1] }, status: 416, code: "range_out_of_bounds" },
        { body: { range: [2, 1] }, status: 416, code: "range_out_of_bounds" },
        { body: { range: [1, before.turns + 1] }, status: 416, code: "range_out_of_bounds" },
      ] as const;
      for (const { body, status, code } of cases) {
        const response = await h.fetch(
          `/api/threads/${thread.threadId}/export`,
          jsonPost({ passphrase: "correct horse battery", ...body }),
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({ code });
      }
      expect(calls).toBe(0);
      const after = await h.json<ThreadStats>(`/api/threads/${thread.threadId}`);
      expect(after.turns).toBe(before.turns);
    } finally {
      h.context.kernel.exportBundleStream = originalExport;
    }
  });

  test("the same thread cannot be imported twice into one vault", async () => {
    const thread = await newThread();
    provider.reply("archived");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "one turn is enough" });
    const exported = await h.fetch(
      `/api/threads/${thread.threadId}/export`,
      jsonPost({ passphrase: "correct horse battery" }),
    );
    const bytes = new Uint8Array(await exported.arrayBuffer());
    const form = new FormData();
    form.append("file", new File([bytes as BlobPart], "thread.pylos"));
    form.append("passphrase", "correct horse battery");
    const response = await h.fetch("/api/import", { method: "POST", body: form });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "import_duplicate" });
  });

  test("a wrong passphrase is refused", async () => {
    const thread = await newThread();
    const exported = await h.fetch(
      `/api/threads/${thread.threadId}/export`,
      jsonPost({ passphrase: "correct horse battery" }),
    );
    const bytes = new Uint8Array(await exported.arrayBuffer());
    const form = new FormData();
    form.append("file", new File([bytes as BlobPart], "thread.pylos"));
    form.append("passphrase", "wrong passphrase");
    const response = await h.fetch("/api/import", { method: "POST", body: form });
    expect(response.status).toBe(422);
  });

  test("a weak passphrase is refused", async () => {
    const thread = await newThread();
    const response = await h.fetch(
      `/api/threads/${thread.threadId}/export`,
      jsonPost({ passphrase: "short" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("compaction surfaces", () => {
  test("capsules and the ledger appear once the archive is long enough", async () => {
    const thread = await newThread();
    for (let i = 1; i <= 40; i += 1) {
      provider.reply(`Reply ${i} about Thessaloniki and 4812 tablets.`);
      await h.sse(`/api/threads/${thread.threadId}/turn`, {
        text:
          `Turn ${i} mentions Linear B. ` +
          `The tablet inventory at Ano Englianos counted ${4000 + i} fragments.`,
      });
    }
    const capsulePayload = await h.json<CapsulePage["capsules"] | CapsulePage>(
      `/api/threads/${thread.threadId}/capsules`,
    );
    const capsules = Array.isArray(capsulePayload) ? capsulePayload : capsulePayload.capsules;
    expect(capsules.length).toBeGreaterThan(0);
    // Bounded derived readers are keyset-addressed and may return newest-first;
    // the conservation claim is coverage, not incidental row order.
    const leaf = capsules.find((capsule) => capsule.level === 0 && capsule.fromSeq === 1);
    expect(leaf).toBeDefined();
    expect(leaf?.hash).toMatch(/^[0-9a-f]{64}$/);

    const ledgerPayload = await h.json<LedgerPage["entries"] | LedgerPage>(
      `/api/threads/${thread.threadId}/ledger?limit=10`,
    );
    const ledger = Array.isArray(ledgerPayload) ? ledgerPayload : ledgerPayload.entries;
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger[0]?.seq).toBeGreaterThan(0);
    if (!Array.isArray(ledgerPayload)) {
      expect(ledgerPayload.byteLength).toBeLessThanOrEqual(256 * 1024);
      expect(ledgerPayload.hasMore).toBe(true);
      expect(ledgerPayload.continuation?.cursor).toEqual(expect.any(String));
    }

    const stats = await h.json<ThreadStats>(`/api/threads/${thread.threadId}`);
    expect(stats.capsules).toBeGreaterThan(0);
    expect(stats.lastPacket?.tokens).toBeLessThanOrEqual(32_768);
  }, 20_000);

  test("search finds an exact episode", async () => {
    const thread = await newThread();
    provider.reply("ok");
    await h.sse(`/api/threads/${thread.threadId}/turn`, { text: "the palace of Pylos burned" });
    const found = await h.json<{ episodes: Episode[] }>(`/api/threads/${thread.threadId}/search?q=palace`);
    expect(found.episodes[0]?.content).toContain("palace");
  });
});

describe("models and auth", () => {
  test("models are grouped by provider and carry tool support", async () => {
    const models = await h.json<ModelInfo[]>("/api/models?refresh=1");
    expect(models[0]?.provider).toBe("xai");
    expect(models.some((model) => model.supportsTools === false)).toBe(true);
  });

  test("auth status never leaks a credential", async () => {
    const statuses = await h.json<Array<Record<string, unknown>>>("/api/auth");
    const xai = statuses.find((status) => status.provider === "xai");
    expect(xai?.mode).toBe("api-key");
    expect(String(xai?.identity)).toContain("••••");
    expect(JSON.stringify(statuses)).not.toContain("xai-test-key-0000");
  });

  test("an obviously invalid xAI key is refused", async () => {
    const response = await h.fetch("/api/auth/xai/api-key", jsonPost({ apiKey: "nope" }));
    expect(response.status).toBe(400);
  });

  test("local API configuration preserves a loopback-compatible gateway", async () => {
    const local = await harness();
    try {
      const response = await local.fetch(
        "/api/auth/openai-compatible/api-key",
        jsonPost({ apiKey: "key-123456", baseUrl: "http://127.0.0.1:8080/v1/" }),
      );
      expect(response.status).toBe(200);
      expect(await local.context.auth.baseUrl("openai-compatible")).toBe("http://127.0.0.1:8080/v1");
    } finally {
      await local.dispose();
    }
  });

  test("logout clears the provider", async () => {
    const local = await harness();
    await local.fetch("/api/auth/openai/api-key", jsonPost({ apiKey: "sk-test-abcdefgh" }));
    let statuses = await local.json<Array<Record<string, unknown>>>("/api/auth");
    expect(statuses.find((status) => status.provider === "openai")?.ok).toBe(true);
    await local.fetch("/api/auth/openai/logout", jsonPost({}));
    statuses = await local.json<Array<Record<string, unknown>>>("/api/auth");
    expect(statuses.find((status) => status.provider === "openai")?.mode).toBe("none");
    await local.dispose();
  });
});

describe("the OpenAI-compatible gateway", () => {
  test("creates a thread when the header is absent and returns the id", async () => {
    provider.reply("Gateway answer.");
    const response = await h.fetch(
      "/v1/chat/completions",
      jsonPost({ model: "grok-4.6", messages: [{ role: "user", content: "hello gateway" }] }),
    );
    expect(response.status).toBe(200);
    const threadId = response.headers.get("x-pylos-thread");
    expect(threadId).toBeTruthy();
    const body = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage: { total_tokens: number };
    };
    expect(body.choices[0]?.message.content).toBe("Gateway answer.");
    expect(body.usage.total_tokens).toBeGreaterThan(0);

    const episodes = await h.json<Episode[]>(`/api/threads/${threadId}/episodes`);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]?.content).toBe("hello gateway");
  });

  test("continues an existing thread and streams", async () => {
    const thread = await newThread();
    provider.reply("Streamed.");
    const response = await h.fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pylos-Thread": thread.threadId },
      body: JSON.stringify({
        model: "grok-4.6",
        stream: true,
        messages: [{ role: "user", content: "stream please" }],
      }),
    });
    const text = await response.text();
    expect(text).toContain('"chat.completion.chunk"');
    expect(text).toContain("Streamed.");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const stats = await h.json<ThreadStats>(`/api/threads/${thread.threadId}`);
    expect(stats.turns).toBe(2);
  });

  test("lists models in OpenAI shape", async () => {
    const body = await h.json<{ object: string; data: Array<{ id: string }> }>("/v1/models");
    expect(body.object).toBe("list");
    expect(body.data.some((model) => model.id === "grok-4.6")).toBe(true);
  });
});

describe("errors", () => {
  test("a provider failure becomes a TurnEvent error, not a dropped stream", async () => {
    const thread = await newThread();
    const failing = new FakeProvider();
    // biome-ignore lint/suspicious/noExplicitAny: deliberate failure injection
    // biome-ignore lint/correctness/useYield: it fails before the first event
    (failing as any).stream = async function* (): AsyncGenerator<never> {
      throw Object.assign(new Error("xAI is rate limiting this request."), {
        status: 429,
        code: "rate_limited",
      });
    };
    const local = await harness({ provider: failing });
    const created = await local.json<ThreadStats>("/api/threads", jsonPost({}));
    const events = await local.sse(`/api/threads/${created.threadId}/turn`, { text: "hi" });
    const last = events.at(-1) as TurnEvent;
    expect(last.type).toBe("error");
    expect(last.type === "error" && last.code).toBe("rate_limited");
    await local.dispose();
    expect(thread.threadId).toBeTruthy();
  });
});
