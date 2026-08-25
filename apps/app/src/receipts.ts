/**
 * The kernel appends its qualification lines to the assistant's own text — the
 * memory gate's `⟨pylos UNKNOWN · …⟩`, the paging round's `⟨UNKNOWN — …⟩`. They
 * are receipts, not the model's sentence, so the app sets them in the engraved
 * register instead of leaving them as body prose. This is display only: the
 * archived bytes keep every line exactly where the kernel wrote it.
 */

/** A finished receipt line: `⟨pylos HISTORICAL · the cited archive witness has changed⟩`. */
const RECEIPT = /^⟨(?:pylos )?[A-Z_]+ [·—] .+⟩$/u;

/**
 * A trailing line the stream has opened but not yet closed. Without this a
 * half-arrived receipt reads as body for a few frames and then jumps out of it.
 */
const OPENING = /^⟨pylos[^⟩]*$/u;

export interface SplitText {
  /** The answer as the model wrote it. Identical to the input when it carries no receipts. */
  body: string;
  /** Each receipt line, brackets kept, in the order the kernel appended them. */
  receipts: string[];
}

export function splitReceipts(text: string): SplitText {
  const lines = text.split("\n");
  const body: string[] = [];
  const receipts: string[] = [];
  let afterReceipt = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (RECEIPT.test(line) || (i === lines.length - 1 && OPENING.test(line))) {
      while (body.at(-1) === "") body.pop();
      receipts.push(line);
      afterReceipt = true;
      continue;
    }
    // The blank line the kernel wrote to hold the receipts apart from the answer.
    if (afterReceipt && line === "") continue;
    afterReceipt = false;
    body.push(line);
  }

  return { body: body.join("\n"), receipts };
}
