import type { PageRecord, ProviderId } from "@pylos/protocol";

export function compactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

export function groupedNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function tokenCount(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

export function shortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function fullStamp(ts: number): string {
  return new Date(ts).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function shortHash(hash: string): string {
  return hash.length <= 12 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

export function providerLabel(id: ProviderId | string): string {
  switch (id) {
    case "xai":
      return "xAI";
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
    case "ollama":
      return "Ollama · local";
    case "openai-compatible":
      return "Compatible endpoint";
    default:
      return String(id);
  }
}

/** "recovered two earlier moments" reads better than "recovered 2". */
const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

export function spelled(count: number): string {
  return WORDS[count] ?? groupedNumber(count);
}

/**
 * The turns a recovery line names, after the count: `turn 966`, `turns 1 and
 * 966`, `turns 1, 966 and 4,120`. Past three the line stops listing and says
 * how many more, because the point is which archive came back, not all of it.
 */
export function turnList(seqs: readonly number[]): string {
  const [first, second, third] = seqs;
  if (first === undefined) return "";
  if (second === undefined) return `turn ${groupedNumber(first)}`;
  const head = `turns ${groupedNumber(first)}`;
  if (third === undefined) return `${head} and ${groupedNumber(second)}`;
  if (seqs.length === 3) return `${head}, ${groupedNumber(second)} and ${groupedNumber(third)}`;
  return `${head}, ${groupedNumber(second)} and ${groupedNumber(seqs.length - 2)} more`;
}

export function bytesLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${Math.round(size / 1024)} KiB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MiB`;
  return `${(size / 1024 ** 3).toFixed(2)} GiB`;
}

/** Why a span came back, in the reader's words rather than the kernel's. */
export function pageLabel(page: PageRecord): string {
  switch (page.trigger) {
    case "sequence":
      return `turn ${groupedNumber(page.seqs[0] ?? 0)}`;
    case "check":
      return "checked";
    case "ledger":
      return page.name ?? "ledger";
    case "historical":
      return page.name === undefined ? "changed" : `changed · ${page.name}`;
    case "search":
      return page.query ?? "search";
    case "model":
      return "recall";
    case "explicit":
      return "asked for";
    case "fault":
      return "page fault";
    case "path": {
      // KERNEL A11.2: the query is the hit whose receipt led here, written `#61234`.
      const hit = Number(/\d+/.exec(page.query ?? "")?.[0]);
      return Number.isFinite(hit) ? `by way of turn ${groupedNumber(hit)}` : "by way of an earlier answer";
    }
  }
}
