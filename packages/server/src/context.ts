import { AuthService } from "./auth/xai.ts";
import { type Kernel, openKernel } from "./kernel.ts";
import { ProviderRegistry } from "./providers/registry.ts";

/** Everything one signed-in user's requests execute against. */
export interface ServerContext {
  kernel: Kernel;
  auth: AuthService;
  registry: ProviderRegistry;
}

export interface ContextOptions {
  home?: string;
  kernel?: Kernel;
  auth?: AuthService;
  registry?: ProviderRegistry;
}

export async function createContext(options: ContextOptions = {}): Promise<ServerContext> {
  const auth = options.auth ?? new AuthService();
  const kernel =
    options.kernel ?? (await openKernel(options.home === undefined ? {} : { home: options.home }));
  const registry = options.registry ?? new ProviderRegistry(auth);
  return { kernel, auth, registry };
}
