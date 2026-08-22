import type { ProviderId } from "@pylos/protocol";

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

export function bytesLabel(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
