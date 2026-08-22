/**
 * Serves the built single-page app under `/app/` (Vite `base: "/app/"`).
 * Anything outside that prefix is left to the API router.
 */
import { existsSync } from "node:fs";
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

export function staticSite(directory: string): StaticSite {
  const root = resolve(directory);
  const indexPath = resolve(root, "index.html");

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
        const file = Bun.file(target);
        if (await file.exists()) {
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

      const index = Bun.file(indexPath);
      if (!(await index.exists())) return plain(404, "Not found.");
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
