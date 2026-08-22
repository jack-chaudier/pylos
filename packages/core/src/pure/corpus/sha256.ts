/**
 * SHA-256 in plain TypeScript.
 *
 * The corpus derives every episode from `sha256(seed:salt:seq)`, and the same
 * bytes have to come out in Bun, in a browser worker and in the bench — so the
 * digest cannot be `node:crypto` (absent in the browser) or `crypto.subtle`
 * (async). This is FIPS 180-4 and nothing else. The hot path is a short key, so
 * the message buffer and the schedule are reused rather than allocated.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

const w = new Uint32Array(64);

/** UTF-8 bytes of `text`, appended to `out` from `at`. Returns the new length. */
function utf8Into(out: Uint8Array, at: number, text: string): number {
  let n = at;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.codePointAt(i) as number;
    if (c < 0x80) {
      out[n++] = c;
    } else if (c < 0x800) {
      out[n++] = 0xc0 | (c >> 6);
      out[n++] = 0x80 | (c & 0x3f);
    } else if (c < 0x10000) {
      out[n++] = 0xe0 | (c >> 12);
      out[n++] = 0x80 | ((c >> 6) & 0x3f);
      out[n++] = 0x80 | (c & 0x3f);
    } else {
      out[n++] = 0xf0 | (c >> 18);
      out[n++] = 0x80 | ((c >> 12) & 0x3f);
      out[n++] = 0x80 | ((c >> 6) & 0x3f);
      out[n++] = 0x80 | (c & 0x3f);
      i += 1;
    }
  }
  return n;
}

/** Reused for the short keys the corpus hashes; longer inputs get their own buffer. */
const scratch = new Uint8Array(256);

/** `sha256(utf8(text))`, written into `out` as eight big-endian words. */
export function sha256Into(text: string, out: Uint32Array): void {
  const upper = text.length * 3;
  const buffer = upper + 9 <= scratch.length ? scratch : new Uint8Array(upper + 72);
  const len = utf8Into(buffer, 0, text);
  const blocks = Math.ceil((len + 9) / 64);
  const total = blocks * 64;
  buffer.fill(0, len, total);
  buffer[len] = 0x80;
  const bits = len * 8;
  buffer[total - 4] = (bits >>> 24) & 0xff;
  buffer[total - 3] = (bits >>> 16) & 0xff;
  buffer[total - 2] = (bits >>> 8) & 0xff;
  buffer[total - 1] = bits & 0xff;

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let block = 0; block < blocks; block += 1) {
    const base = block * 64;
    for (let i = 0; i < 16; i += 1) {
      const p = base + i * 4;
      w[i] =
        (((buffer[p] as number) << 24) |
          ((buffer[p + 1] as number) << 16) |
          ((buffer[p + 2] as number) << 8) |
          (buffer[p + 3] as number)) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15] as number;
      const y = w[i - 2] as number;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  out[0] = h0;
  out[1] = h1;
  out[2] = h2;
  out[3] = h3;
  out[4] = h4;
  out[5] = h5;
  out[6] = h6;
  out[7] = h7;
}

const words = new Uint32Array(8);

/** Lowercase hex of `sha256(utf8(text))`. */
export function sha256Hex(text: string): string {
  sha256Into(text, words);
  let out = "";
  for (const word of words) out += word.toString(16).padStart(8, "0");
  return out;
}
