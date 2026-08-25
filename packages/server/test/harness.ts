import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Me, TurnEvent } from "@pylos/protocol";
import { CredentialStore } from "../src/auth/store.ts";
import { AuthService } from "../src/auth/xai.ts";
import { createContext, type ServerContext } from "../src/context.ts";
import { HostedRegistry } from "../src/hosted.ts";
import { openKernel } from "../src/kernel.ts";
import type { HeavyOperationGate, TurnConcurrencyGate } from "../src/limits.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { createFetch, createHostedFetch, type Handler } from "../src/serve.ts";
import { staticSite } from "../src/static.ts";
import { FakeProvider } from "./fake-provider.ts";

export interface Harness {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  json<T>(path: string, init?: RequestInit): Promise<T>;
  sse(path: string, body: unknown): Promise<TurnEvent[]>;
  provider: FakeProvider;
  context: ServerContext;
  home: string;
  dispose(): Promise<void>;
}

/** A stand-in for auth.x.ai, injected into the `AuthService` the harness builds. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const ORIGIN = "tauri://localhost";
export const HOSTED_ORIGIN = "https://pylos.test";

export async function harness(
  options: { provider?: FakeProvider; web?: string; authFetch?: Fetcher; authNow?: () => number } = {},
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "pylos-test-"));
  const provider = options.provider ?? new FakeProvider();
  const auth = new AuthService({
    store: new CredentialStore(join(home, "auth.json")),
    ...(options.authFetch === undefined ? {} : { fetch: options.authFetch }),
    ...(options.authNow === undefined ? {} : { now: options.authNow }),
  });
  await auth.setApiKey("xai", "xai-test-key-0000");
  const kernel = await openKernel({ home });
  const registry = new ProviderRegistry(auth, { xai: provider });
  const context = await createContext({ kernel, auth, registry });
  const handler = createFetch(context, options.web === undefined ? {} : { site: staticSite(options.web) });

  const call = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (!headers.has("origin")) headers.set("origin", ORIGIN);
    return handler(new Request(`http://127.0.0.1:7334${path}`, { ...init, headers }));
  };

  return {
    fetch: call,
    home,
    provider,
    context,
    json: async <T>(path: string, init?: RequestInit): Promise<T> => {
      const response = await call(path, init);
      return (await response.json()) as T;
    },
    sse: async (path: string, body: unknown): Promise<TurnEvent[]> => {
      const response = await call(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return collectSse(response);
    },
    dispose: async (): Promise<void> => {
      await kernel.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

// ---------- hosted ----------

export interface HostedHarness {
  fetch(path: string, init?: RequestInit, address?: string): Promise<Response>;
  json<T>(path: string, init?: RequestInit, session?: string): Promise<T>;
  sse(path: string, body: unknown, session: string): Promise<TurnEvent[]>;
  /** Runs the device grant end to end for one subject and returns their session. */
  login(sub: string, profile?: { name?: string; email?: string }): Promise<{ session: string; me: Me }>;
  /** Leaves the device grant unauthorized, so a poll keeps answering `pending`. */
  holdGrant(held: boolean): void;
  registry: HostedRegistry;
  provider: FakeProvider;
  home: string;
  dispose(): Promise<void>;
}

export async function hostedHarness(
  options: {
    provider?: FakeProvider;
    web?: string;
    origins?: readonly string[];
    heavy?: HeavyOperationGate;
    turns?: TurnConcurrencyGate;
  } = {},
): Promise<HostedHarness> {
  const home = await mkdtemp(join(tmpdir(), "pylos-hosted-"));
  const provider = options.provider ?? new FakeProvider();
  const xai = fakeXai();

  const registry = new HostedRegistry({
    home,
    ...(options.heavy === undefined ? {} : { heavy: options.heavy }),
    ...(options.turns === undefined ? {} : { turns: options.turns }),
    fetch: xai.fetch,
    context: async (dir) => {
      const auth = new AuthService({ store: new CredentialStore(join(dir, "auth.json")) });
      return createContext({
        kernel: await openKernel({ home: dir }),
        auth,
        registry: new ProviderRegistry(auth, { xai: provider }),
      });
    },
  });

  const handler: Handler = createHostedFetch({
    registry,
    origins: options.origins ?? [HOSTED_ORIGIN],
    ...(options.web === undefined ? {} : { site: staticSite(options.web) }),
  });

  let addresses = 0;
  const call = (path: string, init: RequestInit = {}, address?: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (!headers.has("origin")) headers.set("origin", HOSTED_ORIGIN);
    const request = new Request(`https://pylos.test${path}`, { ...init, headers });
    if (address === undefined) return handler(request);
    return handler(request, { requestIP: () => ({ address }) });
  };

  return {
    fetch: call,
    home,
    provider,
    registry,
    holdGrant: xai.hold,
    json: async <T>(path: string, init: RequestInit = {}, session?: string): Promise<T> => {
      const response = await call(path, session === undefined ? init : withSession(init, session));
      return (await response.json()) as T;
    },
    sse: async (path: string, body: unknown, session: string): Promise<TurnEvent[]> => {
      const response = await call(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session}` },
        body: JSON.stringify(body),
      });
      return collectSse(response);
    },
    login: async (sub, profile) => {
      xai.identify(sub, profile ?? {});
      // Each sign-in comes from its own address, as it would in the world.
      addresses += 1;
      const address = `198.51.100.${addresses}`;
      const started = (await call("/api/login/xai/start", jsonPost({}), address)).json() as Promise<{
        handle: string;
      }>;
      const handle = (await started).handle;
      const response = await call("/api/login/xai/poll", jsonPost({ handle }), address);
      const body = (await response.json()) as { session?: string; me?: Me };
      if (body.session === undefined || body.me === undefined) {
        throw new Error(`login did not complete: ${JSON.stringify(body)}`);
      }
      return { session: body.session, me: body.me };
    },
    dispose: async (): Promise<void> => {
      await registry.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

export function withSession(init: RequestInit, session: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session}`);
  return { ...init, headers };
}

/** A stand-in for auth.x.ai: the device grant and the userinfo endpoint. */
function fakeXai(): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  identify(sub: string, profile: { name?: string; email?: string }): void;
  hold(held: boolean): void;
} {
  let held = false;
  let current = {
    sub: "user-a",
    name: undefined as string | undefined,
    email: undefined as string | undefined,
  };
  const tokens = new Map<string, string>(); // access token → sub
  return {
    identify(sub, profile): void {
      current = { sub, name: profile.name, email: profile.email };
    },
    hold(value): void {
      held = value;
    },
    fetch: async (url, init): Promise<Response> => {
      if (url.endsWith("/oauth2/device/code")) {
        return Response.json({
          device_code: `dc-${current.sub}`,
          user_code: "WXYZ-1234",
          verification_uri: "https://x.ai/device",
          verification_uri_complete: "https://x.ai/device?code=WXYZ-1234",
          expires_in: 600,
          interval: 0,
        });
      }
      if (url.endsWith("/oauth2/token")) {
        if (held) return Response.json({ error: "authorization_pending" }, { status: 400 });
        const body = String((init?.body as URLSearchParams | undefined)?.toString() ?? "");
        const sub = /device_code=dc-([^&]+)/.exec(body)?.[1] ?? current.sub;
        const token = fakeJwt({ sub, iss: "https://auth.x.ai" });
        tokens.set(token, sub);
        return Response.json({ access_token: token, refresh_token: `rt-${sub}`, expires_in: 3600 });
      }
      if (url.endsWith("/oauth2/userinfo")) {
        const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
        const sub = tokens.get(bearer.replace(/^Bearer\s+/, ""));
        if (sub === undefined) return new Response("no", { status: 401 });
        return Response.json({
          sub,
          ...(current.name === undefined ? {} : { name: current.name }),
          ...(current.email === undefined ? {} : { email: current.email }),
        });
      }
      return new Response("not found", { status: 404 });
    },
  };
}

/** A JWT shape with a fake payload and no real signature. */
export function fakeJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(payload)}.not-a-signature`; // scan-secrets:allow (fixture)
}

export async function collectSse(response: Response): Promise<TurnEvent[]> {
  if (response.body === null) throw new Error("no body");
  const events: TurnEvent[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        events.push(JSON.parse(payload) as TurnEvent);
      }
      index = buffer.indexOf("\n\n");
    }
  }
  return events;
}

export function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
