import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@pylos/protocol";
import { AuthService } from "../src/auth/xai.ts";
import { CredentialStore } from "../src/auth/store.ts";
import { openKernel } from "../src/kernel.ts";
import { ProviderRegistry } from "../src/providers/registry.ts";
import { createContext, createFetch, type ServerContext } from "../src/serve.ts";
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

const ORIGIN = "tauri://localhost";

export async function harness(options: { provider?: FakeProvider } = {}): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "pylos-test-"));
  const provider = options.provider ?? new FakeProvider();
  const auth = new AuthService({ store: new CredentialStore(join(home, "auth.json")) });
  await auth.setApiKey("xai", "xai-test-key-0000");
  const kernel = await openKernel({ home });
  const registry = new ProviderRegistry(auth, { xai: provider });
  const context = await createContext({ kernel, auth, registry });
  const handler = createFetch(context);

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
