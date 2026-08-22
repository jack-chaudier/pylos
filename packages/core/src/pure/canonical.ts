/**
 * Canonical JSON — the one serialization the hash chain and the packet digest
 * agree on. Pure and browser-safe: object keys sorted by UTF-8 bytes, no
 * whitespace, `undefined` dropped, non-finite numbers rejected.
 */

export class CanonicalJsonError extends TypeError {
  constructor(reason: string, path: string) {
    super(`${reason} at ${path}`);
    this.name = "CanonicalJsonError";
  }
}

const encoder = new TextEncoder();

/** Sort by UTF-8 bytes, not by UTF-16 code units or host locale. */
export function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

function normalize(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError("non-finite-number", path);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, i) => normalize(item, `${path}[${i}]`));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).filter((k) => source[k] !== undefined);
    keys.sort(compareUtf8);
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = normalize(source[key], `${path}.${key}`);
    return out;
  }
  if (value === undefined) throw new CanonicalJsonError("undefined", path);
  throw new CanonicalJsonError(`unsupported-type ${typeof value}`, path);
}

/** Canonical UTF-8 JSON for stable identities and chain hashes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, "$"));
}
