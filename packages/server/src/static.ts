/**
 * Serves the built single-page app under `/app/` (Vite `base: "/app/"`).
 * Anything outside that prefix is left to the API router.
 */
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
    "img-src 'self' data: https:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; " +
    "form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const PREFIX = "/app/";

export interface StaticSite {
  handle(url: URL, method: string): Promise<Response | undefined>;
}

type SafePath = "missing" | "directory" | "unsafe" | string;

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export function staticSite(directory: string): StaticSite {
  const root = resolve(directory);
  const indexPath = resolve(root, "index.html");
  let rootRealpath: Promise<string | undefined> | undefined;

  const safeRoot = (): Promise<string | undefined> => {
    rootRealpath ??= realpath(root)
      .then(async (resolved) => {
        try {
          return (await lstat(resolved)).isDirectory() ? resolved : undefined;
        } catch {
          return undefined;
        }
      })
      .catch(() => undefined);
    return rootRealpath;
  };

  const safePath = async (target: string): Promise<SafePath> => {
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(target);
    } catch {
      return "missing";
    }
    // Directories are not assets; let the SPA fallback handle a route-shaped
    // directory. Symlinks and all other non-regular entries are refused
    // instead of handing Bun.file a path that it may follow or stream.
    if (stat.isDirectory()) return "directory";
    if (!stat.isFile()) return "unsafe";

    const resolvedRoot = await safeRoot();
    if (resolvedRoot === undefined) return "unsafe";
    let resolvedTarget: string;
    try {
      resolvedTarget = await realpath(target);
    } catch {
      return "unsafe";
    }
    if (!inside(resolvedRoot, resolvedTarget)) return "unsafe";
    try {
      const resolvedStat = await lstat(resolvedTarget);
      return resolvedStat.isFile() ? resolvedTarget : "unsafe";
    } catch {
      return "unsafe";
    }
  };

  return {
    async handle(url: URL, method: string): Promise<Response | undefined> {
      if (method !== "GET" && method !== "HEAD") return undefined;
      const path = url.pathname;
      if (path === "/" || path === "/app") return redirect(PREFIX);
      if (!path.startsWith(PREFIX)) return undefined;

      let rest: string;
      try {
        rest = decodeURIComponent(path.slice(PREFIX.length));
      } catch {
        return plain(400, "Bad request.");
      }
      if (rest.includes("\0")) return plain(400, "Bad request.");

      // `..` survives percent-encoding, so resolve first and refuse anything outside the root.
      const target = resolve(root, rest);
      if (target !== root && !target.startsWith(root + sep)) return plain(404, "Not found.");

      if (rest.length > 0 && target !== indexPath) {
        const safeTarget = await safePath(target);
        if (safeTarget === "unsafe") return plain(404, "Not found.");
        if (typeof safeTarget === "string" && safeTarget !== "missing" && safeTarget !== "directory") {
          const file = Bun.file(safeTarget);
          return new Response(file, {
            headers: {
              ...SECURITY_HEADERS,
              "Content-Type": file.type,
              "Cache-Control": path.startsWith("/app/assets/")
                ? "public, max-age=31536000, immutable"
                : "no-cache",
            },
          });
        }
      }

      const safeIndex = await safePath(indexPath);
      if (safeIndex === "unsafe" || safeIndex === "missing" || safeIndex === "directory") {
        return plain(404, "Not found.");
      }
      const index = Bun.file(safeIndex);
      return new Response(index, {
        headers: {
          ...SECURITY_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        },
      });
    },
  };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { ...SECURITY_HEADERS, Location: location } });
}

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * Where the built app lives when nobody says. A release tarball unpacks `pylos`
 * and `app/` side by side; a source checkout has `apps/app/dist` once it is
 * built. Either only counts if it actually holds a shell to serve.
 */
export function defaultWebDir(): string | undefined {
  const candidates = [
    resolve(dirname(process.execPath), "app"),
    resolve(import.meta.dir, "..", "..", "..", "apps", "app", "dist"),
  ];
  return candidates.find((directory) => existsSync(join(directory, "index.html")));
}
